import { execFile } from 'node:child_process';
import { mkdir, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { download } from './download.mjs';
import { DIRS } from './paths.mjs';
import { getState, update } from './state.mjs';

const run = promisify(execFile);

// Deux sources de binaires llama.cpp : l'officiel (Qwen3.8, MTP, vision) et le fork Prism,
// seul à lire les packs ternaires de Bonsai. Même nommage d'assets, même installation.
const SOURCES = {
  llama: { repo: 'ggml-org/llama.cpp', tag: /^b\d+$/ },
  prism: { repo: 'PrismML-Eng/llama.cpp', tag: /^prism-/ },
};

// Motif de l'asset Windows selon le backend choisi par le planificateur.
const ASSET = {
  cuda13: /-bin-win-cuda-13\.\d+-x64\.zip$/,
  cuda12: /-bin-win-cuda-12\.\d+-x64\.zip$/,
  vulkan: /-bin-win-vulkan-x64\.zip$/,
  cpu: /-bin-win-cpu-x64\.zip$/,
  // Radeon RDNA 3/4 sous Windows : build HIP officiel (« rocm ») ou Prism (« hip-radeon »).
  hip: /-bin-win-(rocm-[\d.]+|hip-radeon)-x64\.zip$/,
};
const CUDART = { cuda13: /^cudart-llama-bin-win-cuda-13\.\d+-x64\.zip$/, cuda12: /^cudart-llama-bin-win-cuda-12\.\d+-x64\.zip$/ };

// L'empreinte que GitHub calcule pour chaque fichier publié (« sha256:… »). Les releases d'avant
// mi-2025 n'en ont pas : le binaire est alors installé sans vérification, et l'état le note.
const assetSha = (asset) => (/^sha256:[0-9a-f]{64}$/i.test(asset.digest ?? '') ? asset.digest.slice(7).toLowerCase() : null);

async function latestRelease(source) {
  const response = await fetch(`https://api.github.com/repos/${source.repo}/releases?per_page=15`, {
    headers: { 'User-Agent': 'harn', Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GitHub ne répond pas (${response.status})`);
  const releases = await response.json();
  // Le dernier build qui publie vraiment des binaires Windows (certaines releases n'en ont pas).
  const release = releases.find((item) => source.tag.test(item.tag_name) && item.assets.some((asset) => /-bin-win-/.test(asset.name)));
  if (!release) throw new Error(`Aucun binaire Windows publié sur ${source.repo}`);
  return release;
}

// Extraction sans dépendance : tar.exe (bsdtar) est livré avec Windows 10 et 11. Chemin
// complet obligatoire : le tar GNU de Git, souvent premier dans le PATH, lit « C: » comme un
// hôte distant et ne sait pas ouvrir un zip.
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
async function extract(zip, target) {
  await mkdir(target, { recursive: true });
  await run(TAR, ['-xf', zip, '-C', target], { windowsHide: true, timeout: 300_000 });
}

// Les archives récentes rangent parfois tout dans un sous-dossier : on cherche llama-server.
async function findServerDir(root) {
  const exe = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  if (await stat(path.join(root, exe)).catch(() => null)) return root;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      const found = await findServerDir(path.join(root, entry.name)).catch(() => null);
      if (found) return found;
    }
  }
  return null;
}

export async function installLlama(kind, backend) {
  const runtimeId = `${kind}-${backend}`;
  const existing = getState().runtimes[runtimeId];
  if (existing && await stat(existing.serverPath).catch(() => null)) return existing;

  const source = SOURCES[kind];
  const release = await latestRelease(source);
  // « cudart-llama-bin-win-cuda-… » a le même suffixe que le moteur : on l'écarte ici.
  const asset = release.assets.find((item) => !item.name.startsWith('cudart-') && ASSET[backend].test(item.name));
  if (!asset) throw new Error(`Pas de build ${backend} dans ${source.repo} ${release.tag_name}`);
  const target = path.join(DIRS.runtime, kind, `${release.tag_name}-${backend}`);

  const zip = await download({
    id: `runtime:${runtimeId}`,
    label: `Moteur ${kind === 'prism' ? 'llama.cpp Prism' : 'llama.cpp'} ${release.tag_name} (${backend})`,
    url: asset.browser_download_url,
    dest: path.join(DIRS.downloads, asset.name),
    expectedBytes: asset.size,
    sha256: assetSha(asset),
  });
  await extract(zip, target);

  // Les DLL CUDA (cudart, cublas) sont livrées à part : sans elles, llama-server ne démarre pas.
  if (CUDART[backend]) {
    const runtimeAsset = release.assets.find((item) => CUDART[backend].test(item.name));
    if (runtimeAsset) {
      const cudart = await download({
        id: `runtime:${runtimeId}:cudart`,
        label: `Bibliothèques CUDA (${runtimeAsset.name.match(/cuda-[\d.]+/)?.[0]})`,
        url: runtimeAsset.browser_download_url,
        dest: path.join(DIRS.downloads, runtimeAsset.name),
        expectedBytes: runtimeAsset.size,
        sha256: assetSha(runtimeAsset),
      });
      const serverDir = await findServerDir(target);
      await extract(cudart, serverDir ?? target);
    }
  }

  const serverDir = await findServerDir(target);
  if (!serverDir) throw new Error('llama-server introuvable dans l’archive');
  const serverPath = path.join(serverDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  const { stdout, stderr } = await run(serverPath, ['--version'], { windowsHide: true, timeout: 30_000 }).catch((error) => error);
  const version = `${stdout ?? ''}${stderr ?? ''}`.match(/version:\s*(\S+)/)?.[1] ?? release.tag_name;
  const info = { kind, backend, tag: release.tag_name, version, dir: serverDir, serverPath, verified: Boolean(assetSha(asset)), installedAt: new Date().toISOString() };
  update((s) => { s.runtimes[runtimeId] = info; });
  return info;
}

// ketch : recherche web, docs de librairies, code open source et extraction de pages, en un
// binaire Go sans clé API. pi s'en sert comme serveur MCP (voir pi.mjs).
export async function installKetch() {
  const existing = getState().ketch;
  if (existing?.path && await stat(existing.path).catch(() => null)) return existing;
  const response = await fetch('https://api.github.com/repos/1broseidon/ketch/releases/latest', {
    headers: { 'User-Agent': 'harn', Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GitHub ne répond pas (${response.status})`);
  const release = await response.json();
  const asset = release.assets.find((item) => /windows_x86_64\.zip$/.test(item.name));
  if (!asset) throw new Error('Pas de build Windows de ketch');
  const zip = await download({
    id: 'runtime:ketch',
    label: `Recherche web ketch ${release.tag_name}`,
    url: asset.browser_download_url,
    dest: path.join(DIRS.downloads, asset.name),
    expectedBytes: asset.size,
    sha256: assetSha(asset),
  });
  const dir = path.join(DIRS.runtime, 'ketch');
  await extract(zip, dir);
  const exe = path.join(dir, process.platform === 'win32' ? 'ketch.exe' : 'ketch');
  const { stdout } = await run(exe, ['version'], { windowsHide: true, timeout: 20_000 });
  const info = { path: exe, version: stdout.match(/v[\d.]+/)?.[0] ?? release.tag_name, installedAt: new Date().toISOString() };
  update((s) => { s.ketch = info; });
  return info;
}

// Strata : dépôt GitHub + son propre installeur, piloté sans questions (--yes). Il gère seul
// Python, son moteur et le téléchargement du modèle dans Strata-data.
// Version figée sur un commit : Harn exécute son code Python, il ne doit pas suivre la branche
// main les yeux fermés. Monter de version = changer ce commit après l'avoir relu et essayé.
// (Pas d'empreinte de l'archive : GitHub ne garantit pas qu'un zip régénéré reste identique ;
// l'identifiant de commit, lui, désigne un contenu unique.)
const STRATA_COMMIT = '6f32ec070f23ced9f50e704d854d775da52591ab';

export async function installStrata(model, contextSize, onLog = () => {}, { ggufDir = null } = {}) {
  const dir = path.join(DIRS.runtime, 'strata');
  const repoDir = path.join(dir, 'Strata-main');
  if (!(await stat(path.join(repoDir, 'START-HERE.bat')).catch(() => null))) {
    const zip = await download({
      id: 'runtime:strata',
      label: `Strata (runtime MoE, ${STRATA_COMMIT.slice(0, 7)})`,
      url: `https://github.com/Niko1221/Strata/archive/${STRATA_COMMIT}.zip`,
      dest: path.join(DIRS.downloads, `strata-${STRATA_COMMIT.slice(0, 7)}.zip`),
    });
    // L'archive d'un commit se déplie dans Strata-<commit> : ramenée au nom attendu partout.
    const unpacked = path.join(dir, `Strata-${STRATA_COMMIT}`);
    await rm(repoDir, { recursive: true, force: true });
    await rm(unpacked, { recursive: true, force: true });
    await extract(zip, dir);
    await rename(unpacked, repoDir);
  }
  const args = [
    '--setup', '--family', 'swift', '--model', model.strataModel, '--context', String(contextSize),
    '--vision', 'cpu', '--data-dir', path.join(DIRS.models, 'strata-data'), '--yes', '--no-start', '--no-browser',
    // Fichiers déjà présents sur la machine : Strata les utilise au lieu de retélécharger 70 Go.
    ...(ggufDir ? ['--gguf-dir', ggufDir] : []),
  ];
  onLog(`START-HERE.bat ${args.join(' ')}`);
  await new Promise((resolve, reject) => {
    // Chemin complet : avec NoDefaultCurrentDirectoryInExePath (postes durcis), cmd ne lance
    // pas un script du dossier courant par son seul nom.
    const child = execFile('cmd.exe', ['/c', path.join(repoDir, 'START-HERE.bat'), ...args], { cwd: repoDir, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    // Sans console, le « pause » de START-HERE.bat attendrait une touche pour toujours : on ferme son entrée.
    child.stdin.end();
    child.stdout.on('data', (chunk) => onLog(String(chunk)));
    child.stderr.on('data', (chunk) => onLog(String(chunk)));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`L’installeur de Strata s’est arrêté (code ${code})`))));
  });
  const config = (await readdir(repoDir)).find((name) => name.startsWith('strata-swift') && name.endsWith('.json') && name.toLowerCase().includes(model.strataModel.toLowerCase()));
  const info = { kind: 'strata', commit: STRATA_COMMIT, dir: repoDir, config, python: path.join(repoDir, '.venv', 'Scripts', 'python.exe'), installedAt: new Date().toISOString() };
  update((s) => { s.runtimes[`strata-${model.strataModel}`] = info; });
  return info;
}
