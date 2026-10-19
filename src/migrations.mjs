// Le format de data/state.json évolue avec Harn. Chaque changement de format a sa migration,
// appliquée une fois au chargement, plutôt que du code qui devine l'ancien format partout.
// Ajouter une migration : incrémenter SCHEMA_VERSION et décrire le passage à cette version.

export const SCHEMA_VERSION = 3;

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
