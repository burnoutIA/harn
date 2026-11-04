"""Mélange de données de code pour l'entraînement (SFT), au format commun :
{"messages": [...OpenAI...], "tools": [...OpenAI...], "source": ..., "lang": ...} par ligne.

Sources (téléchargées en streaming depuis Hugging Face) :
- magicoder  : ise-uiuc/Magicoder-OSS-Instruct-75K — problème → solution, multi-langages
               (python, typescript, rust, php, shell, cpp, java…)
- opencode   : nvidia/Nemotron-SFT-OpenCode-v1 — vraies sessions d'agent de code (outils
               read / bash / edit / glob / grep…), format proche de pi
- swesmith   : SWE-bench/SWE-smith-trajectories (split « tool ») — corrections de bugs dans des
               dépôts Python, sessions résolues seulement

Le dosage par langage suit les projets de l'utilisateur (TS/JS > Python > front > Rust > PHP,
shell, SQL). Le front (HTML/CSS/SCSS/Svelte/Twig) manque dans ces sources : il viendra des
données générées par le professeur (Qwen3.8-27B, Radiance) — voir README.

Aucune de ces sources n'a de réflexion séparée : le modèle apprendra à agir sans longue
réflexion. Choix à réévaluer au banc.

Usage : python donnees.py [--echelle 1.0]   (indépendant du modèle de base)
"""
import argparse
import ast
import json
import random
from pathlib import Path

from datasets import load_dataset

RACINE = Path(__file__).resolve().parent

# nombre d'exemples visés par source/langage (échelle 1.0)
DOSAGE = {
    "magicoder": {"typescript": 5000, "python": 8000, "rust": 4000, "php": 3000, "shell": 3000,
                  "cpp": 800, "java": 800, "csharp": 400, "swift": 300},
    "opencode": {"agent_skills": 12000, "general": 6000, "bash_only_tool": 3000},
    "swesmith": {"tool": 4000},
}


def texte(contenu):
    if isinstance(contenu, list):
        return "\n".join(p.get("text", "") if isinstance(p, dict) else str(p) for p in contenu)
    return "" if contenu is None else str(contenu)


def lire(v):
    """Champs stockés en JSON ou en repr Python selon les sources."""
    if not isinstance(v, str):
        return v
    for f in (json.loads, ast.literal_eval):
        try:
            return f(v)
        except Exception:
            pass
    return v


def appels(tool_calls):
    out = []
    for c in lire(tool_calls) or []:
        f = c["function"]
        args = lire(f.get("arguments")) or {}
        if not isinstance(args, dict):
            args = {"input": args}
        out.append({"id": c.get("id", ""), "type": "function", "function": {"name": f["name"], "arguments": args}})
    return out


def schemas_observes(messages):
    """Outils sans définition fournie : schéma déduit des arguments réellement utilisés."""
    vus = {}
    for m in messages:
        for c in m.get("tool_calls", []):
            props = vus.setdefault(c["function"]["name"], {})
            for k, v in c["function"]["arguments"].items():
                props.setdefault(k, {"type": "integer" if isinstance(v, int) else "array" if isinstance(v, list) else "string"})
    return [{"type": "function", "function": {"name": n, "description": f"Outil {n}", "parameters": {"type": "object", "properties": p}}}
            for n, p in vus.items()]


def magicoder(lang, n, rng):
    ds = load_dataset("ise-uiuc/Magicoder-OSS-Instruct-75K", split="train", streaming=True)
    k = 0
    for ex in ds:
        if ex["lang"] != lang:
            continue
        yield {"messages": [{"role": "user", "content": ex["problem"]}, {"role": "assistant", "content": ex["solution"]}],
               "tools": [], "source": "magicoder", "lang": lang}
        k += 1
        if k >= n:
            return


# catégories d'OpenCode utiles au code (on écarte rédaction, pédagogie, conseils généraux…)
CATEGORIES_CODE = {"code_generation", "code_debugging", "code_explanation", "code_review",
                   "planning_and_task_structuring", "fact_seeking_qa", "reasoning"}


def opencode(split, n, rng):
    ds = load_dataset("nvidia/Nemotron-SFT-OpenCode-v1", split=split, streaming=True).shuffle(seed=0, buffer_size=2000)
    k = 0
    for ex in ds:
        if ex.get("question_category") not in CATEGORIES_CODE:
            continue
        try:
            msgs = []
            for m in ex["messages"]:
                r = {"role": m["role"], "content": texte(m.get("content"))}
                if m["role"] == "assistant" and m.get("tool_calls"):
                    r["tool_calls"] = appels(m["tool_calls"])
                if m["role"] == "tool":
                    sortie = lire(m.get("content"))
                    if isinstance(sortie, list):
                        r["content"] = "\n".join(str((p.get("output") or {}).get("value", p)) if isinstance(p, dict) else str(p) for p in sortie)
                msgs.append(r)
            tools = []
            for t in ex.get("tools") or []:
                schema = (lire(t.get("inputSchema")) or {}).get("jsonSchema", {})
                schema = {k2: v for k2, v in schema.items() if k2 not in ("$schema", "additionalProperties")}
                if t.get("id") != "invalid":
                    tools.append({"type": "function", "function": {"name": t["id"], "description": t.get("description", "")[:1500], "parameters": schema}})
        except Exception:
            continue
        yield {"messages": msgs, "tools": tools or schemas_observes(msgs), "source": f"opencode-{split}", "lang": ex.get("question_category", "")}
        k += 1
        if k >= n:
            return


def swesmith(split, n, rng):
    ds = load_dataset("SWE-bench/SWE-smith-trajectories", split=split, streaming=True).shuffle(seed=0, buffer_size=1000)
    k = 0
    for ex in ds:
        if not ex.get("resolved"):
            continue
        try:
            msgs = []
            for m in lire(ex["messages"]):
                r = {"role": m["role"], "content": texte(m.get("content"))}
                if m["role"] == "assistant" and m.get("tool_calls"):
                    r["tool_calls"] = appels(m["tool_calls"])
                if m["role"] == "tool":
                    ids = lire(m.get("tool_call_ids")) or [""]
                    r["tool_call_id"] = ids[0]
                    r["content"] = r["content"].removeprefix("OBSERVATION:\n")
                msgs.append(r)
        except Exception:
            continue
        yield {"messages": msgs, "tools": schemas_observes(msgs), "source": "swesmith", "lang": "python"}
        k += 1
        if k >= n:
            return


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--echelle", type=float, default=1.0, help="multiplie tous les dosages (0.01 pour un essai)")
    p.add_argument("--sortie", default=str(RACINE / "data" / "melange.jsonl"))
    args = p.parse_args()
    rng = random.Random(0)
    sources = {"magicoder": magicoder, "opencode": opencode, "swesmith": swesmith}
    exemples = []
    for source, parts in DOSAGE.items():
        for part, n in parts.items():
            n = max(1, int(n * args.echelle))
            avant = len(exemples)
            exemples += list(sources[source](part, n, rng))
            print(f"{source}/{part}: {len(exemples) - avant}/{n}", flush=True)
    rng.shuffle(exemples)
    Path(args.sortie).parent.mkdir(parents=True, exist_ok=True)
    with open(args.sortie, "w") as f:
        for e in exemples:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")
    print(f"{len(exemples)} exemples → {args.sortie}")


if __name__ == "__main__":
    main()
