"""Banc de code : le modèle écrit des fonctions, des tests cachés les exécutent. Note = part des
épreuves réussies du premier coup (pass@1, glouton). Indépendant du modèle : il interroge
n'importe quel serveur compatible OpenAI (llama-server, vLLM…).

Épreuves : HumanEval+ (Python, tests renforcés) et MultiPL-E (HumanEval traduit) en TypeScript,
JavaScript, PHP, Rust, shell. Exécution dans l'image podman harn-banc-code (Containerfile) :
sans réseau, lecture seule hors /travail, mémoire et processus plafonnés, 15 s par épreuve.

Usage : python banc/code.py --url http://127.0.0.1:4760 --etiquette base [--langages py,ts,php]
        [--limite 20] [--paralleles 4] [--max-tokens 8192] [--sans-reflexion] [--biais mots.json]
        [--ids liste.txt]
Sortie : banc/resultats/<etiquette>.json (réponses, code extrait, verdicts) + résumé à l'écran.
"""
import argparse
import concurrent.futures as cf
import json
import re
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path

from datasets import load_dataset

ICI = Path(__file__).resolve().parent
IMAGE = "harn-banc-code:1"
NOMS = {"py": "Python", "ts": "TypeScript", "js": "JavaScript", "php": "PHP", "rs": "Rust", "sh": "Bash"}
BLOCS = {"py": "python", "ts": "typescript", "js": "javascript", "php": "php", "rs": "rust", "sh": "bash"}
EXECUTER = {  # dans le conteneur, fichier f.<ext>
    "py": "timeout 15 python f.py",
    "ts": "tsc --target es2020 --module commonjs f.ts >/dev/null 2>&1; timeout 15 node f.js",
    "js": "timeout 15 node f.js",
    "php": "timeout 15 php f.php",
    "rs": "timeout 60 rustc -O --edition 2021 -o f f.rs && timeout 15 ./f",
    "sh": "timeout 15 bash f.sh",
}


def epreuves(langage, limite, famille="humaneval"):
    """famille « humaneval » : le banc. « mbpp » : autres exercices avec tests (MBPP+ et sa traduction
    MultiPL-E), réservés à l'entraînement — jamais les épreuves du banc."""
    if famille == "mbpp" and langage == "py":
        ds = load_dataset("evalplus/mbppplus", split="test")
        for ex in list(ds)[: limite or None]:
            signature = re.search(r"^def \w+\(.*?\).*?:", ex["code"], re.M)
            if not signature:
                continue
            nom = re.match(r"def (\w+)", signature.group(0)).group(1)
            exemple = ex["test_list"][0] if ex["test_list"] else ""
            enonce = f'{signature.group(0)}\n    """{ex["prompt"].strip()}\n    {exemple}\n    """\n'
            yield {"id": f"Mbpp/{ex['task_id']}", "langage": "py", "enonce": enonce, "nom": nom,
                   "tests": "\n".join(ex["test_imports"]) + "\n" + ex["test"]}
        return
    if langage == "py":
        ds = load_dataset("evalplus/humanevalplus", split="test")
        for ex in list(ds)[: limite or None]:
            yield {"id": ex["task_id"], "langage": "py", "enonce": ex["prompt"], "nom": ex["entry_point"],
                   "tests": ex["test"] + f"\ncheck({ex['entry_point']})\n"}
    else:
        ds = load_dataset("nuprl/MultiPL-E", f"{famille}-{langage}", split="test")
        for ex in list(ds)[: limite or None]:
            nom = re.sub(r"^(HumanEval|mbpp)_\d+_", "", ex["name"])
            yield {"id": ex["name"], "langage": langage, "enonce": ex["prompt"], "nom": nom, "tests": ex["tests"]}


def consigne(e):
    langue = NOMS[e["langage"]]
    return (f"Complète cette fonction {langue}. Réponds avec le code complet de la fonction (signature "
            f"comprise, et les imports ou use nécessaires) dans un seul bloc ```{BLOCS[e['langage']]}, "
            f"sans exemple d'utilisation ni test.\n\n```{BLOCS[e['langage']]}\n{e['enonce'].rstrip()}\n```")


def demander(url, e, max_tokens, extra=None):
    corps = {"messages": [{"role": "user", "content": consigne(e)}], "temperature": 0, "max_tokens": max_tokens, "seed": 0,
             **(extra or {})}
    req = urllib.request.Request(f"{url}/v1/chat/completions", data=json.dumps(corps).encode(),
                                 headers={"Content-Type": "application/json"})
    t0 = time.time()
    with urllib.request.urlopen(req, timeout=1800) as r:
        rep = json.load(r)
    choix = rep["choices"][0]
    return {"reponse": choix["message"].get("content") or "", "reflexion": choix["message"].get("reasoning_content") or "",
            "coupee": choix.get("finish_reason") == "length",
            "tokens": rep.get("usage", {}).get("completion_tokens", 0), "secondes": round(time.time() - t0, 1)}


def extraire(e, texte):
    """Code de la réponse, ou None si elle n'en contient pas (réponse vide ou coupée : ratée).
    Sans cette règle, l'énoncé seul (accolade ouverte) peut avaler les tests et « réussir »."""
    blocs = re.findall(r"```[a-zA-Z0-9_+-]*\n(.*?)```", texte, re.S)
    if not blocs:
        return None
    code = max(blocs, key=len)
    if e["nom"] not in code:  # le modèle n'a donné que le corps
        code = e["enonce"] + code
    if e["langage"] == "php" and "<?php" not in code:
        code = "<?php\n" + code
    if e["langage"] == "php":
        code = code.replace("?>", "")
    return code


def programme(e, code):
    tests = e["tests"]
    # MultiPL-E (rs, sh) : les tests commencent par l'accolade qui ferme la fonction (format
    # « compléter le corps »). On demande la fonction entière : cette accolade est en trop.
    if tests.lstrip().startswith("}"):
        tests = tests.lstrip()[1:]
    if e["langage"] == "php":
        tests = tests.replace("<?php", "")
    return code + "\n\n" + tests


def executer(lot):
    """lot : liste de (index, langage, programme). Un conteneur par langage, épreuves en série."""
    verdicts = {}
    par_langage = {}
    for i, lang, prog in lot:
        par_langage.setdefault(lang, []).append((i, prog))
    for lang, progs in par_langage.items():
        with tempfile.TemporaryDirectory() as d:
            for i, prog in progs:
                (Path(d) / f"e{i}").mkdir()
                (Path(d) / f"e{i}" / f"f.{lang}").write_text(prog)
            script = ("for e in e*; do (cd $e && { " + EXECUTER[lang] + "; } >sortie.txt 2>&1; echo $? > code.txt); done")
            subprocess.run(["podman", "run", "--rm", "--network", "none", "--memory", "2g", "--pids-limit", "256",
                            "--read-only", "--tmpfs", "/tmp", "-v", f"{d}:/travail:Z", "--userns", "keep-id",
                            IMAGE, "sh", "-c", script], capture_output=True, timeout=3600)
            for i, _ in progs:
                rc = (Path(d) / f"e{i}" / "code.txt").read_text().strip() if (Path(d) / f"e{i}" / "code.txt").exists() else "?"
                sortie = (Path(d) / f"e{i}" / "sortie.txt").read_text(errors="replace")[-600:] if (Path(d) / f"e{i}" / "sortie.txt").exists() else ""
                verdicts[i] = {"ok": rc == "0", "code": rc, "sortie": sortie}
    return verdicts


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--url", required=True)
    p.add_argument("--etiquette", required=True)
    p.add_argument("--langages", default="py,ts,js,php,rs,sh")
    p.add_argument("--limite", type=int, default=0, help="épreuves par langage (0 = toutes)")
    p.add_argument("--paralleles", type=int, default=4)
    p.add_argument("--max-tokens", type=int, default=8192)
    p.add_argument("--sans-reflexion", action="store_true", help="enable_thinking=false dans le gabarit")
    p.add_argument("--biais", help='JSON {"mot": biais} : pénalise (biais < 0) des mots pendant la génération (logit_bias)')
    p.add_argument("--ids", help="fichier d'identifiants d'épreuves (un par ligne) : ne passer que celles-là")
    args = p.parse_args()

    extra = {}
    if args.sans_reflexion:
        extra["chat_template_kwargs"] = {"enable_thinking": False}
    if args.biais:
        extra["logit_bias"] = [[mot, b] for mot, b in json.loads(Path(args.biais).read_text()).items()]
    toutes = [e for lang in args.langages.split(",") for e in epreuves(lang, args.limite)]
    if args.ids:
        garder = set(Path(args.ids).read_text().split())
        toutes = [e for e in toutes if e["id"] in garder]
    print(f"{len(toutes)} épreuves", flush=True)
    t0 = time.time()
    with cf.ThreadPoolExecutor(args.paralleles) as pool:
        reponses = list(pool.map(lambda e: demander(args.url, e, args.max_tokens, extra), toutes))
    print(f"réponses reçues en {time.time() - t0:.0f} s", flush=True)
    codes = [extraire(e, r["reponse"]) for e, r in zip(toutes, reponses)]
    verdicts = executer([(i, e["langage"], programme(e, c)) for i, (e, c) in enumerate(zip(toutes, codes)) if c is not None])
    for i, c in enumerate(codes):
        if c is None:
            verdicts[i] = {"ok": False, "code": "sans code", "sortie": ""}

    lignes = [{**e, **r, "code_extrait": c, **verdicts[i]} for i, (e, r, c) in enumerate(zip(toutes, reponses, codes))]
    resume = {}
    for lang in args.langages.split(","):
        l = [x for x in lignes if x["langage"] == lang]
        if l:
            resume[lang] = {"reussite": round(100 * sum(x["ok"] for x in l) / len(l), 1), "epreuves": len(l),
                            "coupees": sum(x["coupee"] for x in l), "tokens_moyens": round(sum(x["tokens"] for x in l) / len(l))}
    resume["moyenne"] = round(sum(v["reussite"] for v in resume.values()) / len(resume), 1)
    sortie = ICI / "resultats" / f"{args.etiquette}.json"
    sortie.parent.mkdir(exist_ok=True)
    sortie.write_text(json.dumps({"etiquette": args.etiquette, "options": extra, "resume": resume, "epreuves": lignes}, indent=1, ensure_ascii=False))
    for lang, v in resume.items():
        print(f"  {NOMS.get(lang, lang):11s} {v}" if lang != "moyenne" else f"  MOYENNE     {v} %")
    print("écrit :", sortie)


if __name__ == "__main__":
    main()
