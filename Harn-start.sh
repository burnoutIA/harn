#!/usr/bin/env bash
# Harn en une commande : lance l'application, ou la relance proprement si elle tourne deja
# (rien n'est coupe si une installation, un banc ou une reponse est en cours).
cd "$(dirname "$(readlink -f "$0")")" || exit 1
export PATH="$HOME/.local/node/bin:$PATH"
pause() { [ -t 0 ] && read -r -n 1 -s -p " Appuyez sur une touche pour fermer..." && echo; }

if ! command -v node >/dev/null 2>&1; then
  echo " Node.js est introuvable : lancez d'abord ./Harn-install.sh"
  pause
  exit 1
fi

node src/ctl.mjs restart --open "$@" || { pause; exit 1; }
