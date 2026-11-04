#!/usr/bin/env bash
# Échanges entre le PC de mesure (R9700) et le PC d'entraînement (3090), à lancer depuis le
# PC de mesure. Réseau (ssh + rsync) par défaut ; clé USB quand les données sont trop lourdes.
#
# Réglage une fois : copier machines.env.exemple en machines.env (non suivi par git).
#
#   ./pc.sh envoyer              code + data/ → PC d'entraînement
#   ./pc.sh lancer <recette…>    lance ./recette.sh là-bas en arrière-plan (survit à la coupure ssh)
#   ./pc.sh suivre               affiche le journal en direct
#   ./pc.sh etat                 dernier pas de chaque entraînement + mémoire de la carte
#   ./pc.sh recuperer [nom]      sorties/ (modèles entraînés, journaux) → ici
#   ./pc.sh usb-export <point>   data/ → clé USB          (à brancher ensuite sur l'autre PC)
#   ./pc.sh usb-import <point>   sorties/ de la clé → ici
# Sur le PC d'entraînement, l'équivalent USB : rsync -a <clé>/training/data/ data/  puis, après
# l'entraînement, rsync -a sorties/ <clé>/training/sorties/
set -euo pipefail
cd "$(dirname "$0")"
[ -f machines.env ] && . ./machines.env

distant() {
  : "${ENTRAINEMENT:?renseigner ENTRAINEMENT dans machines.env (copie de machines.env.exemple)}"
}
DIST=${DOSSIER_DISTANT:-harn/training}
EXCLUS=(--exclude .venv --exclude modeles --exclude sorties --exclude __pycache__ --exclude machines.env --exclude banc/resultats)

cmd=${1:-aide}
[ $# -gt 0 ] && shift
case "$cmd" in
  envoyer)
    distant
    rsync -a --info=progress2 "${EXCLUS[@]}" ./ "$ENTRAINEMENT:$DIST/"
    ;;
  lancer)
    distant
    [ $# -gt 0 ] || { echo "usage : ./pc.sh lancer <org/modele> [nom] [options]" >&2; exit 1; }
    args=$(printf '%q ' "$@")
    env_distant=""
    [ -n "${ESSAI:-}" ] && env_distant+="ESSAI=$ESSAI "
    [ -n "${CODE_DISTANT:-}" ] && env_distant+="CODE_DISTANT=$CODE_DISTANT "
    ssh "$ENTRAINEMENT" "cd $DIST && mkdir -p sorties && $env_distant setsid nohup ./recette.sh $args > sorties/lancement.log 2>&1 < /dev/null & echo lancé"
    ;;
  suivre)
    distant
    ssh -t "$ENTRAINEMENT" "cd $DIST && tail -n 30 -F sorties/lancement.log"
    ;;
  etat)
    distant
    ssh "$ENTRAINEMENT" "cd $DIST && for j in sorties/*/journal.jsonl; do [ -f \"\$j\" ] && echo \"\$j : \$(tail -n 1 \"\$j\")\"; done; nvidia-smi --query-gpu=name,memory.used,memory.total,utilization.gpu --format=csv,noheader 2>/dev/null || true"
    ;;
  recuperer)
    distant
    rsync -a --info=progress2 "$ENTRAINEMENT:$DIST/sorties/${1:-}" "sorties/"
    ;;
  usb-export)
    cle=${1:?usage : ./pc.sh usb-export <point de montage de la clé>}
    mkdir -p "$cle/training"
    rsync -a --info=progress2 "${EXCLUS[@]}" ./ "$cle/training/"
    ;;
  usb-import)
    cle=${1:?usage : ./pc.sh usb-import <point de montage de la clé>}
    rsync -a --info=progress2 "$cle/training/sorties/" sorties/
    ;;
  *)
    sed -n '2,17p' "$0"
    ;;
esac
