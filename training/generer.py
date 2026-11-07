"""Génération vérifiée (« auto-sélection ») : le modèle à entraîner résout des exercices avec tests,
plusieurs fois chacun, réflexion comprise ; chaque réponse est exécutée dans le conteneur du banc.
Sert ensuite à construire le SFT (meilleure réponse juste et courte) et les paires DPO (selection.py).

Exercices : MBPP+ (Python) et sa traduction MultiPL-E (TypeScript, JavaScript, PHP, Rust, Bash).
Jamais les épreuves du banc (HumanEval). La consigne varie d'un exercice à l'autre (FR/EN, formulations)
pour ne pas apprendre une seule formulation, mais reste la même pour toutes les réponses d'un exercice.

Usage (sur le PC de mesure, modèle servi par banc/servir.sh avec PARALLELE=128) :
  python generer.py --url http://127.0.0.1:4760 --sortie data/auto/generations.jsonl [--k 4]
Reprend là où il s'était arrêté (exercices déjà présents dans la sortie sautés).
Une ligne par exercice : {id, langage, consigne, reponses: [{reponse, reflexion, tokens, coupee, ok, code}]}
"""
import argparse
import concurrent.futures as cf
import importlib.util
import json
import random
import time
import urllib.request
import zlib
from pathlib import Path

ICI = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("banc_code", ICI / "banc" / "code.py")
banc = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(banc)

CONSIGNES = [
    "Complète cette fonction {langue}. Réponds avec le code complet de la fonction dans un seul bloc ```{bloc}.\n\n```{bloc}\n{enonce}\n```",
    "Écris le corps de cette fonction {langue} :\n\n```{bloc}\n{enonce}\n```\n\nDonne la fonction entière dans un bloc ```{bloc}.",
    "Implémente la fonction suivante en {langue}.\n```{bloc}\n{enonce}\n```",
    "Complete this {langue} function. Reply with the full function in a single ```{bloc} block.\n\n```{bloc}\n{enonce}\n```",
    "Implement the following {langue} function:\n\n```{bloc}\n{enonce}\n```",
    "Write the implementation for this {langue} function and return the complete code in one ```{bloc} code block.\n```{bloc}\n{enonce}\n```",
]


def consigne(e):
    alea = random.Random(f"{e['langage']}/{e['id']}")
    texte = alea.choice(CONSIGNES).format(langue=banc.NOMS[e["langage"]], bloc=banc.BLOCS[e["langage"]], enonce=e["enonce"].rstrip())
    if e.get("exemple"):
        texte += alea.choice(["\n\nExemple de test qui doit passer :\n", "\n\nThis test must pass:\n"]) + f"```\n{e['exemple']}\n```"
    return texte


def demander(url, texte, args, graine):
    corps = {"messages": [{"role": "user", "content": texte}], "temperature": args.temperature, "top_p": 0.95,
             "max_tokens": args.max_tokens, "seed": graine}
    req = urllib.request.Request(f"{url}/v1/chat/completions", data=json.dumps(corps).encode(),
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=3600) as r:
        rep = json.load(r)
    choix = rep["choices"][0]
    return {"reponse": choix["message"].get("content") or "", "reflexion": choix["message"].get("reasoning_content") or "",
            "tokens": rep.get("usage", {}).get("completion_tokens", 0), "coupee": choix.get("finish_reason") == "length"}


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", required=True)
    p.add_argument("--sortie", default="data/auto/generations.jsonl")
    p.add_argument("--langages", default="py,ts,js,php,rs,sh")
    p.add_argument("--k", type=int, default=4, help="réponses par exercice")
    p.add_argument("--temperature", type=float, default=0.8)
    p.add_argument("--max-tokens", type=int, default=8192)
    p.add_argument("--paralleles", type=int, default=128)
    p.add_argument("--lot", type=int, default=256, help="exercices générés puis exécutés ensemble (gros lots : sinon la carte attend la réponse la plus longue de chaque lot)")
    p.add_argument("--limite", type=int, default=0, help="exercices par langage (0 = tous)")
    args = p.parse_args()

    sortie = Path(args.sortie)
    sortie.parent.mkdir(parents=True, exist_ok=True)
    faits = set()
    if sortie.exists():
        faits = {(l["langage"], l["id"]) for l in map(json.loads, sortie.open())}
    exos = [e for lang in args.langages.split(",") for e in banc.epreuves(lang, args.limite, "mbpp")
            if (e["langage"], e["id"]) not in faits]
    random.Random(0).shuffle(exos)  # langages mélangés : un arrêt en cours laisse un échantillon équilibré
    print(f"{len(exos)} exercices à faire ({len(faits)} déjà faits), {args.k} réponses chacun", flush=True)

    t0, toks = time.time(), 0
    with cf.ThreadPoolExecutor(args.paralleles) as pool:
        for debut in range(0, len(exos), args.lot):
            lot = exos[debut:debut + args.lot]
            demandes = [(e, consigne(e), j) for e in lot for j in range(args.k)]
            reponses = list(pool.map(lambda d: demander(args.url, d[1], args, 1000 * d[2] + zlib.crc32(d[0]["id"].encode()) % 1000), demandes))
            codes = [banc.extraire(d[0], r["reponse"]) for d, r in zip(demandes, reponses)]
            verdicts = banc.executer([(i, d[0]["langage"], banc.programme(d[0], c))
                                      for i, (d, c) in enumerate(zip(demandes, codes)) if c is not None])
            with sortie.open("a") as f:
                for n, e in enumerate(lot):
                    rs = []
                    for j in range(args.k):
                        i = n * args.k + j
                        v = verdicts.get(i, {"ok": False, "code": "sans code"})
                        rs.append({**reponses[i], "ok": v["ok"], "code": v["code"]})
                        toks += reponses[i]["tokens"]
                    f.write(json.dumps({"id": e["id"], "langage": e["langage"], "consigne": demandes[n * args.k][1],
                                        "reponses": rs}, ensure_ascii=False) + "\n")
            fait = debut + len(lot)
            ecoule = time.time() - t0
            print(f"{fait}/{len(exos)} exercices · {toks / ecoule:.0f} tok/s · reste ~{ecoule / fait * (len(exos) - fait) / 3600:.1f} h",
                  flush=True)


if __name__ == "__main__":
    main()
