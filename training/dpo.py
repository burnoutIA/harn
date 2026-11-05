"""DPO après le SFT : apprend à préférer une réponse à une autre, sur les paires de selection.py
(juste et courte ≻ fausse, coupée ou juste mais bien plus longue). Même modèle, même gabarit et
mêmes réglages mémoire que sft.py (une seule carte de 24 Go pour un petit modèle).

Économie mémoire : le modèle de référence n'est jamais chargé en même temps. Ses log-probabilités
sont calculées d'abord (passe sans gradient, poids de départ), puis l'entraînement utilise la forme
factorisée du gradient DPO : avec z = β·[(lc − rc) − (lr − rr)],
    ∇ perte = −β·σ(−z)·(∇lc − ∇lr)
On calcule z sans gradient, puis on rétropropage les deux réponses l'une après l'autre : une seule
séquence en mémoire à la fois.

  python dpo.py --modele sorties/<nom>-sft/modele --donnees data/auto/dpo.jsonl --sortie sorties/<nom>-dpo
"""
import argparse
import json
import math
import time
from pathlib import Path

import torch
from transformers import AutoModelForCausalLM, AutoTokenizer, get_cosine_schedule_with_warmup

from sft import encoder, perte_par_tranches


def logp(modele, ids, lab):
    ids_t = torch.tensor([ids], device="cuda")
    lab_t = torch.tensor([lab], device="cuda")
    with torch.autocast("cuda", dtype=torch.bfloat16):
        total, _ = perte_par_tranches(modele, ids_t, lab_t)
    return -total  # somme des log-probabilités des tokens de la réponse


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--modele", required=True)
    p.add_argument("--donnees", required=True)
    p.add_argument("--sortie", required=True)
    p.add_argument("--longueur", type=int, default=16384)
    p.add_argument("--beta", type=float, default=0.1)
    p.add_argument("--lr", type=float, default=1e-6)
    p.add_argument("--epoques", type=float, default=1.0)
    p.add_argument("--accum", type=int, default=16, help="paires par pas d'optimisation")
    p.add_argument("--echauffement", type=float, default=0.05)
    p.add_argument("--max-paires", type=int, default=0)
    p.add_argument("--pas-max", type=int, default=0)
    p.add_argument("--entrainer-embeddings", action="store_true")
    p.add_argument("--code-distant", action="store_true")
    args = p.parse_args()

    torch.manual_seed(0)
    sortie = Path(args.sortie)
    sortie.mkdir(parents=True, exist_ok=True)
    tok = AutoTokenizer.from_pretrained(args.modele, trust_remote_code=args.code_distant)

    paires, ecartees = [], 0
    for ligne in open(args.donnees):
        x = json.loads(ligne)
        c = encoder(tok, {"messages": x["prompt"] + [x["chosen"]]}, args.longueur)
        r = encoder(tok, {"messages": x["prompt"] + [x["rejected"]]}, args.longueur)
        if c is None or r is None:
            ecartees += 1
            continue
        paires.append({"c": c, "r": r})
        if args.max_paires and len(paires) >= args.max_paires:
            break
    print(f"{len(paires)} paires gardées, {ecartees} écartées", flush=True)

    modele = AutoModelForCausalLM.from_pretrained(args.modele, dtype=torch.float32, trust_remote_code=args.code_distant).cuda()
    modele.config.use_cache = False

    # 1. référence : log-probabilités du modèle de départ, une fois pour toutes
    modele.eval()
    t0 = time.time()
    with torch.no_grad():
        for k, pr in enumerate(paires):
            pr["rc"] = logp(modele, *pr["c"]).item()
            pr["rr"] = logp(modele, *pr["r"]).item()
            if k % 200 == 0:
                print(f"référence {k}/{len(paires)} ({time.time() - t0:.0f} s)", flush=True)

    # 2. entraînement
    if not args.entrainer_embeddings:
        for module in (modele.get_input_embeddings(), modele.get_output_embeddings()):
            module.weight.requires_grad_(False)
    entraines = [q for q in modele.parameters() if q.requires_grad]
    modele.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    modele.train()
    try:
        import bitsandbytes as bnb
        opt = bnb.optim.AdamW8bit(entraines, lr=args.lr, betas=(0.9, 0.95), weight_decay=0.0)
    except ImportError:
        opt = torch.optim.AdamW(entraines, lr=args.lr, betas=(0.9, 0.95), weight_decay=0.0, fused=True)
    pas_total = math.ceil(len(paires) * args.epoques / args.accum)
    if args.pas_max:
        pas_total = min(pas_total, args.pas_max)
    sched = get_cosine_schedule_with_warmup(opt, max(1, int(pas_total * args.echauffement)), pas_total)
    print(f"{pas_total} pas de {args.accum} paires, lr {args.lr}, β {args.beta}", flush=True)

    journal = open(sortie / "journal.jsonl", "a")
    ordre = torch.randperm(len(paires)).tolist()
    i, t0 = 0, time.time()
    for pas in range(1, pas_total + 1):
        pertes, justes, marges = [], 0, []
        for k in range(args.accum):
            pr = paires[ordre[(i + k) % len(paires)]]
            with torch.no_grad():
                z = args.beta * ((logp(modele, *pr["c"]).item() - pr["rc"]) - (logp(modele, *pr["r"]).item() - pr["rr"]))
            poids = args.beta * torch.sigmoid(torch.tensor(-z)).item() / args.accum
            (-poids * logp(modele, *pr["c"])).backward()
            (poids * logp(modele, *pr["r"])).backward()
            pertes.append(-torch.nn.functional.logsigmoid(torch.tensor(z)).item())
            justes += z > 0
            marges.append(z)
        i += args.accum
        norme = torch.nn.utils.clip_grad_norm_(entraines, 1.0).item()
        opt.step()
        sched.step()
        opt.zero_grad(set_to_none=True)
        info = {"pas": pas, "perte": sum(pertes) / len(pertes), "precision": justes / args.accum,
                "marge": sum(marges) / len(marges), "norme": norme, "lr": sched.get_last_lr()[0],
                "secondes": round(time.time() - t0), "memoire_go": round(torch.cuda.max_memory_allocated() / 2**30, 1)}
        journal.write(json.dumps(info) + "\n")
        journal.flush()
        print(" ".join(f"{k}={v:.4g}" if isinstance(v, float) else f"{k}={v}" for k, v in info.items()), flush=True)
    modele.save_pretrained(sortie / "modele", safe_serialization=True,
                           state_dict={k: v.to(torch.bfloat16) for k, v in modele.state_dict().items()})
    tok.save_pretrained(sortie / "modele")
    print("terminé :", sortie / "modele")


if __name__ == "__main__":
    main()
