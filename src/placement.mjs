import { modelById, ownLauncher, totalBytes } from './catalog.mjs';
import { layersOf, loadedModels, stopEngine } from './engine.mjs';
import { busyWith } from './gpu-queue.mjs';
import { inUse, lastUseOf } from './idle.mjs';
import { clientsOf } from './metrics.mjs';
import { freeVram, loadWithHeadroom } from './loading.mjs';
import { bus, getState, update } from './state.mjs';
import { HEADROOM_MIN_MIB } from './tuner.mjs';

// Plusieurs modèles sur une carte. Avant de charger, on calcule ce que le modèle prendra (mesuré à
// son dernier chargement avec ce réglage, sinon estimé : poids + cache du contexte + tampons) et
// ce qui reste de libre. S'il ne tient pas, on décharge le modèle inactif utilisé le moins
// récemment ; si tous répondent, on attend qu'une réponse finisse. Le contexte reste celui du banc.
// Les moteurs qui se réservent toute la carte (vLLM, Strata, modèle partagé avec la RAM) ne
// cohabitent avec personne.

const MiB = 2 ** 20;
// Tampons de calcul de llama.cpp (graphe, sorties) en plus des poids et du cache.
const COMPUTE_MIB = 1024;
const WAIT_MS = 15 * 60_000;

export const exclusive = (model, tuning = {}) => ownLauncher(model) || layersOf(tuning) === 'auto' || tuning.backend === 'cpu';
const tuningOf = (modelId) => getState().profiles?.[modelId]?.tuning ?? {};

// Ce que le modèle prendra sur la carte avec ce réglage, en Mio. Chaque session (slots) a son
// propre cache de tout le contexte : une session de plus coûte un cache de plus.
const kvMiB = (model, tuning) => ((tuning.context ?? 32768) * (model.kvBytesPerToken?.[tuning.kv ?? 'q8_0'] ?? model.kvBytesPerToken?.q8_0 ?? 35_000)) / MiB;
export function needMiB(model, tuning = {}) {
  const slots = tuning.slots ?? 1;
  const measured = getState().profiles?.[model.id]?.vram;
  if (measured?.mib && measured.context === (tuning.context ?? null) && measured.kv === (tuning.kv ?? null)) {
    return Math.round(measured.mib + (slots - (measured.slots ?? 1)) * kvMiB(model, tuning) * 1.05);
  }
  return Math.round((totalBytes(model) / MiB + slots * kvMiB(model, tuning) + COMPUTE_MIB) * 1.05);
}

// Un modèle qui travaille : une réponse en cours, ou un banc / un test qui tient la carte pour lui.
const working = (modelId) => inUse(modelId) || busyWith() === modelId;

// Libère la place pour modelId. Rend la liste des modèles déchargés.
export async function makeRoom(modelId, tuning, { waitMs = WAIT_MS } = {}) {
  const model = modelById(modelId);
  const need = needMiB(model, tuning);
  const alone = exclusive(model, tuning);
  const unloaded = [];
  const deadline = Date.now() + waitMs;
  for (;;) {
    const others = loadedModels().filter((id) => id !== modelId);
    if (!others.length) return unloaded;
    // Un moteur exclusif déjà là occupe toute la carte, et un exclusif à charger veut la carte vide.
    const mustGo = others.filter((id) => alone || exclusive(modelById(id) ?? {}, tuningOf(id)));
    let candidates = mustGo;
    if (!mustGo.length) {
      const free = await freeVram();
      // Carte illisible : on charge quand même, loadWithHeadroom vérifie la marge après coup.
      if (free === null || free - need >= HEADROOM_MIN_MIB) return unloaded;
      candidates = others;
    }
    const victim = candidates.filter((id) => !working(id)).sort((a, b) => lastUseOf(a) - lastUseOf(b))[0];
    if (victim) {
      await stopEngine(victim);
      unloaded.push(victim);
      console.log(`[harn] ${victim} déchargé pour faire de la place à ${modelId}`);
      continue;
    }
    if (Date.now() > deadline) throw Object.assign(new Error('La carte graphique est occupée par d’autres modèles en train de répondre : réessayez dans un instant'), { status: 503 });
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

// Un chargement à la fois : deux modèles qui calculeraient la place libre en même temps
// croiraient tous deux qu'elle leur revient.
let queue = Promise.resolve();
const serial = (task) => { const turn = queue.then(task); queue = turn.catch(() => {}); return turn; };

// Charge un modèle à côté des autres : place faite, chargement, puis mémoire réellement prise
// notée dans son profil (la prochaine fois, plus d'estimation). Il reçoit autant de sessions que
// la demande récente en réclame et que la carte en permet (slotsFor).
export function placeAndLoad(model, tuning) {
  return serial(async () => {
    const slots = exclusive(model, tuning) ? 1 : await slotsFor(model, tuning);
    const wanted = { ...tuning, ...(slots > 1 ? { slots } : {}) };
    const unloaded = await makeRoom(model.id, wanted);
    if (unloaded.length) bus.emit('toast', `Place faite pour ${model.name ?? model.id} : ${unloaded.join(', ')} déchargé${unloaded.length > 1 ? 's' : ''}`);
    const before = await freeVram();
    // Marge trop juste après chargement (estimation trop basse) : un autre modèle inactif part
    // d'abord, le contexte ne cède qu'en dernier recours.
    const freeMore = async () => Boolean(await evictOne(model.id));
    const loaded = await loadWithHeadroom(model, wanted, { alone: exclusive(model, wanted), freeMore });
    const after = await freeVram();
    if (before !== null && after !== null && before > after && !exclusive(model, loaded.tuning)) {
      update((s) => { (s.profiles[model.id] ??= {}).vram = { mib: before - after, context: loaded.tuning.context ?? null, kv: loaded.tuning.kv ?? null, slots: loaded.tuning.slots ?? 1, at: new Date().toISOString() }; });
    }
    if (slots > 1) bus.emit('toast', `${model.name ?? model.id} sert maintenant ${slots} sessions en même temps (${Math.round((loaded.tuning.context ?? 0) / 1024)}k de contexte chacune)`);
    updateSharing();
    return loaded;
  });
}

// ── Sessions en parallèle, selon la demande ─────────────────────
// Le moteur démarre avec une session. Une requête qui arrive quand toutes sont prises est notée :
// la demande de pointe des 15 dernières minutes donne le nombre de sessions voulu (4 au plus).
// Changer ce nombre relance le moteur : on ne le fait qu'à un moment où il ne répond à personne
// (entre deux tours d'un agent), jamais au milieu d'une réponse.
//
// Un client peut aussi annoncer ses sessions (en-tête X-Harn-Parallel: N). Elles valent pour CE
// Harn (chaque machine gère sa copie du modèle : un client qui répartit sur pc1 et pc2 annonce à
// chacune ce qu'il lui enverra). L'annonce tient tant que le client la renvoie, et ASKED.ms après
// la dernière : passé ce délai, le moteur est relancé avec moins de sessions dès qu'il ne répond à
// personne, pour rendre la mémoire aux autres usages de la carte. Les requêtes qui portent
// l'annonce ne comptent pas dans la demande observée (15 min) : c'est le client qui décide.
const MAX_SLOTS = 4;
const DEMAND_MS = 15 * 60_000;
export const ASKED = { ms: 60_000, retryMs: 5_000 };
const demand = new Map(); // id du modèle → [{ n, at }]
const asked = new Map();  // id du modèle → { n, at } (dernière annonce du client)
export function noteDemand(modelId, n, now = Date.now()) {
  const list = (demand.get(modelId) ?? []).filter((d) => now - d.at < DEMAND_MS);
  list.push({ n, at: now });
  demand.set(modelId, list);
}
const askedNow = (modelId, now) => { const a = asked.get(modelId); return a && now - a.at < ASKED.ms ? a.n : 1; };
export const wantedSlots = (modelId, now = Date.now()) => Math.min(MAX_SLOTS, Math.max(1, askedNow(modelId, now), ...(demand.get(modelId) ?? []).filter((d) => now - d.at < DEMAND_MS).map((d) => d.n)));

// Le nombre de sessions qui tient : la place libre, plus celle du modèle lui-même s'il est chargé,
// plus celle des modèles inactifs qu'on peut décharger.
export async function slotsFor(model, tuning) {
  const wanted = wantedSlots(model.id);
  if (wanted <= 1) return 1;
  const free = await freeVram();
  if (free === null) return 1;
  const own = getState().engines?.[model.id] ? needMiB(model, { ...tuning, slots: getState().engines[model.id].slots ?? 1 }) : 0;
  const spare = loadedModels().filter((id) => id !== model.id && !working(id) && !exclusive(modelById(id) ?? {}, tuningOf(id)))
    .reduce((sum, id) => sum + needMiB(modelById(id), { ...tuningOf(id), slots: getState().engines[id]?.slots ?? 1 }), 0);
  for (let slots = wanted; slots > 1; slots -= 1) {
    if (free + own + spare - needMiB(model, { ...tuning, slots }) >= HEADROOM_MIN_MIB) return slots;
  }
  return 1;
}

// Valeur de l'en-tête X-Harn-Parallel : 2 à 4 sessions, sinon rien d'annoncé.
export function parallelAsked(value) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 1 ? Math.min(MAX_SLOTS, n) : null;
}

// Appelé par la passerelle à chaque requête, avant de la relayer. n : réponses en cours pour ce
// modèle, celle-ci comprise ; relayed : celles déjà parties au moteur ; askedN : sessions
// annoncées par le client (parallelAsked). Rend la promesse d'un rechargement avec plus de
// sessions quand il est temps, sinon null.
const resizing = new Map();
const shrinkTimers = new Map();
export function followDemand(modelId, n, relayed, reload, askedN = null) {
  if (askedN) {
    asked.set(modelId, { n: askedN, at: Date.now() });
    armShrink(modelId, reload, ASKED.ms);
  } else noteDemand(modelId, n);
  const engine = getState().engines?.[modelId];
  const model = modelById(modelId);
  if (!engine || engine.status !== 'ready' || !model || exclusive(model, tuningOf(modelId))) return null;
  if (resizing.has(modelId)) return resizing.get(modelId);
  if (relayed > 0 || wantedSlots(modelId) <= (engine.slots ?? 1)) return null;
  return resize(modelId, async () => {
    // Rien ne gagne à relancer si la carte n'a pas la place d'une session de plus.
    if (await slotsFor(model, tuningOf(modelId)) <= (engine.slots ?? 1)) {
      notice(`Plus de place pour une ${(engine.slots ?? 1) + 1}e session de ${model.name ?? modelId} : les demandes passent l’une après l’autre`);
      return;
    }
    console.log(`[harn] ${modelId} : ${wantedSlots(modelId)} sessions demandées, rechargement entre deux réponses`);
    await stopEngine(modelId);
    await reload(modelId);
  });
}
function resize(modelId, work) {
  const task = work().finally(() => resizing.delete(modelId));
  resizing.set(modelId, task);
  return task;
}

// L'annonce du client a expiré : moins de sessions, dès que le moteur ne répond à personne.
function armShrink(modelId, reload, delay) {
  clearTimeout(shrinkTimers.get(modelId));
  const timer = setTimeout(() => {
    shrinkTimers.delete(modelId);
    const engine = getState().engines?.[modelId];
    if (!engine || engine.status !== 'ready' || wantedSlots(modelId) >= (engine.slots ?? 1)) return;
    if (inUse(modelId) || resizing.has(modelId)) return armShrink(modelId, reload, ASKED.retryMs);
    console.log(`[harn] ${modelId} : annonce du client expirée, retour à ${wantedSlots(modelId)} session(s)`);
    resize(modelId, async () => { await stopEngine(modelId); await reload(modelId); }).catch(() => {});
  }, delay + 50);
  timer.unref?.();
  shrinkTimers.set(modelId, timer);
}

// ── Prévenir l'utilisateur ─────────────────────────────────────
// Plusieurs modèles sur la carte, ou plusieurs clients sur un même modèle : tout le monde va
// plus lentement. state.sharing le dit dans la fenêtre, avec qui est concerné ; un message
// s'affiche à chaque nouvelle situation.
const toasted = new Set();
function notice(message) {
  if (toasted.has(message)) return;
  toasted.add(message);
  setTimeout(() => toasted.delete(message), DEMAND_MS).unref?.();
  bus.emit('toast', message);
}
export function updateSharing() {
  const engines = Object.entries(getState().engines ?? {}).filter(([, e]) => ['ready', 'loading'].includes(e.status));
  const items = [];
  if (engines.length > 1) items.push({ kind: 'models', models: engines.map(([id]) => ({ id, name: modelById(id)?.name ?? id, busy: inUse(id) })) });
  for (const [id] of engines) {
    const who = clientsOf(id);
    if (who.length > 1) items.push({ kind: 'sessions', model: id, name: modelById(id)?.name ?? id, clients: who, slots: getState().engines[id]?.slots ?? 1, max: exclusive(modelById(id) ?? {}, tuningOf(id)) ? 1 : MAX_SLOTS });
  }
  const next = items.length ? items : null;
  if (JSON.stringify(next) === JSON.stringify(getState().sharing ?? null)) return;
  update((s) => { s.sharing = next; });
  for (const item of items) {
    if (item.kind === 'sessions') notice(`${item.name} répond à ${item.clients.length} demandes en même temps (${[...new Set(item.clients)].join(', ')}) : chacune va plus lentement${item.slots < item.clients.length ? ', certaines attendent leur tour' : ''}. Si l’une ne vous sert pas, fermez-la.`);
    if (item.kind === 'models' && item.models.filter((m) => m.busy).length > 1) notice(`${item.models.length} modèles se partagent la carte et répondent ensemble : chacun va plus lentement. Déchargez celui qui ne vous sert pas.`);
  }
}

// Décharge le modèle inactif le moins récemment utilisé (autre que keep). Rend son id, ou null.
export async function evictOne(keep) {
  const victim = loadedModels().filter((id) => id !== keep && !working(id)).sort((a, b) => lastUseOf(a) - lastUseOf(b))[0];
  if (!victim) return null;
  await stopEngine(victim);
  console.log(`[harn] ${victim} déchargé : marge trop juste pour ${keep}`);
  return victim;
}
