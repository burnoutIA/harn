import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { activationsSettled } from './activation.mjs';
import { modelById, ownLauncher } from './catalog.mjs';
import { comboOf, comboRefusal } from './combo-state.mjs';
import { describe, startEngine, stopOthers } from './engine.mjs';
import { alternates, engineSheet, ensureEngine, recordBuildFailure } from './engines.mjs';
import { withGpu } from './gpu-queue.mjs';
import { dflashEligible, gpuProfile, mtpPlan } from './levers.mjs';
import { HYPERQWEN_ARMS, INK2_ARMS, freeVram, loadWithHeadroom, recipeFor, runtimeKind, startingTuning } from './loading.mjs';
import { writeMachineFacts } from './machine-doc.mjs';
import { downloadFile } from './model-files.mjs';
import { makePlan, OBJECTIVE } from './planner.mjs';
import { installLlama } from './runtimes.mjs';
import { iqScores } from './scores.mjs';
import { settleGpuChange } from './gpu-profiles.mjs';
import { getState, update } from './state.mjs';
import { HEADROOM_MIN_MIB, USAGE_WEIGHTS, isBetter, measure } from './tuner.mjs';

// Le banc : une variable à la fois, le plus rapide gagne.
const sameTuning = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// DFlash2 : brouillon Q4_K_M et ses tampons. Mesuré sur RTX 3090 (b11430, 124k) : ~0,9 Gio ;
// on garde un peu de marge. La VRAM réelle est revérifiée après chargement.
const DFLASH_MIB = 1200;
// DSpark (Inkling 2 Mini) : brouillon Q8_0 de 0,4 à 0,5 Go, ses tampons et son état récurrent.
// Son contexte a son propre tampon de calcul, qui suit ubatch × contexte comme celui du modèle :
// RTX 3090, Inkling UD-Q4_K_M, ub 512 : cudaMalloc refusé à 100k q8_0 avec 900 réservés ; à 100k
// q4_0 il charge, 23,3 Go sur 24,6, soit ~1,8 Gio pour le brouillon et son contexte.
const DSPARK_MIB = 1800;
// La charge longue (~94k tokens lus) demande ce contexte.
const LONG_CONTEXT = 100 * 1024;
// Le plus grand contexte (≥ 100k) qui laisse la marge une fois `extraMiB` ajoutés en VRAM.
function roomFor(model, best, extraMiB) {
  if (best.headroomMiB == null || !model.kvBytesPerToken) return null;
  const perToken = model.kvBytesPerToken[best.tuning.kv] / 2 ** 20;
  const missing = extraMiB + HEADROOM_MIN_MIB - best.headroomMiB;
  const context = missing <= 0 ? best.tuning.context : Math.floor((best.tuning.context - missing / perToken) / 4096) * 4096;
  return context >= OBJECTIVE.minContext ? context : null;
}

// Le réglage de départ de DSpark : le meilleur, contexte réduit pour loger le brouillon. S'il
// tomberait sous 100k, un cache plus léger (f16 → q8_0 → q4_0) libère la place. RTX 3090, Inkling
// UD-Q4_K_M à 118k en q8_0 : le bras était sauté sans un mot ; il est maintenant noté.
export function dsparkStart(model, best) {
  const context = roomFor(model, best, DSPARK_MIB);
  if (context) return { ...best.tuning, context };
  const per = model.kvBytesPerToken ?? {};
  for (const kv of { f16: ['q8_0', 'q4_0'], q8_0: ['q4_0'] }[best.tuning.kv] ?? []) {
    if (!per[kv] || best.headroomMiB == null) continue;
    const freed = (best.tuning.context * (per[best.tuning.kv] - per[kv])) / 2 ** 20;
    const room = roomFor(model, { ...best, headroomMiB: best.headroomMiB + freed, tuning: { ...best.tuning, kv } }, DSPARK_MIB);
    if (room) return { ...best.tuning, kv, context: room };
  }
  return null;
}
export async function tuneModel(modelId, options = {}) {
  // Le banc veut la carte pour le modèle mesuré seul : pas pendant un combo.
  if (comboOf()) throw comboRefusal('le banc');
  return withGpu(modelId, async () => {
    const result = await tuneModelInner(modelId, options);
    // La vitesse et le contexte mesurés changent la note globale : le plan est recalculé. Un banc
    // réussi efface l'erreur d'un essai précédent (relancé seul, il ne passe pas par l'installation).
    update((s) => {
      s.plan = makePlan(s.hardware, iqScores(s), s.profiles);
      if (s.models[modelId]) s.models[modelId].error = null;
      settleGpuChange(s);
    });
    return result;
  });
}
// Un banc lancé à la main (bouton Mesurer) : suivi dans le panneau « En cours » comme à
// l'installation, et l'erreur reste sur la carte du modèle.
export async function benchWithProgress(modelId) {
  update((s) => { if (s.models[modelId]) Object.assign(s.models[modelId], { tuning: true, tuneDetail: null, error: null }); });
  try {
    return await tuneModel(modelId, { onProgress: (detail) => update((s) => { if (s.models[modelId]) s.models[modelId].tuneDetail = detail; }) });
  } catch (error) {
    update((s) => { if (s.models[modelId]) s.models[modelId].error = error.message; });
    throw error;
  } finally {
    update((s) => { if (s.models[modelId]) Object.assign(s.models[modelId], { tuning: false, tuneDetail: null }); });
  }
}

async function tuneModelInner(modelId, { startFrom = null, engine = null, onProgress = () => {} } = {}) {
  const model = modelById(modelId);
  const state = getState();
  const hardware = state.hardware;
  const profile = gpuProfile(hardware);
  // Le banc mesure le modèle seul sur la carte : vitesse et marge VRAM ne valent qu'ainsi. Un
  // chargement encore en cours (le modèle par défaut, rechargé au démarrage de Harn) finit d'abord :
  // arrêté en route, il laissait la carte occupée et le banc partait à 102k au lieu de 150k.
  await activationsSettled();
  await stopOthers(modelId);
  // engine : le moteur imposé quand l'officiel ne sait pas charger ce modèle ({ fork, backend }).
  const startTuning = { ...(state.profiles[modelId]?.tuning ?? startingTuning(model, hardware)), ...(engine ?? {}) };
  // Le contexte repart de l'estimation du plan : un banc passé au mauvais moment (carte encore occupée
  // par un autre moteur) l'avait réduit, et rien ne le faisait remonter. Le chargement le réduit à
  // nouveau si la marge manque vraiment.
  const estimate = state.plan?.verdicts?.find((v) => v.id === modelId);
  const estimated = estimate?.contextEstimated ?? estimate?.context;
  if (!startFrom && !ownLauncher(model) && estimated > (startTuning.context ?? 0)) startTuning.context = estimated;
  // Un moteur compilé par Harn dont les sources ont changé (correctif ajouté ou modifié) est recompilé
  // avant toute mesure : sinon le banc mesurerait l'ancien binaire. Sans changement, rien à faire.
  // Un moteur sans fiche (orphelin, voir engineSheet) n'a plus de sources connues : on le garde tel quel.
  if (!startFrom && startTuning.fork && engineSheet(startTuning.fork)?.source === 'build' && !engineSheet(startTuning.fork).orphan) {
    const sheet = engineSheet(startTuning.fork);
    onProgress(`${sheet.label} · préparation du moteur`);
    await ensureEngine({ id: sheet.id }, { hardware, onLog: (text) => {
      const step = String(text).match(/\[\s*(\d+)%\]/g)?.at(-1);
      if (step) onProgress(`${sheet.label} · compilation ${step}`);
    } }).catch((error) => recordBuildFailure(sheet.id, error, hardware));
  }
  const initial = startFrom ?? await loadWithHeadroom(model, startTuning);

  let loadedTuning = initial.tuning;
  let loadedHeadroom = initial.headroomMiB;
  const results = [];
  let index = 0;

  // Les charges comparées d'un essai à l'autre (la profondeur ne s'ajoute qu'à l'étape KV, la dernière).
  const compared = ['code', 'prose'];
  const usage = getState().prefs?.usage ?? 'balanced';
  const weights = USAGE_WEIGHTS[usage] ?? USAGE_WEIGHTS.balanced;
  async function trial(stage, tuning, workloads = compared) {
    index += 1;
    const label = describe(tuning);
    const say = (what) => onProgress(`${stage} · ${label}${what ? ` · ${what}` : ''}`);
    say('chargement');
    try {
      if (!sameTuning(tuning, loadedTuning)) {
        await startEngine(recipeFor(model, tuning));
        loadedTuning = tuning;
        loadedHeadroom = await freeVram();
      }
      // Un brouillon n-gramme se souvient des réponses précédentes : deux passages quand même, moteur
      // relancé avant le second. Mesuré une seule fois, un passage chanceux gagnait le banc (Ornith 9B,
      // MTP adaptatif + n-gramme : code à 285 tok/s contre ~130 pour ses voisins, aux mêmes graines).
      const ngram = ['mtp-adaptive', 'ngram'].includes(tuning.spec?.type) || tuning.spec?.ngram;
      const fresh = ngram ? async () => { say('relance (mémoire n-gramme)'); await startEngine(recipeFor(model, tuning)); } : null;
      const result = await measure(getState().active.endpoint, modelId, { workloads, weights, runs: 2, fresh, sampling: model.sampling, onProgress: say });
      const entry = { id: `arm${index}`, stage, label, tuning, headroomMiB: loadedHeadroom, ...result };
      entry.ok = ownLauncher(model) || loadedHeadroom === null || loadedHeadroom >= HEADROOM_MIN_MIB;
      results.push(entry);
      return entry;
    } catch (error) {
      loadedTuning = null;
      const entry = { id: `arm${index}`, stage, label, tuning, error: error.message.slice(0, 200), ok: false };
      results.push(entry);
      return entry;
    }
  }
  const better = (candidate, current) => (isBetter(candidate, current) ? candidate : current);

  if (model.engine === 'strata') {
    let best = await trial('Réglages Strata', { ...initial.tuning, strataArm: 'Réglages de l’installeur' });
    for (const arm of await strataArms(model, initial.tuning)) best = better(await trial('Strata', arm), best);
    return finish(model, results, best);
  }
  // Le moteur du Gemma Challenge : le seul réglage de la fiche. La pile telle quelle (4k) ne tient
  // ni la charge en profondeur (~32k) ni le prompt de code (plus de 4k tokens Gemma).
  if (model.engine === 'gemma-challenge') {
    const only = await trial('Gemma Challenge', initial.tuning, model.challengeStack === 'qat' ? compared : ['prose']);
    if (only.error) throw new Error(only.error);
    return finish(model, results, only);
  }
  // Radiance : le seul réglage de la fiche, mesuré sur toutes les charges.
  if (model.engine === 'radiance') {
    const only = await trial('Radiance', initial.tuning);
    if (only.error) throw new Error(only.error);
    return finish(model, results, only);
  }
  // Le moteur sur mesure d'Inkling : sans spéculation, puis avec son drafter MTP (blocs de 8, repli
  // automatique quand il ne paie pas). Le meilleur des deux à 128k.
  if (model.engine === 'ink2') {
    let best = await trial('Moteur sur mesure', initial.tuning);
    const other = Object.values(INK2_ARMS).find((arm) => arm.spec !== Boolean(initial.tuning.spec));
    best = better(await trial('Moteur sur mesure', other), best);
    if (best.error) throw new Error(best.error);
    return finish(model, results, best);
  }
  // Le moteur sur mesure de LFM3 : son seul réglage, mesuré sur toutes les charges.
  if (model.engine === 'lfm3') {
    const only = await trial('Moteur sur mesure', initial.tuning);
    if (only.error) throw new Error(only.error);
    return finish(model, results, only);
  }
  // HyperQwen : ses deux réglages à 128k (HYPERQWEN_ARMS), celui en place d'abord. DFlash2 ne se
  // charge que si la carte est libre : son échec est noté, MTP reste.
  if (model.engine === 'hyperqwen') {
    let best = await trial('Réglages HyperQwen', initial.tuning);
    for (const arm of Object.values(HYPERQWEN_ARMS).filter((a) => a.spec !== initial.tuning.spec)) best = better(await trial('HyperQwen', arm), best);
    if (best.error) throw new Error(best.error);
    return finish(model, results, best);
  }

  let best = await trial('Départ', initial.tuning);
  if (best.error) throw new Error(best.error);
  const gpu = initial.tuning.backend !== 'cpu';

  if (gpu && model.mtp && !best.tuning.noNextn) {
    // Les voisins du meilleur réglage connu (n ± 1), plus les a priori de la classe de carte.
    const current = best.tuning.spec?.type === 'mtp' ? best.tuning.spec : mtpPlan(profile).base;
    const seen = new Set([`${current.n}/${current.pMin}`]);
    const arms = [{ n: current.n - 1, pMin: current.pMin }, { n: current.n + 1, pMin: current.pMin }, ...mtpPlan(profile).arms]
      .filter((arm) => arm.n >= 2 && arm.n <= 6 && !seen.has(`${arm.n}/${arm.pMin}`) && seen.add(`${arm.n}/${arm.pMin}`))
      .slice(0, 3);
    const ngram = current.ngram ? { ngram: true } : {};
    for (const arm of arms) best = better(await trial('Spéculation MTP', { ...best.tuning, spec: { type: 'mtp', n: arm.n, pMin: arm.pMin, ...ngram } }), best);
  }

  // Brouillon n-gramme (DFlash2, s'il existe, est essayé ensuite) : en place par
  // défaut, car son vrai gain est l'édition de fichiers, que le banc (code écrit de zéro, prose) ne
  // mesure pas. Le retirer ne l'emporte que s'il gagne au-delà du bruit.
  // Avec MTP (n fixe), le n-gramme s'y ajoute ou s'en retire de la même façon.
  const spec = best.tuning.spec ?? { type: 'none' };
  if (engineSheet(runtimeKind(model, best.tuning))?.ngram) {
    let flipped = null;
    if (['ngram', 'none'].includes(spec.type) && (!model.mtp || best.tuning.noNextn)) flipped = spec.type === 'ngram' ? { type: 'none' } : { type: 'ngram' };
    else if (spec.type === 'mtp' && spec.n !== 'auto') flipped = { ...spec, ngram: !spec.ngram };
    if (flipped) best = better(await trial('Spéculation n-gramme', { ...best.tuning, spec: flipped }), best);
  }

  const dflashContext = gpu ? roomFor(model, best, DFLASH_MIB) : null;
  if (dflashContext && dflashEligible(model, profile, best.headroomMiB + (best.tuning.context - dflashContext) * model.kvBytesPerToken[best.tuning.kv] / 2 ** 20)) {
    onProgress('DFlash2 · téléchargement du brouillon');
    try {
      await downloadFile(model, model.dflash);
      best = better(await trial('DFlash2', { ...best.tuning, context: dflashContext, spec: { type: 'dflash', n: 5 } }), best);
    } catch (error) {
      results.push({ id: 'dflash', stage: 'DFlash2', label: 'brouillon indisponible', error: error.message, ok: false });
    }
  }

  // DSpark (Inkling 2) : le brouillon livré avec le modèle, à plusieurs profondeurs (Unsloth conseille
  // 3). R9700, Inkling 2 Mini : ~7 600 petits noyaux par token, la carte occupée 39 % du temps ; une
  // passe qui vérifie plusieurs tokens coûte presque autant qu'une seule. Un moteur qui ne connaît
  // pas DSpark (sans la PR #32218) refuse le brouillon : l'essai est noté, le réglage reste.
  const sparkStart = gpu && model.dspark ? dsparkStart(model, best) : null;
  if (gpu && model.dspark && !sparkStart) results.push({ id: 'dspark', stage: 'DSpark', label: 'pas essayé : pas la place pour le brouillon à 100k', ok: false });
  if (sparkStart) {
    onProgress('DSpark · téléchargement du brouillon');
    try {
      await downloadFile(model, model.dspark);
      const start = sparkStart;
      let spark = null;
      for (const n of [3, 2, 4, 6]) {
        // Au-delà de 4, seulement si 4 a battu 2 et 3.
        if (n === 6 && spark?.tuning.spec?.n !== 4) break;
        const arm = await trial('DSpark', { ...start, spec: { type: 'dspark', n } });
        if (arm.error && n === 3) throw new Error(arm.error);
        spark = spark ? better(arm, spark) : arm;
      }
      best = better(spark, best);
    } catch (error) {
      results.push({ id: 'dspark', stage: 'DSpark', label: 'brouillon refusé par le moteur', error: error.message.slice(0, 200), ok: false });
    }
  }

  if (gpu && profile.flashAttentionUncertain) best = better(await trial('Flash Attention', { ...best.tuning, fa: 'off' }), best);

  // Radeon : Vulkan et HIP, même réglage.
  // Un modèle lié à un seul moteur (engineOnly) n'a que le backend de sa compilation.
  for (const backend of model.engineOnly ? [] : getState().plan.backend.candidates.slice(1)) {
    try {
      await installLlama(runtimeKind(model), backend);
      best = better(await trial('Backend', { ...best.tuning, backend }), best);
    } catch (error) {
      results.push({ id: backend, stage: 'Backend', label: backend, error: error.message, ok: false });
    }
  }

  // Les variantes propres au moteur du réglage (fiche de engines.mjs : DFlash2, MTP adaptatif…).
  // alternates() écarte le moteur courant : sans cette étape, un modèle déjà passé sur un fork ne
  // réessaierait jamais ses variantes, même quand le moteur change (nouveau correctif de Harn).
  const ownSheet = gpu && best.tuning.fork ? engineSheet(best.tuning.fork) : null;
  if (ownSheet?.arms) {
    try {
      const arms = ownSheet.arms({ ...best.tuning }, model).filter((arm) => describe(arm) !== describe(best.tuning));
      if (model.dflash && arms.some((arm) => arm.spec?.type === 'dflash')) {
        onProgress(`${ownSheet.label} · téléchargement du brouillon DFlash2`);
        await downloadFile(model, model.dflash);
      }
      for (const arm of arms) best = better(await trial(`Moteur ${ownSheet.label}`, arm), best);
    } catch (error) {
      results.push({ id: ownSheet.id, stage: `Moteur ${ownSheet.label}`, label: 'variantes', error: error.message.slice(0, 200), ok: false });
    }
  }

  // Les autres moteurs qui savent charger ce modèle (fiches de engines.mjs) : le même réglage,
  // plus les variantes propres à chacun. Un moteur à compiler l'est une seule fois (10-20 min) ;
  // un échec est noté et ne bloque pas le banc.
  for (const alt of gpu ? await alternates(model, best.tuning, profile, hardware) : []) {
    try {
      onProgress(`${alt.label} · préparation du moteur`);
      const info = await ensureEngine(alt, { hardware, onLog: (text) => {
        const step = String(text).match(/\[\s*(\d+)%\]/g)?.at(-1);
        if (step) onProgress(`${alt.label} · compilation ${step}`);
      } });
      const arms = alt.arms(info.backend);
      // Un réglage DFlash2 sans son brouillon tournerait sans anticipation : téléchargé d'abord.
      if (model.dflash && arms.some((arm) => arm.spec?.type === 'dflash')) {
        onProgress(`${alt.label} · téléchargement du brouillon DFlash2`);
        await downloadFile(model, model.dflash);
      }
      for (const arm of arms) best = better(await trial(`Moteur ${alt.label}`, arm), best);
    } catch (error) {
      if (engineSheet(alt.id).source === 'build') recordBuildFailure(alt.id, error, hardware);
      results.push({ id: alt.id, stage: `Moteur ${alt.label}`, label: 'installation', error: error.message.slice(0, 200), ok: false });
    }
  }

  // Le type de KV (f16 ou q8_0), en dernier : il se juge sur le moteur et l'anticipation retenus, et
  // seulement en contexte long, où se joue l'écart. R9700, Qwen3.8-27B (RDNA Boosts), décodage simple :
  // q8_0 ~2 % plus lent à 1k, à égalité vers 30k, 11 % plus rapide à 100k et 17 % à 141k (l'attention
  // lit deux fois moins de KV). Qualité : perplexité à 64k identique (2,151 f16, 2,148 q8_0).
  // Chaque type est mesuré au plus grand contexte qui lui laisse la marge (jamais sous l'objectif).
  const perToken = model.kvBytesPerToken;
  if (gpu && perToken?.f16 && perToken?.q8_0 && ['f16', 'q8_0'].includes(best.tuning.kv) && !best.tuning.kvV && best.headroomMiB != null) {
    const other = best.tuning.kv === 'f16' ? 'q8_0' : 'f16';
    // Une architecture plafonnée (gguf.mjs, CONTEXT_CAPS) se compare à son plafond, jamais au-delà.
    const cap = model.profile?.maxContext ?? Infinity;
    const otherContext = Math.min(OBJECTIVE.maxContext, cap, Math.floor((best.headroomMiB - HEADROOM_MIN_MIB + best.tuning.context * perToken[best.tuning.kv] / 2 ** 20) / (perToken[other] / 2 ** 20) / 4096) * 4096);
    if (otherContext >= Math.min(OBJECTIVE.minContext, cap)) {
      const loads = Math.min(best.tuning.context, otherContext) >= LONG_CONTEXT ? ['code', 'prose', 'depth', 'long'] : ['code', 'prose', 'depth'];
      const reference = await trial('KV en contexte long', best.tuning, loads);
      const candidate = await trial('KV en contexte long', { ...best.tuning, kv: other, context: otherContext }, loads);
      if (!reference.error) best = isBetter(candidate, reference) ? candidate : reference;
      else if (!candidate.error && candidate.ok) best = candidate;
    }
  }

  return finish(model, results, best);

  async function finish(model, results, best) {
    if (!sameTuning(loadedTuning, best.tuning)) await startEngine(recipeFor(model, best.tuning));
    // La vitesse en profondeur du réglage retenu (reprise si l'étape KV l'a déjà mesurée).
    let depth = best.workloads?.find((w) => w.workload === 'depth') ?? null;
    const long = best.workloads?.find((w) => w.workload === 'long') ?? null;
    if (!depth && model.engine !== 'strata' && best.tuning.backend !== 'cpu' && best.tuning.context >= 40960) {
      onProgress('Vitesse en profondeur (~32k tokens)');
      depth = (await measure(getState().active.endpoint, modelId, { workloads: ['depth'], sampling: model.sampling }).catch(() => null))?.workloads[0] ?? null;
    }
    update((s) => {
      const entry = (s.profiles[model.id] ??= {});
      entry.tuning = best.tuning;
      entry.bench = {
        at: new Date().toISOString(),
        gpu: s.hardware.primary?.name ?? null,
        arch: profile.archLabel,
        arms: results.map(({ tuning, ...rest }) => rest),
        winner: { id: best.id, label: best.label, tps: best.tps, prefillTps: best.prefillTps, throttled: best.throttled },
        usage,
        depth: depth && { tokens: depth.promptTokens, tps: +depth.tps.toFixed(1), prefillTps: depth.prefillTps ? Math.round(depth.prefillTps) : null },
        long: long && { tokens: long.promptTokens, tps: +long.tps.toFixed(1), prefillTps: long.prefillTps ? Math.round(long.prefillTps) : null },
      };
    });
    await writeMachineFacts().catch(() => {});
    return getState().profiles[model.id];
  }
}
// Variantes Strata : chacune est une copie de la config d'installation avec un argument changé.
function setArg(args, flag, value) {
  const copy = [...args];
  const at = copy.indexOf(flag);
  if (at >= 0) copy.splice(at, 2, flag, value);
  else copy.push(flag, value);
  return copy;
}
async function strataArms(model, baseTuning) {
  const runtime = getState().runtimes[`strata-${model.strataModel}`];
  const config = JSON.parse(await readFile(path.join(runtime.dir, runtime.config), 'utf8'));
  const variants = [];
  // Réponses en français : le brouillon MTP propose aussi les tokens français (+15-38 %).
  // draft-vocab et KV k8v4 sont des choix d'installation (Strata prépare des fichiers) : pas des
  // options du moteur. On ne fait varier ici que ce que le moteur accepte au démarrage.
  // 0,35 a battu la valeur calibrée (0,00) sur la 3090 de référence ; ailleurs, on mesure.
  const pcie = config.args[config.args.indexOf('--pcie-frac') + 1];
  if (pcie !== '0.35') variants.push(['pcie-frac 0.35', (args) => setArg(args, '--pcie-frac', '0.35')]);

  const arms = [];
  for (const [label, change] of variants) {
    const name = `strata-harn-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.json`;
    await writeFile(path.join(runtime.dir, name), JSON.stringify({ ...config, args: change(config.args) }, null, 2));
    arms.push({ ...baseTuning, strataConfig: name, strataArm: label });
  }
  return arms;
}
