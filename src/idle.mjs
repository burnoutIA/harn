import { setEngine, stopEngine } from './engine.mjs';
import { busyWith } from './gpu-queue.mjs';
import { bus, getState } from './state.mjs';

// Un modèle chargé que personne n'interroge garde sa part de VRAM : le bureau n'en a plus et se
// fige par à-coups. Après dix minutes sans requête, il est déchargé ; la requête suivante le
// recharge toute seule (gateway.mjs), comme après « Libérer la carte graphique ». Chaque modèle
// chargé a son propre compte : l'un peut partir pendant qu'un autre répond.
export const IDLE_MS = 10 * 60_000;

const inFlight = new Map();  // id du modèle → réponses en cours
const lastUse = new Map();   // id du modèle → fin de la dernière réponse

const activeId = () => getState().active?.modelId ?? null;
export const inUse = (modelId) => (inFlight.get(modelId) ?? 0) > 0;
export const inFlightOf = (modelId) => inFlight.get(modelId) ?? 0;
export const lastUseOf = (modelId) => Math.max(lastUse.get(modelId) ?? 0, getState().engines?.[modelId]?.readyAt ?? 0);

// Une requête relayée au moteur d'un modèle : à appeler à son arrivée, la fonction rendue à sa fin.
export function engineInUse(modelId = activeId()) {
  inFlight.set(modelId, (inFlight.get(modelId) ?? 0) + 1);
  lastUse.set(modelId, Date.now());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight.set(modelId, inFlight.get(modelId) - 1);
    lastUse.set(modelId, Date.now());
  };
}

// Bancs, tests d'intelligence et images parlent au moteur sans passer par la passerelle : tant
// que la carte est tenue (busyWith), rien n'est déchargé.
export async function unloadIfIdle(now = Date.now()) {
  if (busyWith()) { for (const id of Object.keys(getState().engines ?? {})) lastUse.set(id, Math.max(lastUse.get(id) ?? 0, now)); return false; }
  let unloaded = false;
  for (const [modelId, engine] of Object.entries(getState().engines ?? {})) {
    if (engine.status !== 'ready') continue;
    if (inUse(modelId)) { lastUse.set(modelId, Math.max(lastUse.get(modelId) ?? 0, now)); continue; }
    if (now - lastUseOf(modelId) < IDLE_MS) continue;
    // « stopping » avant l'arrêt : une requête qui arrive pendant qu'il s'éteint recharge le
    // modèle au lieu de frapper un moteur mourant.
    setEngine(modelId, { status: 'stopping' });
    await stopEngine(modelId);
    console.log(`[harn] ${modelId} déchargé après ${IDLE_MS / 60_000} minutes sans requête`);
    bus.emit('toast', `${engine.label ?? modelId} déchargé : ${IDLE_MS / 60_000} minutes sans requête`);
    unloaded = true;
  }
  return unloaded;
}

export function watchIdle() {
  setInterval(() => { unloadIfIdle().catch((error) => console.error(`[harn] ${error.message}`)); }, 30_000).unref();
}
