// Le format de data/state.json évolue avec Harn. Chaque changement de format a sa migration,
// appliquée une fois au chargement, plutôt que du code qui devine l'ancien format partout.
// Ajouter une migration : incrémenter SCHEMA_VERSION et décrire le passage à cette version.
import { verbosityLabel } from './iq-test.mjs';

export const SCHEMA_VERSION = 7;

const MIGRATIONS = {
  // v2 : `layers` explicite dans chaque réglage. Avant, une cible --fit relevée (> 1 Gio)
  // désignait un modèle partagé avec le processeur ; sinon toutes les couches sur la carte.
  2: (state) => {
    for (const profile of Object.values(state.profiles ?? {})) {
      if (profile.tuning && !profile.tuning.layers) profile.tuning.layers = profile.tuning.fitTargetMiB > 1024 ? 'auto' : 'all';
    }
  },
  // v3 : les modèles partagés avec la RAM passent en lots de 4096 (préfill ×2,5, voir loading.mjs).
  3: (state) => {
    for (const profile of Object.values(state.profiles ?? {})) {
      const tuning = profile.tuning;
      if (tuning?.layers === 'auto' && (tuning.ubatch ?? 512) < 4096) Object.assign(tuning, { batch: 4096, ubatch: 4096 });
    }
  },
  // v4 : « bavard » ne se déclenche plus sur une seule réponse coupée, mais sur la longueur des
  // réponses. Les anciens tests n'ont que la moyenne sur tout le test : elle sert d'approximation
  // jusqu'au prochain passage (qui mesurera `replyTokens` au palier difficile).
  4: (state) => {
    for (const profile of Object.values(state.profiles ?? {})) {
      const v = profile.iq?.verbosity;
      if (v && v.replyTokens === undefined && v.avgTokens !== undefined) v.label = verbosityLabel(v.avgTokens);
    }
  },
  // v5 : les modèles llama.cpp sans spéculation passent au brouillon n-gramme (voir defaultTuning).
  // Strata, Radiance, HyperQwen et Gemma Challenge n'utilisent pas ce champ ; un moteur qui ne
  // connaît pas ngram-mod (Prism, llamAmpere) le lance sans spéculation, comme avant.
  5: (state) => {
    for (const profile of Object.values(state.profiles ?? {})) {
      const tuning = profile.tuning;
      if (tuning?.spec?.type === 'none' && !tuning.strataArm && !tuning.strataConfig) tuning.spec = { type: 'ngram' };
    }
  },
  // v6 : les moteurs ajoutés (PR, fork) quittent state.engines, qui liste les modèles chargés et
  // repart vide à chaque démarrage, pour state.addedEngines. Une fiche se reconnaît à onlyArchs.
  6: (state) => {
    for (const [id, entry] of Object.entries(state.engines ?? {})) {
      if (!Array.isArray(entry?.onlyArchs)) continue;
      state.addedEngines = { ...state.addedEngines, [id]: entry };
      delete state.engines[id];
    }
  },
  // v7 : la voix n'est plus Voxtral seul mais un modèle de voix parmi d'autres (voice-models.mjs),
  // servis par un même vLLM-Omni. Celui installé pour Voxtral (runtime/voxtral) devient ce moteur
  // commun, sans bouger (un venv ne se déplace pas), et ses poids le modèle « voxtral », choisi
  // pour les agents comme avant.
  7: (state) => {
    const old = state.runtimes?.voxtral;
    if (old?.installedAt && old.venv) {
      state.runtimes['vllm-omni'] ??= { kind: 'vllm-omni', dir: old.dir, venv: old.venv, version: '0.32.0', installedAt: old.installedAt };
      state.voice = { ...state.voice };
      state.voice.models = { ...state.voice.models, voxtral: { installedAt: old.installedAt, path: old.model, revision: old.revision ?? null } };
      state.voice.selected ??= { model: 'voxtral', voice: 'fr_female', language: 'French' };
    }
    if (state.runtimes) delete state.runtimes.voxtral;
    if (state.voice) { delete state.voice.installing; delete state.voice.detail; }
  },
};

// Un état écrit par une version plus récente de Harn est laissé tel quel : on ne le dégrade pas.
export function migrate(state) {
  let version = state.version ?? 1;
  while (version < SCHEMA_VERSION) {
    version += 1;
    MIGRATIONS[version]?.(state);
    state.version = version;
  }
  return state;
}
