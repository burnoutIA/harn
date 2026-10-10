#!/usr/bin/env bash
# Fermer Harn : arret propre (moteur compris). Si quelque chose est en cours
# (installation, banc, reponse...), la liste s'affiche et on peut arreter quand meme ou renoncer.
cd "$(dirname "$(readlink -f "$0")")" || exit 1
export PATH="$HOME/.local/node/bin:$PATH"
pause() { [ -t 0 ] && read -r -n 1 -s -p " Appuyez sur une touche pour fermer..." && echo; }

if ! command -v node >/dev/null 2>&1; then
  echo " Node.js est introuvable : Harn ne peut pas tourner sur cette machine."
  pause
  exit 1
fi

node src/ctl.mjs stop && { sleep 3; exit 0; }

echo
read -r -n 1 -p " Arreter quand meme ? [O]ui / [N]on : " answer
echo
case "$answer" in
  [oO]) node src/ctl.mjs stop --force || { pause; exit 1; } ;;
  *) exit 1 ;;
esac
