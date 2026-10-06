import { MODELS, totalBytes } from './catalog.mjs';
import { backendCandidates, gpuProfile } from './levers.mjs';
import { RATING_WEIGHTS, globalRating, ratingFrom } from './rating.mjs';

// L'objectif : entre 100k et 150k de contexte, le modèle le plus intelligent que la machine
// porte, et le plus rapide possible, sachant que sous 40 tok/s c'est lent. Le planificateur
// estime, pour chaque modèle, le contexte qui tient et le débit attendu à 100k, puis arbitre.
// Les estimations sont calées sur les mesures du poste de référence ; le banc les remplace.

export const OBJECTIVE = { minContext: 100 * 1024, maxContext: 150 * 1024, minTps: 40 };

const GiB = 1024 ** 3;
const BACKEND_LABEL = { cuda13: 'CUDA 13', cuda12: 'CUDA 12.4', vulkan: 'Vulkan', hip: 'HIP (ROCm)', cpu: 'Processeur' };

export function pickBackend(hardware) {
  const profile = gpuProfile(hardware);
  const candidates = backendCandidates(hardware, profile);
  const id = candidates[0];
  const gpu = hardware.primary;
  const oldNvidia = gpu?.vendor === 'nvidia' && id === 'vulkan';
  return {
    id,
    candidates,
    label: candidates.map((c) => BACKEND_LABEL[c]).join(' / ') + (oldNvidia ? ' (pilote NVIDIA ancien)' : ''),
    gpu: id !== 'cpu',
    profile,
    hint: oldNvidia ? 'Mettre à jour le pilote NVIDIA débloque CUDA, nettement plus rapide.' : null,
  };
}

// ── Capacité : quel contexte tient sur la carte ──────────────
// VRAM = poids + KV(contexte) + tampons de calcul + marge anti-débordement + bureau Windows.
// Coût KV mesuré sur Qwen3.8-27B (16 couches d'attention pleine sur 64) : 160k en q8_0 = 5,6 Go.
const COMPUTE_GIB = 1.3;
const HEADROOM_GIB = 1.5;
const round = (tokens) => Math.floor(tokens / 4096) * 4096;

function llamaCapacity(model, hardware, desktopGiB) {
  const weights = model.files.reduce((sum, file) => sum + file.bytes, 0) / GiB;
  const budget = hardware.vramGiB - desktopGiB - HEADROOM_GIB - COMPUTE_GIB - weights;
  if (budget <= 0) return { context: 0, kv: 'q8_0', weightsGiB: weights };
  // q8_0 d'abord ; q4_0 seulement s'il faut ça pour atteindre 100k (le K quantifié coûte plus
  // en qualité que le V, et q4_0 est plus lent que q8_0 en profondeur sur le build officiel).
  for (const kv of ['q8_0', 'q4_0']) {
    const tokens = round((budget * GiB) / model.kvBytesPerToken[kv]);
    if (tokens >= OBJECTIVE.minContext || kv === 'q4_0') return { context: Math.min(OBJECTIVE.maxContext, tokens), kv, weightsGiB: weights };
  }
}

// ── Vitesse attendue à 100k ──────────────────────────────────
// Génération ≈ bande passante utile / octets lus par token, × gain MTP, × pente de profondeur.
// 3090 + IQ3_S (12,1 Go) : 936 × 0,75 / 12,1 × 1,45 = 84 à 4k (mesuré 82), × 0,72 = 61 à 100k
// (mesuré 59).
function llamaTps(model, profile, weightsGiB) {
  // MoE : chaque token ne lit que les experts actifs (plus la partie partagée, ~6 %), mais le
  // routage et les petits noyaux ajoutent un coût fixe (~6 ms) qui domine vite.
  if (model.moe) {
    const active = weightsGiB * GiB * (0.06 + 0.94 * model.moe.used / model.moe.experts);
    const ms = (active / (profile.bandwidth * 0.75 * 1e9)) * 1000 + 6;
    return (1000 / ms) * (model.mtp ? 1.35 : 1) * 0.8;
  }
  const base = (profile.bandwidth * 0.75) / (weightsGiB * GiB / 1e9);
  return base * (model.mtp ? 1.45 : 1) * 0.72;
}

// Strata : RTX 5070 (672 Go/s, 12 Go) à 128k : IQ2_XS 63, IQ3_XXS 49 tok/s (README Strata).
// Plus de VRAM = plus d'experts en cache. 3090 : 49 × 1,22 × 1,41 = 85 (mesuré 86 à 100k).
const STRATA_REF = { IQ2_XS: 63, IQ3_XXS: 49 };
function strataTps(model, profile, hardware) {
  const bandwidth = Math.min(1.8, Math.max(0.5, profile.bandwidth / 672)) ** 0.6;
  const cache = (Math.min(hardware.vramGiB, 32) / 12) ** 0.5;
  return STRATA_REF[model.strataModel] * bandwidth * cache;
}

// Le verdict d'un modèle sur cette machine, en mots simples.
export function assess(model, hardware) {
  const profile = gpuProfile(hardware);
  const backend = pickBackend(hardware);
  const desktopGiB = Math.max(0.8, (hardware.vramBaselineMiB ?? 1024) / 1024);
  const gpu = hardware.primary;
  const sizeGB = totalBytes(model) / 1e9;
  const reasons = [];

  if (hardware.diskFreeGiB !== null && hardware.diskFreeGiB < sizeGB * 1.05 + 5) reasons.push(`il faut ${Math.ceil(sizeGB + 5)} Go libres sur le disque (${hardware.diskFreeGiB} disponibles)`);
  if (hardware.ramGiB < model.needs.ramGiB) reasons.push(`il faut ${model.needs.ramGiB} Go de RAM (${Math.round(hardware.ramGiB)} ici)`);

  if (model.engine === 'strata') {
    if (gpu?.vendor !== 'nvidia') reasons.push('Strata demande une carte NVIDIA');
    else if (gpu.computeCapability < model.needs.nvidiaCc) reasons.push('Strata demande une RTX série 20 ou plus récente');
    if (hardware.vramGiB < model.needs.vramGiB) reasons.push(`il faut ${model.needs.vramGiB} Go de mémoire graphique (${hardware.vramGiB} ici)`);
    if (reasons.length) return { fit: 'no', reasons };
    // Le KV de Strata vit en RAM au-delà de 64k (~13,7 Ko par token) : 131k tiennent dès que la RAM suit.
    const context = 131072;
    return finalize({ fit: 'full', reasons, context, kv: 'int8', tps: strataTps(model, profile, hardware) });
  }

  if (reasons.length) return { fit: 'no', reasons };
  const capacity = llamaCapacity(model, hardware, desktopGiB);
  if (backend.gpu && capacity.context >= 32768) {
    return finalize({ fit: 'full', reasons, context: capacity.context, kv: capacity.kv, tps: llamaTps(model, profile, capacity.weightsGiB) });
  }
  // Un modèle qui déborde de la carte tourne quand même, partagé avec la RAM, mais lentement.
  if (model.engine === 'prism' || hardware.ramGiB >= sizeGB + 8) {
    return finalize({ fit: 'partial', reasons: ['une partie du modèle tournera sur le processeur, plus lentement'], context: 32768, kv: 'q8_0', tps: null });
  }
  return { fit: 'no', reasons: [`il faut au moins ${Math.ceil(capacity.weightsGiB + 4)} Go de mémoire graphique`] };
}

function finalize(verdict) {
  const tps = verdict.tps === null ? null : Math.round(verdict.tps);
  return {
    ...verdict,
    tps,
    meetsContext: verdict.context >= OBJECTIVE.minContext,
    meetsSpeed: tps !== null && tps >= OBJECTIVE.minTps,
  };
}

// Le plan : le modèle visé (l'objectif), le premier modèle installé tout de suite, et le verdict
// de tout le catalogue.
// Intelligence d'un modèle : son score au banc Harn (échelle commune) ; à défaut, la note du
// catalogue, simple estimation en attendant le test.
export function intelligence(model, scores = {}) {
  return scores[model.id] ?? model.quality ?? 0;
}

export function makePlan(hardware, scores = {}, profiles = {}) {
  const q = (model) => intelligence(model, scores);
  const backend = pickBackend(hardware);
  const verdicts = MODELS.map((model) => ({ id: model.id, ...assess(model, hardware), intelligence: q(model), tested: scores[model.id] !== undefined }));
  const verdict = (id) => verdicts.find((entry) => entry.id === id);
  // Note globale : mesurée pour un modèle passé aux bancs, sinon estimée (intelligence, vitesse et
  // contexte attendus ici). C'est elle qui départage les modèles qui tiennent l'objectif.
  for (const entry of verdicts) {
    const model = MODELS.find((m) => m.id === entry.id);
    const measured = globalRating(model, profiles[entry.id]);
    const rating = measured ?? ratingFrom(model, { iq: entry.intelligence, tps: entry.tps, context: entry.context });
    entry.rating = rating.score;
    entry.ratingParts = rating.parts;
    entry.ratingMeasured = Boolean(measured);
  }
  const r = (model) => verdict(model.id).rating;
  const usable = MODELS.filter((model) => verdict(model.id).fit !== 'no');

  // La cible : la meilleure note globale parmi ceux qui tiennent 100k et 40 tok/s ; sinon, parmi ceux qui tiennent
  // 100k, le plus rapide (sous 40 tok/s c'est la vitesse qui manque) ; sinon le plus grand contexte.
  const both = usable.filter((m) => verdict(m.id).meetsContext && verdict(m.id).meetsSpeed);
  const contextOnly = usable.filter((m) => verdict(m.id).meetsContext);
  const target = both.sort((a, b) => r(b) - r(a) || q(b) - q(a))[0]
    ?? contextOnly.sort((a, b) => (verdict(b.id).tps ?? 0) - (verdict(a.id).tps ?? 0) || q(b) - q(a))[0]
    ?? usable.sort((a, b) => verdict(b.id).context - verdict(a.id).context || q(b) - q(a))[0]
    ?? null;

  const targetWhy = target && both.includes(target) ? explainTarget(target, both, verdict, q, profiles) : null;

  // Le premier modèle : la cible si elle s'installe vite (pas Strata, 70 Go) ; sinon le meilleur
  // modèle llama.cpp qui tient sur la carte, pour avoir une IA qui marche pendant le reste.
  const quick = usable
    .filter((m) => m.engine !== 'strata' && verdict(m.id).fit === 'full')
    .sort((a, b) => {
      const score = (m) => (verdict(m.id).meetsContext && verdict(m.id).meetsSpeed ? 2 : 0) + (verdict(m.id).meetsContext ? 1 : 0);
      return score(b) - score(a) || q(b) - q(a);
    });
  const fallback = usable.filter((m) => m.engine === 'prism');
  const first = target && target.engine !== 'strata' ? target : quick[0] ?? fallback[0] ?? null;
  const upgrade = target && target.id !== first?.id ? target : null;

  for (const entry of verdicts) {
    entry.role = entry.id === first?.id ? 'first' : entry.id === upgrade?.id ? 'upgrade' : entry.fit === 'no' ? 'incompatible' : 'compatible';
  }

  return {
    backend,
    objective: OBJECTIVE,
    firstModel: first?.id ?? null,
    upgradeModel: upgrade?.id ?? null,
    targetModel: target?.id ?? null,
    targetWhy,
    verdicts,
    summary: summarize(hardware, backend, first, upgrade, target ? verdict(target.id) : null),
    advice: ramAdvice(hardware),
  };
}

// Pourquoi la cible passe devant un modèle plus intelligent : on le dit, avec le critère qui l'a
// emporté (la note globale peut préférer la vitesse, la taille ou le contexte à l'intelligence).
const RATING_LABELS = { taille: 'la taille', vitesse: 'la vitesse', contexte: 'le contexte' };
function explainTarget(target, candidates, verdict, q, profiles) {
  const smartest = [...candidates].sort((a, b) => q(b) - q(a) || verdict(b.id).rating - verdict(a.id).rating)[0];
  if (!smartest || smartest.id === target.id || q(smartest) <= q(target)) return null;
  const parts = (m) => verdict(m.id).ratingParts;
  const gains = Object.keys(RATING_LABELS).map((k) => [k, (parts(target)[k] - parts(smartest)[k]) * RATING_WEIGHTS[k]]).sort((a, b) => b[1] - a[1]);
  const [winner] = gains[0];
  const tps = (m) => Math.round(profiles[m.id]?.bench?.winner?.tps ?? verdict(m.id).tps ?? 0);
  const detail = { vitesse: `${tps(target)} tok/s contre ${tps(smartest)}`, contexte: `${Math.round(verdict(target.id).context / 1024)}k contre ${Math.round(verdict(smartest.id).context / 1024)}k`, taille: 'un modèle plus gros' }[winner];
  return `Note globale ${verdict(target.id).rating} contre ${verdict(smartest.id).rating} pour ${smartest.name} · ${smartest.variant}, plus intelligent (${q(smartest)} contre ${q(target)}) : la note privilégie ici ${RATING_LABELS[winner]} (${detail}).`;
}

// Ce qu'un ajout de RAM débloquerait : Strata + Flash-Next donne de beaux résultats même sur
// une carte de 12 ou 16 Go, à condition d'avoir la RAM à côté.
function ramAdvice(hardware) {
  const gpu = hardware.primary;
  if (gpu?.vendor !== 'nvidia' || gpu.computeCapability < 7.5 || hardware.vramGiB < 11.5) return null;
  const strata = MODELS.filter((m) => m.engine === 'strata' && hardware.ramGiB < m.needs.ramGiB && hardware.vramGiB >= m.needs.vramGiB)
    .sort((a, b) => a.needs.ramGiB - b.needs.ramGiB)[0];
  if (!strata) return null;
  const tps = Math.round(strataTps(strata, gpuProfile(hardware), hardware));
  return `Avec ${strata.needs.ramGiB} Go de RAM, cette carte ferait tourner ${strata.name} (${strata.variant}) via Strata, à environ ${tps} tok/s et 131k de contexte.`;
}

function summarize(hardware, backend, first, upgrade, targetVerdict) {
  const gpu = hardware.primary;
  const machine = gpu
    ? `${gpu.name} · ${hardware.vramGiB} Go de mémoire graphique · ${Math.round(hardware.ramGiB)} Go de RAM`
    : `Pas de carte graphique utilisable · ${Math.round(hardware.ramGiB)} Go de RAM`;
  const extra = { backend: backend.label, arch: backend.profile.archLabel, bandwidth: backend.profile.bandwidth, hint: backend.hint ?? null };
  if (!first) return { machine, line: 'Cette machine n’a pas assez de mémoire pour les modèles validés.', ...extra };
  const goal = targetVerdict
    ? `${Math.round(targetVerdict.context / 1024)}k de contexte, environ ${targetVerdict.tps ?? '?'} tok/s attendus`
    : null;
  const line = upgrade
    ? `On installe ${first.name} tout de suite, puis on vous proposera ${upgrade.name}, le meilleur choix ici (${goal}).`
    : `On installe ${first.name}, le meilleur choix pour cette machine${goal ? ` (${goal})` : ''}.`;
  return { machine, line, ...extra };
}
