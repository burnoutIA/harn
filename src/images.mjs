import { execFile, spawn } from 'node:child_process';
import { chmod, link, mkdir, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { activate } from './activation.mjs';
import { hfSha256 } from './catalog.mjs';
import { download } from './download.mjs';
import { stopEngine } from './engine.mjs';
import { github } from './github.mjs';
import { addedImageModels, forgetImageModel, imageSuggestions } from './image-hub.mjs';
import { withGpu } from './gpu-queue.mjs';
import { getLive } from './metrics.mjs';
import { DIRS } from './paths.mjs';
import { engineEnv, extract } from './runtimes.mjs';
import { bus, getState, update } from './state.mjs';

// La génération d'images : un moteur à part (stable-diffusion.cpp, sans interface, comme
// llama.cpp pour le texte) et des modèles à part. Une image se fait à la demande d'un agent : la
// carte graphique quitte le modèle de texte le temps de la générer, puis il est rechargé.

const run = promisify(execFile);
const SD_REPO = 'leejet/stable-diffusion.cpp';

// Chaque modèle : ses poids, son décodeur (vae) et le modèle de langue qui lit la consigne (llm).
// vision : ce qu'il faut en plus pour retoucher une image donnée en référence. family : sa famille
// (image-families.mjs). Les modèles ajoutés depuis Hugging Face ont la même forme (image-hub.mjs).
export const IMAGE_MODELS = [
  {
    id: 'flux2-klein-4b',
    name: 'FLUX.2 klein 4B',
    family: 'flux2-klein-4b',
    edit: true,
    tagline: 'Le plus rapide : quatre étapes. Photos, illustrations, retouche d’une image.',
    license: 'Apache-2.0',
    gigabytes: 8.9,
    vramGiB: 10,
    files: [
      { role: 'diffusion', repo: 'leejet/FLUX.2-klein-4B-GGUF', name: 'flux-2-klein-4b-Q8_0.gguf' },
      { role: 'vae', repo: 'Comfy-Org/flux2-klein-4B', name: 'split_files/vae/flux2-vae.safetensors' },
      { role: 'llm', repo: 'unsloth/Qwen3-4B-GGUF', name: 'Qwen3-4B-Q8_0.gguf' },
    ],
    args: ['--cfg-scale', '1.0', '--steps', '4'],
  },
  {
    id: 'qwen-image-2-1-uc',
    name: 'Qwen-Image 2.1 Uncensored',
    family: 'qwen-image-2.1',
    edit: true,
    tagline: 'Plus lent, plus fidèle à la consigne ; écrit du texte lisible dans l’image. Sans filtre.',
    license: 'Qwen Research (usage non commercial)',
    gigabytes: 18.2,
    vramGiB: 20,
    files: [
      { role: 'diffusion', repo: 'abenzerps/Qwen-Image-2.1-Uncensored-GGUF', name: 'qwen-image-2.1-UC-Q8_0.gguf' },
      { role: 'vae', repo: 'abenzerps/Qwen-Image-2.1-Uncensored-GGUF', name: 'vae/qwen_image_2.1_vae_bf16.safetensors' },
      { role: 'llm', repo: 'Qwen/Qwen3-VL-8B-Instruct-GGUF', name: 'Qwen3VL-8B-Instruct-Q8_0.gguf' },
      { role: 'vision', repo: 'Qwen/Qwen3-VL-8B-Instruct-GGUF', name: 'mmproj-Qwen3VL-8B-Instruct-F16.gguf' },
    ],
    // CFG 4 / 30 étapes : à 6 / 20, les couleurs saturent et la peau tourne au plastique (surtout
    // avec un LoRA de visage), pour 50 % de temps en plus.
    args: ['--cfg-scale', '4.0', '--sampling-method', 'euler', '--steps', '30'],
  },
];

const FLAGS = { diffusion: '--diffusion-model', vae: '--vae', llm: '--llm', vision: '--llm_vision', clip_l: '--clip_l', t5xxl: '--t5xxl' };
const allModels = () => [...IMAGE_MODELS, ...addedImageModels()];
export const imageModelById = (id) => allModels().find((model) => model.id === id);
const modelDir = (id) => path.join(DIRS.models, 'image', id);
// Décodeurs et lecteurs de consigne (shared) : un seul exemplaire pour tous les modèles qui s'en servent.
const SHARED = path.join(DIRS.models, 'image', 'shared');
const pathOf = (model, file) => (file.shared ? path.join(SHARED, file.repo.replace('/', '--'), path.basename(file.name)) : path.join(modelDir(model.id), path.basename(file.name)));
const fileOf = (model, role) => { const file = model.files.find((f) => f.role === role); return file && pathOf(model, file); };
const images = () => getState().images ?? {};
const installedModels = () => allModels().filter((model) => images().models?.[model.id]?.installedAt);
const patch = (id, fields) => update((s) => { ((s.images ??= {}).models ??= {})[id] = { ...s.images.models[id], ...fields }; });

// Ce que l'interface et pi voient : chaque modèle, installé ou non, l'image en cours, et les
// propositions venues de Hugging Face.
export function imagesReport() {
  const hardware = getState().hardware;
  const vram = (hardware?.primary?.vramMiB ?? 0) / 1024;
  const ram = hardware?.ramGiB ?? Infinity;
  const models = allModels();
  return {
    engine: images().engine ? { tag: images().engine.tag, backend: images().engine.backend } : null,
    job: images().job ?? null,
    models: models.map((model) => ({
      id: model.id, name: model.name, tagline: model.tagline, license: model.license, gigabytes: model.gigabytes,
      family: model.family ?? null, edit: model.edit !== false, custom: Boolean(model.custom), repo: model.repo ?? model.files[0].repo,
      fits: vram >= model.vramGiB && ram >= (model.ramGiB ?? 0),
      needs: `${model.vramGiB} Go de mémoire graphique`,
      ...(images().models?.[model.id] ?? {}),
      installed: Boolean(images().models?.[model.id]?.installedAt),
    })),
    suggestions: imageSuggestions(new Set(models.map((model) => model.family).filter(Boolean))),
    watch: { checking: Boolean(getState().imageWatch?.checking), checkedAt: getState().imageWatch?.checkedAt ?? null, error: getState().imageWatch?.error ?? null },
  };
}

// ── Le moteur ──────────────────────────────────────────────────
// Le dernier build publié pour ce système. NVIDIA sous Windows : CUDA 12 et ses bibliothèques.
// Ailleurs avec une carte : Vulkan (aucun build CUDA n'est publié pour Linux). Sans carte : CPU.
function assetPatterns(hardware) {
  const gpu = Boolean(hardware?.primary?.vramMiB);
  if (process.platform === 'win32') {
    if (hardware?.primary?.vendor === 'nvidia') return { backend: 'cuda12', main: /-bin-win-cuda12-x64\.zip$/, extra: /^cudart-sd-bin-win-cu12-x64\.zip$/ };
    return gpu ? { backend: 'vulkan', main: /-bin-win-vulkan-x64\.zip$/ } : { backend: 'cpu', main: /-bin-win-cpu-x64\.zip$/ };
  }
  return gpu ? { backend: 'vulkan', main: /-bin-Linux-.*-x86_64-vulkan\.zip$/ } : { backend: 'cpu', main: /-bin-Linux-[^-]+-[\d.]+-x86_64\.zip$/ };
}

const assetSha = (asset) => (/^sha256:[0-9a-f]{64}$/i.test(asset.digest ?? '') ? asset.digest.slice(7).toLowerCase() : null);

async function findCli(root) {
  const exe = process.platform === 'win32' ? 'sd-cli.exe' : 'sd-cli';
  if (await stat(path.join(root, exe)).catch(() => null)) return path.join(root, exe);
  for (const entry of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!entry.isDirectory()) continue;
    const found = await findCli(path.join(root, entry.name));
    if (found) return found;
  }
  return null;
}

// Les builds sont des zip, sous Linux aussi, et le tar de Linux ne les lit pas : unzip, sinon le
// module zipfile de Python (qui ne garde pas le droit d'exécution, reposé ensuite sur sd-cli).
async function unzip(archive, target) {
  if (process.platform === 'win32') return extract(archive, target);
  await mkdir(target, { recursive: true });
  await run('unzip', ['-oq', archive, '-d', target], { timeout: 300_000 })
    .catch(() => run('python3', ['-m', 'zipfile', '-e', archive, target], { timeout: 300_000 }))
    .catch(() => { throw new Error('Impossible d’ouvrir l’archive du moteur d’images : installez unzip (sudo apt install unzip)'); });
}

let engineInstall = null;
export function ensureImageEngine() {
  engineInstall ??= (async () => {
    const known = images().engine;
    if (known && await stat(known.cli).catch(() => null)) return known;
    const want = assetPatterns(getState().hardware);
    const releases = await github(`/repos/${SD_REPO}/releases?per_page=10`);
    const release = releases.find((item) => item.assets.some((asset) => want.main.test(asset.name)));
    if (!release) throw new Error(`Aucun binaire de stable-diffusion.cpp publié pour ce système (${want.backend})`);
    const dir = path.join(DIRS.runtime, 'sdcpp', `${release.tag_name}-${want.backend}`);
    for (const pattern of [want.main, want.extra].filter(Boolean)) {
      const asset = release.assets.find((item) => pattern.test(item.name));
      if (!asset) continue;
      const archive = await download({ id: `runtime:sdcpp:${asset.name}`, label: `Moteur d’images stable-diffusion.cpp (${want.backend})`, url: asset.browser_download_url, dest: path.join(DIRS.downloads, asset.name), expectedBytes: asset.size, sha256: assetSha(asset) });
      await unzip(archive, dir);
    }
    const cli = await findCli(dir);
    if (!cli) throw new Error('Moteur d’images téléchargé, mais sd-cli est introuvable dans l’archive');
    await chmod(cli, 0o755).catch(() => {});
    const engine = { tag: release.tag_name, backend: want.backend, dir: path.dirname(cli), cli, installedAt: new Date().toISOString() };
    update((s) => { (s.images ??= {}).engine = engine; });
    return engine;
  })().finally(() => { engineInstall = null; });
  return engineInstall;
}

// ── Les modèles ────────────────────────────────────────────────
// Un fichier déjà sur la machine, même nom et même taille (un autre modèle d'images l'a téléchargé
// avant le partage des fichiers) : lié plutôt que retéléchargé.
async function reuseLocal(file, dest) {
  if (await stat(dest).catch(() => null)) return;
  const head = await fetch(`https://huggingface.co/${file.repo}/resolve/main/${file.name.split('/').map(encodeURIComponent).join('/')}`, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': 'harn' } }).catch(() => null);
  const size = Number(head?.headers.get('x-linked-size')) || 0;
  if (!size) return;
  const root = path.join(DIRS.models, 'image');
  for (const dir of await readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])) {
    if (!dir.isFile() || dir.name !== path.basename(file.name)) continue;
    const found = path.join(dir.parentPath ?? dir.path, dir.name);
    if ((await stat(found)).size !== size) continue;
    await mkdir(path.dirname(dest), { recursive: true });
    await link(found, dest).catch(() => {});
    return;
  }
}

const installs = new Map();
export function installImageModel(id) {
  const model = imageModelById(id);
  if (!model) return Promise.reject(Object.assign(new Error('Modèle d’images inconnu'), { status: 404 }));
  if (!installs.has(id)) {
    patch(id, { installing: true, error: null, detail: 'Moteur d’images' });
    installs.set(id, (async () => {
      await ensureImageEngine();
      for (const file of model.files) {
        const dest = pathOf(model, file);
        await reuseLocal(file, dest);
        patch(id, { detail: `Téléchargement de ${path.basename(file.name)}` });
        const sha256 = file.sha256 ?? await hfSha256(file.repo, file.name);
        if (!sha256) throw new Error(`Hugging Face ne publie pas d’empreinte SHA-256 pour ${file.name} (${file.repo}) : téléchargement refusé.`);
        await download({ id: `image:${id}:${path.basename(file.name)}`, label: path.basename(file.name), url: `https://huggingface.co/${file.repo}/resolve/main/${file.name.split('/').map(encodeURIComponent).join('/')}?download=true`, dest, sha256 });
      }
      patch(id, { installing: false, detail: null, installedAt: new Date().toISOString() });
    })().catch((error) => {
      patch(id, { installing: false, error: error.message });
      throw error;
    }).finally(() => installs.delete(id)));
  }
  return installs.get(id);
}

// Un modèle ajouté depuis Hugging Face disparaît aussi de la liste ; un fichier partagé n'est
// effacé que si plus aucun modèle installé ne s'en sert.
export async function deleteImageModel(id) {
  const model = imageModelById(id);
  if (!model) throw Object.assign(new Error('Modèle d’images inconnu'), { status: 404 });
  if (installs.has(id) || images().job?.model === id) throw Object.assign(new Error('Ce modèle est en cours d’installation ou d’utilisation : attendez la fin'), { status: 409 });
  await rm(modelDir(id), { recursive: true, force: true });
  update((s) => { if (s.images?.models) delete s.images.models[id]; });
  const inUse = allModels().filter((other) => other.id !== id && (images().models?.[other.id]?.installedAt || installs.has(other.id)));
  const stillUsed = new Set(inUse.flatMap((other) => other.files.filter((f) => f.shared).map((f) => pathOf(other, f))));
  for (const file of model.files.filter((f) => f.shared)) {
    const where = pathOf(model, file);
    if (!stillUsed.has(where)) await rm(where, { force: true });
  }
  if (model.custom) await forgetImageModel(id);
}

// ── Générer ────────────────────────────────────────────────────
const MAX_PROMPT = 4000;
const TIMEOUT_MS = 20 * 60_000;
const failure = (status, message) => Object.assign(new Error(message), { status });
// Les modèles travaillent sur des côtés multiples de 32, entre 256 et 2048 pixels.
const side = (value, fallback) => Math.min(2048, Math.max(256, Math.round((Number(value) || fallback) / 32) * 32));
const inside = (dir, file) => { const rel = path.relative(dir, file); return Boolean(rel) && !rel.startsWith('..') && !path.isAbsolute(rel); };

// workspace : le dossier de travail de qui demande. L'image y est rangée (images/), et les
// références à retoucher ne sont lues que là.
export async function generateImage({ workspace, who = 'pi', model: wanted = null, prompt, negative = null, width = 1024, height = 1024, seed = null, references = [] }) {
  const text = String(prompt ?? '').trim();
  if (!text) throw failure(400, 'Il manque la description de l’image (prompt)');
  if (text.length > MAX_PROMPT) throw failure(400, `Description limitée à ${MAX_PROMPT} caractères`);
  const ready = installedModels();
  if (!ready.length) throw failure(409, 'Aucun modèle d’images n’est installé : l’utilisateur en installe un dans Harn, vue Modèles');
  const model = wanted ? ready.find((m) => m.id === wanted) : ready[0];
  if (!model) throw failure(404, `Modèle d’images « ${wanted} » non installé. Installés : ${ready.map((m) => m.id).join(', ')}`);
  const refs = [].concat(references ?? []).filter(Boolean).slice(0, 4).map((ref) => path.resolve(workspace, String(ref)));
  if (refs.length && model.edit === false) {
    const editors = ready.filter((m) => m.edit !== false).map((m) => m.id);
    throw failure(400, `${model.name} ne sait pas retoucher une image donnée.${editors.length ? ` Modèles installés qui savent : ${editors.join(', ')}` : ''}`);
  }
  for (const ref of refs) {
    if (!inside(workspace, ref)) throw failure(400, `Image de référence hors du dossier de travail : ${ref}`);
    if (!(await stat(ref).catch(() => null))?.isFile()) throw failure(400, `Image de référence introuvable : ${path.relative(workspace, ref)}`);
  }
  const engine = await ensureImageEngine();
  const outDir = path.join(workspace, 'images');
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-');
  const output = path.join(outDir, `${stamp}-${model.id}.png`);
  const chosenSeed = Number.isInteger(seed) && seed >= 0 ? seed : Math.floor(Math.random() * 2 ** 31);
  // Un dossier lora/ dans le workspace de l'agent est passé au moteur : chaque .safetensors/.gguf/.ckpt
  // s'applique alors via le prompt, syntaxe <lora:nom:echelle> (comme stable-diffusion-webui). Sans
  // les chevrons, sd.cpp ignore la mention sans rien dire : on les remet quand le nom existe.
  const loraDir = path.join(workspace, 'lora');
  const loraFiles = (await readdir(loraDir).catch(() => [])).filter((name) => /\.(safetensors|gguf|ckpt)$/i.test(name));
  const loraNames = new Set(loraFiles.map((name) => name.replace(/\.[^.]+$/, '')));
  const withLoras = text.replace(/(?<![<\w])lora:([\w.-]+):(\d+(?:\.\d+)?)(?!>)/g, (all, name, scale) => (loraNames.has(name) ? `<lora:${name}:${scale}>` : all));
  const args = [
    ...model.files.filter((file) => file.role !== 'vision' || refs.length).flatMap((file) => [FLAGS[file.role], fileOf(model, file.role)]),
    ...model.args,
    // Le lecteur T5 (9,8 Go) reste sur le processeur quand la carte est petite.
    ...(model.files.some((file) => file.role === 't5xxl') && (getState().hardware?.primary?.vramMiB ?? 0) < 12 * 1024 ? ['--clip-on-cpu'] : []),
    ...(loraFiles.length ? ['--lora-model-dir', loraDir] : []),
    '-p', withLoras, ...(negative ? ['-n', String(negative).slice(0, MAX_PROMPT)] : []),
    '-W', String(side(width, 1024)), '-H', String(side(height, 1024)),
    '--seed', String(chosenSeed),
    ...refs.flatMap((ref) => ['-r', ref]),
    // Chaque partie ne monte sur la carte que le temps de servir : le pic de mémoire reste bas.
    '--offload-to-cpu', '--diffusion-fa', '--vae-tiling',
    '-o', output,
  ];

  const started = Date.now();
  let before = null;
  try {
    await withGpu(`image:${model.id}`, async () => {
      update((s) => { (s.images ??= {}).job = { model: model.id, who, prompt: text.slice(0, 200), startedAt: started }; });
      bus.emit('toast', `${who} génère une image (${model.name})`);
      // Une réponse en cours pour quelqu'un d'autre se termine d'abord (l'agent qui demande l'image,
      // lui, attend déjà son outil).
      for (let waited = 0; getLive().request && waited < 120_000; waited += 500) await new Promise((resolve) => setTimeout(resolve, 500));
      const active = getState().active;
      before = active?.status === 'ready' || active?.status === 'loading' ? active.modelId : null;
      await stopEngine();
      await runCli(engine, args);
      if (!(await stat(output).catch(() => null))) throw new Error('Le moteur d’images s’est terminé sans écrire d’image');
    });
  } finally {
    update((s) => { if (s.images) s.images.job = null; });
    // La carte est rendue : le modèle de texte revient, sans faire attendre la réponse.
    if (before) activate(before).catch(() => {});
  }
  const seconds = +((Date.now() - started) / 1000).toFixed(1);
  patch(model.id, { lastSeconds: seconds });
  return { file: output, model: model.id, width: side(width, 1024), height: side(height, 1024), seed: chosenSeed, seconds };
}

function runCli(engine, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(engine.cli, args, { env: engineEnv(engine.dir), cwd: engine.dir, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let tail = '';
    const keep = (chunk) => { tail = (tail + String(chunk)).slice(-4000); };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => child.kill('SIGKILL'), TIMEOUT_MS);
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      const reason = tail.split(/\r?\n/).filter((line) => /\[E\]|error|failed|out of memory/i.test(line)).pop() ?? tail.trim().split(/\r?\n/).pop() ?? '';
      reject(new Error(`Le moteur d’images s’est arrêté (code ${code}) : ${reason.replace(/\s+---.*$/, '').slice(0, 300)}`));
    });
  });
}

export const imagesReady = () => installedModels().length > 0;
