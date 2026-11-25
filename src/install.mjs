import path from 'node:path';
import { execFile } from 'node:child_process';
import { readFile, rm } from 'node:fs/promises';
import { activate, runIq } from './activation.mjs';
import { runAnalysis } from './analysis.mjs';
import { requestApproval } from './approvals.mjs';
import { SANDBOX_INSTALL, sandboxAvailable } from './sandbox.mjs';
import { tuneModel } from './bench.mjs';
import { displayName, modelById, MODELS, ownLauncher } from './catalog.mjs';
import { buildEntry, cardFacts, inspectLora, inspectRepo, loraModelId, registerLoraModel, registerModel, unregisterModel } from './custom-models.mjs';
import { download } from './download.mjs';
import { stopEngine } from './engine.mjs';
import { CHALLENGE_STACK_DIRS, strataTakes } from './runtimes.mjs';
import { addEngine, archMissing, buildable, dropUnusedEngines, enginesFor, engineSheet, ensureEngine, findEngine, requiredPrsEngine } from './engines.mjs';
import { busyWith, withGpu } from './gpu-queue.mjs';
import { runtimeKind } from './loading.mjs';
import { refreshHardware } from './machine-state.mjs';
import { installModelFiles } from './model-files.mjs';
import { DIRS } from './paths.mjs';
import { readGgufFile } from './gguf.mjs';
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
      const pinned = model.engineOnly ? engineSheet(model.engineOnly) : null;
      if (pinned?.orphan) throw new Error(`${displayName(model)} ne se sert qu’avec ${model.engineOnly}, dont l’accord a été perdu : supprimez le modèle et ajoutez-le à nouveau.`);
      const engines = ownLauncher(model) ? null : pinned ? [{ id: pinned.id, ref: pinned.ref, label: pinned.label }] : (await enginesFor(model.profile?.arch))?.filter((e) => !failed[e.id]) ?? null;
      if (engines && !engines.length) throw new Error(archMissing(model.profile.arch));
      let engine = null;
      if (!ownLauncher(model)) {
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
  // Le moteur qui le servira ici : Strata pour un Flash-Next quand il est installé, sinon llama.cpp.
  const strata = await strataTakes(report.profile);
  report.engine = strata ? 'strata' : 'llama.cpp';
  report.quants = report.quants.map((quant) => {
    const entry = buildEntry({ repo: report.repo, quant, profile: report.profile, strata });
    const verdict = assess(entry, hardware);
    return { quant: quant.quant, gigabytes: +(quant.bytes / 1e9).toFixed(1), files: quant.files.length, alreadyOnDisk: quant.files.every((file) => report.local[file.name]), verdict: { fit: verdict.fit, context: verdict.context ?? null, kv: verdict.kv ?? null, tpsAt100k: verdict.tps ?? null, meetsObjective: Boolean(verdict.meetsContext && verdict.meetsSpeed), reasons: verdict.reasons } };
  });
  report.objective = { minContext: OBJECTIVE.minContext, maxContext: OBJECTIVE.maxContext, minTps: OBJECTIVE.minTps };
  report.machine = getState().plan?.summary?.machine ?? null;
  return report;
}
// Installer un modèle choisi : enregistrement, téléchargement, banc, test d'intelligence, puis
// retour au modèle qui servait avant (pi tourne dessus). Une seule installation à la fois.
let customJob = null;
const ENGINE_APPROVAL_TIMEOUT_MS = 30 * 60_000;
let jobState = null;
export const customJobState = () => jobState;
// name, card : ce que pi a lu sur la fiche du modèle (custom-models.mjs, cardFacts).
export function installCustom({ url, quant, mmproj = null, sampling = null, name = null, card = null }) {
  return runJob({ url, quant, step: 'inspect', detail: 'Analyse du dépôt' }, async (onProgress) => {
    const report = await inspectRepo(url);
    const chosen = report.quants.find((q) => q.quant.toUpperCase() === String(quant).toUpperCase());
    if (!chosen) throw new Error(`Quantification « ${quant} » absente. Disponibles : ${report.quants.map((q) => q.quant).join(', ')}`);
    // Un Flash-Next va sur Strata dès qu'il y est installé : deux à trois fois plus vite que
    // llama.cpp, qui laisse les experts au processeur.
    const strata = await strataTakes(report.profile);
    const projector = mmproj && !strata ? report.mmproj.find((m) => m.name === mmproj) : null;
    if (mmproj && !strata && !projector) throw new Error(`Projecteur vision « ${mmproj} » absent du dépôt`);
    // La fiche exige une PR de llama.cpp (correctif pas encore publié) : ce moteur-là, et lui seul,
    // même si la version officielle charge déjà l'architecture.
    const requiredPr = !strata ? cardFacts(card)?.requiredPr : null;
    const required = requiredPr ? await requiredPrsEngine(requiredPr, report.profile.arch) : null;
    // Même dépôt, même quantification : c'est le même fichier, pas un second modèle.
    const engines = strata ? null : required ? [] : await enginesFor(report.profile?.arch);
    // Aucun moteur ne connaît l'architecture : on en cherche un (PR, fork cité par la fiche). Sa
    // compilation attend l'accord de l'utilisateur dans la fenêtre ; une fois donné, l'installation
    // continue d'elle-même (le moteur se compile avant le téléchargement).
    if (engines && !engines.length) {
      let decided;
      const decision = new Promise((resolve) => { decided = resolve; });
      const proposal = await proposeEngine({ arch: report.profile.arch, name: name ?? report.repo.split('/')[1], repo: report.repo, found: required, onAccept: () => decided(true), onRefuse: (error) => decided(error ?? false) }).catch((error) => ({ status: 'error', message: error.message }));
      if (proposal.status === 'approval' || proposal.status === 'official') {
        onProgress({ step: 'engine', detail: proposal.status === 'official' ? proposal.message : `${proposal.message} En attente de votre accord dans la fenêtre de Harn.` });
        const timeout = setTimeout(() => decided(null), ENGINE_APPROVAL_TIMEOUT_MS);
        const accepted = await decision.finally(() => clearTimeout(timeout));
        if (accepted instanceof Error) throw new Error(`${archMissing(report.profile.arch)} : la mise à jour du moteur a échoué (${accepted.message}).`);
        if (accepted === false) throw new Error(`${archMissing(report.profile.arch)} : compilation du moteur refusée.`);
        if (accepted === null) throw new Error(`${archMissing(report.profile.arch)} : ${proposal.status === 'official' ? 'la mise à jour du moteur n’a pas abouti' : 'pas de réponse à la demande de compilation'} au bout de ${ENGINE_APPROVAL_TIMEOUT_MS / 60_000} min.`);
      } else if (proposal.status !== 'known') {
        throw new Error(`${archMissing(report.profile.arch)}. ${proposal.message}`);
      }
    }
    const { id } = buildEntry({ repo: report.repo, quant: chosen, profile: report.profile });
    if (getState().models[id]?.installedAt) throw new Error(`Ce modèle est déjà installé (${displayName(modelById(id))}) : rien à ajouter`);
    const entry = await registerModel({ repo: report.repo, quant: chosen, profile: report.profile, mmproj: projector, mtpDraft: report.mtpDraft, dspark: strata ? null : report.dspark, sampling, strata, name, card, engineOnly: required?.sheet.id ?? null });
    const onDisk = chosen.files.every((file) => report.local[file.name]);
    return benchAndTest(entry, onProgress, onDisk ? 'Fichier déjà sur cette machine : rien à télécharger' : `Téléchargement de ${(chosen.bytes / 1e9).toFixed(1)} Go`);
  });
}

// Une installation à la fois, suivie par /api/custom/job.
function runJob(start, work) {
  if (customJob) throw new Error('Une installation est déjà en cours');
  jobState = { running: true, startedAt: Date.now(), ...start, result: null, error: null };
  const onProgress = ({ step, detail }) => { jobState = { ...jobState, step, detail }; };
  customJob = work(onProgress)
    .then((result) => { jobState = { ...jobState, running: false, step: 'done', detail: 'Terminé', result }; return result; })
    .catch((error) => { jobState = { ...jobState, running: false, step: 'error', error: error.message }; throw error; })
    .finally(() => { customJob = null; });
  customJob.catch(() => {});
  return customJob;
}

// Téléchargement, banc, test d'intelligence, analyse, puis retour au modèle qui servait avant.
async function benchAndTest(entry, onProgress, downloadDetail) {
  const before = getState().active?.status === 'ready' ? getState().active.modelId : null;
  await refreshHardware();
  onProgress({ step: 'download', detail: downloadDetail });
  await installAndTune(entry.id, (detail) => onProgress({ step: 'bench', detail: `Banc · ${detail}` }), { fromCustomJob: true });
  onProgress({ step: 'iq', detail: 'Test d’intelligence' });
  setPhase(entry.id, 'iq');
  const iq = await runIq(entry.id).catch((error) => { setPhase(entry.id, null); throw error; });
  setPhase(entry.id, 'analysis');
  onProgress({ step: 'analysis', detail: 'Analyse des mesures par l’IA locale' });
  await runAnalysis().finally(() => setPhase(entry.id, null));
  const profile = getState().profiles[entry.id];
  const result = { status: 'installed', id: entry.id, name: displayName(entry), tuning: profile.tuning, bench: profile.bench?.winner, iq: { score: iq.score, categories: iq.categories, verbosity: iq.verbosity }, cardNotes: entry.cardNotes ?? null };
  if (before && before !== entry.id) {
    onProgress({ step: 'restore', detail: 'Retour au modèle précédent' });
    await activate(before).catch(() => {});
    result.restored = before;
  }
  return result;
}

// Un LoRA de texte sur un modèle déjà installé : un profil à part (ses propres réglage, banc et
// note), qui reprend les fichiers de sa base par liens physiques ; seul l'adaptateur se télécharge.
// reasoning : false pour un adaptateur entraîné sans réflexion.
export async function inspectLoraFor(baseId, url) {
  const base = modelById(baseId);
  if (!base || !getState().models[baseId]?.installedAt) throw Object.assign(new Error(`Modèle de base « ${baseId} » non installé`), { status: 400 });
  if (base.lora) throw Object.assign(new Error('Ce modèle porte déjà un LoRA : partir de sa base'), { status: 400 });
  if (ownLauncher(base) || (base.engine && base.engine !== 'llama')) throw Object.assign(new Error('Un LoRA ne se pose que sur un modèle servi par llama.cpp'), { status: 400 });
  const where = getState().models[baseId].paths?.[base.files[0].name] ?? path.join(DIRS.models, baseId, base.files[0].name);
  const baseArch = base.profile?.arch ?? (await readGgufFile(where).catch(() => null))?.meta['general.architecture'] ?? null;
  return { base, baseArch, ...(await inspectLora(url, { baseArch })) };
}
export function installLora({ base: baseId, url, name = null, sampling = null, reasoning = null, card = null }) {
  return runJob({ url, quant: 'LoRA', step: 'inspect', detail: 'Analyse du LoRA' }, async (onProgress) => {
    const report = await inspectLoraFor(baseId, url);
    const id = loraModelId(baseId, report.repo);
    if (getState().models[id]?.installedAt) throw new Error(`Ce profil est déjà installé (${displayName(modelById(id))}) : rien à ajouter`);
    const entry = await registerLoraModel({ base: report.base, loraRepo: report.repo, lora: report.lora, name, sampling, reasoning, card });
    return benchAndTest(entry, onProgress, `Fichiers de ${displayName(report.base)} repris ; téléchargement du LoRA (${(report.lora.bytes / 1e6).toFixed(0)} Mo)`);
  });
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

  if (state.engines?.[modelId]) await stopEngine(modelId);
  if (getState().active?.modelId === modelId) update((s) => { s.active = null; });

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
    // Un Flash-Next ajouté garde ses fichiers dans son propre dossier, comme les modèles de llama.cpp.
    if (model.strataPack) await remove(path.join(DIRS.models, modelId));
  } else if (model.engine === 'hyperqwen') {
    // Moteur, environnement Python et poids vivent ensemble dans runtime/hyperqwen, pour ce seul modèle.
    await remove(path.join(DIRS.runtime, 'hyperqwen'));
  } else if (model.engine === 'radiance') {
    // Poids et caches de compilation dans runtime/radiance ; l'image (~10 Go) part avec eux.
    await remove(path.join(DIRS.runtime, 'radiance'));
    const image = getState().runtimes.radiance?.image;
    if (image) await new Promise((resolve) => execFile('podman', ['rmi', '-f', image], () => resolve()));
  } else if (model.engine === 'ink2') {
    // Les poids dans models/<id>, le moteur compilé et son venv dans runtime/ink2, pour ce seul modèle.
    await remove(path.join(DIRS.models, modelId));
    await remove(path.join(DIRS.runtime, 'ink2'));
  } else if (model.engine === 'lfm3') {
    await remove(path.join(DIRS.models, modelId));
    await remove(path.join(DIRS.runtime, 'lfm3'));
  } else if (model.engine === 'strata-inkling') {
    // Le moteur sert aux deux packs : il ne part qu'avec le dernier.
    await remove(path.join(DIRS.models, modelId));
    if (!MODELS.some((m) => m.engine === 'strata-inkling' && m.id !== model.id && getState().models[m.id]?.installedAt)) await remove(path.join(DIRS.runtime, 'strata-inkling'));
  } else if (model.engine === 'gemma-challenge') {
    // Le moteur sert aux deux fiches : seuls les poids de celle-ci partent, sauf si c'est la dernière.
    const other = MODELS.some((m) => m.engine === 'gemma-challenge' && m.id !== model.id && getState().models[m.id]?.installedAt);
    if (other) for (const name of CHALLENGE_STACK_DIRS[model.challengeStack]) await remove(path.join(DIRS.runtime, 'gemma-challenge', 'models', name));
    else await remove(path.join(DIRS.runtime, 'gemma-challenge'));
  } else {
    await remove(path.join(DIRS.models, modelId));
  }

  update((s) => {
    delete s.models[modelId];
    delete s.profiles[modelId];
    if (model.engine === 'strata') delete s.runtimes[`strata-${model.strataModel}`];
    if (model.engine === 'hyperqwen') delete s.runtimes.hyperqwen;
    if (model.engine === 'radiance') delete s.runtimes.radiance;
    if (model.engine === 'ink2') delete s.runtimes.ink2;
    if (model.engine === 'lfm3') delete s.runtimes.lfm3;
    if (model.engine === 'strata-inkling' && !MODELS.some((m) => m.engine === 'strata-inkling' && m.id !== model.id && s.models[m.id]?.installedAt)) delete s.runtimes['strata-inkling'];
    if (model.engine === 'gemma-challenge') {
      const runtime = s.runtimes['gemma-challenge'];
      if (runtime && MODELS.some((m) => m.engine === 'gemma-challenge' && m.id !== model.id && s.models[m.id]?.installedAt)) delete runtime[model.challengeStack === 'qat' ? 'qat' : 'submissionStack'];
      else delete s.runtimes['gemma-challenge'];
    }
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
// onAccept / onRefuse : prévenus de la décision (une installation en cours qui attend son moteur) ;
// onRefuse reçoit l'erreur quand une mise à jour du moteur officiel échoue.
// found : un moteur déjà désigné (la PR qu'exige la fiche du modèle), sans recherche.
export async function proposeEngine({ modelId = null, arch = null, name = null, repo = null, onAccept = null, onRefuse = null, found: given = null } = {}) {
  const model = modelId ? modelById(modelId) : null;
  arch ??= model?.profile?.arch;
  name ??= model ? displayName(model) : null;
  repo ??= model?.repo ?? null;
  if (!arch) throw Object.assign(new Error('Architecture du modèle inconnue'), { status: 400 });
  const exclude = Object.keys((modelId && getState().models[modelId]?.engineFailures) ?? {});
  const found = given ?? await findEngine(arch, { name, exclude, repo });
  if (!found) return { status: 'none', message: `Aucun ${exclude.length ? 'autre ' : ''}moteur trouvé pour « ${arch} » : ni version officielle récente, ni proposition dans llama.cpp, ni fork cité par la fiche du modèle qui la connaisse${exclude.length ? ' et que ce fichier n’ait pas déjà mise en échec' : ''}. Harn le proposera dès qu’il en existera un.` };
  // Ensuite : régler le modèle s'il est déjà là, sinon revoir la veille, qui le proposera.
  const after = () => (onAccept ? Promise.resolve(onAccept()) : modelId && getState().models[modelId]?.installedAt ? installAndTune(modelId) : checkHub()).catch(() => {});
  if (found.kind === 'official') {
    ensureEngine(found.candidate).then(after).catch((error) => onRefuse?.(error));
    return { status: 'official', message: `${found.label} sait charger ce modèle : mise à jour du moteur, puis réglage.` };
  }
  if (!buildable(getState().hardware)) {
    return { status: 'unbuildable', message: `${found.label} sait charger ce modèle, mais il faut le compiler : pour l’instant, Linux avec une carte NVIDIA et les outils de compilation, ou une Radeon RDNA4 avec bubblewrap (${SANDBOX_INSTALL}).` };
  }
  const { sheet } = found;
  // Déjà accepté une fois (pour un autre modèle de la même architecture) : pas de nouvelle demande.
  if (getState().addedEngines?.[sheet.id]) { after(); return { status: 'known', message: `${found.label} est déjà installé : réglage du modèle avec lui.` }; }
  const isolated = await sandboxAvailable();
  requestApproval({
    kind: 'engine',
    title: `Compiler ${sheet.label} pour ${name ?? arch}${isolated ? '' : ' (sans isolation)'} ?`,
    detail: `${sheet.state === 'mix'
      ? `llama.cpp au commit ${sheet.ref.slice(0, 7)}, avec les propositions ${sheet.title}, de ${sheet.author}${given ? `, que la fiche de ${repo} demande` : ''}. Ces propositions ne sont pas encore acceptées dans llama.cpp (ou viennent d’un fork) ; Harn pose leurs diffs, figés à ces commits, avant de compiler`
      : sheet.state === 'fork'
      ? `Fork de llama.cpp par ${sheet.author} (${sheet.url}), que la fiche de ${sheet.citedBy} demande pour charger ce modèle. Dernier commit : « ${sheet.title} ». Ce fork n’est pas llama.cpp`
      : `« ${sheet.title} », proposé par ${sheet.author} (${sheet.url})${given ? `, que la fiche de ${repo} exige pour que le modèle réponde juste` : ''}. ${sheet.state === 'closed' ? 'Cette proposition a été fermée sans être acceptée dans llama.cpp' : 'Cette proposition n’est pas encore acceptée dans llama.cpp'}`} : son code n’a pas été relu par les mainteneurs, et il s’exécutera sur votre machine. Harn compile ce commit précis une fois (${sheet.ref.slice(0, 7)}, 10 à 20 min) et ne s’en sert que pour l’architecture « ${arch} ». ${isolated
      ? 'Il est compilé et lancé isolé : sans réseau, sans accès à vos fichiers, seulement ses sources, le modèle et la carte graphique.'
      : `Attention : il tournerait sans isolation, avec accès à vos fichiers et au réseau, car bubblewrap manque. Pour l’isoler, refusez, installez-le (${SANDBOX_INSTALL}) et relancez Harn.`}`,
    run: () => { addEngine(sheet).then(after).catch(() => {}); },
    refuse: () => onRefuse?.(),
  });
  return { status: 'approval', message: `${found.label} sait charger ce modèle : acceptez la demande pour le compiler.` };
}
