"""Réentraînement complet (SFT) d'un petit modèle de langage sur le mélange de code — PyTorch +
transformers, sans Unsloth. Indépendant du modèle de base : tout modèle Hugging Face « causal LM »
avec un gabarit de conversation (chat template) qui gère les outils.

- Perte sur les réponses de l'assistant seulement. Chaque exemple est vérifié : chaque tour
  rendu doit être un préfixe exact de la conversation complète, sinon l'exemple est écarté
  (gabarit qui réécrit l'historique).
- Perte calculée par tranches de 1024 tokens avec recalcul (torch.utils.checkpoint) : les logits
  16k × 128k ne sont jamais en mémoire d'un coup (8 Go sinon).
- Poids maîtres en fp32, calcul en bf16 (autocast), gradient checkpointing, AdamW 8 bits
  (bitsandbytes) si disponible. Budget 3090 : ~7 Go poids + 7 Go gradients + 3,5 Go Adam 8 bits
  + activations → tient dans 24 Go à 16k tokens.
- Exemples plus longs que --longueur : écartés (pas tronqués : une session coupée apprend à
  s'arrêter au milieu).

Usage :
  python sft.py --modele modeles/<base> --donnees data/melange.jsonl --sortie sorties/<base>-sft [--longueur 16384] [--lr 1e-5] [--epoques 1] [--accum 16]
Essai rapide : --max-exemples 20 --pas-max 3
"""
import argparse
import json
import math
import re
import time
from pathlib import Path

import torch
from torch.utils.checkpoint import checkpoint
from transformers import AutoModelForCausalLM, AutoTokenizer, get_cosine_schedule_with_warmup


REFLEXION_VIDE = re.compile(r"\s*(?:<think>)?\s*</think>\s*")


def encoder(tok, ex, longueur):
    """input_ids + labels (−100 hors réponses de l'assistant)."""
    msgs, tools = ex["messages"], ex.get("tools") or None
    complet = tok.apply_chat_template(msgs, tools=tools, tokenize=False)
    zones = []
    for k, m in enumerate(msgs):
        if m["role"] != "assistant":
            continue
        avant = tok.apply_chat_template(msgs[:k], tools=tools, tokenize=False, add_generation_prompt=True)
        jusque = tok.apply_chat_template(msgs[:k + 1], tools=tools, tokenize=False)
        if not (complet.startswith(avant) and complet.startswith(jusque)):
            return None  # gabarit non stable pour cet exemple : on l'écarte
        # Exemple sans réflexion : le gabarit écrit un bloc vide (<think></think>). On ne l'apprend pas,
        # sinon le modèle apprend à ne plus réfléchir (mesuré : bien pire en code sans réflexion).
        vide = REFLEXION_VIDE.match(complet, len(avant))
        zones.append((vide.end() if vide else len(avant), len(jusque)))
    if not zones:
        return None
    enc = tok(complet, add_special_tokens=False, return_offsets_mapping=True)
    ids = enc["input_ids"]
    if len(ids) > longueur:
        return None
    labels = [t if any(a <= deb < b for a, b in zones) else -100 for t, (deb, _) in zip(ids, enc["offset_mapping"])]
    return ids, labels


def etat_bf16(modele):
    """Poids à sauvegarder, en bf16. Si la table de sortie est la même que celle d'entrée (tied), on ne
    l'écrit qu'une fois : sinon la conversion GGUF en fait deux tenseurs (plus gros, quantifiés à part)."""
    etat = modele.state_dict()
    sortie, entree = modele.get_output_embeddings(), modele.get_input_embeddings()
    if sortie is not None and sortie.weight is entree.weight:
        ptr = entree.weight.data_ptr()
        memes = [k for k, v in etat.items() if v.data_ptr() == ptr]
        garder = next((k for k in memes if "embed" in k), memes[0])
        etat = {k: v for k, v in etat.items() if k == garder or v.data_ptr() != ptr}
    return {k: v.to(torch.bfloat16) for k, v in etat.items()}


def perte_par_tranches(modele, ids, labels, tranche=1024):
    h = modele.get_decoder()(input_ids=ids).last_hidden_state[0]  # [L, d]
    cibles = labels[0, 1:]
    h = h[:-1]
    poids = modele.get_output_embeddings().weight

    def morceau(hh, cc):
        logits = torch.nn.functional.linear(hh, poids).float()
        return torch.nn.functional.cross_entropy(logits, cc, ignore_index=-100, reduction="sum")

    total = h.new_zeros((), dtype=torch.float32)
    for a in range(0, h.shape[0], tranche):
        cc = cibles[a:a + tranche]
        if (cc != -100).any():
            total = total + checkpoint(morceau, h[a:a + tranche], cc, use_reentrant=False)
    n = (cibles != -100).sum()
    return total, n


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--modele", required=True)
    p.add_argument("--donnees", required=True)
    p.add_argument("--sortie", required=True)
    p.add_argument("--longueur", type=int, default=16384)
    p.add_argument("--lr", type=float, default=1e-5)
    p.add_argument("--epoques", type=float, default=1.0)
    p.add_argument("--accum", type=int, default=16, help="exemples par pas d'optimisation")
    p.add_argument("--echauffement", type=float, default=0.03)
    p.add_argument("--max-exemples", type=int, default=0)
    p.add_argument("--pas-max", type=int, default=0)
    p.add_argument("--sauver-tous", type=int, default=500, help="pas entre deux sauvegardes")
    p.add_argument("--optim", choices=["auto", "adamw8bit", "adamw"], default="auto")
    p.add_argument("--entrainer-embeddings", action="store_true",
                   help="entraîner aussi la table des tokens (gelée par défaut : ~15 %% des poids, ~2,6 Go économisés)")
    p.add_argument("--code-distant", action="store_true",
                   help="autoriser le code Python livré avec le modèle (trust_remote_code) — le relire avant")
    args = p.parse_args()

    torch.manual_seed(0)
    sortie = Path(args.sortie)
    sortie.mkdir(parents=True, exist_ok=True)
    tok = AutoTokenizer.from_pretrained(args.modele, trust_remote_code=args.code_distant)

    exemples, ecartes = [], 0
    with open(args.donnees) as f:
        for ligne in f:
            e = encoder(tok, json.loads(ligne), args.longueur)
            if e is None:
                ecartes += 1
            else:
                exemples.append(e)
            if args.max_exemples and len(exemples) >= args.max_exemples:
                break
    ntok = sum(sum(1 for l in lab if l != -100) for _, lab in exemples)
    print(f"{len(exemples)} exemples gardés, {ecartes} écartés (trop longs / gabarit), {ntok:,} tokens appris", flush=True)

    modele = AutoModelForCausalLM.from_pretrained(args.modele, dtype=torch.float32, trust_remote_code=args.code_distant).cuda()
    if not args.entrainer_embeddings:
        for module in (modele.get_input_embeddings(), modele.get_output_embeddings()):
            module.weight.requires_grad_(False)
    entraines = [p for p in modele.parameters() if p.requires_grad]
    print(f"{sum(p.numel() for p in entraines) / 1e6:.0f} M paramètres entraînés sur {sum(p.numel() for p in modele.parameters()) / 1e6:.0f} M", flush=True)
    modele.gradient_checkpointing_enable(gradient_checkpointing_kwargs={"use_reentrant": False})
    modele.config.use_cache = False
    modele.train()

    optim = args.optim
    if optim == "auto":
        try:
            import bitsandbytes  # noqa: F401
            optim = "adamw8bit"
        except ImportError:
            optim = "adamw"
    if optim == "adamw8bit":
        import bitsandbytes as bnb
        opt = bnb.optim.AdamW8bit(entraines, lr=args.lr, betas=(0.9, 0.95), weight_decay=0.0)
    else:
        opt = torch.optim.AdamW(entraines, lr=args.lr, betas=(0.9, 0.95), weight_decay=0.0, fused=True)
    pas_total = math.ceil(len(exemples) * args.epoques / args.accum)
    if args.pas_max:
        pas_total = min(pas_total, args.pas_max)
    sched = get_cosine_schedule_with_warmup(opt, max(1, int(pas_total * args.echauffement)), pas_total)
    print(f"optimiseur {optim}, {pas_total} pas de {args.accum} exemples, lr {args.lr}", flush=True)

    journal = open(sortie / "journal.jsonl", "a")
    ordre = torch.randperm(len(exemples)).tolist()
    i, t0 = 0, time.time()
    for pas in range(1, pas_total + 1):
        somme, compte = 0.0, 0
        lot = [exemples[ordre[(i + k) % len(exemples)]] for k in range(args.accum)]
        i += args.accum
        nlot = sum(sum(1 for l in lab if l != -100) for _, lab in lot)
        for ids, lab in lot:
            ids_t = torch.tensor([ids], device="cuda")
            lab_t = torch.tensor([lab], device="cuda")
            with torch.autocast("cuda", dtype=torch.bfloat16):
                total, n = perte_par_tranches(modele, ids_t, lab_t)
            (total / max(nlot, 1)).backward()
            somme += total.item()
            compte += int(n)
        norme = torch.nn.utils.clip_grad_norm_(entraines, 1.0).item()
        opt.step()
        sched.step()
        opt.zero_grad(set_to_none=True)
        info = {"pas": pas, "perte": somme / max(compte, 1), "norme": norme, "lr": sched.get_last_lr()[0],
                "tokens": compte, "secondes": round(time.time() - t0), "memoire_go": round(torch.cuda.max_memory_allocated() / 2**30, 1)}
        journal.write(json.dumps(info) + "\n")
        journal.flush()
        print(" ".join(f"{k}={v:.4g}" if isinstance(v, float) else f"{k}={v}" for k, v in info.items()), flush=True)
        if pas % args.sauver_tous == 0 or pas == pas_total:
            # poids maîtres fp32 en mémoire, sauvegarde en bf16 (3,4 Go au lieu de 6,9)
            modele.save_pretrained(sortie / "modele", safe_serialization=True,
                                   state_dict=etat_bf16(modele))
            tok.save_pretrained(sortie / "modele")
    print("terminé :", sortie / "modele")


if __name__ == "__main__":
    main()
