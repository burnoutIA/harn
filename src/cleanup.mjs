import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { requestApproval } from './approvals.mjs';
import { imagePathsInUse } from './images.mjs';
import { DIRS } from './paths.mjs';
import { bus, getState, update } from './state.mjs';

// Le ménage de models/ : au démarrage, les fichiers qu'aucun modèle ne réclame (copies laissées à
// la racine, doublons, modèles d'images jamais installés, restes d'essais) sont proposés à la
// suppression par une demande dans la fenêtre. Rien ne part sans le clic de l'utilisateur ; une
// liste refusée n'est plus reproposée, seuls de nouveaux fichiers en trop relancent la question.

// Ce qui sert : le dossier de chaque modèle connu de l'état (installé, en cours, ou en échec qu'on
// relancera), les copies reprises ailleurs, Strata, et les modèles d'images connus.
function inUse() {
  const state = getState();
  const keep = [path.join(DIRS.models, 'strata-data')];
  for (const [id, entry] of Object.entries(state.models ?? {})) {
    keep.push(path.join(DIRS.models, id), ...Object.values(entry.paths ?? {}));
  }
  keep.push(...imagePathsInUse());
  return keep.map((p) => path.resolve(p));
}
const covered = (file, keep) => keep.some((p) => file === p || file.startsWith(p + path.sep));

// Les fichiers en trop sous models/, avec la place qu'ils libèrent vraiment : un lien physique
// vers un fichier gardé ne libère rien, et deux liens en trop vers le même fichier comptent une fois.
export async function findUnusedModelFiles() {
  const keep = inUse();
  const entries = await readdir(DIRS.models, { recursive: true, withFileTypes: true }).catch(() => []);
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const full = path.resolve(entry.parentPath ?? entry.path, entry.name);
    if (covered(full, keep)) continue;
    const info = await stat(full).catch(() => null);
    if (info) files.push({ path: full, bytes: info.size, inode: info.ino, links: info.nlink });
  }
  return { files, freedBytes: freedBy(files) };
}
function freedBy(files) {
  const listed = new Map();
  for (const file of files) listed.set(file.inode, (listed.get(file.inode) ?? 0) + 1);
  const counted = new Set();
  let total = 0;
  for (const file of files) {
    if (counted.has(file.inode) || file.links > listed.get(file.inode)) continue;
    counted.add(file.inode);
    total += file.bytes;
  }
  return total;
}

const gb = (bytes) => `${(bytes / 1e9).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Go`;
const relative = (p) => path.relative(DIRS.models, p);

// Supprime les fichiers proposés qui sont toujours en trop (un modèle a pu les reprendre depuis),
// puis les dossiers restés vides.
export async function removeUnusedModelFiles(paths) {
  const wanted = new Set(paths);
  const targets = (await findUnusedModelFiles()).files.filter((file) => wanted.has(file.path));
  const freedBytes = freedBy(targets);
  for (const target of targets) await rm(target.path, { force: true });
  for (const dir of [...new Set(targets.map((file) => path.dirname(file.path)))].sort((a, b) => b.length - a.length)) {
    for (let d = dir; d.startsWith(DIRS.models + path.sep); d = path.dirname(d)) {
      if (await rmdir(d).then(() => false, () => true)) break;
    }
  }
  return { removed: targets.length, freedBytes };
}

export async function proposeCleanup() {
  const state = getState();
  const { files, freedBytes } = await findUnusedModelFiles();
  const refused = new Set(state.cleanupRefused ?? []);
  if (!files.length || files.every((file) => refused.has(file.path))) return null;
  const paths = files.map((file) => file.path);
  const shown = files.slice(0, 8).map((file) => `${relative(file.path)} (${gb(file.bytes)})`).join(' · ');
  const more = files.length > 8 ? ` · et ${files.length - 8} autre${files.length > 9 ? 's' : ''}` : '';
  return requestApproval({
    kind: 'cleanup',
    title: `Supprimer ${files.length} fichier${files.length > 1 ? 's' : ''} de modèles inutilisé${files.length > 1 ? 's' : ''}${freedBytes ? ` (${gb(freedBytes)} libérés)` : ''} ?`,
    detail: `Aucun modèle installé dans Harn ne s’en sert : ${shown}${more}.${freedBytes ? '' : ' Ce sont des doublons d’un fichier gardé : la suppression range le dossier sans libérer de place.'}`,
    run: () => {
      update((s) => { s.cleanupRefused = []; });
      removeUnusedModelFiles(paths)
        .then(({ removed, freedBytes: freed }) => bus.emit('toast', `Ménage fait : ${removed} fichier${removed > 1 ? 's' : ''} supprimé${removed > 1 ? 's' : ''}, ${gb(freed)} libérés`))
        .catch((error) => bus.emit('toast', `Ménage interrompu : ${error.message}`));
    },
    refuse: () => update((s) => { s.cleanupRefused = paths; }),
  });
}
