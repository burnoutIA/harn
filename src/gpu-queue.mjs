import { modelById } from './catalog.mjs';
import { update } from './state.mjs';

// À qui est la carte : bancs, tests d'intelligence et analyses passent un par un.
// Pendant un banc ou un test, la carte appartient au modèle mesuré : la passerelle refuse les
// requêtes pour un autre modèle au lieu de le recharger (ce qui casserait la mesure).
let busy = null;
export const busyWith = () => busy;
// File d'attente de la carte : bancs, tests d'intelligence et analyses passent un par un. Sans
// elle, deux installations se volaient la carte (« chargement remplacé ») et faussaient leurs
// mesures. Réentrant : une tâche qui tient déjà la carte pour ce modèle (installation → banc →
// test) continue sans se remettre en file derrière elle-même.
let gpuQueue = Promise.resolve();
export function withGpu(modelId, task) {
  if (busy === modelId) return task();
  update((s) => { if (s.models[modelId]) s.models[modelId].waitingGpu = true; });
  const turn = gpuQueue.then(async () => {
    update((s) => { if (s.models[modelId]) s.models[modelId].waitingGpu = false; });
    busy = modelId;
    try { return await task(); } finally { busy = null; }
  });
  gpuQueue = turn.catch(() => {});
  return turn;
}
// Charger un modèle décharge celui qui tourne (startEngine arrête l'ancien moteur). Refusé
// pendant le banc ou le test d'un autre modèle : la carte lui appartient.
export const activationBlocker = (modelId) => {
  if (!busy || busy === modelId) return null;
  if (isImageJob(busy)) return 'Harn génère une image : la carte graphique revient dans un instant';
  return `Harn mesure « ${modelById(busy)?.name ?? busy} » : attendez la fin du banc pour changer de modèle`;
};
// Une image en cours occupe la carte quelques secondes à quelques minutes : la passerelle attend
// qu'elle soit rendue au lieu de refuser la requête.
export const isImageJob = (id) => String(id ?? '').startsWith('image:');
export const gpuFree = () => gpuQueue;
