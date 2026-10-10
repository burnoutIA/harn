#!/usr/bin/env bash
# Harn : un lancement suffit. Node.js est la seule dependance ; il est installe s'il manque,
# dans ~/.local/node (sans sudo), depuis nodejs.org avec verification SHA-256.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
export PATH="$HOME/.local/node/bin:$PATH"

# Nautilus ouvre les .sh dans l'editeur au lieu de les lancer : on ajoute Harn, « Harn - arreter »
# et « Harn - installer » au menu des applications (lanceurs .desktop, dans un terminal).
install_launchers() {
  local root apps icons
  root=$(pwd)
  apps="$HOME/.local/share/applications"
  icons="$HOME/.local/share/icons/hicolor/scalable/apps"
  mkdir -p "$apps" "$icons"
  cat > "$icons/harn.svg" <<'SVG'
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="9" fill="#0b0d10"/><path d="M9 23V9m0 7h14m0-7v14" stroke="#3ddc97" stroke-width="3.2" stroke-linecap="round"/></svg>
SVG
  launcher() { # fichier, nom, script, description
    cat > "$apps/$1.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=$2
Comment=$4
Exec="$root/$3"
Path=$root
Icon=harn
Terminal=true
Categories=Development;
DESKTOP
  }
  launcher harn 'Harn' Harn-start.sh 'Lancer ou relancer Harn, l’IA locale'
  launcher harn-stop 'Harn - arrêter' Harn-stop.sh 'Arrêter Harn proprement, moteur compris'
  launcher harn-install 'Harn - installer' Harn-install.sh 'Premier lancement de Harn : installe Node.js si besoin'
  update-desktop-database "$apps" >/dev/null 2>&1 || true
}
install_launchers
if [ "${1:-}" = "--lanceurs" ]; then
  echo " Lanceurs ajoutés au menu des applications : Harn, Harn - arrêter, Harn - installer."
  exit 0
fi

# La fenetre du terminal se ferme a la sortie : on laisse lire l'erreur.
trap 'status=$?; if [ $status -ne 0 ] && [ -t 0 ]; then read -r -n 1 -s -p " Appuyez sur une touche pour fermer..."; echo; fi' EXIT

node_ok() {
  command -v node >/dev/null 2>&1 &&
    node -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit(a>22||(a===22&&b>=19)?0:1)"
}

if ! node_ok; then
  echo " Installation de Node.js (une seule fois)..."
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64|arm64) arch=arm64 ;;
    *) echo " Architecture $(uname -m) non prise en charge : installez Node.js 22.19+ (https://nodejs.org)"; exit 1 ;;
  esac
  base=https://nodejs.org/dist/latest-v22.x
  tmp=$(mktemp -d)
  fetch() { if command -v curl >/dev/null 2>&1; then curl -fsSL -o "$2" "$1"; else wget -qO "$2" "$1"; fi; }
  fetch "$base/SHASUMS256.txt" "$tmp/SHASUMS256.txt"
  file=$(grep -o "node-v22[0-9.]*-linux-$arch\.tar\.xz" "$tmp/SHASUMS256.txt" | head -1)
  fetch "$base/$file" "$tmp/$file"
  (cd "$tmp" && grep " $file\$" SHASUMS256.txt | sha256sum -c --quiet -)
  rm -rf "$HOME/.local/node" && mkdir -p "$HOME/.local/node"
  tar -xJf "$tmp/$file" -C "$HOME/.local/node" --strip-components=1
  grep -qs '.local/node/bin' "$HOME/.bashrc" || echo 'export PATH="$HOME/.local/node/bin:$PATH"' >> "$HOME/.bashrc"
  rm -rf "$tmp"
  echo " Node.js $(node -v) installe dans ~/.local/node"
fi

# Les grands MoE (Strata) ont besoin de Python 3.10+ avec venv ; Debian/Ubuntu le livrent sans
# (paquet python3-venv). Il faut sudo : Harn ne le fera pas seul, on le propose ici, une fois.
# Seulement avec une NVIDIA d'au moins 12 Go, la condition de Strata.
python_ok() {
  for c in python3 python; do
    command -v $c >/dev/null 2>&1 &&
      $c -c 'import sys, venv, ensurepip; sys.exit(0 if sys.version_info >= (3, 10) else 1)' 2>/dev/null && return 0
  done
  return 1
}
vram=$(nvidia-smi --query-gpu=memory.total --format=csv,noheader,nounits 2>/dev/null | sort -n | tail -1 || true)
if [ "${vram:-0}" -ge 11500 ] 2>/dev/null && ! python_ok; then
  echo " Les grands MoE (Strata) demandent Python avec venv : sudo apt install python3-venv"
  if command -v apt-get >/dev/null 2>&1 && [ -t 0 ]; then
    read -r -p " L'installer maintenant (mot de passe sudo) ? [o/N] " answer
    case "$answer" in
      [oOyY]*) sudo apt-get install -y python3 python3-venv python3-pip || echo " Échec : Harn indiquera quoi faire." ;;
      *) echo " Plus tard : Harn le rappellera dans ses vérifications." ;;
    esac
  fi
fi

node src/main.mjs "$@"
