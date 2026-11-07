// Le format de data/state.json évolue avec Harn. Chaque changement de format a sa migration,
// appliquée une fois au chargement, plutôt que du code qui devine l'ancien format partout.
// Ajouter une migration : incrémenter SCHEMA_VERSION et décrire le passage à cette version.
import { verbosityLabel } from './iq-test.mjs';

export const SCHEMA_VERSION = 4;

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
