import { execFile } from 'node:child_process';
import { copyFile, link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { download, hashFile } from './download.mjs';
import { github } from './github.mjs';
import { sandboxed } from './sandbox.mjs';
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
  const releases = await github(`/repos/${source.repo}/releases?per_page=15`);
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
  const release = await github('/repos/1broseidon/ketch/releases/latest');
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
    // Code non relu (fiche isolée) : compilé dans la bulle, sans réseau, ne voyant que ses sources.
    const step = (args, options) => (sheet.isolated
      ? (({ command, args: boxed }) => runLogged(command, boxed, options, onLog))(sandboxed('cmake', args, { writable: [repoDir], cwd: repoDir }))
      : runLogged('cmake', args, options, onLog));
    onLog('Configuration (cmake)');
    await step(['-S', '.', '-B', buildDir, '-DCMAKE_BUILD_TYPE=Release', '-DGGML_CUDA=ON',
      `-DCMAKE_CUDA_ARCHITECTURES=${sheet.cudaArch}`, `-DCMAKE_CUDA_HOST_COMPILER=${hostCompiler}`, '-DLLAMA_CURL=OFF'], { cwd: repoDir });
    await step(['--build', buildDir, '-j', String(os.availableParallelism()), '--target', 'llama-server'], { cwd: repoDir, timeout: 90 * 60_000 });
    await writeFile(path.join(repoDir, '.harn-commit'), sheet.ref);
  }

  const probe = sheet.isolated ? sandboxed(serverPath, ['--version'], { readable: [binDir] }) : { command: serverPath, args: ['--version'] };
  const { stdout, stderr } = await run(probe.command, probe.args, { env: engineEnv(binDir), timeout: 30_000 }).catch((error) => error);
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

// ── Strata pour un Flash-Next ajouté depuis Hugging Face ────────
// L'installeur de Strata ne connaît que ses propres familles. Pour un autre GGUF de la même
// architecture, son outil iq_pack prépare un « pack » à côté des fichiers d'origine (qui ne sont
// pas réécrits), et le moteur se lance avec une config calquée sur celle d'un modèle déjà installé.
// Il faut donc qu'un Strata tourne déjà ici : moteur, Python, tête MTP (docs/ORCA.md de Strata).
const STRATA_ARCH = 'qwen4exp';
const ggufPy = (dir) => path.join(dir, 'third_party', 'llama.cpp', 'gguf-py');

export async function strataBase() {
  for (const runtime of Object.values(getState().runtimes ?? {})) {
    if (runtime?.kind !== 'strata' || runtime.pack) continue;
    const ready = await Promise.all([runtime.python, path.join(runtime.dir, runtime.config), path.join(runtime.dir, 'tools', 'iq_pack.py'), ggufPy(runtime.dir), path.join(DIRS.models, 'strata-data', 'mtp', 'rt')].map((file) => stat(file).then(() => true, () => false)));
    if (ready.every(Boolean)) return runtime;
  }
  return null;
}
export const strataTakes = async (profile) => profile?.arch === STRATA_ARCH && Boolean(await strataBase());

const setFlag = (args, flag, value) => { const copy = [...args]; const at = copy.indexOf(flag); if (at >= 0) copy[at + 1] = value; else copy.push(flag, value); return copy; };

// firstShard : le premier fichier du modèle, là où il est vraiment (les autres sont trouvés par leur nom).
export async function installStrataPack(model, firstShard, contextSize, onLog = () => {}) {
  const base = await strataBase();
  if (!base) throw new Error('Strata n’est pas installé sur cette machine : installez d’abord un Flash-Next du catalogue (il apporte le moteur et sa tête MTP)');
  const pack = path.join(DIRS.models, 'strata-data', 'packs', model.id);
  onLog(`iq_pack.py --gguf ${firstShard} --out ${pack} --compat-bf16`);
  await runLogged(base.python, [path.join('tools', 'iq_pack.py'), '--gguf', firstShard, '--out', pack, '--compat-bf16'], { cwd: base.dir, env: { ...process.env, STRATA_GGUF_PY: ggufPy(base.dir) }, timeout: 60 * 60_000 }, onLog);
  if (!(await stat(path.join(pack, 'tokenizer', 'vocab.json')).catch(() => null))) throw new Error('Strata a préparé le modèle sans son tokenizer : ce fichier n’est pas pris en charge');

  const template = JSON.parse((await readFile(path.join(base.dir, base.config), 'utf8')).replace(/^\uFEFF/, ''));
  let args = template.args.filter((arg) => arg !== '--vision');
  // Le fichier porte aussi la table PLE (premier fragment), et son propre profil d'experts n'existe
  // pas : celui du modèle d'origine sert de point de départ au cache de la carte.
  for (const [flag, value] of [['--pack', pack], ['--native', firstShard], ['--ple-gguf', firstShard], ['--expert-profile', path.join(base.dir, 'data', 'expert-profile.bin')], ['--max-context', String(contextSize)]]) args = setFlag(args, flag, value);
  const name = `strata-pack-${model.id}.json`;
  const { vision, ...rest } = template;
  await writeFile(path.join(base.dir, name), JSON.stringify({ ...rest, args, tokenizer: path.join(pack, 'tokenizer'), model_name: model.id, log: path.join(base.dir, name.replace(/\.json$/, '.log')) }, null, 2));
  const info = { kind: 'strata', pack: true, commit: base.commit, dir: base.dir, config: name, python: base.python, installedAt: new Date().toISOString() };
  update((s) => { s.runtimes[`strata-${model.strataModel}`] = info; });
  return info;
}

// ── HyperQwen : vLLM patché par syv-ai pour Qwen3.8-27B sur une carte de 24 Go ────────
// Même règle que Strata : un commit figé. On suit la voie sans Docker de son docs/install.md :
// venv Python 3.12 créé par uv, vLLM 0.31.0 et ses épingles, patchs, pthfa (KV int8 en contexte
// long), poids requantifiés, variante « fast ». Puis la variante française : le brouillon MTP ne
// propose que 40 960 tokens, et la liste livrée (danois, anglais, code) laisse ~20 % des tokens
// français hors de portée. Celle de src/assets, comptée sur Wikipédia FR/EN, du code et des
// réponses du modèle en français, les couvre à 99 % : +24 % de génération en français, anglais
// et code inchangés (RTX 3090). Le décodage spéculatif reste exact : les réponses ne changent pas.
// Chaque étape longue pose un marqueur .harn-ready : une installation interrompue reprend au
// début de l'étape, sur un dossier remis à zéro (les patchs ne s'appliquent qu'à un vLLM neuf).
const HYPERQWEN_COMMIT = 'ce9615c4f2309be727407918a6c979bd67968069';
const UV_VERSION = '0.13.0';
const HYPERQWEN_PIP = ['vllm==0.31.0', 'huggingface_hub', 'hf_transfer', 'ninja', 'flashinfer-cubin==0.7.0.post1', 'pandas',
  // Le compilateur CUDA tenu à la version du runtime (13.0) : sans ces épingles, pip prend un nvcc
  // plus récent et la compilation à la volée de FlashInfer échoue au premier démarrage.
  'nvidia-cuda-nvcc==13.0.88', 'nvidia-cuda-crt==13.0.88', 'nvidia-cuda-cccl==13.0.85', 'nvidia-nvvm==13.0.88'];
const HYPERQWEN_WEIGHTS = { repo: 'dbirks/Qwen3.8-27B-W4A16-AutoRound', dir: 'Qwen3.8-27B-W4A16-AutoRound' };
const DRAFT_VOCAB_FR = fileURLToPath(new URL('./assets/hyperqwen-draft-vocab-fr.json', import.meta.url));
// Les fichiers que build_draft_vocab.py réécrit : de vraies copies dans la variante française,
// le reste en liens physiques (pas 20 Go de plus sur le disque).
const DRAFT_REWRITES = new Set(['model_extra_tensors.safetensors', 'model.safetensors.index.json', 'mtp_draft_vocab_ids.pt', 'config.json']);
const ready = (dir) => stat(path.join(dir, '.harn-ready')).then(() => true, () => false);
const markReady = (dir) => writeFile(path.join(dir, '.harn-ready'), `${new Date().toISOString()}\n`);

// uv : celui de la machine s'il y en a un, sinon la version figée, vérifiée par son empreinte.
async function uvCommand() {
  for (const candidate of ['uv', path.join(os.homedir(), '.local', 'bin', 'uv')]) {
    if (await run(candidate, ['--version']).then(() => true, () => false)) return candidate;
  }
  const name = 'uv-x86_64-unknown-linux-gnu';
  const binary = path.join(DIRS.runtime, 'uv', name, 'uv');
  if (await stat(binary).catch(() => null)) return binary;
  const url = `https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/${name}.tar.gz`;
  const sha256 = (await fetch(`${url}.sha256`).then((r) => (r.ok ? r.text() : ''))).trim().split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/i.test(sha256)) throw new Error(`Empreinte de uv ${UV_VERSION} introuvable : installation de HyperQwen arrêtée`);
  const archive = await download({ id: 'runtime:uv', label: `uv ${UV_VERSION}`, url, dest: path.join(DIRS.downloads, `${name}-${UV_VERSION}.tar.gz`), sha256 });
  await extract(archive, path.join(DIRS.runtime, 'uv'));
  return binary;
}

// CUDA 13.0 déclare rsqrt et rsqrtf sans noexcept, la glibc 2.41+ avec : toute compilation par le
// nvcc du venv échoue alors (pthfa, et FlashInfer au démarrage). On fait comme les CUDA suivants.
async function fixCudaMath(venv) {
  const file = path.join(venv, 'lib', 'python3.12', 'site-packages', 'nvidia', 'cu13', 'include', 'crt', 'math_functions.h');
  const text = await readFile(file, 'utf8');
  const fixed = text.replace(/\b(rsqrtf?)\((double|float) x\);/g, '$1($2 x) noexcept (true);');
  if (fixed !== text) await writeFile(file, fixed);
}

export async function installHyperQwen(onLog = () => {}) {
  if (!LINUX) throw new Error('HyperQwen n’est installé par Harn que sous Linux');
  const dir = path.join(DIRS.runtime, 'hyperqwen');
  const venv = path.join(dir, 'venv');
  const python = path.join(venv, 'bin', 'python');
  const step = (command, args, env = {}) => {
    onLog(`${path.basename(command)} ${args.join(' ')}`);
    return runLogged(command, args, { cwd: dir, timeout: 3 * 3600_000, env: { ...process.env, HF_XET_HIGH_PERFORMANCE: '1', ...env } }, onLog);
  };

  if (!(await stat(path.join(dir, 'single-user', 'start_qwen.sh')).catch(() => null))) {
    const archive = await download({
      id: 'runtime:hyperqwen',
      label: `HyperQwen (vLLM pour Qwen3.8-27B, ${HYPERQWEN_COMMIT.slice(0, 7)})`,
      url: `https://github.com/syv-ai/HyperQwen/archive/${HYPERQWEN_COMMIT}.tar.gz`,
      dest: path.join(DIRS.downloads, `hyperqwen-${HYPERQWEN_COMMIT.slice(0, 7)}.tar.gz`),
    });
    const unpacked = path.join(DIRS.runtime, `HyperQwen-${HYPERQWEN_COMMIT}`);
    await rm(unpacked, { recursive: true, force: true });
    await extract(archive, DIRS.runtime);
    await rm(dir, { recursive: true, force: true });
    await rename(unpacked, dir);
  }

  if (!(await ready(venv))) {
    await rm(venv, { recursive: true, force: true });
    const uv = await uvCommand();
    await step(uv, ['venv', '--python', '3.12', '--seed', 'venv']);
    await step(uv, ['pip', 'install', '--python', python, '--index-strategy', 'unsafe-best-match', '--extra-index-url', 'https://flashinfer.ai/whl/', ...HYPERQWEN_PIP]);
    await fixCudaMath(venv);
    await step('bash', ['patches/apply.sh', path.join(venv, 'lib', 'python3.12', 'site-packages', 'vllm')]);
    await step('bash', ['pthfa/install.sh']);
    await markReady(venv);
  }

  const weights = path.join(dir, 'models', HYPERQWEN_WEIGHTS.dir);
  if (!(await ready(weights))) {
    // La requantification réécrit les poids sur place : on repart toujours de fichiers neufs.
    await rm(weights, { recursive: true, force: true });
    await rm(`${weights}-fast`, { recursive: true, force: true });
    await step(path.join(venv, 'bin', 'hf'), ['download', HYPERQWEN_WEIGHTS.repo, '--local-dir', weights]);
    for (const script of ['quant_lm_head.py', 'quant_embed.py', 'quant_mtp.py']) await step(python, [path.join('prepare', script), weights]);
    await step(python, [path.join('prepare', 'build_draft_vocab.py'), weights, '--ids', path.join('prepare', 'draft_vocab_ids.json')]);
    await step(python, [path.join('prepare', 'fetch_fast_variant.py')]);
    await markReady(weights);
  }

  // Le drafter DFlash2 (W4A16, 1,2 Go), pour le second réglage du banc.
  const drafter = path.join(dir, 'models', 'Qwen3.8-27B-DFlash2-W4A16');
  if (!(await ready(drafter))) {
    await rm(drafter, { recursive: true, force: true });
    await step(python, [path.join('prepare', 'fetch_dflash2.py')]);
    await markReady(drafter);
  }

  const fast = `${weights}-fast`;
  const french = `${fast}-fr`;
  if (!(await ready(french))) {
    await rm(french, { recursive: true, force: true });
    await mkdir(french, { recursive: true });
    for (const entry of await readdir(fast, { withFileTypes: true })) {
      if (!entry.isFile() || entry.name === '.harn-ready') continue;
      await (DRAFT_REWRITES.has(entry.name) ? copyFile : link)(path.join(fast, entry.name), path.join(french, entry.name));
    }
    await step(python, [path.join('prepare', 'build_draft_vocab.py'), french, '--ids', DRAFT_VOCAB_FR]);
    await markReady(french);
  }

  await step('bash', ['verify.sh', '--no-server']);
  const info = { kind: 'hyperqwen', commit: HYPERQWEN_COMMIT, dir, model: french, installedAt: new Date().toISOString() };
  update((s) => { s.runtimes.hyperqwen = info; });
  return info;
}

// ── Gemma Challenge : le moteur des soumissions du Fast Gemma Challenge (Hugging Face, 2026) ──
// La soumission gemma-slayer w188-ctk49-n64 (511 tok/s vérifiés sur A10G) : son serve.py, ses
// patchs, son vLLM nightly. Deux fiches s'en servent (model.challengeStack) :
// - 'submission' : la pile telle quelle, pour se comparer au challenge. Gemma 4 E4B int4 privé de
//   5 couches (bake osoi5), lm_head réduit à 12 288 tokens, fenêtre 188, brouillon ré-entraîné, 4k ;
// - 'qat' : ce qu'elle a de sans perte (boucle MTP K=7 en un seul graphe CUDA, split-KV en
//   vérification, échauffement) sur le checkpoint QAT W4A16 officiel complet et le brouillon de
//   Google, à 131k. Le brouillon ré-entraîné y perd 30 % en français, le budget de centroïdes
//   (32/49/64) ne change rien : on garde ceux de la soumission.
// Les fichiers des buckets du challenge ne sont pas versionnés : vérifiés par leur empreinte,
// relevée le 28/10/2026 ; les dépôts Google sont figés à un commit.
const CHALLENGE_BUCKET = 'hf://buckets/gemma-challenge';
const CHALLENGE_SUBMISSION = {
  path: 'gemma-gemma-slayer/submissions/gemma-slayer/w188-ctk49-n64-fork',
  files: {
    'detok_endonly.py': 'e24accb1b4a10b80a2409edfdce1b010268e82327c4abffe6274a668be20fcd1',
    'fa_sliding_patch.py': '3effdca8c2da666ffcab8caaf7f9755a0a8d1f2352a9be2a49134989b378f84d',
    'lsk_patch.py': 'a702b617bd9fab833ab407e2c7f5dd7a72ad16cb6a44dde1edba7c65c15f0f24',
    'manifest.json': '050fdb6d27a7fc4c5b420624308303e6ec993c540b4e80e60d3d1a4d17efda24',
    'serve_patch_pck04.py': '5491e358743a936f408d9c7d39732d106bb8d63813be59a2f6f9627dd474dc0b',
    'serve_patch_precache.py': 'c0ff6dcf344196b32c907221dfd17eac342eb49dfee831fc93026662d101857a',
    'serve_patch_warmup_bridge.py': '001009a88e524eb33bf803cd61dfad6dedb89420032244056ab2d2376c03600b',
    'serve.py': '33e3618bc61c17ca112b3361da68b0dcd1ea9a36f1ffa94aa9b84c36a2bfe37f',
    'sitecustomize.py': 'b8c48143449264cba97a7b865159dd956692c19ae07381c7f5b0a02118d85aec',
    'splitkv_verify_patch.py': 'fa321f4761b746e2e6a56c87539b7268f5445fc41a0d91f57e2d4c43cc227e33',
    'steptime_patch.py': '0558345ba60a533d8022e4d2b1e899e1246621bc2c6272e64851fc8c72bdf9aa',
  },
};
const CHALLENGE_WEIGHTS = { path: 'gemma-chiku-inu/weights/osoi5-v0-baked', sha256: '96ddb126a1e7b90d700b01dab98c491ee50784bb55847eb39f8b67f91ea91d30' };
const CHALLENGE_KEEPSET = { path: 'gemma-dixie-flatline/weights/int4-pck04c-12k/pck04_keepset.json', sha256: 'c0853633c1ad5a6b741a43524ee505f7d5994767d49d495d061a726822f3dc1d' };
const CHALLENGE_DRAFTER = { path: 'gemma-kenyan-duma/weights/drafter-ft/ft-v1-epoch_001', sha256: 'ed159e334999fd6b5f2d0dbad026346d4efac89eb7c6f55c5cdb042eca5dd18e' };
const QAT_TARGET = { repo: 'google/gemma-4-E4B-it-qat-w4a16-ct', revision: '6cd26aaa2357fb2bad8c51699a7558a4d1a965bb', sha256: '19d89d2a4b3e401a3eae75ec08ab112810421a036c91d8c8226b686be7fe0c5d', dir: 'qat-w4a16' };
const QAT_DRAFTER = { repo: 'google/gemma-4-E4B-it-qat-q4_0-unquantized-assistant', revision: '27f8d204f09f2be353d6ff0bf0d012792b13c79f', sha256: '9d0e2053067590cae9a8f4fcc57eefbe20dff90599360458ebd451e5cb5c947d', dir: 'qat-assistant' };
// Les dépendances du manifeste, plus le client hf (buckets) que serve.py appelle.
const CHALLENGE_PIP = ['https://wheels.vllm.ai/3e8afdf78598afc8be999a6a049be3a5fe182e48/vllm-0.22.1rc1.dev307%2Bg3e8afdf78.cu129-cp38-abi3-manylinux_2_28_x86_64.whl',
  'transformers==5.9.0', 'jinja2==3.1.6', 'MarkupSafe==3.0.3', 'orjson==3.10.18', 'safetensors', 'torch', 'huggingface_hub', 'hf_transfer'];
// L'échauffement (64 prompts synthétiques) interroge le serveur sans clé : avec VLLM_API_KEY, il
// reçoit des 401 et le serveur finit par s'ouvrir à froid. Seul écart au code de la soumission.
const WARMUP_AUTH = {
  old: '        headers={"Content-Type": "application/json"},\n',
  new: '        headers={"Content-Type": "application/json", **({"Authorization": f"Bearer {os.environ[\'VLLM_API_KEY\']}"} if os.environ.get("VLLM_API_KEY") else {})},\n',
};
// Les dossiers de poids de chaque fiche, sous runtime/gemma-challenge/models.
export const CHALLENGE_STACK_DIRS = { submission: ['osoi5-12k', 'drafter-ft-v1-epoch_001'], qat: [QAT_TARGET.dir, QAT_DRAFTER.dir] };

async function checkSha(file, expected) {
  const actual = (await hashFile(file)).digest('hex');
  if (actual !== expected) throw new Error(`Empreinte différente pour ${path.basename(file)} : attendu ${expected.slice(0, 16)}…, reçu ${actual.slice(0, 16)}…`);
}

export async function installGemmaChallenge(model, onLog = () => {}) {
  if (!LINUX) throw new Error('Le moteur du Gemma Challenge n’est installé par Harn que sous Linux');
  const dir = path.join(DIRS.runtime, 'gemma-challenge');
  const venv = path.join(dir, 'venv');
  const python = path.join(venv, 'bin', 'python');
  const hf = path.join(venv, 'bin', 'hf');
  const submission = path.join(dir, 'submission');
  const models = path.join(dir, 'models');
  const step = (command, args, options = {}) => {
    onLog(`${path.basename(command)} ${args.join(' ')}`);
    return runLogged(command, args, { cwd: dir, timeout: 3 * 3600_000, ...options, env: { ...process.env, HF_XET_HIGH_PERFORMANCE: '1', ...options.env } }, onLog);
  };
  await mkdir(models, { recursive: true });

  if (!(await ready(venv))) {
    await rm(venv, { recursive: true, force: true });
    const uv = await uvCommand();
    await step(uv, ['venv', '--python', '3.12', '--seed', 'venv']);
    // En copie : serve.py réécrit des sources de vLLM sur place. En liens physiques (le défaut de
    // uv), il réécrirait aussi le cache de uv, et tout venv suivant hériterait d'un vLLM patché.
    await step(uv, ['pip', 'install', '--python', python, '--link-mode', 'copy', ...CHALLENGE_PIP]);
    await markReady(venv);
  }

  if (!(await ready(submission))) {
    await rm(submission, { recursive: true, force: true });
    await step(hf, ['buckets', 'sync', `${CHALLENGE_BUCKET}/${CHALLENGE_SUBMISSION.path}`, submission]);
    for (const [name, sha256] of Object.entries(CHALLENGE_SUBMISSION.files)) await checkSha(path.join(submission, name), sha256);
    const warmup = path.join(submission, 'serve_patch_warmup_bridge.py');
    await writeFile(warmup, (await readFile(warmup, 'utf8')).replace(WARMUP_AUTH.old, WARMUP_AUTH.new));
    await markReady(submission);
  }

  const previous = getState().runtimes['gemma-challenge'] ?? {};
  const info = { ...previous, kind: 'gemma-challenge', dir, submission, installedAt: new Date().toISOString() };
  // Première version de l'état : les chemins de la pile du challenge à plat.
  if (previous.model && !previous.submissionStack) info.submissionStack = { model: previous.model, drafter: previous.drafter };
  if (model.challengeStack === 'qat') {
    for (const source of [QAT_TARGET, QAT_DRAFTER]) {
      const target = path.join(models, source.dir);
      if (await ready(target)) continue;
      await rm(target, { recursive: true, force: true });
      await step(hf, ['download', source.repo, '--revision', source.revision, '--local-dir', target]);
      await checkSha(path.join(target, 'model.safetensors'), source.sha256);
      await markReady(target);
    }
    info.qat = { model: path.join(models, QAT_TARGET.dir), drafter: path.join(models, QAT_DRAFTER.dir) };
  } else {
    // Le bake osoi5 (8,5 Go), réduit sur place à 12k lignes de lm_head par le code de la
    // soumission, comme son serve.py le fait au premier démarrage du job ; l'original est effacé.
    const target = path.join(models, 'osoi5-12k');
    if (!(await ready(target))) {
      const source = path.join(models, 'osoi5-v0-baked');
      const keepset = path.join(models, 'keepset-12k.json');
      await rm(target, { recursive: true, force: true });
      if (!(await stat(path.join(source, 'model.safetensors')).catch(() => null))) await step(hf, ['buckets', 'sync', `${CHALLENGE_BUCKET}/${CHALLENGE_WEIGHTS.path}`, source]);
      await checkSha(path.join(source, 'model.safetensors'), CHALLENGE_WEIGHTS.sha256);
      await step(hf, ['buckets', 'cp', `${CHALLENGE_BUCKET}/${CHALLENGE_KEEPSET.path}`, keepset]);
      await checkSha(keepset, CHALLENGE_KEEPSET.sha256);
      await step(python, ['-c', `import serve; serve._prune_lm_head_rows(${JSON.stringify(source)}, ${JSON.stringify(keepset)}, ${JSON.stringify(target)})`], { cwd: submission });
      await markReady(target);
      await rm(source, { recursive: true, force: true });
      await rm(keepset, { force: true });
    }
    const drafter = path.join(models, 'drafter-ft-v1-epoch_001');
    if (!(await ready(drafter))) {
      await rm(drafter, { recursive: true, force: true });
      await step(hf, ['buckets', 'sync', `${CHALLENGE_BUCKET}/${CHALLENGE_DRAFTER.path}`, drafter]);
      await checkSha(path.join(drafter, 'model.safetensors'), CHALLENGE_DRAFTER.sha256);
      await markReady(drafter);
    }
    info.submissionStack = { model: target, drafter };
  }
  delete info.model;
  delete info.drafter;
  update((s) => { s.runtimes['gemma-challenge'] = info; });
  return info;
}
