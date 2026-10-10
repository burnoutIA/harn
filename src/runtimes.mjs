import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { download } from './download.mjs';
import { linuxPython } from './hardware.mjs';
import { DIRS } from './paths.mjs';
import { getState, update } from './state.mjs';

const run = promisify(execFile);

// Deux sources de binaires llama.cpp : l'officiel (Qwen3.8, MTP, vision) et le fork Prism,
// seul à lire les packs ternaires de Bonsai. Même nommage d'assets, même installation.
const SOURCES = {
  llama: { repo: 'ggml-org/llama.cpp', tag: /^b\d+$/ },
  prism: { repo: 'PrismML-Eng/llama.cpp', tag: /^prism-/ },
};

// Motif de l'asset selon le système et le backend choisi par le planificateur. Sous Linux,
// l'officiel publie « ubuntu-… », Prism « linux-cuda-… » pour CUDA et « ubuntu-… » pour le reste.
const LINUX = process.platform === 'linux';
const ASSET = LINUX ? {
  cuda13: /-bin-(?:ubuntu|linux)-cuda-13\.\d+-x64\.tar\.gz$/,
  cuda12: /-bin-(?:ubuntu|linux)-cuda-12\.\d+-x64\.tar\.gz$/,
  vulkan: /-bin-ubuntu-vulkan-x64\.tar\.gz$/,
  cpu: /-bin-ubuntu-x64\.tar\.gz$/,
  hip: /-bin-ubuntu-rocm-[\d.]+-x64\.tar\.gz$/,
} : {
  cuda13: /-bin-win-cuda-13\.\d+-x64\.zip$/,
  cuda12: /-bin-win-cuda-12\.\d+-x64\.zip$/,
  vulkan: /-bin-win-vulkan-x64\.zip$/,
  cpu: /-bin-win-cpu-x64\.zip$/,
  // Radeon RDNA 3/4 sous Windows : build HIP officiel (« rocm ») ou Prism (« hip-radeon »).
  hip: /-bin-win-(rocm-[\d.]+|hip-radeon)-x64\.zip$/,
};
const PLATFORM_ASSET = LINUX ? /-bin-(?:ubuntu|linux)-.*x64\.tar\.gz$/ : /-bin-win-/;
// Les bibliothèques CUDA (cudart, cublas), livrées à part. Sous Linux, le build CUDA de Prism
// les embarque déjà ; l'officiel publie un « cudart-llama-<tag>-bin-ubuntu-cuda-… » par release.
const CUDART = LINUX
  ? { cuda13: /^cudart-llama-.*-bin-ubuntu-cuda-13\.\d+-x64\.tar\.gz$/, cuda12: /^cudart-llama-.*-bin-ubuntu-cuda-12\.\d+-x64\.tar\.gz$/ }
  : { cuda13: /^cudart-llama-bin-win-cuda-13\.\d+-x64\.zip$/, cuda12: /^cudart-llama-bin-win-cuda-12\.\d+-x64\.zip$/ };

// Plusieurs builds CUDA 12 possibles (Prism Linux : 12.4 et 12.8) : le plus récent.
const cudaOf = (name) => Number.parseFloat(name.match(/cuda-(\d+\.\d+)/)?.[1] ?? '0');
const newest = (assets) => [...assets].sort((a, b) => cudaOf(b.name) - cudaOf(a.name))[0];

// L'empreinte que GitHub calcule pour chaque fichier publié (« sha256:… »). Les releases d'avant
// mi-2025 n'en ont pas : le binaire est alors installé sans vérification, et l'état le note.
const assetSha = (asset) => (/^sha256:[0-9a-f]{64}$/i.test(asset.digest ?? '') ? asset.digest.slice(7).toLowerCase() : null);

export async function latestRelease(source) {
  const response = await fetch(`https://api.github.com/repos/${source.repo}/releases?per_page=15`, {
    headers: { 'User-Agent': 'harn', Accept: 'application/vnd.github+json' },
  });
  if (!response.ok) throw new Error(`GitHub ne répond pas (${response.status})`);
  const releases = await response.json();
  // Le dernier build qui publie vraiment des binaires pour ce système (certaines releases n'en ont pas).
  const release = releases.find((item) => source.tag.test(item.tag_name) && item.assets.some((asset) => PLATFORM_ASSET.test(asset.name)));
  if (!release) throw new Error(`Aucun binaire ${LINUX ? 'Linux' : 'Windows'} publié sur ${source.repo}`);
  return release;
}

// Extraction sans dépendance : tar.exe (bsdtar) est livré avec Windows 10 et 11, tar partout ailleurs. Chemin
// complet obligatoire : le tar GNU de Git, souvent premier dans le PATH, lit « C: » comme un
// hôte distant et ne sait pas ouvrir un zip.
const TAR = process.platform === 'win32' ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';
export async function extract(zip, target) {
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

// Sous Linux, les bibliothèques livrées avec le moteur (libggml-*, cudart, cublas) sont à côté
// de llama-server : on les rend visibles au chargeur, la machine n'a pas forcément CUDA.
export function engineEnv(dir) {
  if (process.platform !== 'linux') return process.env;
  return { ...process.env, LD_LIBRARY_PATH: [dir, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
}

// refresh : passer à la dernière version publiée (une architecture récente l'exige). Les
// fichiers de l'ancienne restent dans leur dossier, rien n'est écrasé.
export async function installLlama(kind, backend, { refresh = false } = {}) {
  const runtimeId = `${kind}-${backend}`;
  const existing = getState().runtimes[runtimeId];
  const present = existing && await stat(existing.serverPath).catch(() => null);
  if (present && !refresh) return existing;

  const source = SOURCES[kind];
  const release = await latestRelease(source);
  if (present && existing.tag === release.tag_name) return existing;
  // « cudart-llama-bin-win-cuda-… » a le même suffixe que le moteur : on l'écarte ici.
  const asset = newest(release.assets.filter((item) => !item.name.startsWith('cudart-') && ASSET[backend].test(item.name)));
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
    const runtimeAsset = newest(release.assets.filter((item) => CUDART[backend].test(item.name)));
    if (runtimeAsset) {
      const cudart = await download({
        id: `runtime:${runtimeId}:cudart`,
        label: `Bibliothèques CUDA (${runtimeAsset.name.match(/cuda-[\d.]+/)?.[0]})`,
        url: runtimeAsset.browser_download_url,
        dest: path.join(DIRS.downloads, runtimeAsset.name),
        expectedBytes: runtimeAsset.size,
        sha256: assetSha(runtimeAsset),
      });
      const serverDir = (await findServerDir(target)) ?? target;
      await extract(cudart, serverDir);
      // L'archive Linux range ses bibliothèques dans un dossier à son nom : on les remonte à côté
      // de llama-server, là où le chargeur les cherche.
      const nested = path.join(serverDir, runtimeAsset.name.replace(/\.(zip|tar\.gz)$/, ''));
      for (const name of await readdir(nested).catch(() => [])) await rename(path.join(nested, name), path.join(serverDir, name));
      await rm(nested, { recursive: true, force: true });
    }
  }

  const serverDir = await findServerDir(target);
  if (!serverDir) throw new Error('llama-server introuvable dans l’archive');
  const serverPath = path.join(serverDir, process.platform === 'win32' ? 'llama-server.exe' : 'llama-server');
  const { stdout, stderr } = await run(serverPath, ['--version'], { env: engineEnv(serverDir), windowsHide: true, timeout: 30_000 }).catch((error) => error);
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
  const asset = release.assets.find((item) => (LINUX ? /linux_x86_64\.tar\.gz$/ : /windows_x86_64\.zip$/).test(item.name));
  if (!asset) throw new Error(`Pas de build ${LINUX ? 'Linux' : 'Windows'} de ketch`);
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

// Moteurs compilés ici (llamAmpere, une PR llama.cpp, un fork) : pas de binaire publié pour cette
// machine, on compile un commit figé — même règle que Strata, un contenu précis plutôt qu'une
// branche qui bouge. Le dossier porte le nom de la fiche et de sa version : une compilation faite
// à la main au même endroit, au même commit, est reprise telle quelle.
async function builtCommit(dir) {
  for (const file of ['.harn-commit', path.join('.git', 'HEAD')]) {
    const text = await readFile(path.join(dir, file), 'utf8').catch(() => '');
    if (text.trim()) return text.trim();
  }
  return null;
}

function runLogged(command, args, options, onLog) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { maxBuffer: 256 * 1024 * 1024, ...options });
    child.stdout.on('data', (chunk) => onLog(String(chunk)));
    child.stderr.on('data', (chunk) => onLog(String(chunk)));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${path.basename(command)} s’est arrêté (code ${code})`))));
  });
}

// sheet : { id, label, repo, ref (commit), version?, cudaArch } ; tools : hardware.buildTools.
export async function buildEngine(sheet, tools, onLog = () => {}) {
  const backend = `cuda${Number.parseInt(tools.nvcc, 10)}`;
  const runtimeId = `${sheet.id}-${backend}`;
  const existing = getState().runtimes[runtimeId];
  if (existing?.commit === sheet.ref && (await stat(existing.serverPath).catch(() => null))) return existing;
  const repoDir = path.join(DIRS.runtime, sheet.id, sheet.version ?? sheet.ref.slice(0, 12));
  const buildDir = `build-sm${sheet.cudaArch}`;
  const binDir = path.join(repoDir, buildDir, 'bin');
  const serverPath = path.join(binDir, 'llama-server');
  const reuse = (await builtCommit(repoDir)) === sheet.ref && (await stat(serverPath).catch(() => null));

  if (!reuse) {
    const archive = await download({
      id: `runtime:${sheet.id}`,
      label: `${sheet.label} (sources ${sheet.ref.slice(0, 7)})`,
      url: `https://github.com/${sheet.repo}/archive/${sheet.ref}.tar.gz`,
      dest: path.join(DIRS.downloads, `${sheet.id}-${sheet.ref.slice(0, 7)}.tar.gz`),
    });
    const parent = path.dirname(repoDir);
    // L'archive d'un commit se déplie dans <dépôt>-<commit>.
    const unpacked = path.join(parent, `${sheet.repo.split('/')[1]}-${sheet.ref}`);
    await rm(repoDir, { recursive: true, force: true });
    await rm(unpacked, { recursive: true, force: true });
    await extract(archive, parent);
    await rename(unpacked, repoDir);
    // nvcc refuse un g++ trop récent : on lui passe celui que la détection a retenu, par son chemin.
    const hostCompiler = (await run('sh', ['-c', `command -v ${tools.hostCompiler}`])).stdout.trim();
    onLog('Configuration (cmake)');
    await runLogged('cmake', ['-S', '.', '-B', buildDir, '-DCMAKE_BUILD_TYPE=Release', '-DGGML_CUDA=ON',
      `-DCMAKE_CUDA_ARCHITECTURES=${sheet.cudaArch}`, `-DCMAKE_CUDA_HOST_COMPILER=${hostCompiler}`, '-DLLAMA_CURL=OFF'], { cwd: repoDir }, onLog);
    await runLogged('cmake', ['--build', buildDir, '-j', String(os.availableParallelism()), '--target', 'llama-server'], { cwd: repoDir, timeout: 90 * 60_000 }, onLog);
    await writeFile(path.join(repoDir, '.harn-commit'), sheet.ref);
  }

  const { stdout, stderr } = await run(serverPath, ['--version'], { env: engineEnv(binDir), timeout: 30_000 }).catch((error) => error);
  const version = `${stdout ?? ''}${stderr ?? ''}`.match(/version:\s*(\S+)/)?.[1];
  if (!version) throw new Error(`${sheet.label} compilé mais llama-server ne démarre pas`);
  const info = { kind: sheet.id, label: sheet.label, backend, tag: sheet.version ?? sheet.ref.slice(0, 7), commit: sheet.ref, version, dir: binDir, serverPath, verified: false, builtWith: `nvcc ${tools.nvcc}, ${tools.hostCompiler}`, installedAt: new Date().toISOString() };
  update((s) => { s.runtimes[runtimeId] = info; });
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
  // Windows : START-HERE.bat ; Linux : setup.sh, mêmes options. Sous Linux, l'archive en .tar.gz :
  // le tar GNU ne sait pas ouvrir un zip.
  const script = LINUX ? 'setup.sh' : 'START-HERE.bat';
  const ext = LINUX ? 'tar.gz' : 'zip';
  if (!(await stat(path.join(repoDir, script)).catch(() => null))) {
    const zip = await download({
      id: 'runtime:strata',
      label: `Strata (runtime MoE, ${STRATA_COMMIT.slice(0, 7)})`,
      url: `https://github.com/Niko1221/Strata/archive/${STRATA_COMMIT}.${ext}`,
      dest: path.join(DIRS.downloads, `strata-${STRATA_COMMIT.slice(0, 7)}.${ext}`),
    });
    // L'archive d'un commit se déplie dans Strata-<commit> : ramenée au nom attendu partout.
    const unpacked = path.join(dir, `Strata-${STRATA_COMMIT}`);
    await rm(repoDir, { recursive: true, force: true });
    await rm(unpacked, { recursive: true, force: true });
    await extract(zip, dir);
    await rename(unpacked, repoDir);
  }
  const args = [
    '--setup', '--family', model.strataFamily ?? 'swift', '--model', model.strataModel, '--context', String(contextSize),
    '--vision', 'cpu', '--data-dir', path.join(DIRS.models, 'strata-data'), '--yes', '--no-start', '--no-browser',
    // Fichiers déjà présents sur la machine : Strata les utilise au lieu de retélécharger 70 Go.
    ...(ggufDir ? ['--gguf-dir', ggufDir] : []),
  ];
  if (LINUX && !(await stat(path.join(repoDir, '.venv', 'bin', 'python')).catch(() => null)) && !(await linuxPython())?.ok) {
    throw new Error('Python 3.10+ avec venv manque : sudo apt install python3-venv (Ubuntu, Debian), puis relancer Harn');
  }
  onLog(`${script} ${args.join(' ')}`);
  await new Promise((resolve, reject) => {
    // Chemin complet : avec NoDefaultCurrentDirectoryInExePath (postes durcis), cmd ne lance
    // pas un script du dossier courant par son seul nom.
    const child = LINUX
      ? execFile('sh', [path.join(repoDir, script), ...args], { cwd: repoDir, maxBuffer: 64 * 1024 * 1024 })
      : execFile('cmd.exe', ['/c', path.join(repoDir, script), ...args], { cwd: repoDir, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    // Sans console, le « pause » de START-HERE.bat attendrait une touche pour toujours : on ferme son entrée.
    // (Sous Linux, setup.sh demande sudo seulement si Python 3.10+ avec venv manque : il échoue alors avec un message clair.)
    child.stdin.end();
    child.stdout.on('data', (chunk) => onLog(String(chunk)));
    child.stderr.on('data', (chunk) => onLog(String(chunk)));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`L’installeur de Strata s’est arrêté (code ${code})`))));
  });
  const config = (await readdir(repoDir)).find((name) => name.startsWith(`strata-${model.strataFamily ?? 'swift'}`) && name.endsWith('.json') && name.toLowerCase().includes(model.strataModel.toLowerCase()));
  const info = { kind: 'strata', commit: STRATA_COMMIT, dir: repoDir, config, python: LINUX ? path.join(repoDir, '.venv', 'bin', 'python') : path.join(repoDir, '.venv', 'Scripts', 'python.exe'), installedAt: new Date().toISOString() };
  update((s) => { s.runtimes[`strata-${model.strataModel}`] = info; });
  return info;
}
