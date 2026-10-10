import { runIq } from './activation.mjs';
import { runAnalysis } from './analysis.mjs';
import { tuneModel } from './bench.mjs';
import { modelById, MODELS, totalBytes } from './catalog.mjs';
import { describe, stopEngine } from './engine.mjs';
import { loadWithHeadroom, runtimeKind, startingTuning } from './loading.mjs';
import { refreshHardware } from './machine-state.mjs';
import { installModelFiles } from './model-files.mjs';
import { configurePi, installPi } from './pi.mjs';
import { installKetch, installLlama } from './runtimes.mjs';
import { getState, update } from './state.mjs';

// Le parcours du premier démarrage, sans aucune question :
// matériel → (runtime ‖ modèle ‖ pi) → chargement avec marge VRAM → banc → prêt.
// Chaque étape est publiée dans l'état : l'interface n'invente rien, elle lit.

const STEPS = [
  ['hardware', 'Analyse de la machine'],
  ['runtime', 'Installation du moteur'],
  ['model', 'Téléchargement du modèle'],
  ['pi', 'Installation de pi agent et de la recherche web'],
  ['load', 'Premier chargement'],
  ['tune', 'Réglage et mesure'],
];
function step(id, patch) {
  update((s) => {
    const entry = s.setup.steps.find((item) => item.id === id);
    if (entry) Object.assign(entry, patch, patch.status === 'running' ? { startedAt: Date.now() } : {}, ['done', 'error', 'skipped'].includes(patch.status) ? { endedAt: Date.now() } : {});
  });
}
let running = null;
export function runFirstSetup() {
  running ??= firstSetup().finally(() => { running = null; });
  return running;
}
export function firstSetupAttempts(plan, hardware) {
  const attempts = [];
  const add = (modelId, backend) => {
    if (modelId && !attempts.some((a) => a.modelId === modelId && a.backend === backend)) attempts.push({ modelId, backend });
  };
  const gpu = plan.backend.gpu;
  add(plan.firstModel, plan.backend.id);
  if (gpu && plan.backend.id !== 'vulkan') add(plan.firstModel, 'vulkan');
  // Le modèle suivant, plus léger, qui tient lui aussi sur la carte.
  const first = modelById(plan.firstModel);
  const lighter = MODELS.filter((m) => m.engine !== 'strata' && m.id !== plan.firstModel && totalBytes(m) < totalBytes(first)
    && plan.verdicts.find((v) => v.id === m.id)?.fit !== 'no').sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0))[0];
  if (lighter) add(lighter.id, plan.backend.id);
  // Le dernier recours : Bonsai 1-bit sur le processeur.
  if (plan.verdicts.find((v) => v.id === 'swift-bonsai2-1bit')?.fit !== 'no') add('swift-bonsai2-1bit', 'cpu');
  return attempts.slice(0, 4);
}
async function firstSetup() {
  update((s) => {
    s.setup = { phase: 'running', error: null, startedAt: Date.now(), finishedAt: null, steps: STEPS.map(([id, label]) => ({ id, label, status: 'pending', detail: null })) };
  });
  try {
    step('hardware', { status: 'running' });
    const { hardware, plan } = await refreshHardware();
    if (!plan.firstModel) throw new Error(plan.summary.line);
    step('hardware', { status: 'done', detail: `${plan.summary.machine} · ${plan.backend.profile.archLabel}, ${plan.backend.profile.bandwidth} Go/s` });

    // pi et la recherche web s'installent en parallèle de tout le reste.
    const piJob = (async () => {
      if (getState().pi.installed) {
        // ketch a pu manquer au premier passage (réseau, pas de build pour ce système) : on le reprend.
        const ketch = getState().ketch ?? await installKetch().catch(() => null);
        return step('pi', { status: 'done', detail: `déjà installé (${getState().pi.version})${ketch ? ` · recherche web ketch ${ketch.version}` : ''}` });
      }
      step('pi', { status: 'running' });
      try {
        const [version, ketch] = await Promise.all([installPi(), installKetch().catch(() => null)]);
        step('pi', { status: 'done', detail: `version ${version}${ketch ? ` · recherche web ketch ${ketch.version}` : ''}${hardware.gitBash ? '' : ' · Git pour Windows manquant'}` });
      } catch (error) {
        // pi n'est pas indispensable pour servir le modèle : on continue sans lui.
        step('pi', { status: 'error', detail: error.message.split('\n')[0] });
      }
    })();

    // Au premier démarrage il n'y a encore aucun modèle, donc personne pour dépanner : Harn
    // descend lui-même d'un cran à chaque échec (moteur plus simple, modèle plus petit, puis
    // Bonsai sur le processeur, qui tourne partout) jusqu'à avoir une IA qui répond.
    // Mais un modèle plus petit ne répare qu'un échec de chargement : si c'est le moteur qui ne
    // s'installe pas, seul un autre moteur peut aider ; si c'est le téléchargement, rien.
    const attempts = firstSetupAttempts(plan, hardware);
    let model = null;
    let loaded = null;
    const failures = [];
    const brokenRuntimes = new Set();
    let blocker = null; // le dernier échec qui ne tient pas à la taille du modèle
    for (const attempt of attempts) {
      const candidate = modelById(attempt.modelId);
      const runtimeId = `${runtimeKind(candidate)}-${attempt.backend}`;
      if (brokenRuntimes.has(runtimeId)) continue;
      if (blocker && (blocker.stage === 'model' || candidate.id !== blocker.modelId)) continue;
      const label = `${candidate.name} · ${candidate.variant}${attempt.backend === plan.backend.id ? '' : ` (moteur ${attempt.backend})`}`;
      let stage = 'runtime';
      try {
        step('runtime', { status: 'running', detail: attempt.backend });
        const info = await installLlama(runtimeKind(candidate), attempt.backend);
        step('runtime', { status: 'done', detail: `llama.cpp ${info.tag} · ${attempt.backend}` });
        stage = 'model';
        step('model', { status: 'running', detail: label });
        await installModelFiles(candidate);
        step('model', { status: 'done', detail: label });
        stage = 'load';
        step('load', { status: 'running', detail: failures.length ? `Après ${failures.length} échec(s), essai plus simple : ${label}` : null });
        loaded = await loadWithHeadroom(candidate, { ...startingTuning(candidate, hardware), backend: attempt.backend });
        model = candidate;
        break;
      } catch (error) {
        const reason = error.message.split('\n')[0];
        failures.push(stage === 'runtime' ? `moteur ${attempt.backend} : ${reason}` : `${label} : ${reason}`);
        await stopEngine().catch(() => {});
        if (stage === 'runtime') brokenRuntimes.add(runtimeId);
        blocker = stage === 'load' ? null : { stage, modelId: candidate.id };
        if (stage === 'runtime') step('runtime', { status: 'running', detail: `Échec du moteur ${attempt.backend}. On essaie un autre moteur…` });
        else if (stage === 'load') step('load', { status: 'running', detail: `Échec avec ${label}. On essaie plus simple…` });
      }
    }
    if (!model) {
      const what = blocker?.stage === 'runtime' ? 'Le moteur n’a pas pu s’installer'
        : blocker?.stage === 'model' ? 'Le modèle n’a pas pu se télécharger'
          : 'Aucun modèle n’a pu démarrer sur cette machine';
      throw new Error(`${what}. ${failures.join(' | ')}`);
    }
    step('load', { status: 'done', detail: `${describe(loaded.tuning)} · ${loaded.active.loadSeconds.toFixed(0)} s${failures.length ? ` · repli après ${failures.length} échec(s)` : ''}` });

    step('tune', { status: 'running' });
    await tuneModel(model.id, { startFrom: loaded, onProgress: (detail) => step('tune', { detail }) });
    const profile = getState().profiles[model.id];
    step('tune', { status: 'done', detail: `${profile.bench.winner.tps} tok/s · ${profile.bench.winner.label}` });

    await piJob;
    if (getState().pi.installed) await configurePi();
    update((s) => { s.setup.phase = 'done'; s.setup.finishedAt = Date.now(); });
    // Le banc d'intelligence suit en arrière-plan : c'est lui qui rend pi éligible au dépannage.
    runIq(model.id).catch(() => {}).finally(() => runAnalysis());
  } catch (error) {
    update((s) => {
      s.setup.phase = 'error';
      s.setup.error = error.message;
      const current = s.setup.steps.find((item) => item.status === 'running');
      if (current) { current.status = 'error'; current.detail = error.message; }
    });
    throw error;
  }
}

// Points d'entrée regroupés : main.mjs et les tests importent d'ici.
export { stopEngine } from './engine.mjs';
export { activate, runIq } from './activation.mjs';
export { runAnalysis } from './analysis.mjs';
export { tuneModel } from './bench.mjs';
export { activationBlocker, busyWith, withGpu } from './gpu-queue.mjs';
export { customJobState, deleteModel, inspectForMachine, installAndTune, installCustom, proposeEngine } from './install.mjs';
export { loadWithHeadroom } from './loading.mjs';
export { refreshHardware } from './machine-state.mjs';
export { installLogPath, installModelFiles } from './model-files.mjs';
export { iqScores, pickHelper } from './scores.mjs';
