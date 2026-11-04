"""Revérifie des générations déjà faites (generer.py) sans rien régénérer : ré-extrait le code de
chaque réponse et réexécute les tests. Utile quand l'extraction ou les tests changent.

  python reverifier.py data/auto/generations.jsonl data/auto/generations-v2.jsonl
"""
import argparse
import json

from generer import banc


def main():
    p = argparse.ArgumentParser()
    p.add_argument("entree")
    p.add_argument("sortie")
    p.add_argument("--lot", type=int, default=200, help="exercices exécutés ensemble")
    args = p.parse_args()

    lignes = [json.loads(l) for l in open(args.entree)]
    exos = {}
    for lang in {x["langage"] for x in lignes}:
        exos.update({(lang, e["id"]): e for e in banc.epreuves(lang, 0, "mbpp")})

    avant = apres = 0
    with open(args.sortie, "w") as f:
        for debut in range(0, len(lignes), args.lot):
            lot = lignes[debut:debut + args.lot]
            travaux, places = [], []
            for n, x in enumerate(lot):
                e = exos[(x["langage"], x["id"])]
                for j, r in enumerate(x["reponses"]):
                    avant += r["ok"]
                    code = banc.extraire(e, r["reponse"])
                    if code is None:
                        r.update(ok=False, code="sans code")
                    else:
                        travaux.append((len(places), x["langage"], banc.programme(e, code)))
                        places.append(r)
            for i, v in banc.executer(travaux).items():
                places[i].update(ok=v["ok"], code=v["code"])
            for x in lot:
                apres += sum(r["ok"] for r in x["reponses"])
                f.write(json.dumps(x, ensure_ascii=False) + "\n")
            print(f"{debut + len(lot)}/{len(lignes)} · réponses justes {avant} → {apres}", flush=True)


if __name__ == "__main__":
    main()
