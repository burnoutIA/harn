import { modelById } from './catalog.mjs';
import { IQ_VERSION } from './iq-test.mjs';
import { globalRating, RATING_WEIGHTS } from './rating.mjs';
import { getState } from './state.mjs';

// Notes du banc d'intelligence, et le modèle qui sait dépanner.
// Les scores du banc d'intelligence (format actuel uniquement : les anciens sont à refaire).
export function iqScores(state = getState()) {
  const scores = {};
  for (const [id, profile] of Object.entries(state.profiles ?? {})) if (profile.iq?.version === IQ_VERSION) scores[id] = profile.iq.score;
  return scores;
}
// Qui peut dépanner une installation ? Le modèle installé à la meilleure note globale, autre que
// celui en cause, à condition qu'il ait prouvé au banc qu'il sait manier des outils (au moins 40 %
// en outils : le plancher réussi, ou mieux).
export function pickHelper(exceptId = null, state = getState()) {
  const rating = (id, p) => globalRating(modelById(id), p)?.score ?? p.iq.score * RATING_WEIGHTS.intelligence / 100;
  const candidates = Object.entries(state.profiles ?? {})
    .filter(([id, p]) => id !== exceptId && state.models[id]?.installedAt && p.iq?.version === IQ_VERSION && p.iq.categories.outils.ratio >= 0.4)
    .sort(([idA, a], [idB, b]) => rating(idB, b) - rating(idA, a));
  return candidates[0]?.[0] ?? null;
}
