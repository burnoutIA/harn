import { EventEmitter } from 'node:events';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { sampleGpu } from './hardware.mjs';
import { DIRS } from './paths.mjs';
import { getState, update } from './state.mjs';

// Le direct : GPU chaque seconde, et pendant une génération le compteur du moteur lui-même
// (/slots → n_decoded). Compter les événements SSE ment dès que le décodage spéculatif livre
// plusieurs tokens par événement (35 tok/s affichés pour 86 réels sur le poste de référence).
export const live = new EventEmitter();
live.setMaxListeners(100);

const HISTORY_FILE = path.join(DIRS.data, 'requests.jsonl');
const SERIES_LENGTH = 120;

const snapshot = {
  gpu: null,
  request: null,       // la requête en cours
  series: [],          // { t, tps } : un point par seconde, 0 quand rien ne tourne
  recent: [],          // les 30 dernières requêtes terminées
};

let viewers = 0;
let gpuTimer = null;
let slotTimer = null;

export const getLive = () => snapshot;

export function addViewer() {
  viewers += 1;
  if (!gpuTimer) gpuTimer = setInterval(tick, 1000);
  return () => {
    viewers -= 1;
    if (viewers <= 0 && !snapshot.request) { clearInterval(gpuTimer); gpuTimer = null; viewers = 0; }
  };
}

async function tick() {
  snapshot.gpu = await sampleGpu();
  const tps = snapshot.request?.phase === 'decode' ? snapshot.request.tps ?? 0 : 0;
  snapshot.series.push({ t: Date.now(), tps: +tps.toFixed(1) });
  if (snapshot.series.length > SERIES_LENGTH) snapshot.series.shift();
  live.emit('live', snapshot);
}

function decodedFromSlots(slots) {
  const slot = [].concat(slots).find((item) => item?.is_processing) ?? null;
  if (!slot) return null;
  const next = Array.isArray(slot.next_token) ? slot.next_token[0] : slot.next_token;
  return {
    decoded: slot.n_decoded ?? next?.n_decoded ?? null,
    promptProcessed: slot.n_prompt_tokens_processed ?? slot.n_past ?? null,
  };
}

// Début d'une requête relayée par la passerelle.
export function beginRequest({ model, client, endpoint, engine }) {
  const request = { id: Date.now().toString(36), model, client, engine, startedAt: Date.now(), phase: 'prefill', decoded: 0, tps: null, ttft: null, chunks: 0 };
  snapshot.request = request;
  if (!gpuTimer) gpuTimer = setInterval(tick, 1000);

  let lastDecoded = 0;
  let lastAt = Date.now();
  if (engine === 'llama') {
    slotTimer = setInterval(async () => {
      const slots = await fetch(`${endpoint}/slots`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const info = slots && decodedFromSlots(slots);
      if (!info || info.decoded === null || snapshot.request !== request) return;
      const now = Date.now();
      if (info.decoded > 0 && request.phase === 'prefill') {
        request.phase = 'decode';
        request.ttft = (now - request.startedAt) / 1000;
        request.decodeStartedAt = now;
        lastDecoded = info.decoded;
        lastAt = now;
      } else if (info.decoded > lastDecoded) {
        // Lissage court : le débit instantané d'un cycle MTP est trop haché pour être lu.
        const instant = (info.decoded - lastDecoded) / ((now - lastAt) / 1000);
        request.tps = request.tps === null ? instant : request.tps * 0.6 + instant * 0.4;
        lastDecoded = info.decoded;
        lastAt = now;
      }
      request.decoded = info.decoded;
      live.emit('live', snapshot);
    }, 400);
  }
  live.emit('live', snapshot);
  return request;
}

// Pour Strata (pas de /slots) : estimation par morceaux, remplacée à la fin par l'usage.
export function onChunk(request, tokens = 1) {
  request.chunks += 1;
  if (request.engine === 'llama') return;
  const now = Date.now();
  if (request.phase === 'prefill') {
    request.phase = 'decode';
    request.ttft = (now - request.startedAt) / 1000;
    request.decodeStartedAt = now;
  }
  request.decoded += tokens;
  const elapsed = (now - request.decodeStartedAt) / 1000;
  if (elapsed > 0.3) request.tps = request.decoded / elapsed;
}

// Fin de requête : les compteurs du moteur font foi (timings llama.cpp, usage OpenAI).
export async function endRequest(request, { timings, usage, error }) {
  clearInterval(slotTimer);
  slotTimer = null;
  const now = Date.now();
  const generated = timings?.predicted_n ?? usage?.completion_tokens ?? request.decoded;
  const decodeSeconds = timings?.predicted_ms ? timings.predicted_ms / 1000 : request.decodeStartedAt ? (now - request.decodeStartedAt) / 1000 : null;
  const record = {
    at: new Date(request.startedAt).toISOString(),
    model: request.model,
    client: request.client,
    promptTokens: (timings?.prompt_n ?? 0) + (timings?.cache_n ?? 0) || usage?.prompt_tokens || null,
    cachedTokens: timings?.cache_n ?? usage?.prompt_tokens_details?.cached_tokens ?? null,
    prefillTps: timings?.prompt_per_second ?? null,
    generated,
    tps: timings?.predicted_per_second ?? (decodeSeconds ? generated / decodeSeconds : null),
    ttft: request.ttft,
    draftAcceptance: timings?.draft_n ? timings.draft_n_accepted / timings.draft_n : null,
    seconds: (now - request.startedAt) / 1000,
    estimated: !timings,
    error: error ?? null,
  };
  snapshot.request = null;
  snapshot.recent.unshift(record);
  snapshot.recent.length = Math.min(snapshot.recent.length, 30);
  live.emit('live', snapshot);
  live.emit('request', record);

  // Le débit réel d'usage, par modèle : c'est lui qu'on affiche à côté du banc.
  if (record.tps && !error && generated >= 64) {
    update((s) => {
      const profile = (s.profiles[record.model] ??= {});
      const usageStats = (profile.usage ??= { requests: 0, tokens: 0, seconds: 0 });
      usageStats.requests += 1;
      usageStats.tokens += generated;
      usageStats.seconds += generated / record.tps;
      usageStats.lastTps = record.tps;
    });
  }
  await mkdir(DIRS.data, { recursive: true });
  await appendFile(HISTORY_FILE, `${JSON.stringify(record)}\n`).catch(() => {});
}

export async function loadRecent() {
  const text = await readFile(HISTORY_FILE, 'utf8').catch(() => '');
  snapshot.recent = text.trim().split('\n').filter(Boolean).slice(-30).reverse().map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

export const activeModel = () => getState().active;
