import path from 'node:path';
import { readFile, rm } from 'node:fs/promises';
import { activate, runIq } from './activation.mjs';
import { runAnalysis } from './analysis.mjs';
import { requestApproval } from './approvals.mjs';
import { SANDBOX_INSTALL, sandboxAvailable } from './sandbox.mjs';
import { tuneModel } from './bench.mjs';
import { displayName, modelById, MODELS } from './catalog.mjs';
import { buildEntry, inspectRepo, registerModel, unregisterModel } from './custom-models.mjs';
import { download } from './download.mjs';
import { stopEngine } from './engine.mjs';
import { addEngine, archMissing, canBuild, dropUnusedEngines, enginesFor, engineSheet, ensureEngine, findEngine } from './engines.mjs';
import { busyWith, withGpu } from './gpu-queue.mjs';
import { runtimeKind } from './loading.mjs';
import { refreshHardware } from './machine-state.mjs';
import { installModelFiles } from './model-files.mjs';
import { DIRS } from './paths.mjs';
import { configurePi } from './pi.mjs';
import { assess, makePlan, OBJECTIVE } from './planner.mjs';
import { iqScores } from './scores.mjs';
import { getState, update } from './state.mjs';
import { checkHub } from './watch.mjs';

// Installer, supprimer, et trouver le moteur qui manque.
// Installer un modèle proposé, puis le régler. Le modèle courant reste servi pendant le
// téléchargement ; il ne cède la carte qu'au moment du banc.
const installs = new Map();
// La phase d'une installation, pour l'interface : download → tune → iq → analysis, puis null.
const setPhase = (modelId, phase, detail = null) => update((s) => { Object.assign(s.models[modelId] ??= {}, { phase, phaseDetail: detail }); });
export function installAndTune(modelId, onDetail = () => {}, { fromCustomJob = false, ggufDir = null } = {}) {
  if (!installs.has(modelId)) {
    installs.set(modelId, (async () => {
      const model = modelById(modelId);
      const plan = getState().plan;
      // Une nouvelle tentative efface l'erreur de la précédente.
      update((s) => { if (s.models[modelId]) s.models[modelId].error = null; });
      // Avant de télécharger : quel moteur sait charger cette architecture ? L'officiel d'abord
      // (mis à jour s'il le faut), sinon un moteur ajouté avec l'accord de l'utilisateur.
      const failed = getState().models[modelId]?.engineFailures ?? {};
      const engines = model.engine === 'strata' ? null : (await enginesFor(model.profile?.arch))?.filter((e) => !failed[e.id]) ?? null;
      if (engines && !engines.length) throw new Error(archMissing(model.profile.arch));
      let engine = null;
      if (model.engine !== 'strata') {
        const primary = engines?.find((e) => e.id === runtimeKind(model)) ?? engines?.[0] ?? { id: runtimeKind(model) };
        setPhase(modelId, 'download', `Préparation du moteur ${engineSheet(primary.id).label}`);
        const info = await ensureEngine(primary, { backend: plan.backend.id, onLog: (text) => {
          const step = String(text).match(/\[\s*(\d+)%\]/g)?.at(-1);
          if (step) setPhase(modelId, 'download', `Compilation de ${engineSheet(primary.id).label} ${step}`);
        } });
        if (primary.id !== runtimeKind(model)) engine = { fork: primary.id, backend: info.backend };
      }
      setPhase(modelId, 'download');
      await installModelFiles(model, { ggufDir });
      setPhase(modelId, 'tune');
      update((s) => { s.models[modelId].tuning = true; });
      await withGpu(modelId, async () => {
        await tuneModel(modelId, { engine, onProgress: (detail) => { onDetail(detail); update((s) => { s.models[modelId].tuneDetail = detail; }); } }).catch((error) => {
          // Un moteur ajouté qui connaît l'architecture mais pas ce fichier (tenseurs d'une autre
          // version du code) : noté pour ce modèle, la prochaine recherche passe au suivant.
          if (error.fatal && engine?.fork) update((s) => { s.models[modelId].engineFailures = { ...s.models[modelId].engineFailures, [engine.fork]: error.message.slice(0, 300) }; });
          throw error;
        });
        update((s) => { s.models[modelId].tuning = false; s.models[modelId].tuneDetail = null; });
        if (getState().pi.installed) await configurePi();
        if (fromCustomJob) return; // la suite (test, analyse) est menée par installCustom
        setPhase(modelId, 'iq');
        await runIq(modelId).catch(() => {});
        setPhase(modelId, 'analysis');
        await runAnalysis().catch(() => {});
      }).finally(() => { if (!fromCustomJob) setPhase(modelId, null); });
    })().catch((error) => {
      update((s) => { s.models[modelId] = { ...(s.models[modelId] ?? {}), installing: false, tuning: false, phase: null, error: error.message }; });
      throw error;
    }).finally(() => installs.delete(modelId)));
  }
  return installs.get(modelId);
}
// Évaluer chaque quantification d'un dépôt sur cette machine, avec le même planificateur.
export async function inspectForMachine(url) {
  const report = await inspectRepo(url);
  const hardware = getState().hardware;
  report.quants = report.quants.map((quant) => {
    const entry = buildEntry({ repo: report.repo, quant, profile: report.profile });
    const verdict = assess(entry, hardware);
    return { quant: quant.quant, gigabytes: +(quant.bytes / 1e9).toFixed(1), files: quant.files.length, verdict: { fit: verdict.fit, context: verdict.context ?? null, kv: verdict.kv ?? null, tpsAt100k: verdict.tps ?? null, meetsObjective: Boolean(verdict.meetsContext && verdict.meetsSpeed), reasons: verdict.reasons } };
  });
  report.objective = { minContext: OBJECTIVE.minContext, maxContext: OBJECTIVE.maxContext, minTps: OBJECTIVE.minTps };
  report.machine = getState().plan?.summary?.machine ?? null;
  return report;
}
// Installer un modèle choisi : enregistrement, téléchargement, banc, test d'intelligence, puis
// retour au modèle qui servait avant (pi tourne dessus). Une seule installation à la fois.
let customJob = null;
let jobState = null;
export const customJobState = () => jobState;
export function installCustom({ url, quant, mmproj = null, sampling = null }) {
  if (customJob) throw new Error('Une installation est déjà en cours');
  jobState = { running: true, startedAt: Date.now(), url, quant, step: 'inspect', detail: 'Analyse du dépôt', result: null, error: null };
  const onProgress = ({ step, detail }) => { jobState = { ...jobState, step, detail }; };
  customJob = (async () => {
    const report = await inspectRepo(url);
    const chosen = report.quants.find((q) => q.quant.toUpperCase() === String(quant).toUpperCase());
    if (!chosen) throw new Error(`Quantification « ${quant} » absente. Disponibles : ${report.quants.map((q) => q.quant).join(', ')}`);
    const engines = await enginesFor(report.profile?.arch);
    if (engines && !engines.length) throw new Error(archMissing(report.profile.arch));
    const projector = mmproj ? report.mmproj.find((m) => m.name === mmproj) : null;
    if (mmproj && !projector) throw new Error(`Projecteur vision « ${mmproj} » absent du dépôt`);
    // Même dépôt, même quantification : c'est le même fichier, pas un second modèle.
    const { id } = buildEntry({ repo: report.repo, quant: chosen, profile: report.profile });
    if (getState().models[id]?.installedAt) throw new Error(`Ce modèle est déjà installé (${displayName(modelById(id))}) : rien à ajouter`);
    const entry = await registerModel({ repo: report.repo, quant: chosen, profile: report.profile, mmproj: projector, sampling });
    const before = getState().active?.status === 'ready' ? getState().active.modelId : null;
    await refreshHardware();
    onProgress({ step: 'download', detail: `Téléchargement de ${(chosen.bytes / 1e9).toFixed(1)} Go` });
    await installAndTune(entry.id, (detail) => onProgress({ step: 'bench', detail: `Banc · ${detail}` }), { fromCustomJob: true });
    onProgress({ step: 'iq', detail: 'Test d’intelligence' });
    setPhase(entry.id, 'iq');
    const iq = await runIq(entry.id).catch((error) => { setPhase(entry.id, null); throw error; });
    setPhase(entry.id, 'analysis');
    onProgress({ step: 'analysis', detail: 'Analyse des mesures par l’IA locale' });
    await runAnalysis().finally(() => setPhase(entry.id, null));
    const profile = getState().profiles[entry.id];
    const result = { id: entry.id, name: displayName(entry), tuning: profile.tuning, bench: profile.bench?.winner, iq: { score: iq.score, categories: iq.categories, verbosity: iq.verbosity } };
    if (before && before !== entry.id) {
      onProgress({ step: 'restore', detail: 'Retour au modèle précédent' });
      await activate(before).catch(() => {});
      result.restored = before;
    }
    return result;
  })()
    .then((result) => { jobState = { ...jobState, running: false, step: 'done', detail: 'Terminé', result }; return result; })
    .catch((error) => { jobState = { ...jobState, running: false, step: 'error', error: error.message }; throw error; })
    .finally(() => { customJob = null; });
  customJob.catch(() => {});
  return customJob;
}
// Supprimer un modèle : ses fichiers, ses réglages, ses notes. Refusé tant qu'il travaille
// (installation, réglage, banc, test, téléchargement). S'il est chargé, le moteur s'arrête d'abord.
// Les fichiers réutilisés depuis un autre dossier ne sont jamais touchés : dans models/ ce sont des
// liens physiques (l'original reste), ailleurs on n'y va pas.
export async function deleteModel(modelId) {
  const model = modelById(modelId);
  const state = getState();
  const entry = state.models[modelId];
  if (!model || !entry) throw new Error('Ce modèle n’est pas installé');
  const busyNow = entry.installing || entry.tuning || entry.tuneDetail || busyWith() === modelId || state.profiles[modelId]?.iqRunning
    || Object.entries(state.downloads ?? {}).some(([id, d]) => !d.done && id.startsWith(`model:${modelId}:`))
    || (customJob && jobState?.result?.id === modelId);
  if (busyNow) throw new Error('Ce modèle est en cours d’installation, de réglage ou de test : attendez la fin');

  if (state.active?.modelId === modelId) {
    await stopEngine();
    update((s) => { s.active = null; });
  }

  let freed = 0;
  const remove = async (target) => {
    const size = await dirSize(target);
    await rm(target, { recursive: true, force: true });
    freed += size;
  };
  if (model.engine === 'strata') {
    // Les chemins viennent de la config Strata ; on ne supprime que sous models/strata-data.
    const runtime = state.runtimes[`strata-${model.strataModel}`];
    const dataDir = path.join(DIRS.models, 'strata-data');
    const inside = (p) => p && path.resolve(p).toLowerCase().startsWith(path.resolve(dataDir).toLowerCase() + path.sep);
    const configPath = runtime ? path.join(runtime.dir, runtime.config) : null;
    const config = configPath ? JSON.parse(await readFile(configPath, 'utf8').catch(() => '{}')) : {};
    const find = (key) => { const stack = [config]; while (stack.length) { const o = stack.pop(); if (o && typeof o === 'object') { if (typeof o[key] === 'string') return o[key]; stack.push(...Object.values(o)); } } return null; };
    const weights = find('model') && path.dirname(find('model'));
    const pack = find('tokenizer') && path.dirname(find('tokenizer'));
    if (inside(weights)) await remove(weights);
    if (inside(pack)) await remove(pack);
    // Vision et têtes MTP sont communes aux variantes Strata : seulement si plus aucune ne reste.
    const otherStrata = MODELS.some((m) => m.engine === 'strata' && m.id !== modelId && state.models[m.id]?.installedAt);
    if (!otherStrata) {
      if (inside(find('mmproj'))) { await remove(find('mmproj')); await rm(`${find('mmproj')}.done`, { force: true }); }
      await remove(path.join(dataDir, 'mtp'));
    }
    if (configPath) { await rm(configPath, { force: true }); await rm(configPath.replace(/\.json$/, '.log'), { force: true }); }
  } else {
    await remove(path.join(DIRS.models, modelId));
  }

  update((s) => {
    delete s.models[modelId];
    delete s.profiles[modelId];
    if (model.engine === 'strata') delete s.runtimes[`strata-${model.strataModel}`];
    if (s.favorite === modelId) s.favorite = null;
    for (const id of Object.keys(s.downloads ?? {})) if (id.startsWith(`model:${modelId}:`)) delete s.downloads[id];
  });
  if (model.custom) await unregisterModel(modelId);
  // Les moteurs ajoutés pour ce seul modèle (PR, fork) partent avec lui.
  const engines = await dropUnusedEngines().catch(() => ({ dropped: [], bytes: 0 }));
  update((s) => { s.plan = makePlan(s.hardware, iqScores(s), s.profiles); });
  return { freedBytes: freed + engines.bytes, kept: Object.values(entry.paths ?? {}), droppedEngines: engines.dropped };
}
async function dirSize(target) {
  const { readdir, stat } = await import('node:fs/promises');
  const info = await stat(target).catch(() => null);
  if (!info) return 0;
  // Un lien physique vers un fichier qui existe ailleurs ne libère rien.
  if (!info.isDirectory()) return info.nlink > 1 ? 0 : info.size;
  let total = 0;
  for (const name of await readdir(target)) total += await dirSize(path.join(target, name));
  return total;
}
// ── Moteur manquant ───────────────────────────────────────
// Un modèle dont aucun moteur installé ne connaît l'architecture : on cherche une version
// officielle plus récente (installée sans demander, c'est le moteur de tous les jours), sinon une
// PR de llama.cpp qui l'ajoute. Une PR est du code que personne n'a encore relu : elle n'est
// compilée qu'après l'accord de l'utilisateur, donné par un clic dans la fenêtre de Harn.
export async function proposeEngine({ modelId = null, arch = null, name = null } = {}) {
  const model = modelId ? modelById(modelId) : null;
  arch ??= model?.profile?.arch;
  name ??= model ? displayName(model) : null;
  if (!arch) throw Object.assign(new Error('Architecture du modèle inconnue'), { status: 400 });
  const exclude = Object.keys((modelId && getState().models[modelId]?.engineFailures) ?? {});
  const found = await findEngine(arch, { name, exclude });
  if (!found) return { status: 'none', message: `Aucun ${exclude.length ? 'autre ' : ''}moteur trouvé pour « ${arch} » : ni version officielle récente, ni proposition dans llama.cpp qui la connaisse${exclude.length ? ' et que ce fichier n’ait pas déjà mise en échec' : ''}. Harn le proposera dès qu’il en existera un.` };
  // Ensuite : régler le modèle s'il est déjà là, sinon revoir la veille, qui le proposera.
  const after = () => (modelId && getState().models[modelId]?.installedAt ? installAndTune(modelId) : checkHub()).catch(() => {});
  if (found.kind === 'official') {
    ensureEngine(found.candidate).then(after).catch(() => {});
    return { status: 'official', message: `${found.label} sait charger ce modèle : mise à jour du moteur, puis réglage.` };
  }
  if (!canBuild(getState().hardware)) {
    return { status: 'unbuildable', message: `${found.label} sait charger ce modèle, mais il faut le compiler : pour l’instant, Linux avec une carte NVIDIA et les outils de compilation.` };
  }
  const { sheet } = found;
  // Déjà accepté une fois (pour un autre modèle de la même architecture) : pas de nouvelle demande.
  if (getState().engines?.[sheet.id]) { after(); return { status: 'known', message: `${found.label} est déjà installé : réglage du modèle avec lui.` }; }
  const isolated = await sandboxAvailable();
  requestApproval({
    kind: 'engine',
    title: `Compiler ${sheet.label} pour ${name ?? arch}${isolated ? '' : ' (sans isolation)'} ?`,
    detail: `« ${sheet.title} », proposé par ${sheet.author} (${sheet.url}). ${sheet.state === 'closed' ? 'Cette proposition a été fermée sans être acceptée dans llama.cpp' : 'Cette proposition n’est pas encore acceptée dans llama.cpp'} : son code n’a pas été relu par les mainteneurs, et il s’exécutera sur votre machine. Harn compile ce commit précis une fois (${sheet.ref.slice(0, 7)}, 10 à 20 min) et ne s’en sert que pour l’architecture « ${arch} ». ${isolated
      ? 'Il est compilé et lancé isolé : sans réseau, sans accès à vos fichiers, seulement ses sources, le modèle et la carte graphique.'
      : `Attention : il tournerait sans isolation, avec accès à vos fichiers et au réseau, car bubblewrap manque. Pour l’isoler, refusez, installez-le (${SANDBOX_INSTALL}) et relancez Harn.`}`,
    run: () => { addEngine(sheet).then(after).catch(() => {}); },
  });
  return { status: 'approval', message: `${found.label} sait charger ce modèle : acceptez la demande pour le compiler.` };
}
