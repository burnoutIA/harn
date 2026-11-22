import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { activate } from './activation.mjs';
import { killTree, spareRuntime, stopEngine } from './engine.mjs';
import { withGpu } from './gpu-queue.mjs';
import { sampleGpu } from './hardware.mjs';
import { getLive } from './metrics.mjs';
import { DIRS, PORTS } from './paths.mjs';
import { peersWithVoice, peerWithVoice } from './peers.mjs';
import { downloadVoiceWeights, installVoiceEngine } from './runtimes.mjs';
import { bus, getState, update } from './state.mjs';
import { describeVoiceModel, inspectVoiceRepo, VOICE_MODELS } from './voice-models.mjs';

// La voix des agents : un modèle de voix (voice-models.mjs) servi par vLLM-Omni, à côté du modèle
// de texte. Un seul à la fois sur la carte, lancé par /parler sur Telegram (ou un client de
// /v1/audio/speech), arrêté après un quart d'heure sans rien dire. Une seule requête à la fois :
// le modèle de texte, s'il manque de place, est déchargé puis rechargé.
//
// La voix que disent les agents : un modèle et une de ses voix (state.voice.selected). Pour un
// modèle qui imite un extrait (Qwen3-TTS Base), la voix est un extrait gardé ici (data/voices),
// envoyé avec chaque requête : il sert aussi quand le modèle tourne sur une autre machine.

const IDLE_MS = 15 * 60_000;
const START_TIMEOUT_MS = 10 * 60_000;
export const MAX_SPEAK_CHARS = 1200;
// Un extrait de référence : quelques secondes suffisent (5 à 15 s conseillées), 10 Mo au plus
// (la limite de vLLM-Omni pour une voix envoyée).
const MAX_SAMPLE_BYTES = 10 * 1024 * 1024;
const SAMPLE_TYPES = { 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/wave': 'wav', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp3': 'mp3' };
// Les langues de Qwen3-TTS (codec_language_id), telles que l'API les attend.
export const LANGUAGES = [['French', 'français'], ['English', 'anglais'], ['German', 'allemand'], ['Spanish', 'espagnol'], ['Italian', 'italien'], ['Portuguese', 'portugais'], ['Russian', 'russe'], ['Chinese', 'chinois'], ['Japanese', 'japonais'], ['Korean', 'coréen'], ['Auto', 'détectée']];
const DEFAULT_LANGUAGE = 'French';

const failure = (status, message) => Object.assign(new Error(message), { status });
const voiceState = () => getState().voice ?? {};
const patch = (fields) => update((s) => { s.voice = { ...(s.voice ?? {}), ...fields }; });
const patchModel = (id, fields) => update((s) => { s.voice ??= {}; (s.voice.models ??= {})[id] = { ...(s.voice.models[id] ?? {}), ...fields }; });
const engine = () => getState().runtimes?.['vllm-omni'] ?? null;
const modelsDir = path.join(DIRS.models, 'voice');
const samplesDir = path.join(DIRS.data, 'voices');

export const allVoiceModels = () => [...VOICE_MODELS, ...(voiceState().added ?? [])];
export const voiceModelById = (id) => allVoiceModels().find((model) => model.id === id) ?? null;
const entryOf = (id) => voiceState().models?.[id] ?? {};
// Installé, et toujours là : un dossier effacé à la main ne compte plus.
const installedHere = (id) => Boolean(engine()?.installedAt && entryOf(id).installedAt && existsSync(entryOf(id).path ?? ''));
const installedModels = () => allVoiceModels().filter((model) => installedHere(model.id));
export const voiceInstalled = () => installedModels().length > 0;
// Ce que le ménage de models/ (cleanup.mjs) ne touche pas : le dossier de chaque modèle connu de
// l'état (installé, en cours ou en échec qu'on relancera).
export const voicePathsInUse = () => Object.entries(voiceState().models ?? {}).flatMap(([id, entry]) => [path.join(modelsDir, id), entry.path].filter(Boolean));
// vLLM et vLLM-Omni installés par pip visent CUDA : la voix ne tourne que sur une carte Nvidia.
// Une machine sans elle (la R9700) prend celle d'un pair qui l'a (peers.mjs) : il la fait tourner
// sur sa carte et renvoie l'audio, rien ne bouge ici.
const nvidiaHere = () => getState().hardware?.primary?.vendor === 'nvidia';

// ── Les voix clonées : un extrait et sa transcription ──
const samples = () => voiceState().samples ?? [];
const sampleById = (id) => samples().find((sample) => sample.id === id) ?? null;
const slug = (text) => String(text).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

export async function addVoiceSample({ name, text = '', language = DEFAULT_LANGUAGE, audio, mime }) {
  const label = String(name ?? '').trim().slice(0, 60);
  if (!label) throw failure(400, 'Donnez un nom à cette voix');
  const ext = SAMPLE_TYPES[String(mime ?? '').toLowerCase()];
  if (!ext) throw failure(400, 'Extrait attendu en WAV, FLAC, OGG ou MP3');
  if (!LANGUAGES.some(([code]) => code === language)) throw failure(400, `Langue inconnue : ${language}`);
  const bytes = Buffer.from(String(audio ?? ''), 'base64');
  if (bytes.length < 1000) throw failure(400, 'Extrait vide ou illisible');
  if (bytes.length > MAX_SAMPLE_BYTES) throw failure(400, 'Extrait limité à 10 Mo (quelques secondes suffisent)');
  let id = slug(label) || 'voix';
  for (let n = 2; sampleById(id); n += 1) id = `${slug(label) || 'voix'}-${n}`;
  await mkdir(samplesDir, { recursive: true });
  const file = `${id}.${ext}`;
  await writeFile(path.join(samplesDir, file), bytes);
  const sample = { id, name: label, text: String(text).trim().slice(0, 2000), language, file, mime: mime.toLowerCase(), bytes: bytes.length, createdAt: new Date().toISOString() };
  update((s) => { s.voice ??= {}; s.voice.samples = [...(s.voice.samples ?? []), sample]; });
  return sample;
}

export async function deleteVoiceSample(id) {
  const sample = sampleById(id);
  if (!sample) throw failure(404, 'Voix inconnue');
  await rm(path.join(samplesDir, sample.file), { force: true });
  update((s) => {
    s.voice.samples = (s.voice.samples ?? []).filter((x) => x.id !== id);
    if (s.voice.selected?.voice === id) s.voice.selected = { ...s.voice.selected, voice: null };
  });
}

// L'extrait en data URL, la forme que vLLM-Omni accepte sans fichier partagé.
async function sampleAudio(sample) {
  const bytes = await readFile(path.join(samplesDir, sample.file)).catch(() => null);
  if (!bytes) throw failure(409, `L’extrait de la voix « ${sample.name} » a disparu de data/voices`);
  return `data:${sample.mime};base64,${bytes.toString('base64')}`;
}

// ── Les modèles : ajout, installation, suppression ──
// Un dépôt Hugging Face d'une famille connue (voice-models.mjs), ajouté à la liste sans être
// téléchargé : « Installer » s'en charge ensuite.
export async function inspectVoiceModel(url) {
  const repo = String(url ?? '').trim().replace(/^https?:\/\/huggingface\.co\//, '').replace(/\/(tree|blob)\/.*$/, '').replace(/\/+$/, '');
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw failure(400, 'Adresse attendue : https://huggingface.co/auteur/modele');
  const known = allVoiceModels().find((model) => model.repo.toLowerCase() === repo.toLowerCase());
  if (known) return { model: known, known: true, problem: null };
  return inspectVoiceRepo(repo);
}

export async function addVoiceModel(url) {
  const { model, known, problem } = await inspectVoiceModel(url);
  if (known) return model;
  if (problem) throw failure(400, problem);
  let id = slug(model.repo.split('/')[1]);
  for (let n = 2; voiceModelById(id); n += 1) id = `${slug(model.repo.split('/')[1])}-${n}`;
  const added = { ...model, id, custom: true, tagline: `Ajouté depuis Hugging Face (${model.repo}).` };
  update((s) => { s.voice ??= {}; s.voice.added = [...(s.voice.added ?? []), added]; });
  return added;
}

let engineInstall = null;
const installs = new Map();
export function installVoiceModel(id) {
  const model = voiceModelById(id);
  if (!model) return Promise.reject(failure(404, 'Modèle de voix inconnu'));
  if (!nvidiaHere()) return Promise.reject(failure(409, 'vLLM-Omni ne tourne ici que sur une carte Nvidia : installez ce modèle sur une autre machine Harn reliée à celle-ci, elle le prêtera'));
  if (!installs.has(id)) {
    installs.set(id, (async () => {
      patchModel(id, { installing: true, detail: 'Moteur vLLM-Omni', error: null });
      let last = '';
      const onLog = (line) => {
        const text = String(line).trim().split('\n').pop()?.slice(0, 160);
        if (text && text !== last) { last = text; patchModel(id, { detail: text }); }
      };
      try {
        engineInstall ??= installVoiceEngine(onLog).finally(() => { engineInstall = null; });
        const runtime = await engineInstall;
        patchModel(id, { detail: 'Poids du modèle' });
        const dest = path.join(modelsDir, id);
        await downloadVoiceWeights({ repo: model.repo, revision: model.revision, dest, venv: runtime.venv }, onLog);
        patchModel(id, { installing: false, detail: null, error: null, path: dest, revision: model.revision ?? null, installedAt: new Date().toISOString() });
        // Le premier modèle installé devient la voix des agents.
        if (!voiceState().selected?.model) selectDefault(id);
        bus.emit('toast', `${model.name} est installé`);
      } catch (error) {
        patchModel(id, { installing: false, detail: null, error: error.message });
        throw error;
      }
    })().finally(() => installs.delete(id)));
  }
  return installs.get(id);
}

export async function deleteVoiceModel(id) {
  const model = voiceModelById(id);
  if (!model) throw failure(404, 'Modèle de voix inconnu');
  if (installs.has(id)) throw failure(409, 'Installation en cours');
  if (running === id) await stopVoice();
  const where = entryOf(id).path;
  // Seulement sous models/voice ou le dossier du moteur (le Voxtral d'avant, runtime/voxtral/models).
  if (where && [modelsDir, engine()?.dir].filter(Boolean).some((root) => where.startsWith(root + path.sep))) await rm(where, { recursive: true, force: true });
  update((s) => {
    if (s.voice?.models) delete s.voice.models[id];
    if (model.custom) s.voice.added = (s.voice.added ?? []).filter((x) => x.id !== id);
    if (s.voice?.selected?.model === id) s.voice.selected = null;
  });
}

// ── Le choix des agents ──
function selectDefault(modelId) {
  const model = voiceModelById(modelId);
  const { kind, presets } = model ? describeVoiceModel(model) : {};
  const voice = kind === 'preset' ? presets[0] ?? null : samples()[0]?.id ?? null;
  update((s) => { s.voice ??= {}; s.voice.selected = { model: modelId, voice, language: s.voice.selected?.language ?? DEFAULT_LANGUAGE }; });
}

// model : un modèle d'ici ou d'une machine reliée (même identifiant chez elle).
export function selectVoice({ model, voice, language }) {
  const offered = availableModels().find((m) => m.id === model);
  if (!offered) throw failure(404, 'Ce modèle de voix n’est installé ni ici ni sur une machine reliée');
  if (voice && offered.kind === 'preset' && !offered.voices.includes(voice)) throw failure(400, `Voix inconnue pour ${offered.name} : ${voice}`);
  if (voice && offered.kind === 'clone' && !sampleById(voice)) throw failure(400, 'Voix clonée inconnue');
  if (language && !LANGUAGES.some(([code]) => code === language)) throw failure(400, `Langue inconnue : ${language}`);
  update((s) => { s.voice ??= {}; s.voice.selected = { model, voice: voice ?? null, language: language ?? s.voice.selected?.language ?? DEFAULT_LANGUAGE }; });
}

// Les modèles qu'on peut faire parler : ceux d'ici, puis ceux des machines reliées.
function availableModels() {
  const here = nvidiaHere() ? installedModels().map((model) => {
    const { kind, presets } = describeVoiceModel(model);
    return { id: model.id, name: model.name, kind, voices: presets, where: null };
  }) : [];
  const ids = new Set(here.map((m) => m.id));
  const lent = peersWithVoice().flatMap(({ peer, voice }) => voice.models.map((m) => ({ id: m.id, name: m.name ?? m.id, kind: m.kind, voices: m.voices ?? [], where: peer.name })));
  return [...here, ...lent.filter((m) => !ids.has(m.id) && ids.add(m.id))];
}

// Le modèle d'une demande : celui demandé, sinon le choix des agents. Venue d'une autre machine
// (here), seulement un modèle d'ici.
function pickModel(requested, here) {
  // Un nom de modèle d'OpenAI (tts-1…) ou inconnu : le choix des agents.
  if (requested && (voiceModelById(requested) || availableModels().some((m) => m.id === requested))) return requested;
  const choice = effectiveChoice();
  if (!here) return choice?.model.id ?? null;
  return choice && installedHere(choice.model.id) ? choice.model.id : installedModels()[0]?.id ?? null;
}

// Ce qu'une demande sans précision dira : le modèle choisi, sinon le premier disponible.
function effectiveChoice() {
  const offered = availableModels();
  const selected = voiceState().selected ?? {};
  const model = offered.find((m) => m.id === selected.model) ?? offered[0] ?? null;
  if (!model) return null;
  const voice = model.id === selected.model && selected.voice ? selected.voice
    : model.kind === 'preset' ? model.voices[0] ?? null : samples()[0]?.id ?? null;
  return { model, voice, language: selected.language ?? DEFAULT_LANGUAGE };
}

// ── Marche et arrêt ──
let child = null;
let running = null;
let starting = null;
let idleTimer = null;
let streams = 0;
function touch() {
  clearTimeout(idleTimer);
  // Un flux ouvert (un appel en cours) garde la voix en marche.
  idleTimer = setTimeout(() => { if (streams > 0) touch(); else stopVoice().catch(() => {}); }, IDLE_MS);
  idleTimer.unref?.();
}

const healthy = () => fetch(`http://127.0.0.1:${PORTS.voice}/health`).then((r) => r.ok, () => false);

// La route d'un modèle : ici, ou la machine reliée qui l'a.
function routeOf(modelId, here) {
  if (here || (nvidiaHere() && installedHere(modelId))) return null;
  const route = peerWithVoice(modelId);
  if (!route) throw failure(409, installedHere(modelId) ? 'Ce modèle de voix ne tourne ici que sur une carte Nvidia' : 'Ce modèle de voix n’est installé ni ici ni sur une machine reliée joignable');
  return route;
}

const REMOTE_TIMEOUT_MS = START_TIMEOUT_MS + 3 * 60_000;
function remoteCall(route, pathname, body, timeout = REMOTE_TIMEOUT_MS) {
  return fetch(`${route.peer.url}${pathname}`, {
    method: 'POST',
    headers: { ...route.headers, 'content-type': 'application/json', 'X-Harn-Hop': '1' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  }).catch((error) => { throw failure(502, `La voix de « ${route.peer.name} » est injoignable : ${error.name === 'TimeoutError' ? 'pas de réponse' : error.message}`); });
}
async function remoteError(route, res) {
  const text = await res.text();
  let message = text;
  try { message = JSON.parse(text)?.error?.message ?? text; } catch {}
  return failure(res.status === 401 ? 502 : res.status, `La voix de « ${route.peer.name} » : ${String(message).slice(0, 300)}`);
}

// Le modèle de texte déchargé pour faire de la place revient une fois la carte rendue (pendant
// le démarrage, elle est à la voix : il serait refusé), sans faire attendre la voix.
let textToRestore = null;
export async function startVoice({ here = false, model = null } = {}) {
  const id = pickModel(model, here);
  if (!id) throw failure(409, nvidiaHere() ? 'Aucun modèle de voix installé : la vue Modèles en propose' : 'Pas de voix ici (vLLM-Omni demande une carte Nvidia) ni sur une machine reliée joignable');
  const route = routeOf(id, here);
  if (route) {
    const res = await remoteCall(route, '/audio/start', { model: id });
    if (!res.ok) throw await remoteError(route, res);
    return;
  }
  if (!installedHere(id)) throw failure(409, `${voiceModelById(id)?.name ?? id} n’est pas installé ici`);
  if (child && running === id && voiceState().status === 'ready') { touch(); return; }
  // Un démarrage en cours (d'un autre modèle peut-être) se termine d'abord.
  while (starting) await starting.catch(() => {});
  if (child && running === id && voiceState().status === 'ready') { touch(); return; }
  starting = withGpu(`voice:${id}`, () => launch(id)).finally(() => {
    starting = null;
    if (textToRestore) activate(textToRestore).catch(() => {});
    textToRestore = null;
  });
  return starting;
}

// Le dossier deploy/ de vLLM-Omni dans le venv : les profils d'origine, que Harn dérive.
async function deployDirOf(venv) {
  const lib = path.join(venv, 'lib');
  const python = (await readdir(lib).catch(() => [])).find((name) => /^python3\.\d+$/.test(name));
  const dir = python && path.join(lib, python, 'site-packages', 'vllm_omni', 'deploy');
  if (!dir || !existsSync(dir)) throw new Error('vLLM-Omni est incomplet dans son venv : désinstallez puis réinstallez le modèle de voix');
  return dir;
}

async function launch(id) {
  const runtime = engine();
  const model = voiceModelById(id);
  const { family, needMiB } = describeVoiceModel(model);
  if (!family) throw failure(409, `Famille inconnue pour ${model.name}`);
  if (child) await stopVoice();
  patch({ status: 'starting', running: id, since: Date.now(), error: null });
  running = id;
  try {
    const gpu = await sampleGpu();
    if (gpu && gpu.freeMiB < needMiB) {
      // Une réponse en cours se termine d'abord, comme pour une image.
      for (let waited = 0; getLive().request && waited < 120_000; waited += 500) await new Promise((resolve) => setTimeout(resolve, 500));
      const active = getState().active;
      if (active?.status === 'ready' || active?.status === 'loading') textToRestore = active.modelId;
      await stopEngine();
      const after = await sampleGpu();
      if (after && after.freeMiB < needMiB) throw failure(409, `La carte graphique n’a pas la place pour ${model.name} (${Math.round(after.freeMiB / 1024)} Go libres, ~${Math.round(needMiB / 1024)} Go nécessaires)`);
    }
    await mkdir(DIRS.logs, { recursive: true });
    // Les parts de carte des étages se calculent sur sa taille.
    const totalMiB = gpu?.totalMiB ?? getState().hardware?.primary?.vramMiB ?? 24576;
    const share = family.stageMiB(model).map((mib) => Math.min(0.9, mib / totalMiB).toFixed(3));
    const config = path.join(runtime.dir, `deploy-${id}.yaml`);
    await writeFile(config, family.deploy({ share, deployDir: await deployDirOf(runtime.venv) }));
    const log = createWriteStream(path.join(DIRS.logs, 'voice.log'), { flags: 'w' });
    const bin = path.join(runtime.venv, 'bin');
    const args = ['serve', entryOf(id).path, '--omni', '--deploy-config', config, '--served-model-name', id, '--host', '127.0.0.1', '--port', String(PORTS.voice)];
    log.write(`# ${new Date().toISOString()}\n# vllm ${args.join(' ')}\n\n`);
    spareRuntime(runtime.dir, true);
    // Le nvcc de la machine peut être plus ancien que celui que vise FlashInfer : son
    // échantillonneur compilé à la volée est remplacé par celui de PyTorch (même résultat ici).
    const proc = spawn(path.join(bin, 'vllm'), args, {
      cwd: runtime.dir,
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, VLLM_USE_FLASHINFER_SAMPLER: '0', HF_HUB_OFFLINE: '1' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = proc;
    proc.stdout.pipe(log, { end: false });
    proc.stderr.pipe(log, { end: false });
    let tail = '';
    const keep = (chunk) => { tail = (tail + chunk).slice(-8000); };
    proc.stdout.on('data', keep);
    proc.stderr.on('data', keep);
    let exited = false;
    proc.on('exit', (code) => {
      exited = true;
      if (child === proc) {
        child = null;
        running = null;
        spareRuntime(runtime.dir, false);
        if (voiceState().status === 'ready') patch({ status: 'stopped', running: null, error: `La voix s’est arrêtée (code ${code})` });
      }
    });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!(await healthy())) {
      if (exited || Date.now() > deadline) {
        await killTree(proc.pid);
        const reason = tail.split('\n').filter((line) => /Error|error:|out of memory/.test(line)).pop()?.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 300);
        throw new Error(`${model.name} n’a pas démarré${reason ? ` : ${reason}` : ' (voir data/logs/voice.log)'}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    await warmUp(model).catch(() => {});
    patch({ status: 'ready', readyAt: Date.now() });
    touch();
  } catch (error) {
    if (!child) running = null;
    patch({ status: 'error', running: child ? id : null, error: error.message });
    throw error;
  }
}

// Une seconde de son presque muet (un souffle à 220 Hz), en WAV 24 kHz : de quoi faire tourner
// le modèle une fois sans extrait.
function quietWav() {
  const rate = 24000;
  const pcm = Buffer.alloc(rate * 2);
  for (let i = 0; i < rate; i += 1) pcm.writeInt16LE(Math.round(300 * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF'); head.writeUInt32LE(36 + pcm.length, 4); head.write('WAVEfmt ', 8); head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20); head.writeUInt16LE(1, 22); head.writeUInt32LE(rate, 24); head.writeUInt32LE(rate * 2, 28);
  head.writeUInt16LE(2, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(pcm.length, 40);
  return `data:audio/wav;base64,${Buffer.concat([head, pcm]).toString('base64')}`;
}

// La première requête met le moteur en route (compilation, graphes) : faite au démarrage.
async function warmUp(model) {
  const { family, kind, presets } = describeVoiceModel(model);
  if (!family.warmup) return;
  await fetch(`http://127.0.0.1:${PORTS.voice}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input: 'Bonjour.', model: model.id, response_format: 'pcm', ...family.warmup({ kind, presets, silence: quietWav() }) }),
    signal: AbortSignal.timeout(60_000),
  }).then((res) => res.arrayBuffer());
}

export async function stopVoice() {
  clearTimeout(idleTimer);
  const proc = child;
  if (!proc) return;
  child = null;
  running = null;
  await killTree(proc.pid);
  const runtime = engine();
  if (runtime) spareRuntime(runtime.dir, false);
  patch({ status: 'stopped', running: null });
}

// ── La parole en flux (WebSocket, gateway.mjs) ──
// Où relier un client : le moteur d'ici, démarré au besoin, ou la machine reliée qui a le modèle
// (son propre Harn démarre le moteur). release : le client est parti.
export async function openStream({ model = null, here = false } = {}) {
  const id = pickModel(model, here);
  if (!id) throw failure(409, nvidiaHere() ? 'Aucun modèle de voix installé : la vue Modèles en propose' : 'Pas de voix ici (vLLM-Omni demande une carte Nvidia) ni sur une machine reliée joignable');
  const route = routeOf(id, here);
  if (route) {
    const url = new URL(route.peer.url);
    if (url.protocol !== 'http:') throw failure(502, `La voix de « ${route.peer.name} » : flux possible seulement en http sur le réseau local`);
    return {
      host: url.hostname, port: Number(url.port || 80),
      path: `${url.pathname.replace(/\/$/, '')}/audio/speech/stream?model=${encodeURIComponent(id)}`,
      headers: { ...route.headers, 'X-Harn-Hop': '1' }, release: () => {},
    };
  }
  await startVoice({ here: true, model: id });
  streams += 1;
  touch();
  let released = false;
  return {
    host: '127.0.0.1', port: PORTS.voice, path: '/v1/audio/speech/stream', headers: {},
    release: () => { if (released) return; released = true; streams -= 1; touch(); },
  };
}

// ── Parler ──
// Le texte en Ogg/Opus, le format des messages vocaux de Telegram.
// options : model, voice, language ; sans eux, le choix des agents. ref_audio et ref_text : un
// extrait venu d'une autre machine (sa voix clonée), qui prend le pas sur voice.
// here : demandée par un autre Harn, servie avec la voix d'ici seulement (pas d'aller-retour).
export async function speak(text, options = {}, { here = false } = {}) {
  const input = String(text ?? '').trim();
  if (!input) throw failure(400, 'Rien à dire');
  if (input.length > MAX_SPEAK_CHARS) throw failure(400, `Texte limité à ${MAX_SPEAK_CHARS} caractères par message vocal`);
  const opts = typeof options === 'string' ? { voice: options } : options ?? {};
  const choice = effectiveChoice();
  const modelId = pickModel(opts.model, here);
  if (!modelId) throw failure(409, nvidiaHere() ? 'Aucun modèle de voix installé : la vue Modèles en propose' : 'Pas de voix ici (vLLM-Omni demande une carte Nvidia) ni sur une machine reliée joignable');
  const language = opts.language ?? (modelId === choice?.model.id ? choice.language : DEFAULT_LANGUAGE);
  const voice = opts.voice ?? (modelId === choice?.model.id ? choice.voice : null);
  const route = routeOf(modelId, here);

  // Une voix clonée d'ici part avec la requête, même vers une autre machine.
  let sample = opts.ref_audio ? { audio: String(opts.ref_audio), text: opts.ref_text ?? '' } : null;
  const offered = route ? route.voice.models.find((m) => m.id === modelId) : null;
  const kind = route ? offered?.kind : describeVoiceModel(voiceModelById(modelId)).kind;
  if (kind === 'clone' && !sample) {
    const local = voice ? sampleById(voice) : null;
    if (!local) throw failure(409, 'Ce modèle imite une voix : ajoutez une voix clonée (un extrait et sa transcription) dans la vue Modèles, puis choisissez-la');
    sample = { audio: await sampleAudio(local), text: local.text };
    if (!opts.language) sample.language = local.language;
  }
  const lang = sample?.language ?? language;

  if (route) {
    const res = await remoteCall(route, '/audio/speech', { input, model: modelId, voice, language: lang, response_format: 'opus', ...(sample ? { ref_audio: sample.audio, ref_text: sample.text } : {}) });
    if (!res.ok) throw await remoteError(route, res);
    return Buffer.from(await res.arrayBuffer());
  }
  const model = voiceModelById(modelId);
  if (!model || !installedHere(modelId)) throw failure(409, `Le modèle de voix ${modelId} n’est pas installé ici`);
  const { family, presets } = describeVoiceModel(model);
  const said = kind === 'preset' ? voice ?? presets[0] : voice;
  if (kind === 'preset' && !presets.includes(said)) throw failure(400, `Voix inconnue : ${said}. Voix de ${model.name} : ${presets.join(', ')}`);
  await startVoice({ here: true, model: modelId });
  touch();
  const res = await fetch(`http://127.0.0.1:${PORTS.voice}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, model: modelId, response_format: 'opus', ...family.request({ kind, voice: said, sample, language: lang }) }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`La voix a répondu ${res.status} : ${(await res.text()).slice(0, 200)}`);
  touch();
  return Buffer.from(await res.arrayBuffer());
}

// ── Ce que voient l'interface et les autres machines ──
// remote : les modèles que prêtent les machines reliées. canInstall : une carte Nvidia.
export function voiceReport() {
  const vram = getState().hardware?.primary?.vramMiB ?? 0;
  const v = voiceState();
  const choice = effectiveChoice();
  return {
    canInstall: nvidiaHere(),
    installed: voiceInstalled(),
    status: v.status ?? 'stopped',
    running: v.running ?? null,
    error: v.error ?? null,
    models: allVoiceModels().map((model) => {
      const { family, kind, presets, needMiB } = describeVoiceModel(model);
      const entry = entryOf(model.id);
      return {
        id: model.id, name: model.name, tagline: model.tagline, license: model.license, gigabytes: model.gigabytes, repo: model.repo,
        familyName: family?.name ?? null, kind, voices: presets, needMiB, fits: !vram || vram >= needMiB, custom: Boolean(model.custom),
        installing: Boolean(entry.installing), detail: entry.detail ?? null, error: entry.error ?? null, installed: installedHere(model.id),
      };
    }),
    remote: getState().voiceRemote ?? [],
    samples: samples().map(({ id, name, text, language, bytes, createdAt }) => ({ id, name, text, language, bytes, createdAt })),
    selected: v.selected ?? null,
    choice: choice ? { model: choice.model.id, name: choice.model.name, kind: choice.model.kind, voice: choice.voice, language: choice.language, where: choice.model.where } : null,
    languages: LANGUAGES,
  };
}

// Pour un autre Harn (/v1/audio/voices) : les modèles d'ici seulement, jamais ceux d'un pair.
export function voiceOffer() {
  const models = nvidiaHere() ? installedModels().map((model) => {
    const { kind, presets } = describeVoiceModel(model);
    return { id: model.id, name: model.name, kind, voices: presets };
  }) : [];
  // voices : la forme d'avant les modèles de voix (Voxtral seul), pour un Harn qui n'a pas changé.
  return { installed: models.length > 0, models, voices: models.find((m) => m.id === 'voxtral')?.voices ?? [], status: voiceState().status ?? null, running: voiceState().running ?? null };
}

// Au démarrage de Harn : la voix d'avant a été reprise avec les autres orphelins, et un modèle
// dont le dossier a été effacé à la main sort de l'état.
export function resetVoiceState() {
  update((s) => {
    if (!s.voice) return;
    s.voice = { ...s.voice, status: 'stopped', running: null };
    for (const [id, entry] of Object.entries(s.voice.models ?? {})) {
      if (entry.installing) s.voice.models[id] = { ...entry, installing: false, detail: null };
      if (entry.installedAt && !existsSync(entry.path ?? '')) delete s.voice.models[id];
    }
  });
}
