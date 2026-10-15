import { stopEngine } from './engine.mjs';
import { busyWith } from './gpu-queue.mjs';
import { bus, getState, update } from './state.mjs';

// Un modèle chargé que personne n'interroge garde toute la VRAM : le bureau n'en a plus et se
// fige par à-coups. Après dix minutes sans requête, la carte est rendue ; la requête suivante
// recharge le modèle toute seule (gateway.mjs), comme après « Libérer la carte graphique ».
export const IDLE_MS = 10 * 60_000;

let inFlight = 0;
let lastUse = Date.now();

// Une requête relayée au moteur : à appeler à son arrivée, la fonction rendue à sa fin.
export function engineInUse() {
  inFlight += 1;
  lastUse = Date.now();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    inFlight -= 1;
    lastUse = Date.now();
  };
}

// Bancs, tests d'intelligence et images parlent au moteur sans passer par la passerelle : tant
// que la carte est tenue (busyWith), elle sert.
export async function unloadIfIdle(now = Date.now()) {
  const active = getState().active;
  if (inFlight || busyWith() || active?.status !== 'ready') { lastUse = Math.max(lastUse, now); return false; }
  if (now - Math.max(lastUse, active.readyAt ?? 0) < IDLE_MS) return false;
  // « stopped » avant l'arrêt : une requête qui arrive pendant qu'il s'éteint recharge le modèle
  // au lieu de frapper un moteur mourant.
  update((s) => { s.active.status = 'stopped'; });
  await stopEngine();
  console.log(`[harn] ${active.modelId} déchargé après ${IDLE_MS / 60_000} minutes sans requête`);
  bus.emit('toast', `Carte graphique libérée : ${IDLE_MS / 60_000} minutes sans requête`);
  return true;
}

export function watchIdle() {
  setInterval(() => { unloadIfIdle().catch((error) => console.error(`[harn] ${error.message}`)); }, 30_000).unref();
}
