import { IQ_VERSION } from './iq-test.mjs';

// La note globale d'un modèle installé : ce qu'il vaut vraiment sur cette machine. Le banc
// d'intelligence dit jusqu'où il répond juste (100 : tous les paliers limite réussis ; jusqu'à 125
// avec le palier expert) ; la note globale y ajoute sa taille, son temps de réponse et son contexte.
// L'intelligence compte iq / 100 : un modèle au-delà de 100 gagne jusqu'à 10 points de plus, la
// note globale peut donc dépasser 100 pour les meilleurs.

export const RATING_WEIGHTS = { intelligence: 40, taille: 25, vitesse: 20, contexte: 15 };

const clamp = (x) => Math.max(0, Math.min(1, x));

// Un MoE compte pour tous ses paramètres (pas seulement les experts actifs), mais à taille égale
// il est un peu moins intelligent qu'un dense : 35B MoE ≈ 26B dense, juste sous un 27B dense.
export const MOE_FACTOR = 0.75;
const isMoe = (model) => Boolean(model?.sparse || model?.moe || /-A\d/i.test(model?.profile?.sizeLabel ?? ''));

// Échelles logarithmiques : doubler compte autant en bas qu'en haut de l'échelle.
// Taille : 1B → 0, 128B → 1 (4B 0,29 · 9B 0,45 · 27B 0,68 · 35B 0,73 · 125B 0,99).
const sizeRatio = (paramsB) => clamp(Math.log2(paramsB) / 7);
// Vitesse : ce que l'on attend vraiment, le temps d'une réponse = tokens par réponse ÷ tok/s.
// Un modèle à 130 tok/s qui réfléchit 2000 tokens répond moins vite qu'un 65 tok/s qui en écrit 500.
// 32 s → 0, 4 s → 1 (8 s → 0,67 · 16 s → 0,33). Tokens par réponse : ceux du banc d'intelligence
// (palier difficile, commun à tous) ; sans mesure, 640, ce qui redonne l'ancienne échelle en
// tok/s (20 tok/s → 0, 160 tok/s → 1).
export const TYPICAL_REPLY_TOKENS = 640;
export const replySeconds = (tps, tokens = TYPICAL_REPLY_TOKENS) => tokens / tps;
const speedRatio = (seconds) => clamp(Math.log2(32 / seconds) / 3);
// Contexte : 32k → 0, 128k → 1 (64k → 0,5).
const contextRatio = (tokens) => clamp(Math.log2(tokens / 32768) / 2);

// Nombre de paramètres (en milliards, total pour un MoE) : le catalogue le donne ; pour un modèle
// ajouté, l'étiquette du GGUF (« 35B-A3B ») ou à défaut le nom (« ornith-1-5-9b »).
export function paramsOf(model) {
  if (model?.paramsB) return model.paramsB;
  for (const text of [model?.profile?.sizeLabel, model?.name, model?.repo, model?.id]) {
    const match = String(text ?? '').match(/(?:^|[^a-z0-9.])(\d+(?:[.,]\d+)?)\s*b(?![a-z])/i);
    if (match) return Number(match[1].replace(',', '.'));
  }
  return null;
}

// Note sur 100 à partir d'une intelligence (sur 100), d'une vitesse et d'un contexte : mesurés
// (globalRating) ou estimés par le planificateur pour un modèle pas encore installé.
export function ratingFrom(model, { iq, tps, context, replyTokens }) {
  const paramsB = paramsOf(model);
  const seconds = tps ? replySeconds(tps, replyTokens || TYPICAL_REPLY_TOKENS) : null;
  const parts = {
    intelligence: (iq ?? 0) / 100,
    taille: paramsB ? sizeRatio(paramsB * (isMoe(model) ? MOE_FACTOR : 1)) : 0,
    vitesse: seconds ? speedRatio(seconds) : 0,
    contexte: contextRatio(context ?? 0),
  };
  const score = Math.round(Object.entries(RATING_WEIGHTS).reduce((sum, [name, weight]) => sum + parts[name] * weight, 0));
  return { score, parts, paramsB, moe: isMoe(model), replySeconds: seconds === null ? null : +seconds.toFixed(1) };
}

// La note mesurée, ou null tant que le banc d'intelligence et le banc de vitesse n'ont pas tourné.
export function globalRating(model, profile) {
  if (profile?.iq?.version !== IQ_VERSION || !profile.bench?.winner?.tps) return null;
  // replyTokens au palier difficile ; un test plus ancien n'a que la moyenne sur tout le test.
  const v = profile.iq.verbosity ?? {};
  return ratingFrom(model, { iq: profile.iq.score, tps: profile.bench.winner.tps, context: profile.tuning?.context, replyTokens: v.replyTokens ?? v.avgTokens });
}
