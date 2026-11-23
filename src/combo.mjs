import { activate } from './activation.mjs';
import { modelById } from './catalog.mjs';
import { comboOf, comboText, comboVoice } from './combo-state.mjs';
import { loadedModels, stopEngine } from './engine.mjs';
import { busyWith } from './gpu-queue.mjs';
import { sampleGpu } from './hardware.mjs';
import { inUse, lastUseOf } from './idle.mjs';
import { startingTuning } from './loading.mjs';
import { peerById, peerModels, peerRoute, peersWithVoice } from './peers.mjs';
import { exclusive, needMiB } from './placement.mjs';
import { bus, getState, update } from './state.mjs';
import { HEADROOM_MIN_MIB } from './tuner.mjs';
import { allVoiceModels, startVoice, stopVoice, voiceActivity, voiceInstalledHere, voiceModelById } from './voice.mjs';
import { describeVoiceModel } from './voice-models.mjs';

// Un combo : deux modèles gardés ensemble sur la carte, un modèle de voix et un modèle de texte
// (Qwen3-TTS + Qwen3.8-27B sur une 3090) ou deux modèles de texte. Hors combo, un modèle qu'on
// appelle fait de la place en déchargeant les autres ; dans un combo, les deux sont réservés :
// une demande qui aurait à les décharger est refusée (409), jamais servie à leurs dépens.
//
// Harn fait d'abord le plan : la place de chacun (mesurée au dernier chargement, sinon estimée),
// et pour le texte le plus grand contexte qui laisse la place à l'autre, sans descendre sous
// minContext. Le réglage du texte reste celui du banc, seuls le contexte (et un cache f16 qui passe en
// q8_0) changent, et seulement le temps du combo. Une voix qui sait se faire plus petite (fp8, voice-models.mjs) l'est ici.
//
// Un combo vit sur une carte : celle d'ici, ou celle d'une autre machine Harn quand tous ses
// modèles portent son nom (« modele@pc2 »). La demande lui est alors relayée telle quelle.

const STEP = 4096;
// En dessous, un modèle de texte ne sert plus à grand-chose à un agent.
const FLOOR_CONTEXT = 16384;
// Comme un modèle de texte seul (idle.mjs) : 10 minutes sans requête, et les deux s'en vont.
const IDLE_MINUTES = 10;
const WAIT_MS = 120_000;

const failure = (status, message, extra = {}) => Object.assign(new Error(message), { status, ...extra });
const gb = (mib) => `${(mib / 1024).toFixed(1).replace('.', ',')} Go`;
const k = (tokens) => `${Math.round(tokens / 1024)}k`;
const nvidiaHere = () => getState().hardware?.primary?.vendor === 'nvidia';

// Le réglage d'un modèle de texte : celui du banc, sinon celui de départ.
function benchTuning(model) {
  const saved = getState().profiles[model.id]?.tuning;
  return saved?.backend ? saved : startingTuning(model, getState().hardware);
}

// Le cache réellement chargé (argument --cache-type-k).
function loadedKv(id) {
  const args = getState().engines?.[id]?.args ?? [];
  return args.includes('--cache-type-k') ? args[args.indexOf('--cache-type-k') + 1] : null;
}

// Le contexte réellement chargé (argument -c, partagé entre ses sessions).
function loadedContext(id) {
  const engine = getState().engines?.[id];
  const args = engine?.args ?? [];
  return args.includes('-c') ? Math.floor(Number(args[args.indexOf('-c') + 1]) / (engine.slots ?? 1)) : null;
}

function member(id) {
  const text = modelById(id);
  if (text && getState().models[id]?.installedAt) return { id, kind: 'text', model: text, name: text.name + (text.variant ? ` ${text.variant.split(' · ')[0]}` : '') };
  const voice = voiceModelById(id);
  if (voice && voiceInstalledHere(id)) return { id, kind: 'voice', model: voice, name: voice.name };
  throw failure(404, `« ${id} » n’est installé ici ni comme modèle de texte ni comme modèle de voix`);
}

// Le plan d'un combo sur la carte d'ici : rien n'est chargé. ok : il tient ; sinon problem dit
// pourquoi, avec ce qui manque.
export async function planCombo(ids, { minContext = null } = {}) {
  if (!Array.isArray(ids) || ids.length !== 2 || ids.some((id) => typeof id !== 'string' || !id)) throw failure(400, 'Un combo, ce sont deux modèles : {"models": ["texte", "voix"]}');
  if (ids[0] === ids[1]) throw failure(400, 'Deux modèles différents : un modèle avec lui-même, c’est X-Harn-Parallel');
  const members = ids.map(member);
  const voices = members.filter((m) => m.kind === 'voice');
  if (voices.length > 1) throw failure(400, 'Une seule voix à la fois : les modèles de voix partagent un seul moteur (vLLM-Omni)');
  if (voices.length && !nvidiaHere()) throw failure(409, 'La voix ne tourne ici que sur une carte Nvidia');
  const floor = Math.max(FLOOR_CONTEXT, Number(minContext) || 0);

  const planned = members.map((m) => {
    if (m.kind === 'voice') {
      const { needMiB: full, compact } = describeVoiceModel(m.model);
      return { id: m.id, kind: 'voice', name: m.name, needMiB: compact?.needMiB ?? full, compact: Boolean(compact) };
    }
    const tuning = benchTuning(m.model);
    if (exclusive(m.model, tuning)) throw failure(409, `${m.name} se réserve toute la carte (${m.model.engine === 'llama' ? 'il déborde sur la mémoire du processeur' : `moteur ${m.model.engine}`}) : il ne peut pas la partager`);
    if ((tuning.context ?? 0) < floor) throw failure(409, `${m.name} n’a que ${k(tuning.context ?? 0)} de contexte retenu au banc, moins que les ${k(floor)} demandés`);
    return { id: m.id, kind: 'text', name: m.name, model: m.model, benchContext: tuning.context, tuning: { ...tuning, slots: undefined, context: tuning.context } };
  });
  const sizeOf = (p) => (p.kind === 'voice' ? p.needMiB : needMiB(p.model, { ...p.tuning, slots: 1 }));

  const gpu = await sampleGpu();
  const totalMiB = gpu?.totalMiB ?? getState().hardware?.primary?.vramMiB ?? 0;
  if (!totalMiB) throw failure(409, 'Taille de la carte graphique inconnue : pas de combo possible');
  // Le bureau et les autres programmes, relevés au démarrage de Harn (carte sans modèle).
  const desktopMiB = Math.max(0, getState().vramBaselineMiB ?? 1024);
  const availableMiB = totalMiB - desktopMiB - HEADROOM_MIN_MIB;

  // Le contexte cède par paliers, d'abord celui du texte qui en a le plus.
  const texts = planned.filter((p) => p.kind === 'text');
  const total = () => planned.reduce((sum, p) => sum + sizeOf(p), 0);
  const fit = (kvOf) => {
    for (const p of texts) {
      const kv = kvOf(p);
      p.tuning = { ...p.tuning, kv, ...(kv !== benchKv.get(p) ? { kvV: kv } : {}), context: Math.floor(p.benchContext / STEP) * STEP };
    }
    for (;;) {
      if (total() <= availableMiB) break;
      const widest = texts.filter((p) => p.tuning.context - STEP >= floor).sort((a, b) => b.tuning.context - a.tuning.context)[0];
      if (!widest) break;
      widest.tuning.context -= STEP;
    }
    return { ok: total() <= availableMiB, context: texts.reduce((sum, p) => sum + p.tuning.context, 0), tunings: texts.map((p) => p.tuning) };
  };
  // Un cache f16 qu'il faudrait raccourcir passe d'abord en q8_0 (sans perte mesurée) : on garde
  // celui des deux qui laisse le plus de contexte.
  const benchKv = new Map(texts.map((p) => [p, p.tuning.kv]));
  const asBenched = fit((p) => benchKv.get(p));
  const shrunk = texts.some((p, i) => asBenched.tunings[i].context < p.benchContext);
  const narrower = texts.filter((p) => (benchKv.get(p) ?? 'f16') === 'f16' && p.model.kvBytesPerToken?.q8_0);
  if (shrunk && narrower.length) {
    const q8 = fit((p) => (narrower.includes(p) ? 'q8_0' : benchKv.get(p)));
    const better = q8.ok && (!asBenched.ok || q8.context > asBenched.context);
    if (!better) texts.forEach((p, i) => { p.tuning = asBenched.tunings[i]; });
  }
  const usedMiB = total();
  const ok = usedMiB <= availableMiB;
  const models = planned.map((p) => ({
    id: p.id, kind: p.kind, name: p.name, needMiB: sizeOf(p),
    ...(p.kind === 'text' ? { context: p.tuning.context, benchContext: p.benchContext, kv: p.tuning.kv ?? null, tuning: p.tuning } : { compact: p.compact }),
  }));
  const budget = { totalMiB, desktopMiB, headroomMiB: HEADROOM_MIN_MIB, availableMiB, usedMiB, spareMiB: availableMiB - usedMiB };
  const problem = ok ? null : `Il manque ${gb(usedMiB - availableMiB)} sur la carte (${gb(totalMiB)}, dont ${gb(desktopMiB)} au bureau et ${gb(HEADROOM_MIN_MIB)} de marge) : ${models.map((m) => `${m.name} ${gb(m.needMiB)}${m.context ? ` à ${k(m.context)}` : ''}`).join(', ')}${texts.length ? `. Même au plus petit contexte (${k(floor)}), ça ne tient pas` : ''}`;
  return { ok, problem, budget, models };
}

// La forme publique d'un plan : sans le réglage complet du moteur.
const publicPlan = (plan) => ({ ...plan, models: plan.models.map(({ tuning, ...m }) => m) });

const waitIdle = async (id) => {
  for (let waited = 0; inUse(id) && waited < WAIT_MS; waited += 500) await new Promise((resolve) => setTimeout(resolve, 500));
};

let starting = null;
export function startCombo(ids, options = {}) {
  if (starting) return Promise.reject(failure(409, 'Un combo est déjà en train de démarrer'));
  starting = run(ids, options).finally(() => { starting = null; });
  return starting;
}

async function run(ids, { minContext = null, idleMinutes = IDLE_MINUTES } = {}) {
  const current = comboOf();
  if (current) {
    const same = current.models.length === ids?.length && current.models.every((m) => ids.includes(m.id));
    if (same && current.status === 'ready') return comboReport();
    throw failure(409, `Un combo tient déjà la carte (${current.models.map((m) => m.name).join(' + ')}) : arrêtez-le d’abord`);
  }
  if (busyWith()) throw failure(409, 'Harn mesure un modèle ou génère une image : réessayez dans quelques minutes');
  const plan = await planCombo(ids, { minContext });
  if (!plan.ok) throw failure(409, plan.problem, { plan: publicPlan(plan) });
  const since = Date.now();
  const idle = Math.max(0, Number(idleMinutes ?? IDLE_MINUTES) || 0);
  update((s) => {
    s.combo = { status: 'starting', since, readyAt: null, error: null, idleMinutes: idle, budget: plan.budget, models: plan.models.map((m) => ({ ...m })) };
  });
  const stillOurs = () => {
    if (getState().combo?.since !== since) throw failure(409, 'Combo arrêté pendant son démarrage');
  };
  try {
    // La carte se vide de tout ce qui n'est pas du combo, et d'un modèle du combo chargé avec un
    // autre contexte, un autre cache (ou plusieurs sessions) : il revient au contexte du plan.
    for (const id of loadedModels()) {
      const text = comboText(id);
      if (text && loadedContext(id) === text.tuning.context && loadedKv(id) === (text.tuning.kv ?? null) && (getState().engines[id]?.slots ?? 1) === 1) continue;
      await waitIdle(id);
      await stopEngine(id);
    }
    const voiceId = comboVoice();
    const voice = voiceActivity();
    const wantCompact = Boolean(plan.models.find((m) => m.id === voiceId)?.compact);
    if (voice.running && (voice.running !== voiceId || voice.compact !== wantCompact)) await stopVoice();
    stillOurs();
    // La voix d'abord : vLLM-Omni vérifie la place libre à son démarrage, llama.cpp non.
    if (voiceId) await startVoice({ here: true, model: voiceId });
    for (const m of plan.models.filter((x) => x.kind === 'text')) {
      stillOurs();
      await activate(m.id);
    }
    stillOurs();
    // Le contexte réellement chargé : la marge vérifiée au chargement a pu le réduire.
    update((s) => {
      s.combo.status = 'ready';
      s.combo.readyAt = Date.now();
      for (const m of s.combo.models) if (m.kind === 'text') m.context = loadedContext(m.id) ?? m.context;
    });
    const ready = `Combo prêt : ${plan.models.map((m) => m.name + (m.context ? ` (${k(loadedContext(m.id) ?? m.context)})` : '')).join(' + ')}`;
    console.log(`[harn] ${ready}`);
    bus.emit('toast', ready);
    return comboReport();
  } catch (error) {
    if (getState().combo?.since === since) update((s) => { s.combo = { ...s.combo, status: 'error', error: error.message }; });
    throw error;
  }
}

// Défaire le combo. unload : ses modèles quittent la carte ; sinon ils restent, sans réserve.
export async function stopCombo({ unload = true, reason = null } = {}) {
  const combo = getState().combo;
  if (!combo) return comboReport();
  update((s) => { s.combo = null; });
  if (unload && combo.status !== 'error') {
    for (const m of combo.models) {
      if (m.kind === 'text') await stopEngine(m.id);
      else if (voiceActivity().running === m.id) await stopVoice();
    }
  }
  const message = reason ?? `Combo arrêté : ${combo.models.map((m) => m.name).join(' + ')}${unload ? ' déchargés' : ''}`;
  console.log(`[harn] ${message}`);
  bus.emit('toast', message);
  return comboReport();
}

export function comboReport() {
  const combo = getState().combo;
  if (!combo) return { combo: null };
  const voice = voiceActivity();
  return {
    combo: {
      status: combo.status, error: combo.error ?? null, since: combo.since, readyAt: combo.readyAt ?? null,
      idleMinutes: combo.idleMinutes ?? IDLE_MINUTES, budget: combo.budget,
      models: combo.models.map(({ tuning, ...m }) => ({
        ...m,
        loaded: m.kind === 'text' ? getState().engines?.[m.id]?.status ?? 'stopped' : voice.running === m.id ? voice.status : 'stopped',
        ...(m.kind === 'text' ? { context: loadedContext(m.id) ?? m.context } : {}),
      })),
    },
  };
}

// Pour la fenêtre : les modèles qu'on peut mettre en combo, ici et sur chaque machine reliée
// (là-bas, c'est elle qui fera le plan), et les combos des autres machines.
export function comboChoices() {
  const state = getState();
  const here = [
    ...Object.keys(state.models).filter((id) => state.models[id].installedAt && modelById(id))
      .filter((id) => !exclusive(modelById(id), benchTuning(modelById(id))))
      .map((id) => ({ id, name: member(id).name, kind: 'text' })),
    ...(nvidiaHere() ? allVoiceModels().filter((m) => voiceInstalledHere(m.id)).map((m) => ({ id: m.id, name: m.name, kind: 'voice' })) : []),
  ];
  const machines = new Map();
  for (const m of peerModels()) {
    const peer = m.meta?.peer;
    if (!machines.has(peer)) machines.set(peer, { id: peer, name: peer, models: [] });
    machines.get(peer).models.push({ id: m.id, name: m.meta?.name ?? m.id, kind: 'text' });
  }
  for (const { peer, voice } of peersWithVoice()) {
    if (!machines.has(peer.id)) machines.set(peer.id, { id: peer.id, name: peer.name, models: [] });
    machines.get(peer.id).name = peer.name;
    for (const m of voice.models) machines.get(peer.id).models.push({ id: `${m.id}@${peer.id}`, name: `${m.name ?? m.id} · ${peer.name}`, kind: 'voice' });
  }
  return { here, machines: [...machines.values()], remote: state.comboRemote ?? [] };
}

// ── Inactivité ──
// Les modèles d'un combo ne partent pas chacun de leur côté : le combo entier s'arrête quand
// aucun des deux n'a servi depuis idleMinutes (0 : jamais).
export async function comboIdleCheck(now = Date.now()) {
  const combo = getState().combo;
  if (!combo || combo.status !== 'ready' || !combo.idleMinutes) return false;
  const voice = voiceActivity();
  const texts = combo.models.filter((m) => m.kind === 'text').map((m) => m.id);
  if (texts.some(inUse) || voice.streams > 0 || busyWith()) return false;
  const last = Math.max(combo.readyAt ?? 0, ...texts.map(lastUseOf), voice.lastUse ?? 0);
  if (now - last < combo.idleMinutes * 60_000) return false;
  await stopCombo({ reason: `Combo arrêté et déchargé (${combo.models.map((m) => m.id).join(' + ')}) : ${combo.idleMinutes} minutes sans requête` });
  return true;
}
export function watchCombo() {
  setInterval(() => { comboIdleCheck().catch((error) => console.error(`[harn] ${error.message}`)); }, 30_000).unref();
}

// Au démarrage de Harn : les moteurs d'avant ne sont plus là, le combo non plus.
export function resetComboState() {
  if (getState().combo) update((s) => { s.combo = null; });
}

// ── Ici ou sur une autre machine ──
// models : tous d'ici, ou tous « …@machine » de la même machine. hopped : la demande vient déjà
// d'un autre Harn, elle est servie ici (pas de relais en chaîne).
function whereOf(ids, hopped) {
  if (!Array.isArray(ids)) return { local: true, ids };
  const routes = ids.map((id) => peerRoute(id));
  if (routes.every((r) => !r)) return { local: true, ids };
  if (hopped) throw failure(400, 'Combo d’une autre machine demandé par une autre machine : pas de relais en chaîne');
  if (routes.some((r) => !r) || new Set(routes.map((r) => r.peer.id)).size > 1) throw failure(400, 'Un combo vit sur une seule carte : tous ses modèles ici, ou tous sur la même machine (« modele@pc2 »)');
  return { local: false, route: routes[0], ids: routes.map((r) => r.remoteId) };
}

async function remote(route, method, pathname, body = null) {
  let res;
  try {
    res = await fetch(`${route.peer.url}${pathname}`, {
      method,
      headers: { ...route.headers, 'X-Harn-Hop': '1', ...(body ? { 'content-type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
      // Démarrer un combo charge deux modèles : la voix seule prend une à deux minutes.
      signal: AbortSignal.timeout(20 * 60_000),
    });
  } catch (error) {
    throw failure(502, `Machine « ${route.peer.name} » injoignable : ${error.name === 'TimeoutError' ? 'pas de réponse' : error.message}`);
  }
  const payload = await res.json().catch(() => ({}));
  // Un Harn d'avant les combos relaie la demande à son moteur, qui répond « Not Found ».
  if (res.status === 404 && /not found/i.test(payload?.error?.message ?? payload?.error ?? 'not found')) throw failure(502, `« ${route.peer.name} » ne connaît pas les combos : mettez son Harn à jour`);
  if (!res.ok) throw failure(res.status === 401 ? 502 : res.status, `${route.peer.name} : ${payload?.error?.message ?? payload?.error ?? `HTTP ${res.status}`}`, { plan: payload?.plan });
  return { ...payload, machine: route.peer.id };
}

// Une demande de combo, d'où qu'elle vienne (passerelle /v1/combos, fenêtre /api/combo).
// action : plan, start, stop, status. body.models pour plan et start ; body.machine pour stop et
// status (absent : ici).
export async function comboRequest(action, body = {}, { hopped = false } = {}) {
  if (action === 'plan' || action === 'start') {
    const where = whereOf(body?.models, hopped);
    const options = { minContext: body?.minContext ?? null, idleMinutes: body?.idleMinutes ?? IDLE_MINUTES };
    if (!where.local) return remote(where.route, 'POST', `/combos/${action}`, { ...body, models: where.ids });
    if (action === 'plan') return { plan: publicPlan(await planCombo(where.ids, options)) };
    return startCombo(where.ids, options);
  }
  const machine = body?.machine ? String(body.machine) : null;
  if (machine) {
    if (hopped) throw failure(400, 'Pas de relais en chaîne');
    const route = peerById(machine);
    if (!route) throw failure(404, `Machine inconnue : ${machine}`);
    return action === 'stop' ? remote(route, 'POST', '/combos/stop', { unload: body?.unload ?? true }) : remote(route, 'GET', '/combos');
  }
  if (action === 'stop') return stopCombo({ unload: body?.unload ?? true });
  if (action === 'status') return comboReport();
  throw failure(404, 'Action inconnue');
}
