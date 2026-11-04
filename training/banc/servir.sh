#!/usr/bin/env bash
# Sert un GGUF avec llama-server (Vulkan) pour le banc, sur la carte choisie par son NOM :
# l'ordre Vulkan0/Vulkan1 peut changer d'un démarrage à l'autre.
#   CARTE=R9700 PARALLELE=4 LLAMA=<dossier de llama-server> ./servir.sh <modele.gguf> [port] [contexte]
# Le contexte est partagé entre les requêtes parallèles (PARALLELE × ~10k pour le banc).
set -euo pipefail
GGUF=${1:?usage : ./servir.sh <modele.gguf> [port] [contexte]}
PORT=${2:-4760}
CTX=${3:-65536}
LLAMA=${LLAMA:-$(dirname "$0")/../../runtime/llama/b12064-vulkan/llama-b12064}
export LD_LIBRARY_PATH=$LLAMA GGML_VK_ALLOW_GRAPHICS_QUEUE=1
DEV=$("$LLAMA/llama-server" --list-devices 2>/dev/null | grep -i "${CARTE:-R9700}" | head -1 | sed -E 's/^ *([A-Za-z]+[0-9]+):.*/\1/')
[ -n "$DEV" ] || { echo "Carte « ${CARTE:-R9700} » introuvable :" >&2; "$LLAMA/llama-server" --list-devices >&2; exit 1; }
echo "carte : $DEV" >&2
exec "$LLAMA/llama-server" -m "$GGUF" -ngl 99 -dev "$DEV" -fa on -c "$CTX" --parallel "${PARALLELE:-4}" --jinja --host 127.0.0.1 --port "$PORT"
