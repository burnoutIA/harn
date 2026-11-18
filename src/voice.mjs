import { spawn } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { activate } from './activation.mjs';
import { killTree, spareRuntime, stopEngine } from './engine.mjs';
import { withGpu } from './gpu-queue.mjs';
import { sampleGpu } from './hardware.mjs';
import { getLive } from './metrics.mjs';
import { DIRS, PORTS } from './paths.mjs';
import { peerWithVoice } from './peers.mjs';
import { installVoxtral } from './runtimes.mjs';
import { bus, getState, update } from './state.mjs';

// La voix des agents : Voxtral TTS (Mistral, 4B) servi par vLLM-Omni, à côté du modèle de texte.
// Lancée par /parler sur Telegram, arrêtée après un quart d'heure sans rien dire. Poids compressés
// en fp8 au chargement et une seule requête à la fois : ~8,5 Go sur la carte (3090), et 30 s
// d'audio en 5 s. Le modèle de texte, s'il manque de place, est déchargé puis rechargé :
// loadWithHeadroom lui retire alors du contexte pour ce chargement-là seulement.

export const VOICES = ['fr_female', 'fr_male'];
export const DEFAULT_VOICE = 'fr_female';
// Ce que les deux étages de vLLM-Omni prennent, mesuré sur une 3090 : le premier (modèle de
// langue et transformeur acoustique) ~5,7 Go, le second (codec) ~1 Go, plus le contexte CUDA de
// chaque processus. En dessous de 5,2 Go pour le premier, vLLM refuse de démarrer.
const STAGE_MIB = [5800, 1000];
const NEED_MIB = 8800;
const IDLE_MS = 15 * 60_000;
const START_TIMEOUT_MS = 10 * 60_000;
// Une requête : le texte en jetons plus 12,5 trames d'audio par seconde. 2048 couvrent ~2 min de
// parole ; l'extension Telegram découpe les réponses plus longues.
const MAX_MODEL_LEN = 2048;
export const MAX_SPEAK_CHARS = 1200;
const SERVED = 'voxtral';

const failure = (status, message) => Object.assign(new Error(message), { status });
const voiceState = () => getState().voice ?? {};
const patch = (fields) => update((s) => { s.voice = { ...(s.voice ?? {}), ...fields }; });
const runtime = () => getState().runtimes?.voxtral ?? null;
// Installée, et toujours là : un dossier runtime/voxtral effacé à la main ne compte plus.
export const voiceInstalled = () => Boolean(runtime()?.installedAt && existsSync(runtime().model ?? ''));
// vLLM et vLLM-Omni installés par pip visent CUDA : Voxtral ne tourne que sur une carte Nvidia.
// Une machine sans elle (la R9700) prend la voix d'un pair qui l'a (peers.mjs) : il la fait
// tourner sur sa carte et renvoie l'audio, rien ne bouge ici.
const nvidiaHere = () => getState().hardware?.primary?.vendor === 'nvidia';
// Le démarrage à froid chez le pair (chargement, compilation des noyaux) peut prendre plusieurs
// minutes : la première requête l'attend.
const REMOTE_TIMEOUT_MS = START_TIMEOUT_MS + 3 * 60_000;
const remote = () => (voiceInstalled() ? null : peerWithVoice());
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

// La deploy-config de vLLM-Omni pour Voxtral (vllm_omni/deploy/voxtral_tts.yaml), ramenée à une
// requête à la fois. Les parts de carte se calculent sur sa taille.
function deployConfig(totalMiB) {
  const share = (mib) => Math.min(0.9, mib / totalMiB).toFixed(3);
  const common = `    trust_remote_code: true
    enable_prefix_caching: false
    devices: "0"
    tokenizer_mode: mistral
    config_format: mistral
    load_format: mistral
    skip_mm_profiling: true`;
  return `# Écrit par Harn (src/voice.mjs) : Voxtral à côté du modèle de texte.
async_chunk: true
connectors:
  connector_of_shared_memory:
    name: SharedMemoryConnector
    extra:
      codec_streaming: true
      connector_get_sleep_s: 0.01
      connector_get_max_wait_first_chunk: 3000
      connector_get_max_wait: 300
      codec_chunk_frames: 25
      codec_chunk_frames_at_begin: 5
      codec_left_context_frames: 25
stages:
  - stage_id: 0
    max_num_batched_tokens: ${MAX_MODEL_LEN}
    max_num_seqs: 1
    gpu_memory_utilization: ${share(STAGE_MIB[0])}
    enforce_eager: false
    quantization: fp8
    async_scheduling: true
    max_model_len: ${MAX_MODEL_LEN}
    enable_chunked_prefill: false
${common}
    output_connectors:
      to_stage_1: connector_of_shared_memory
    default_sampling_params:
      temperature: 0.0
      top_p: 1.0
      top_k: -1
      max_tokens: ${MAX_MODEL_LEN}
      seed: 42
      repetition_penalty: 1.1
      extra_args:
        cfg_alpha: 1.2
  - stage_id: 1
    max_num_batched_tokens: 8192
    max_num_seqs: 1
    gpu_memory_utilization: ${share(STAGE_MIB[1])}
    enforce_eager: true
    async_scheduling: false
    max_model_len: 8192
${common}
    input_connectors:
      from_stage_0: connector_of_shared_memory
    default_sampling_params:
      temperature: 0.9
      top_p: 0.8
      top_k: 40
      max_tokens: ${MAX_MODEL_LEN}
      seed: 42
      repetition_penalty: 1.05
`;
}

// ── Installation (depuis la fenêtre de Harn) ──
let installing = null;
export function installVoice() {
  if (!nvidiaHere()) return Promise.reject(failure(409, 'Voxtral ne tourne que sur une carte Nvidia : installez la voix sur une autre machine Harn reliée à celle-ci, elle la prêtera'));
  installing ??= (async () => {
    patch({ installing: true, detail: 'Préparation', error: null });
    let last = '';
    try {
      await installVoxtral((line) => {
        const text = String(line).trim().split('\n').pop()?.slice(0, 160);
        if (text && text !== last) { last = text; patch({ detail: text }); }
      });
      patch({ installing: false, detail: null, error: null });
      bus.emit('toast', 'La voix est installée');
    } catch (error) {
      patch({ installing: false, detail: null, error: error.message });
      throw error;
    }
  })().finally(() => { installing = null; });
  return installing;
}

// ── Marche et arrêt ──
let child = null;
let starting = null;
let idleTimer = null;
function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { stopVoice().catch(() => {}); }, IDLE_MS);
  idleTimer.unref?.();
}

const healthy = () => fetch(`http://127.0.0.1:${PORTS.voice}/health`).then((r) => r.ok, () => false);

// Le modèle de texte déchargé pour faire de la place revient une fois la carte rendue (pendant
// le démarrage, elle est à la voix : il serait refusé), sans faire attendre la voix.
let textToRestore = null;
export function startVoice({ here = false } = {}) {
  const route = here ? null : remote();
  if (route) return remoteCall(route, '/audio/start', {}).then(async (res) => { if (!res.ok) throw await remoteError(route, res); });
  if (child && voiceState().status === 'ready') { touch(); return Promise.resolve(); }
  starting ??= withGpu('voice:voxtral', launch).finally(() => {
    starting = null;
    if (textToRestore) activate(textToRestore).catch(() => {});
    textToRestore = null;
  });
  return starting;
}

async function launch() {
  const info = runtime();
  if (!info?.installedAt) throw failure(409, 'La voix n’est pas installée : l’installer depuis la fiche de l’agent, dans Harn');
  if (child) return;
  patch({ status: 'starting', since: Date.now(), error: null });
  try {
    const gpu = await sampleGpu();
    if (gpu && gpu.freeMiB < NEED_MIB) {
      // Une réponse en cours se termine d'abord, comme pour une image.
      for (let waited = 0; getLive().request && waited < 120_000; waited += 500) await new Promise((resolve) => setTimeout(resolve, 500));
      const active = getState().active;
      if (active?.status === 'ready' || active?.status === 'loading') textToRestore = active.modelId;
      await stopEngine();
      const after = await sampleGpu();
      if (after && after.freeMiB < NEED_MIB) throw failure(409, `La carte graphique n’a pas la place pour la voix (${Math.round(after.freeMiB / 1024)} Go libres, ~${Math.round(NEED_MIB / 1024)} Go nécessaires)`);
    }
    await mkdir(DIRS.logs, { recursive: true });
    const config = path.join(info.dir, 'deploy.yaml');
    await writeFile(config, deployConfig(gpu?.totalMiB ?? getState().hardware?.primary?.vramMiB ?? 24576));
    const log = createWriteStream(path.join(DIRS.logs, 'voice.log'), { flags: 'w' });
    const bin = path.join(info.venv, 'bin');
    const args = ['serve', info.model, '--omni', '--deploy-config', config, '--served-model-name', SERVED, '--host', '127.0.0.1', '--port', String(PORTS.voice)];
    log.write(`# ${new Date().toISOString()}\n# vllm ${args.join(' ')}\n\n`);
    spareRuntime(info.dir, true);
    // Le nvcc de la machine peut être plus ancien que celui que vise FlashInfer : son
    // échantillonneur compilé à la volée est remplacé par celui de PyTorch (même résultat ici).
    const proc = spawn(path.join(bin, 'vllm'), args, {
      cwd: info.dir,
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
        spareRuntime(info.dir, false);
        if (voiceState().status === 'ready') patch({ status: 'stopped', error: `La voix s’est arrêtée (code ${code})` });
      }
    });
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (!(await healthy())) {
      if (exited || Date.now() > deadline) {
        await killTree(proc.pid);
        const reason = tail.split('\n').filter((line) => /Error|error:|out of memory/.test(line)).pop()?.replace(/\x1b\[[0-9;]*m/g, '').trim().slice(0, 300);
        throw new Error(`La voix n’a pas démarré${reason ? ` : ${reason}` : ' (voir data/logs/voice.log)'}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    patch({ status: 'ready', readyAt: Date.now() });
    touch();
  } catch (error) {
    patch({ status: 'error', error: error.message });
    throw error;
  }
}

export async function stopVoice() {
  clearTimeout(idleTimer);
  const proc = child;
  if (!proc) return;
  child = null;
  await killTree(proc.pid);
  const info = runtime();
  if (info) spareRuntime(info.dir, false);
  patch({ status: 'stopped' });
}

// ── Parler ──
// Le texte en Ogg/Opus, le format des messages vocaux de Telegram.
// here : demandée par un autre Harn, servie avec la voix d'ici seulement (pas d'aller-retour).
export async function speak(text, voice = DEFAULT_VOICE, { here = false } = {}) {
  const input = String(text ?? '').trim();
  if (!input) throw failure(400, 'Rien à dire');
  if (input.length > MAX_SPEAK_CHARS) throw failure(400, `Texte limité à ${MAX_SPEAK_CHARS} caractères par message vocal`);
  if (!VOICES.includes(voice)) throw failure(400, `Voix inconnue : ${voice}. Voix : ${VOICES.join(', ')}`);
  const route = here ? null : remote();
  if (route) {
    const res = await remoteCall(route, '/audio/speech', { input, model: SERVED, voice, response_format: 'opus' });
    if (!res.ok) throw await remoteError(route, res);
    return Buffer.from(await res.arrayBuffer());
  }
  if (!voiceInstalled()) throw failure(409, nvidiaHere() ? 'La voix n’est pas installée : l’installer depuis la fiche de l’agent, dans Harn' : 'Pas de voix ici (Voxtral demande une carte Nvidia) ni sur une machine reliée joignable');
  await startVoice({ here: true });
  touch();
  const res = await fetch(`http://127.0.0.1:${PORTS.voice}/v1/audio/speech`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ input, model: SERVED, voice, response_format: 'opus' }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`La voix a répondu ${res.status} : ${(await res.text()).slice(0, 200)}`);
  touch();
  return Buffer.from(await res.arrayBuffer());
}

// remote : la machine qui prête sa voix, quand celle-ci n'en a pas. canInstall : une carte Nvidia.
export function voiceReport() {
  const route = remote();
  return { installed: voiceInstalled(), canInstall: nvidiaHere(), voices: VOICES, ...voiceState(), remote: route ? { name: route.peer.name, status: route.voice.status } : null };
}
