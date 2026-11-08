import { modelById, ownLauncher, totalBytes } from './catalog.mjs';
import { layersOf, loadedModels, stopEngine } from './engine.mjs';
import { busyWith } from './gpu-queue.mjs';
import { inUse, lastUseOf } from './idle.mjs';
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

// Ce que le modèle prendra sur la carte avec ce réglage, en Mio.
export function needMiB(model, tuning = {}) {
  const measured = getState().profiles?.[model.id]?.vram;
  if (measured?.mib && measured.context === (tuning.context ?? null) && measured.kv === (tuning.kv ?? null)) return measured.mib;
  const kvBytes = model.kvBytesPerToken?.[tuning.kv ?? 'q8_0'] ?? model.kvBytesPerToken?.q8_0 ?? 35_000;
  return Math.round(((totalBytes(model) + (tuning.context ?? 32768) * kvBytes) / MiB + COMPUTE_MIB) * 1.05);
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
// notée dans son profil (la prochaine fois, plus d'estimation).
export function placeAndLoad(model, tuning) {
  return serial(async () => {
    const unloaded = await makeRoom(model.id, tuning);
    if (unloaded.length) bus.emit('toast', `Place faite pour ${model.name ?? model.id} : ${unloaded.join(', ')} déchargé${unloaded.length > 1 ? 's' : ''}`);
    const before = await freeVram();
    // Marge trop juste après chargement (estimation trop basse) : un autre modèle inactif part
    // d'abord, le contexte ne cède qu'en dernier recours.
    const freeMore = async () => Boolean(await evictOne(model.id));
    const loaded = await loadWithHeadroom(model, tuning, { alone: exclusive(model, tuning), freeMore });
    const after = await freeVram();
    if (before !== null && after !== null && before > after && !exclusive(model, loaded.tuning)) {
      update((s) => { (s.profiles[model.id] ??= {}).vram = { mib: before - after, context: loaded.tuning.context ?? null, kv: loaded.tuning.kv ?? null, at: new Date().toISOString() }; });
    }
    return loaded;
  });
}

// Décharge le modèle inactif le moins récemment utilisé (autre que keep). Rend son id, ou null.
export async function evictOne(keep) {
  const victim = loadedModels().filter((id) => id !== keep && !working(id)).sort((a, b) => lastUseOf(a) - lastUseOf(b))[0];
  if (!victim) return null;
  await stopEngine(victim);
  console.log(`[harn] ${victim} déchargé : marge trop juste pour ${keep}`);
  return victim;
}
