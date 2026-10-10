import path from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { modelById } from './catalog.mjs';
import { describe, startEngine } from './engine.mjs';
import { alternates, engineSheet, ensureEngine, recordBuildFailure } from './engines.mjs';
import { withGpu } from './gpu-queue.mjs';
import { dflashEligible, gpuProfile, mtpPlan } from './levers.mjs';
import { freeVram, loadWithHeadroom, recipeFor, runtimeKind, startingTuning } from './loading.mjs';
import { writeMachineFacts } from './machine-doc.mjs';
import { downloadFile } from './model-files.mjs';
import { makePlan, OBJECTIVE } from './planner.mjs';
import { installLlama } from './runtimes.mjs';
import { iqScores } from './scores.mjs';
import { getState, update } from './state.mjs';
import { HEADROOM_MIN_MIB, USAGE_WEIGHTS, isBetter, measure } from './tuner.mjs';

// Le banc : une variable à la fois, le plus rapide gagne.
const sameTuning = (a, b) => JSON.stringify(a) === JSON.stringify(b);
// DFlash2 : brouillon Q4_K_M et ses tampons. Mesuré sur RTX 3090 (b11430, 124k) : ~0,9 Gio ;
// on garde un peu de marge. La VRAM réelle est revérifiée après chargement.
const DFLASH_MIB = 1200;
// Le plus grand contexte (≥ 100k) qui laisse la marge une fois `extraMiB` ajoutés en VRAM.
function roomFor(model, best, extraMiB) {
  if (best.headroomMiB == null || !model.kvBytesPerToken) return null;
  const perToken = model.kvBytesPerToken[best.tuning.kv] / 2 ** 20;
  const missing = extraMiB + HEADROOM_MIN_MIB - best.headroomMiB;
  const context = missing <= 0 ? best.tuning.context : Math.floor((best.tuning.context - missing / perToken) / 4096) * 4096;
  return context >= OBJECTIVE.minContext ? context : null;
}
export async function tuneModel(modelId, options = {}) {
  return withGpu(modelId, async () => {
    const result = await tuneModelInner(modelId, options);
    // La vitesse et le contexte mesurés changent la note globale : le plan est recalculé.
    update((s) => { s.plan = makePlan(s.hardware, iqScores(s), s.profiles); });
    return result;
  });
}
async function tuneModelInner(modelId, { startFrom = null, engine = null, onProgress = () => {} } = {}) {
  const model = modelById(modelId);
  const state = getState();
  const hardware = state.hardware;
  const profile = gpuProfile(hardware);
  // engine : le moteur imposé quand l'officiel ne sait pas charger ce modèle ({ fork, backend }).
  const initial = startFrom ?? await loadWithHeadroom(model, { ...(state.profiles[modelId]?.tuning ?? startingTuning(model, hardware)), ...(engine ?? {}) });

  let loadedTuning = initial.tuning;
  let loadedHeadroom = initial.headroomMiB;
  const results = [];
  let index = 0;

  // Les charges de la comparaison en cours : une fois la profondeur entrée dans la comparaison
  // (étape KV), chaque essai suivant la mesure aussi, sinon un moteur mesuré sans elle gagnerait
  // d'office (sa moyenne ne compterait pas la partie la plus lente).
  let compared = ['code', 'prose'];
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
      const result = await measure(getState().active.endpoint, modelId, { workloads, weights, onProgress: say });
      const entry = { id: `arm${index}`, stage, label, tuning, headroomMiB: loadedHeadroom, ...result };
      entry.ok = model.engine === 'strata' || loadedHeadroom === null || loadedHeadroom >= HEADROOM_MIN_MIB;
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
    for (const arm of arms) best = better(await trial('Spéculation MTP', { ...best.tuning, spec: { type: 'mtp', n: arm.n, pMin: arm.pMin } }), best);
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

  // KV f16 : pente de profondeur plus faible sur le build officiel, mais KV deux fois plus gros.
  // Il ne se juge qu'avec la charge longue, mesurée aussi sur le réglage actuel.
  // Mesuré en profondeur (~32k), à un contexte qui laisse f16 tenir avec la marge (réduit s'il le
  // faut, jamais sous l'objectif de 100k) : Xing4 (MLA) y gagne 30 % de génération à 49k.
  const perToken = model.kvBytesPerToken;
  const f16Context = gpu && perToken?.f16 && perToken[best.tuning.kv] && best.headroomMiB !== null
    ? Math.min(best.tuning.context, Math.floor((best.headroomMiB - HEADROOM_MIN_MIB + best.tuning.context * perToken[best.tuning.kv] / 2 ** 20) / (perToken.f16 / 2 ** 20) / 4096) * 4096)
    : 0;
  if (best.tuning.kv !== 'f16' && !best.tuning.kvV && f16Context >= OBJECTIVE.minContext) {
    const reference = await trial('KV en profondeur', best.tuning, ['code', 'prose', 'depth']);
    const f16 = await trial('KV en profondeur', { ...best.tuning, kv: 'f16', context: f16Context }, ['code', 'prose', 'depth']);
    if (!reference.error && isBetter(f16, reference)) best = f16;
    else if (!reference.error) best = reference;
    if (!best.error) compared = ['code', 'prose', 'depth'];
  }

  if (gpu && profile.flashAttentionUncertain) best = better(await trial('Flash Attention', { ...best.tuning, fa: 'off' }), best);

  // Radeon : Vulkan et HIP, même réglage.
  for (const backend of getState().plan.backend.candidates.slice(1)) {
    try {
      await installLlama(runtimeKind(model), backend);
      best = better(await trial('Backend', { ...best.tuning, backend }), best);
    } catch (error) {
      results.push({ id: backend, stage: 'Backend', label: backend, error: error.message, ok: false });
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
      for (const arm of alt.arms(info.backend)) best = better(await trial(`Moteur ${alt.label}`, arm), best);
    } catch (error) {
      if (engineSheet(alt.id).source === 'build') recordBuildFailure(alt.id, error, hardware);
      results.push({ id: alt.id, stage: `Moteur ${alt.label}`, label: 'installation', error: error.message.slice(0, 200), ok: false });
    }
  }

  return finish(model, results, best);

  async function finish(model, results, best) {
    if (!sameTuning(loadedTuning, best.tuning)) await startEngine(recipeFor(model, best.tuning));
    // La vitesse en profondeur du réglage retenu (reprise si l'étape KV l'a déjà mesurée).
    let depth = best.workloads?.find((w) => w.workload === 'depth') ?? null;
    if (!depth && model.engine !== 'strata' && best.tuning.backend !== 'cpu' && best.tuning.context >= 40960) {
      onProgress('Vitesse en profondeur (~32k tokens)');
      depth = (await measure(getState().active.endpoint, modelId, { workloads: ['depth'] }).catch(() => null))?.workloads[0] ?? null;
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
