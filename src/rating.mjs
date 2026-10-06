// La note globale d'un modèle installé : ce qu'il vaut vraiment sur cette machine. Le banc
// d'intelligence dit s'il répond juste (100 % est normal pour un modèle qui a tout bon, quelle
// que soit sa taille) ; la note globale y ajoute sa taille, sa vitesse mesurée et son contexte.

export const RATING_WEIGHTS = { intelligence: 40, taille: 25, vitesse: 20, contexte: 15 };

const clamp = (x) => Math.max(0, Math.min(1, x));

// Un MoE compte pour tous ses paramètres (pas seulement les experts actifs), mais à taille égale
// il est un peu moins intelligent qu'un dense : 35B MoE ≈ 26B dense, juste sous un 27B dense.
export const MOE_FACTOR = 0.75;
const isMoe = (model) => Boolean(model?.sparse || model?.moe || /-A\d/i.test(model?.profile?.sizeLabel ?? ''));

// Échelles logarithmiques : doubler compte autant en bas qu'en haut de l'échelle.
// Taille : 1B → 0, 128B → 1 (4B 0,29 · 9B 0,45 · 27B 0,68 · 35B 0,73 · 125B 0,99).
const sizeRatio = (paramsB) => clamp(Math.log2(paramsB) / 7);
// Vitesse : 20 tok/s → 0, 160 tok/s → 1 (40 → 0,33 · 90 → 0,72).
const speedRatio = (tps) => clamp(Math.log2(tps / 20) / 3);
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

// Note sur 100, ou null tant que le banc d'intelligence et le banc de vitesse n'ont pas tourné.
export function globalRating(model, profile) {
  if (profile?.iq?.version !== 2 || !profile.bench?.winner?.tps) return null;
  const paramsB = paramsOf(model);
  const parts = {
    intelligence: profile.iq.score / 100,
    taille: paramsB ? sizeRatio(paramsB * (isMoe(model) ? MOE_FACTOR : 1)) : 0,
    vitesse: speedRatio(profile.bench.winner.tps),
    contexte: contextRatio(profile.tuning?.context ?? 0),
  };
  const score = Math.round(Object.entries(RATING_WEIGHTS).reduce((sum, [name, weight]) => sum + parts[name] * weight, 0));
  return { score, parts, paramsB, moe: isMoe(model) };
}
