import { modelById } from './catalog.mjs';
import { setModelQuality } from './custom-models.mjs';
import { activationBlocker, withGpu } from './gpu-queue.mjs';
import { runIqTest } from './iq-test.mjs';
import { loadWithHeadroom, startingTuning } from './loading.mjs';
import { writeMachineFacts } from './machine-doc.mjs';
import { configurePi } from './pi.mjs';
import { makePlan } from './planner.mjs';
import { iqScores } from './scores.mjs';
import { getState, update } from './state.mjs';

// Charger un modèle installé, et lui faire passer le banc d'intelligence.
// Activer un modèle installé avec ses réglages gagnants (ou ceux par défaut s'il n'a pas de banc).
const activations = new Map();
export function activate(modelId) {
  const blocked = activationBlocker(modelId);
  if (blocked) return Promise.reject(new Error(blocked));
  if (!activations.has(modelId)) {
    activations.set(modelId, (async () => {
      const model = modelById(modelId);
      const state = getState();
      const saved = state.profiles[modelId]?.tuning;
      // Un réglage d'une version précédente (sans backend) est refait à partir des a priori.
      const tuning = saved?.backend || model.engine === 'strata' ? saved : startingTuning(model, state.hardware);
      const loaded = await loadWithHeadroom(model, tuning ?? {});
      // Une réduction faite au chargement reste ponctuelle : seul le banc fixe les réglages.
      if (getState().pi.installed) await configurePi().catch(() => {});
      return loaded.active;
    })().finally(() => activations.delete(modelId)));
  }
  return activations.get(modelId);
}
// L'IA locale analyse ses propres mesures et l'écrit dans le carnet de la machine.
// Le petit test d'intelligence : sur le modèle demandé (chargé si besoin).
const iqRuns = new Map();
export function runIq(modelId) {
  if (!iqRuns.has(modelId)) {
    iqRuns.set(modelId, withGpu(modelId, async () => {
      update((s) => { (s.profiles[modelId] ??= {}).iqRunning = 'Préparation'; });
      try {
        if (getState().active?.modelId !== modelId || getState().active?.status !== 'ready') await activate(modelId);
        // Le contexte réellement chargé (argument -c du moteur) borne la taille du journal du banc.
        const engineArgs = getState().active?.args ?? [];
        const loaded = engineArgs.includes('-c') ? Number(engineArgs[engineArgs.indexOf('-c') + 1]) : null;
        const context = loaded || getState().profiles[modelId]?.tuning?.context || 32768;
        const result = await runIqTest(modelId, { context, onProgress: (detail) => update((s) => { s.profiles[modelId].iqRunning = detail; }) });
        update((s) => { s.profiles[modelId].iq = result; s.profiles[modelId].iqRunning = null; s.profiles[modelId].iqError = null; });
        await setModelQuality(modelId, result.score);
        // Le classement des modèles dépend du score : le plan est recalculé.
        update((s) => { s.plan = makePlan(s.hardware, iqScores(s), s.profiles); });
        await writeMachineFacts().catch(() => {});
        return result;
      } catch (error) {
        update((s) => { s.profiles[modelId].iqRunning = null; s.profiles[modelId].iqError = error.message; });
        throw error;
      }
    }).finally(() => iqRuns.delete(modelId)));
  }
  return iqRuns.get(modelId);
}
