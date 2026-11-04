"""Tri des générations vérifiées (generer.py) → données SFT et paires DPO.

SFT : pour chaque exercice, la réponse juste la plus courte (réflexion comprise, en tokens).
      Le modèle apprend son propre raisonnement, en version qui conclut.
DPO : préférée = cette même réponse ; rejetée = une réponse fausse ou coupée, sinon une réponse juste
      mais nettement plus longue (≥ 1,5× et +500 tokens). Au plus --paires par exercice.

  python selection.py data/auto/generations.jsonl --sft data/auto/sft.jsonl --dpo data/auto/dpo.jsonl
"""
import argparse
import collections
import json
import random


def message(r):
    m = {"role": "assistant", "content": r["reponse"]}
    if r["reflexion"]:
        m["reasoning_content"] = r["reflexion"]
    return m


def main():
    p = argparse.ArgumentParser()
    p.add_argument("generations")
    p.add_argument("--sft", default="data/auto/sft.jsonl")
    p.add_argument("--dpo", default="data/auto/dpo.jsonl")
    p.add_argument("--paires", type=int, default=2)
    args = p.parse_args()

    alea = random.Random(0)
    stats = collections.defaultdict(collections.Counter)
    with open(args.generations) as g, open(args.sft, "w") as fs, open(args.dpo, "w") as fd:
        for ligne in g:
            x = json.loads(ligne)
            st = stats[x["langage"]]
            st["exercices"] += 1
            justes = sorted((r for r in x["reponses"] if r["ok"] and not r["coupee"]), key=lambda r: r["tokens"])
            if not justes:
                st["aucune juste"] += 1
                continue
            meilleure = justes[0]
            consigne = [{"role": "user", "content": x["consigne"]}]
            fs.write(json.dumps({"messages": consigne + [message(meilleure)], "source": "auto", "lang": x["langage"],
                                 "id": x["id"]}, ensure_ascii=False) + "\n")
            st["sft"] += 1
            st["tokens sft"] += meilleure["tokens"]

            mauvaises = [r for r in x["reponses"] if not r["ok"] or r["coupee"]]
            longues = [r for r in justes[1:] if r["tokens"] >= 1.5 * meilleure["tokens"] and r["tokens"] >= meilleure["tokens"] + 500]
            alea.shuffle(mauvaises)
            for r in (mauvaises + longues[::-1])[: args.paires]:
                fd.write(json.dumps({"prompt": consigne, "chosen": message(meilleure), "rejected": message(r),
                                     "lang": x["langage"], "id": x["id"],
                                     "type": "fausse" if not r["ok"] or r["coupee"] else "longue"}, ensure_ascii=False) + "\n")
                st["dpo " + ("fausse" if not r["ok"] or r["coupee"] else "longue")] += 1

    for lang, st in sorted(stats.items()):
        moy = st["tokens sft"] // max(st["sft"], 1)
        print(f"{lang:4s} {st['exercices']:4d} exercices · SFT {st['sft']} (moy. {moy} tokens) · sans réponse juste "
              f"{st['aucune juste']} · DPO {st['dpo fausse']} contre fausse/coupée + {st['dpo longue']} contre longue")


if __name__ == "__main__":
    main()
