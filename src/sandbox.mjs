// Isoler le code que personne n'a relu. Un moteur ajouté avec l'accord de l'utilisateur (une PR
// de llama.cpp, un fork) se compile et tourne dans une bulle bubblewrap (bwrap, celui de
// Flatpak, sans droits administrateur) : le système en lecture seule, le dossier personnel
// invisible, /tmp vide, aucun réseau — le moteur écoute sur un socket Unix et Harn lui parle par
// un relais local. Il ne voit que ses propres fichiers, le modèle qu'il sert et la carte.
// Limite : la carte passe par le pilote NVIDIA, qui reste un point d'entrée ; une bulle n'est pas
// une machine virtuelle. Mais les fichiers, le disque et le réseau sont fermés.
import { execFile } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readlinkSync } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);
let available = null;

// Le système vu de la bulle : /usr et /etc en lecture seule, /bin, /lib… tels qu'ils sont ici
// (liens vers /usr sur les systèmes récents, dossiers sinon).
function systemArgs() {
  const args = ['--ro-bind', '/usr', '/usr', '--ro-bind', '/etc', '/etc', '--proc', '/proc', '--dev', '/dev', '--tmpfs', '/tmp'];
  for (const dir of ['/bin', '/sbin', '/lib', '/lib32', '/lib64']) {
    if (!existsSync(dir)) continue;
    if (lstatSync(dir).isSymbolicLink()) args.push('--symlink', readlinkSync(dir), dir);
    else args.push('--ro-bind', dir, dir);
  }
  return args;
}

// Vérifié une fois au démarrage : bwrap présent, et les espaces de noms utilisateur permis.
export async function sandboxAvailable() {
  if (available !== null) return available;
  if (process.platform !== 'linux') return (available = false);
  try {
    await run('bwrap', [...systemArgs(), '--unshare-all', '--die-with-parent', '/bin/true'], { timeout: 10_000 });
    available = true;
  } catch {
    available = false;
  }
  return available;
}
export const sandboxReady = () => available === true;
export const SANDBOX_INSTALL = 'sudo apt install bubblewrap';

// readable / writable : chemins visibles dans la bulle (lecture seule / lecture-écriture).
// gpu : la carte NVIDIA (et /sys, que CUDA lit pour la trouver).
export function sandboxed(command, args, { readable = [], writable = [], gpu = false, cwd = null } = {}) {
  const box = [...systemArgs(), '--unshare-all', '--die-with-parent', '--new-session', '--setenv', 'HOME', '/tmp'];
  if (gpu) {
    box.push('--ro-bind', '/sys', '/sys');
    for (const name of readdirSync('/dev').filter((n) => n.startsWith('nvidia'))) box.push('--dev-bind', `/dev/${name}`, `/dev/${name}`);
    if (existsSync('/dev/dri')) box.push('--dev-bind', '/dev/dri', '/dev/dri');
  }
  for (const target of [...new Set(readable.filter(Boolean))]) box.push('--ro-bind', target, target);
  for (const target of [...new Set(writable.filter(Boolean))]) box.push('--bind', target, target);
  if (cwd) box.push('--chdir', cwd);
  return { command: 'bwrap', args: [...box, command, ...args] };
}
