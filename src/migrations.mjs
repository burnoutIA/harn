// Le format de data/state.json évolue avec Harn. Chaque changement de format a sa migration,
// appliquée une fois au chargement, plutôt que du code qui devine l'ancien format partout.
// Ajouter une migration : incrémenter SCHEMA_VERSION et décrire le passage à cette version.

export const SCHEMA_VERSION = 2;

const MIGRATIONS = {
  // v2 : `layers` explicite dans chaque réglage. Avant, une cible --fit relevée (> 1 Gio)
  // désignait un modèle partagé avec le processeur ; sinon toutes les couches sur la carte.
  2: (state) => {
    for (const profile of Object.values(state.profiles ?? {})) {
      if (profile.tuning && !profile.tuning.layers) profile.tuning.layers = profile.tuning.fitTargetMiB > 1024 ? 'auto' : 'all';
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
