#!/usr/bin/env bash
# La recette, à lancer sur la machine d'entraînement (CUDA) : même routine pour tout petit
# modèle de base, pour pouvoir les comparer.
#
#   ./recette.sh <org/modele-hugging-face> [nom] [options de sft.py…]
#
# 0. (avant, à part) générations vérifiées du modèle de base : generer.py puis selection.py
#    → data/auto/dpo.jsonl (et data/auto/sft.jsonl) — voir README
# 1. télécharge le modèle de base dans modeles/<nom> (s'il n'y est pas)
# 2. DPO sur le modèle de base → sorties/<nom>-dpo/ , points de contrôle tous les 50 pas
#    (à passer au banc rapide pendant que l'entraînement continue : banc/evaluer.sh)
#
# SORTIE_DPO=<nom> : dossier de sortie du DPO (défaut <nom>-dpo), par ex. pour un 2e tour de boucle
# SFT=1 : SFT avant le DPO (mélange data/melange.jsonl → sorties/<nom>-sft/). Mesuré nuisible sur
#         le premier modèle (63,6 → 47,0 %, et 61,2 après DPO, contre 66,8 pour le DPO seul) : gardé
#         pour d'autres données ou d'autres modèles.
#
# ESSAI=1        : 100 exemples, 3 pas — vérifie la chaîne (et que la perte n'est pas NaN)
# CODE_DISTANT=1 : autorise le code Python livré avec le modèle (trust_remote_code), à relire avant
set -euo pipefail
cd "$(dirname "$0")"
export PYTORCH_CUDA_ALLOC_CONF=${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}

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

[ -f data/auto/dpo.jsonl ] || { echo "Pas de data/auto/dpo.jsonl : faire l'étape 0 (generer.py puis selection.py)." >&2; exit 1; }
DEPART=modeles/$NOM
DPO_OPTIONS=()
[ "${ESSAI:-}" = 1 ] && DPO_OPTIONS+=(--max-paires 8 --pas-max 1 --accum 4)
if [ "${SFT:-}" = 1 ]; then
[ -f data/auto/sft.jsonl ] || echo "Attention : pas de data/auto/sft.jsonl (réponses vérifiées avec réflexion) : SFT sans elles." >&2
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

if [ ! -f "$SORTIE/modele/model.safetensors" ] || [ -n "${REFAIRE_SFT:-}" ]; then
  echo "== $(date -Is) SFT $BASE → $SORTIE" | tee -a "$SORTIE.log"
  "$PY" sft.py --modele "modeles/$NOM" --donnees "$DONNEES" --sortie "$SORTIE" "${OPTIONS[@]}" "$@" 2>&1 | tee -a "$SORTIE.log"
fi
DEPART=$SORTIE/modele
fi

DPO=sorties/${SORTIE_DPO:-$NOM-dpo}
[ "${ESSAI:-}" = 1 ] && DPO=sorties/$NOM-essai-dpo
[ "${SFT:-}" = 1 ] && DPO=$DPO-apres-sft
CODE=()
[ "${CODE_DISTANT:-}" = 1 ] && CODE=(--code-distant)
echo "== $(date -Is) DPO $DEPART → $DPO" | tee -a "$DPO.log"
"$PY" dpo.py --modele "$DEPART" --donnees data/auto/dpo.jsonl --sortie "$DPO" --sauver-tous "${SAUVER_TOUS:-50}" "${CODE[@]}" "${DPO_OPTIONS[@]}" 2>&1 | tee -a "$DPO.log"
