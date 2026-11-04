#!/usr/bin/env bash
# La recette, à lancer sur la machine d'entraînement (CUDA) : même routine pour tout petit
# modèle de base, pour pouvoir les comparer.
#
#   ./recette.sh <org/modele-hugging-face> [nom] [options de sft.py…]
#
# 1. télécharge le modèle de base dans modeles/<nom> (s'il n'y est pas)
# 2. construit data/melange.jsonl (s'il n'existe pas : on le régénère en le supprimant)
# 3. entraîne → sorties/<nom>-sft/ , journal dans sorties/<nom>-sft.log
#
# ESSAI=1        : 100 exemples, 3 pas — vérifie la chaîne (et que la perte n'est pas NaN)
# CODE_DISTANT=1 : autorise le code Python livré avec le modèle (trust_remote_code), à relire avant
set -euo pipefail
cd "$(dirname "$0")"

BASE=${1:?usage : ./recette.sh <org/modele> [nom] [options de sft.py]}
shift
NOM=${1:-$(basename "$BASE" | tr '[:upper:]' '[:lower:]')}
[ $# -gt 0 ] && shift
PY=.venv/bin/python
[ -x "$PY" ] || { echo "Environnement absent : voir l'installation dans README.md" >&2; exit 1; }
mkdir -p modeles sorties data

if [ ! -f "modeles/$NOM/config.json" ]; then
  .venv/bin/hf download "$BASE" --local-dir "modeles/$NOM"
fi

OPTIONS=()
if compgen -G "modeles/$NOM/*.py" > /dev/null; then
  if [ "${CODE_DISTANT:-}" = 1 ]; then
    OPTIONS+=(--code-distant)
  else
    echo "Le modèle livre son propre code Python :" >&2
    ls "modeles/$NOM"/*.py >&2
    echo "Relisez-le, puis relancez avec CODE_DISTANT=1." >&2
    exit 1
  fi
fi

if [ "${ESSAI:-}" = 1 ]; then
  DONNEES=data/essai.jsonl
  [ -f "$DONNEES" ] || "$PY" donnees.py --echelle 0.002 --sortie "$DONNEES"
  SORTIE=sorties/$NOM-essai
  OPTIONS+=(--max-exemples 40 --pas-max 3 --accum 4 --sauver-tous 3)
else
  DONNEES=data/melange.jsonl
  [ -f "$DONNEES" ] || "$PY" donnees.py --sortie "$DONNEES"
  SORTIE=sorties/$NOM-sft
fi

echo "== $(date -Is) recette $BASE → $SORTIE" | tee -a "$SORTIE.log"
"$PY" sft.py --modele "modeles/$NOM" --donnees "$DONNEES" --sortie "$SORTIE" "${OPTIONS[@]}" "$@" 2>&1 | tee -a "$SORTIE.log"
