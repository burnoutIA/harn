import { execFile } from 'node:child_process';
import { link, mkdir, readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { DIRS } from './paths.mjs';

const run = promisify(execFile);

// Avant de télécharger des dizaines de gigaoctets, Harn regarde si le fichier est déjà sur la
// machine : même nom, même taille (à 2 % près, les tailles du catalogue sont arrondies). Il
// cherche dans les endroits habituels (LM Studio, cache Hugging Face, llama.cpp, Documents,
// Téléchargements) puis à la racine de chaque disque fixe, en profondeur limitée et en temps borné.

const SKIP = new Set(['windows', 'program files', 'program files (x86)', 'programdata', '$recycle.bin', 'system volume information', 'node_modules', '.git', 'appdata', 'recovery', 'perflogs', 'msocache']);

async function fixedDrives() {
  if (process.platform !== 'win32') return ['/'];
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3").DeviceID -join ","'], { windowsHide: true, timeout: 10_000 }).catch(() => ({ stdout: 'C:' }));
  return stdout.trim().split(',').filter(Boolean).map((drive) => `${drive}\\`);
}

function usualPlaces() {
  const home = os.homedir();
  return [
    DIRS.models,
    path.join(home, '.lmstudio', 'models'),
    path.join(home, '.cache', 'lm-studio', 'models'),
    path.join(home, '.cache', 'huggingface', 'hub'),
    path.join(process.env.LOCALAPPDATA ?? home, 'llama.cpp'),
    path.join(home, 'Documents'),
    path.join(home, 'Downloads'),
  ];
}

const close = (size, expected) => !expected || Math.abs(size - expected) / expected < 0.02;

// Cherche chaque fichier demandé ; rend { nom → chemin complet } pour ceux trouvés.
export async function findLocalCopies(files, { timeBudgetMs = 15_000, depth = 5 } = {}) {
  const wanted = new Map(files.map((file) => [file.name.split('/').pop().toLowerCase(), file]));
  const found = {};
  const deadline = Date.now() + timeBudgetMs;
  const roots = [...usualPlaces().map((dir) => [dir, depth + 2]), ...(await fixedDrives()).map((drive) => [drive, depth])];
  const seen = new Set();
  const queue = [...roots];
  while (queue.length && Object.keys(found).length < wanted.size && Date.now() < deadline) {
    const [dir, left] = queue.shift();
    const key = dir.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (left > 0 && !SKIP.has(entry.name.toLowerCase())) queue.push([full, left - 1]);
        continue;
      }
      const file = wanted.get(entry.name.toLowerCase());
      if (!file || found[file.name]) continue;
      // Les caches (Hugging Face) pointent vers leurs blobs par des liens : stat les suit.
      const info = await stat(full).catch(() => null);
      if (info?.isFile() && close(info.size, file.bytes)) found[file.name] = full;
    }
  }
  return found;
}

// Rend un fichier local utilisable dans models/<id>/ sans le copier : un lien physique quand
// il est sur le même disque, sinon on garde son chemin d'origine.
export async function adoptLocalCopy(source, dest) {
  await mkdir(path.dirname(dest), { recursive: true });
  if (path.parse(source).root.toLowerCase() === path.parse(dest).root.toLowerCase()) {
    const ok = await link(source, dest).then(() => true).catch((error) => error.code === 'EEXIST');
    if (ok) return dest;
  }
  return source;
}
