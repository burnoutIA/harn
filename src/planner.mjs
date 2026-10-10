import { MODELS, totalBytes } from './catalog.mjs';
import { backendCandidates, gpuProfile } from './levers.mjs';
import { RATING_WEIGHTS, globalRating, ratingFrom } from './rating.mjs';

// L'objectif : entre 100k et 150k de contexte, le modèle le plus intelligent que la machine
// porte, et le plus rapide possible, sachant que sous 40 tok/s c'est lent. Le planificateur
// estime, pour chaque modèle, le contexte qui tient et le débit attendu à 100k, puis arbitre.
// Les estimations sont calées sur les mesures du poste de référence ; le banc les remplace.

// floorContext : le plancher d'une installation. Chaque modèle reçoit le plus grand contexte que
// la marge de la machine permet, jusqu'à 150k ; sous 32k on ne l'installe pas.
export const OBJECTIVE = { minContext: 100 * 1024, maxContext: 150 * 1024, minTps: 40, floorContext: 32 * 1024 };

const GiB = 1024 ** 3;
// Strata sous Linux : le seul prérequis que Harn ne peut pas poser lui-même (il faut sudo).
export const PYTHON_MISSING = 'il faut d’abord installer Python avec venv : sudo apt install python3-venv (Ubuntu, Debian), puis relancer Harn';
const CRAWL_TPS = 15;
const BACKEND_LABEL = { cuda13: 'CUDA 13', cuda12: 'CUDA 12', vulkan: 'Vulkan', hip: 'HIP (ROCm)', cpu: 'Processeur' };

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

const weightsOf = (model) => model.files.reduce((sum, file) => sum + file.bytes, 0) / GiB;
const vramBudgetOf = (hardware, desktopGiB) => hardware.vramGiB - desktopGiB - HEADROOM_GIB - COMPUTE_GIB;

function llamaCapacity(model, hardware, desktopGiB) {
  return contextIn(model, vramBudgetOf(hardware, desktopGiB) - weightsOf(model));
}

// Un modèle qui déborde de la carte : llama.cpp (--fit) laisse en RAM les couches qui ne tiennent
// pas. Le contexte se calcule alors sur la carte et la RAM ensemble, moins ~8 Go pour le système.
const RAM_RESERVE_GIB = 8;
function sharedCapacity(model, hardware, desktopGiB) {
  const vram = Math.max(0, vramBudgetOf(hardware, desktopGiB));
  const capacity = contextIn(model, vram + hardware.ramGiB - RAM_RESERVE_GIB - weightsOf(model));
  const kvGiB = (capacity.context * (model.kvBytesPerToken?.[capacity.kv] ?? 0)) / GiB;
  return { ...capacity, gpuShare: Math.min(1, vram / (capacity.weightsGiB + kvGiB)) };
}

function contextIn(model, budget) {
  const weights = weightsOf(model);
  if (budget <= 0 || !model.kvBytesPerToken) return { context: 0, kv: 'q8_0', weightsGiB: weights };
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

// Partagé carte + RAM : chaque token lit sa part de poids sur la carte et le reste en RAM
// (~60 Go/s en DDR4/DDR5 double canal) ; les temps s'additionnent.
const RAM_BANDWIDTH = 60;
function sharedTps(model, profile, weightsGiB, gpuShare) {
  const onGpu = 1 / llamaTps(model, profile, weightsGiB);
  const onRam = 1 / llamaTps(model, { ...profile, bandwidth: RAM_BANDWIDTH }, weightsGiB);
  return 1 / (gpuShare * onGpu + (1 - gpuShare) * onRam);
}

// Strata : RTX 5070 (672 Go/s, 12 Go) à 128k : IQ2_XS 63, IQ3_XXS 49 tok/s (README Strata).
// Coder IQ1_M : 55 tok/s à 4k sur la même carte, ramenés à 128k comme l'IQ2_XS (63 / 79) : 44.
// Plus de VRAM = plus d'experts en cache. 3090 : 49 × 1,22 × 1,41 = 85 (mesuré 86 à 100k).
const STRATA_REF = { IQ2_XS: 63, IQ3_XXS: 49, IQ1_M: 44 };
function strataTps(model, profile, hardware) {
  const bandwidth = Math.min(1.8, Math.max(0.5, profile.bandwidth / 672)) ** 0.6;
  const cache = (Math.min(hardware.vramGiB, 32) / 12) ** 0.5;
  // Experts relus depuis le SSD : pénalité estimée, pas encore mesurée (les 50 tok/s d'une 5060 Ti
  // 16 Go + 32 Go, pris d'abord pour de l'IQ2_XS, étaient le Coder IQ1_M, qui tient en RAM).
  const ssd = strataMemory(model, hardware.ramGiB, hardware.vramGiB) === 'ssd' ? 0.88 : 1;
  return STRATA_REF[model.strataModel] * bandwidth * cache * ssd;
}

// Où vivent les experts Strata, avec les règles de son installeur (setup.py, mode faible RAM) :
// 'ram' s'ils tiennent en RAM avec 10 Go à côté ; sinon la carte garde les plus utilisés (sa VRAM
// moins ~5 Go) et le reste est copié en RAM ('resident') ou, à défaut, relu depuis le SSD ('ssd')
// tant que RAM - 6 + part de la carte couvre les experts ; null en dessous.
const LOW_RAM_HEADROOM_GIB = 10;
function strataMemory(model, ramGiB, vramGiB) {
  if (ramGiB >= model.arenaGB + LOW_RAM_HEADROOM_GIB) return 'ram';
  const onGpu = Math.max(0, Math.min(model.arenaGB, vramGiB - 5));
  if (ramGiB >= model.arenaGB - onGpu + LOW_RAM_HEADROOM_GIB) return 'resident';
  // 2 Go de tolérance : chez Strata cette règle n'est qu'une indication du menu (l'installeur passe
  // quand même en mode faible RAM), et une machine « 32 Go » n'en annonce souvent que 31.
  return ramGiB - 6 + onGpu >= model.arenaGB - 2 ? 'ssd' : null;
}

// La RAM minimale (taille de barrette courante) pour qu'un modèle Strata tourne sur cette carte.
const RAM_SIZES = [16, 24, 32, 48, 64, 96, 128, 192, 256];
const strataRamNeeded = (model, vramGiB) => RAM_SIZES.find((size) => strataMemory(model, size * 0.98, vramGiB)) ?? null;

// Le verdict d'un modèle sur cette machine, en mots simples.
export function assess(model, hardware) {
  const profile = gpuProfile(hardware);
  const backend = pickBackend(hardware);
  const desktopGiB = Math.max(0.8, (hardware.vramBaselineMiB ?? 1024) / 1024);
  const gpu = hardware.primary;
  const sizeGB = totalBytes(model) / 1e9;
  const reasons = [];

  if (hardware.diskFreeGiB !== null && hardware.diskFreeGiB < sizeGB * 1.05 + 5) reasons.push(`il faut ${Math.ceil(sizeGB + 5)} Go libres sur le disque (${hardware.diskFreeGiB} disponibles)`);
  if (model.engine === 'strata') {
    // Strata s'installe par START-HERE.bat (Windows) ou setup.sh (Linux), rien d'autre.
    if (hardware.os?.platform && !['win32', 'linux'].includes(hardware.os.platform)) return { fit: 'no', reasons: ['Strata n’est installé par Harn que sous Windows et Linux'] };
    // Moins de RAM que conseillé : Strata passe en mode faible RAM (la carte garde les experts les
    // plus utilisés, le reste est relu depuis le SSD) tant que RAM + carte couvrent les experts.
    if (!strataMemory(model, hardware.ramGiB, hardware.vramGiB)) {
      const need = strataRamNeeded(model, hardware.vramGiB);
      reasons.push(`il faut ${need ?? model.needs.ramGiB} Go de RAM avec cette carte (${Math.round(hardware.ramGiB)} ici)`);
    }
    if (gpu?.vendor !== 'nvidia') reasons.push('Strata demande une carte NVIDIA');
    else if (gpu.computeCapability < model.needs.nvidiaCc) reasons.push('Strata demande une RTX série 20 ou plus récente');
    if (hardware.vramGiB < model.needs.vramGiB) reasons.push(`il faut ${model.needs.vramGiB} Go de mémoire graphique (${hardware.vramGiB} ici)`);
    if (hardware.python?.ok === false) reasons.push(PYTHON_MISSING);
    if (reasons.length) return { fit: 'no', reasons };
    // Le KV de Strata vit en RAM au-delà de 64k (~13,7 Ko par token) : 131k tiennent dès que la RAM suit.
    // En mode faible RAM, le KV au-delà de 32k va sur la carte : ~1,4 Go à 131k, sans conséquence.
    const context = 131072;
    return finalize({ fit: 'full', reasons, context, kv: 'int8', tps: strataTps(model, profile, hardware) });
  }

  if (hardware.ramGiB < model.needs.ramGiB) reasons.push(`il faut ${model.needs.ramGiB} Go de RAM (${Math.round(hardware.ramGiB)} ici)`);
  if (reasons.length) return { fit: 'no', reasons };
  const capacity = llamaCapacity(model, hardware, desktopGiB);
  if (backend.gpu && capacity.context >= OBJECTIVE.floorContext) {
    return finalize({ fit: 'full', reasons, context: capacity.context, kv: capacity.kv, tps: llamaTps(model, profile, capacity.weightsGiB) });
  }
  // Un modèle qui déborde de la carte tourne quand même, partagé avec la RAM, mais plus lentement :
  // autant de contexte que la carte et la RAM ensemble en laissent, 32k au moins.
  const shared = sharedCapacity(model, hardware, desktopGiB);
  if (shared.context >= OBJECTIVE.floorContext || model.engine === 'prism') {
    const context = Math.max(OBJECTIVE.floorContext, shared.context);
    const tps = backend.gpu && model.engine !== 'prism' ? sharedTps(model, profile, shared.weightsGiB, shared.gpuShare) : null;
    return finalize({ fit: 'partial', reasons: ['une partie du modèle tournera sur le processeur, plus lentement'], context, kv: shared.kv, tps });
  }
  return { fit: 'no', reasons: [`il faut au moins ${Math.ceil(capacity.weightsGiB + 4)} Go de mémoire graphique`] };
}

// Les estimations calées sur cette machine. Les formules (bande passante, MTP, MoE) sont réglées
// sur une 3090 de référence ; ici, l'écart médian entre mesure et estimation des modèles déjà
// passés au banc, par famille, corrige les autres. À grandeur égale : l'estimation vaut pour 100k
// de contexte, le banc mesure à ~4k (code) et ~32k (profondeur). Le temps par token croissant à
// peu près linéairement avec le contexte, ces deux points donnent la vitesse mesurée à 100k.
// Borné, et seulement les modèles tout sur la carte : un partage avec la RAM suit d'autres lois.
const familyOf = (model) => (model.engine === 'strata' || model.engine === 'prism' ? model.engine : model.moe ? 'moe' : 'dense');

export function measuredAt100k(bench) {
  const arm = bench?.arms?.find((a) => a.id === bench.winner?.id);
  const short = arm?.workloads?.find((w) => w.workload === 'code');
  const deep = bench?.depth;
  if (!short?.promptTokens || !short.tps || !deep?.tokens || !deep.tps || deep.tokens <= short.promptTokens * 2) return null;
  const slope = (1 / deep.tps - 1 / short.tps) / (deep.tokens - short.promptTokens);
  const perToken = 1 / deep.tps + Math.max(0, slope) * (OBJECTIVE.minContext - deep.tokens);
  return perToken > 0 ? 1 / perToken : null;
}

export function calibrate(verdicts, profiles = {}) {
  const ratios = {};
  for (const entry of verdicts) {
    const model = MODELS.find((m) => m.id === entry.id);
    const measured = measuredAt100k(profiles[entry.id]?.bench);
    if (model && measured && entry.tps && entry.fit === 'full') (ratios[familyOf(model)] ??= []).push(measured / entry.tps);
  }
  const factors = {};
  for (const [family, values] of Object.entries(ratios)) {
    const sorted = values.sort((a, b) => a - b);
    const median = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    factors[family] = +Math.min(1.5, Math.max(0.5, median)).toFixed(3);
  }
  for (const entry of verdicts) {
    const model = MODELS.find((m) => m.id === entry.id);
    const factor = model && factors[familyOf(model)];
    if (!factor || !entry.tps || profiles[entry.id]?.bench?.winner?.tps) continue;
    entry.tpsUncalibrated = entry.tps;
    entry.tps = Math.round(entry.tps * factor);
    entry.calibration = +factor.toFixed(2);
    entry.meetsSpeed = entry.tps >= OBJECTIVE.minTps;
  }
  return factors;
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
  const calibration = calibrate(verdicts, profiles);
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
  // Un modèle partagé avec la RAM peut tenir un long contexte à 5 tok/s : on l'affiche, mais on
  // ne le vise pas (Bonsai sur une petite carte vaut mieux qu'un 27B qui rampe).
  const crawling = (model) => verdict(model.id).tps !== null && verdict(model.id).tps < CRAWL_TPS;
  const usable = MODELS.filter((model) => verdict(model.id).fit !== 'no' && !crawling(model));

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
    calibration,
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
  if (hardware.os?.platform && !['win32', 'linux'].includes(hardware.os.platform)) return null; // Strata : Windows et Linux
  // Seulement un modèle qui ne tourne pas encore ici : sinon on conseillerait ce qui marche déjà.
  const strata = MODELS.filter((m) => m.engine === 'strata' && hardware.vramGiB >= m.needs.vramGiB && !strataMemory(m, hardware.ramGiB, hardware.vramGiB))
    .map((m) => ({ model: m, ram: strataRamNeeded(m, hardware.vramGiB) }))
    .filter((x) => x.ram)
    .sort((a, b) => a.ram - b.ram || a.model.arenaGB - b.model.arenaGB)[0];
  if (!strata) return null;
  const { model, ram } = strata;
  const tps = Math.round(strataTps(model, gpuProfile(hardware), { ...hardware, ramGiB: ram }));
  return `Avec ${ram} Go de RAM, cette carte ferait tourner ${model.name} (${model.variant}) via Strata, à environ ${tps} tok/s et 131k de contexte.`;
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
