import { readFileSync, writeFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MODELS, displayName, downloadUrl, hfSha256, modelById, totalBytes } from './catalog.mjs';
import { download, hashFile } from './download.mjs';
import { defaultTuning, describe, layersOf, llamaArgs, modelFiles, startEngine, stopEngine } from './engine.mjs';
import { detectHardware, sampleGpu } from './hardware.mjs';
import { dflashEligible, gpuProfile, mtpPlan } from './levers.mjs';
import { DIRS, PORTS } from './paths.mjs';
import { configurePi, installPi } from './pi.mjs';
import { OBJECTIVE, assess, makePlan } from './planner.mjs';
import { addEngine, alternates, archMissing, canBuild, engineSheet, enginesFor, ensureEngine, findEngine, recordBuildFailure } from './engines.mjs';
import { requestApproval } from './approvals.mjs';
import { checkHub } from './watch.mjs';
import { engineEnv, installKetch, installLlama, installStrata } from './runtimes.mjs';
import { getState, update } from './state.mjs';
import { systemChecks } from './system-checks.mjs';
import { askLocalAnalysis, machineDocPath, writeMachineFacts } from './machine-doc.mjs';
import { adoptLocalCopy, findLocalCopies } from './local-files.mjs';
import { appendFile, mkdir as makeDir } from 'node:fs/promises';
import { HEADROOM_MIN_MIB, measure } from './tuner.mjs';
import { IQ_VERSION, runIqTest } from './iq-test.mjs';
import { RATING_WEIGHTS, globalRating } from './rating.mjs';
import { buildEntry, inspectRepo, registerModel, setModelQuality, unregisterModel } from './custom-models.mjs';

// Le parcours du premier démarrage, sans aucune question :
// matériel → (runtime ‖ modèle ‖ pi) → chargement avec marge VRAM → banc → prêt.
// Chaque étape est publiée dans l'état : l'interface n'invente rien, elle lit.

const STEPS = [
  ['hardware', 'Analyse de la machine'],
  ['runtime', 'Installation du moteur'],
  ['model', 'Téléchargement du modèle'],
  ['pi', 'Installation de pi agent et de la recherche web'],
  ['load', 'Premier chargement'],
  ['tune', 'Réglage et mesure'],
];

function step(id, patch) {
  update((s) => {
    const entry = s.setup.steps.find((item) => item.id === id);
    if (entry) Object.assign(entry, patch, patch.status === 'running' ? { startedAt: Date.now() } : {}, ['done', 'error', 'skipped'].includes(patch.status) ? { endedAt: Date.now() } : {});
  });
}

// Les scores du banc d'intelligence (format actuel uniquement : les anciens sont à refaire).
export function iqScores(state = getState()) {
  const scores = {};
  for (const [id, profile] of Object.entries(state.profiles ?? {})) if (profile.iq?.version === IQ_VERSION) scores[id] = profile.iq.score;
  return scores;
}

export async function refreshHardware() {
  const hardware = await detectHardware();
  const ours = getState().active?.status === 'ready' || getState().active?.status === 'loading';
  hardware.vramBaselineMiB = ours ? getState().vramBaselineMiB ?? null : (hardware.primary?.freeMiB != null ? hardware.primary.vramMiB - hardware.primary.freeMiB : null);
  const plan = makePlan(hardware, iqScores(), getState().profiles);
  // La VRAM prise par les autres applications se lit avant qu'on charge quoi que ce soit.
  const checks = await systemChecks(hardware, { vramBaselineMiB: ours ? getState().vramBaselineMiB ?? 0 : null });
  update((s) => {
    s.hardware = hardware;
    s.plan = plan;
    s.checks = checks;
    if (!ours && hardware.primary?.freeMiB != null) s.vramBaselineMiB = hardware.primary.vramMiB - hardware.primary.freeMiB;
  });
  return { hardware, plan };
}

let running = null;
export function runFirstSetup() {
  running ??= firstSetup().finally(() => { running = null; });
  return running;
}

const runtimeKind = (model, tuning) => (tuning?.fork ?? (model.engine === 'prism' ? 'prism' : 'llama'));

const sharedLayers = { layers: 'auto', fitTargetMiB: HEADROOM_MIN_MIB + 256 };

// Le réglage de départ d'un modèle : contexte et type de KV viennent de l'objectif
// (100k-150k), le reste des a priori de la carte.
function startingTuning(model, hardware) {
  const verdict = assess(model, hardware);
  const tuning = defaultTuning(model, verdict.context, hardware, verdict.kv === 'int8' ? 'q8_0' : verdict.kv);
  // Partagé avec la RAM : --fit remplit la carte jusqu'à sa cible ; on la met au-dessus de la marge
  // exigée, sinon le contrôle de marge raccourcirait le contexte sans rien gagner.
  if (verdict.fit === 'partial') Object.assign(tuning, sharedLayers);
  return tuning;
}

export function firstSetupAttempts(plan, hardware) {
  const attempts = [];
  const add = (modelId, backend) => {
    if (modelId && !attempts.some((a) => a.modelId === modelId && a.backend === backend)) attempts.push({ modelId, backend });
  };
  const gpu = plan.backend.gpu;
  add(plan.firstModel, plan.backend.id);
  if (gpu && plan.backend.id !== 'vulkan') add(plan.firstModel, 'vulkan');
  // Le modèle suivant, plus léger, qui tient lui aussi sur la carte.
  const first = modelById(plan.firstModel);
  const lighter = MODELS.filter((m) => m.engine !== 'strata' && m.id !== plan.firstModel && totalBytes(m) < totalBytes(first)
    && plan.verdicts.find((v) => v.id === m.id)?.fit !== 'no').sort((a, b) => (b.quality ?? 0) - (a.quality ?? 0))[0];
  if (lighter) add(lighter.id, plan.backend.id);
  // Le dernier recours : Bonsai 1-bit sur le processeur.
  if (plan.verdicts.find((v) => v.id === 'swift-bonsai2-1bit')?.fit !== 'no') add('swift-bonsai2-1bit', 'cpu');
  return attempts.slice(0, 4);
}

async function firstSetup() {
  update((s) => {
    s.setup = { phase: 'running', error: null, startedAt: Date.now(), finishedAt: null, steps: STEPS.map(([id, label]) => ({ id, label, status: 'pending', detail: null })) };
  });
  try {
    step('hardware', { status: 'running' });
    const { hardware, plan } = await refreshHardware();
    if (!plan.firstModel) throw new Error(plan.summary.line);
    step('hardware', { status: 'done', detail: `${plan.summary.machine} · ${plan.backend.profile.archLabel}, ${plan.backend.profile.bandwidth} Go/s` });

    // pi et la recherche web s'installent en parallèle de tout le reste.
    const piJob = (async () => {
      if (getState().pi.installed) {
        // ketch a pu manquer au premier passage (réseau, pas de build pour ce système) : on le reprend.
        const ketch = getState().ketch ?? await installKetch().catch(() => null);
        return step('pi', { status: 'done', detail: `déjà installé (${getState().pi.version})${ketch ? ` · recherche web ketch ${ketch.version}` : ''}` });
      }
      step('pi', { status: 'running' });
      try {
        const [version, ketch] = await Promise.all([installPi(), installKetch().catch(() => null)]);
        step('pi', { status: 'done', detail: `version ${version}${ketch ? ` · recherche web ketch ${ketch.version}` : ''}${hardware.gitBash ? '' : ' · Git pour Windows manquant'}` });
      } catch (error) {
        // pi n'est pas indispensable pour servir le modèle : on continue sans lui.
        step('pi', { status: 'error', detail: error.message.split('\n')[0] });
      }
    })();

    // Au premier démarrage il n'y a encore aucun modèle, donc personne pour dépanner : Harn
    // descend lui-même d'un cran à chaque échec (moteur plus simple, modèle plus petit, puis
    // Bonsai sur le processeur, qui tourne partout) jusqu'à avoir une IA qui répond.
    // Mais un modèle plus petit ne répare qu'un échec de chargement : si c'est le moteur qui ne
    // s'installe pas, seul un autre moteur peut aider ; si c'est le téléchargement, rien.
    const attempts = firstSetupAttempts(plan, hardware);
    let model = null;
    let loaded = null;
    const failures = [];
    const brokenRuntimes = new Set();
    let blocker = null; // le dernier échec qui ne tient pas à la taille du modèle
    for (const attempt of attempts) {
      const candidate = modelById(attempt.modelId);
      const runtimeId = `${runtimeKind(candidate)}-${attempt.backend}`;
      if (brokenRuntimes.has(runtimeId)) continue;
      if (blocker && (blocker.stage === 'model' || candidate.id !== blocker.modelId)) continue;
      const label = `${candidate.name} · ${candidate.variant}${attempt.backend === plan.backend.id ? '' : ` (moteur ${attempt.backend})`}`;
      let stage = 'runtime';
      try {
        step('runtime', { status: 'running', detail: attempt.backend });
        const info = await installLlama(runtimeKind(candidate), attempt.backend);
        step('runtime', { status: 'done', detail: `llama.cpp ${info.tag} · ${attempt.backend}` });
        stage = 'model';
        step('model', { status: 'running', detail: label });
        await installModelFiles(candidate);
        step('model', { status: 'done', detail: label });
        stage = 'load';
        step('load', { status: 'running', detail: failures.length ? `Après ${failures.length} échec(s), essai plus simple : ${label}` : null });
        loaded = await loadWithHeadroom(candidate, { ...startingTuning(candidate, hardware), backend: attempt.backend });
        model = candidate;
        break;
      } catch (error) {
        const reason = error.message.split('\n')[0];
        failures.push(stage === 'runtime' ? `moteur ${attempt.backend} : ${reason}` : `${label} : ${reason}`);
        await stopEngine().catch(() => {});
        if (stage === 'runtime') brokenRuntimes.add(runtimeId);
        blocker = stage === 'load' ? null : { stage, modelId: candidate.id };
        if (stage === 'runtime') step('runtime', { status: 'running', detail: `Échec du moteur ${attempt.backend}. On essaie un autre moteur…` });
        else if (stage === 'load') step('load', { status: 'running', detail: `Échec avec ${label}. On essaie plus simple…` });
      }
    }
    if (!model) {
      const what = blocker?.stage === 'runtime' ? 'Le moteur n’a pas pu s’installer'
        : blocker?.stage === 'model' ? 'Le modèle n’a pas pu se télécharger'
          : 'Aucun modèle n’a pu démarrer sur cette machine';
      throw new Error(`${what}. ${failures.join(' | ')}`);
    }
    step('load', { status: 'done', detail: `${describe(loaded.tuning)} · ${loaded.active.loadSeconds.toFixed(0)} s${failures.length ? ` · repli après ${failures.length} échec(s)` : ''}` });

    step('tune', { status: 'running' });
    await tuneModel(model.id, { startFrom: loaded, onProgress: (detail) => step('tune', { detail }) });
    const profile = getState().profiles[model.id];
    step('tune', { status: 'done', detail: `${profile.bench.winner.tps} tok/s · ${profile.bench.winner.label}` });

    await piJob;
    if (getState().pi.installed) await configurePi();
    update((s) => { s.setup.phase = 'done'; s.setup.finishedAt = Date.now(); });
    // Le banc d'intelligence suit en arrière-plan : c'est lui qui rend pi éligible au dépannage.
    runIq(model.id).catch(() => {}).finally(() => runAnalysis());
  } catch (error) {
    update((s) => {
      s.setup.phase = 'error';
      s.setup.error = error.message;
      const current = s.setup.steps.find((item) => item.status === 'running');
      if (current) { current.status = 'error'; current.detail = error.message; }
    });
    throw error;
  }
}

// Chaque installation a son journal complet (data/logs/install-<modèle>.log) : c'est lui qu'on
// montre, et qu'on donne à pi, quand quelque chose échoue.
export const installLogPath = (id) => path.join(DIRS.logs, `install-${id}.log`);

export async function installModelFiles(model, { ggufDir: forcedDir = null } = {}) {
  const dir = path.join(DIRS.models, model.id);
  const logFile = installLogPath(model.id);
  await makeDir(DIRS.logs, { recursive: true });
  const log = (text) => appendFile(logFile, String(text).endsWith('\n') ? String(text) : `${text}\n`).catch(() => {});
  await log(`\n# ${new Date().toISOString()} · installation de ${displayName(model)}`);
  const note = (detail) => { log(detail); update((s) => { s.models[model.id].detail = detail; }); };
  update((s) => { s.models[model.id] = { ...(s.models[model.id] ?? {}), installing: true, error: null, detail: 'Recherche de fichiers déjà présents' }; });
  const files = model.files.map((file) => ({ repo: model.repo, ...file }));
  if (model.mmproj) files.push(model.mmproj);
  const paths = {};
  try {
    // Avant de télécharger : le fichier est peut-être déjà sur la machine (même nom, même taille).
    const local = await findLocalCopies(model.engine === 'strata' ? model.files : files);
    if (model.engine === 'strata') {
      const context = assess(model, getState().hardware).context;
      const shards = model.files.map((file) => local[file.name]).filter(Boolean);
      const ggufDir = forcedDir ?? (shards.length === model.files.length && new Set(shards.map((p) => path.dirname(p))).size === 1 ? path.dirname(shards[0]) : null);
      note(ggufDir ? `Fichiers déjà présents dans ${ggufDir} : réutilisés, pas de téléchargement` : 'Installation de Strata et téléchargement du modèle');
      await installStrata(model, context, (line) => { log(line); update((s) => { s.models[model.id].log = String(line).slice(-400); }); }, { ggufDir });
    } else {
      for (const file of files) {
        // Une copie trouvée sur le disque n'a que le bon nom et la bonne taille : son empreinte
        // doit aussi correspondre, sinon on télécharge l'original.
        if (local[file.name]) {
          note(`${file.name} trouvé dans ${local[file.name]} : vérification de l’empreinte`);
          const actual = (await hashFile(local[file.name])).digest('hex');
          if (actual !== await expectedSha(file)) {
            note(`${file.name} (${local[file.name]}) ne correspond pas à l’original : ignoré`);
            delete local[file.name];
          }
        }
        if (local[file.name]) {
          const used = await adoptLocalCopy(local[file.name], path.join(dir, file.name));
          if (used !== path.join(dir, file.name)) paths[file.name] = used;
          note(`${file.name} déjà présent (${local[file.name]}) : réutilisé`);
        } else {
          note(`Téléchargement de ${file.name}`);
          await downloadFile(model, file);
        }
      }
    }
  } catch (error) {
    await log(`ÉCHEC : ${error.message}`);
    throw new Error(`${error.message}${await lastLines(logFile)}`);
  }
  await log('Fichiers prêts.');
  update((s) => { s.models[model.id] = { installedAt: new Date().toISOString(), installing: false, files: files.map((file) => file.name), paths }; });
}

// Les dernières lignes utiles d'un journal : ce qu'un humain lira en premier.
async function lastLines(file, count = 3) {
  const { readFile: read } = await import('node:fs/promises');
  const text = await read(file, 'utf8').catch(() => '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const useful = lines.filter((l) => /error|erreur|échec|failed|not found|introuvable|impossible|denied|refus|traceback|exception|n'est pas reconnu/i.test(l));
  const pick = (useful.length ? useful : lines).slice(-count);
  return pick.length ? ` — ${pick.join(' · ').slice(0, 400)}` : '';
}

// L'empreinte d'un fichier de modèle : celle notée à l'ajout depuis Hugging Face, sinon celle que
// Hugging Face publie. Sans empreinte, pas de téléchargement : un GGUF est lu par le parseur
// du moteur, qui a déjà eu des failles exploitables par un fichier piégé.
async function expectedSha(file) {
  const sha = file.sha256 ?? await hfSha256(file.repo, file.name);
  if (!sha) throw new Error(`Hugging Face ne publie pas d’empreinte SHA-256 pour ${file.name} (${file.repo}) : fichier non vérifiable, téléchargement refusé.`);
  return sha;
}

async function downloadFile(model, file) {
  return download({
    id: `model:${model.id}:${file.name}`,
    label: file.name,
    url: downloadUrl(file.repo, file.name),
    dest: path.join(DIRS.models, model.id, file.name),
    expectedBytes: file.bytes,
    sha256: await expectedSha(file),
  });
}

// Strata répond sous le `model_name` de sa config (« swift-1.5-iq3_xxs ») : on y met l'identifiant
// Harn, comme l'alias de llama-server, pour que les clients retrouvent le nom qu'ils ont demandé.
// Refait à chaque lancement : l'installeur Strata peut régénérer la config.
function nameStrataConfig(file, modelId) {
  const config = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (config.model_name === modelId) return;
  writeFileSync(file, JSON.stringify({ ...config, model_name: modelId }, null, 2));
}

function recipeFor(model, tuning) {
  const state = getState();
  if (model.engine === 'strata') {
    const runtime = state.runtimes[`strata-${model.strataModel}`];
    nameStrataConfig(path.join(runtime.dir, tuning.strataConfig ?? runtime.config), model.id);
    return {
      modelId: model.id,
      label: displayName(model),
      command: runtime.python,
      args: ['serve/server.py', '--engine', 'strata', '--config', tuning.strataConfig ?? runtime.config, '--port', String(PORTS.strata)],
      cwd: runtime.dir,
      endpoint: `http://127.0.0.1:${PORTS.strata}`,
      health: `http://127.0.0.1:${PORTS.strata}/v1/models`,
    };
  }
  const runtime = state.runtimes[`${runtimeKind(model, tuning)}-${tuning.backend}`];
  if (!runtime) throw new Error(`Moteur ${runtimeKind(model, tuning)} ${tuning.backend} non installé`);
  return {
    modelId: model.id,
    label: displayName(model),
    command: runtime.serverPath,
    args: llamaArgs(model, modelFiles(model.id), tuning, state.hardware),
    cwd: runtime.dir,
    env: engineEnv(runtime.dir),
    endpoint: `http://127.0.0.1:${PORTS.engine}`,
    health: `http://127.0.0.1:${PORTS.engine}/health`,
  };
}

const freeVram = async () => (getState().hardware?.primary?.vendor === 'nvidia' ? (await sampleGpu())?.freeMiB ?? null : null);

// Charger, puis vérifier la marge VRAM. C'est le levier ×21 du poste de référence : sous
// ~1,5 Gio libre, le préfill retombe sur la mémoire hôte sans la moindre erreur. Pour retrouver
// la marge on cède dans l'ordre de l'objectif : contexte par paliers jusqu'à 100k, puis KV q4_0,
// puis seulement sous 100k, par paliers jusqu'au plancher de 32k. En dernier recours, le partage
// avec le processeur (--fit) : plus lent, mais le modèle tourne.
function smaller(tuning) {
  if (tuning.context - 16384 >= OBJECTIVE.minContext) return { ...tuning, context: tuning.context - 16384 };
  if (tuning.kv !== 'q4_0') return { ...tuning, kv: 'q4_0', kvV: undefined };
  if (tuning.context > OBJECTIVE.floorContext) return { ...tuning, context: Math.max(OBJECTIVE.floorContext, tuning.context - 16384) };
  return { ...tuning, ...sharedLayers };
}
// Plus rien à céder : plancher de contexte atteint et couches déjà partagées.
const exhausted = (tuning) => tuning.context <= OBJECTIVE.floorContext && layersOf(tuning) === 'auto';

// Chaque chargement prend un numéro : si un autre modèle est demandé entre-temps, celui-ci
// abandonne au lieu de réessayer (sinon les deux se tueraient le moteur à tour de rôle).
let loadTicket = 0;
const superseded = () => new Error('Chargement remplacé par celui d’un autre modèle');

async function loadWithHeadroom(model, tuning) {
  const ticket = ++loadTicket;
  let current = { ...tuning };
  for (let attempt = 0; attempt < 14; attempt += 1) {
    if (ticket !== loadTicket) throw superseded();
    let active;
    try {
      active = await startEngine(recipeFor(model, current));
    } catch (error) {
      if (ticket !== loadTicket) throw superseded();
      // Un fichier qui annonce une couche MTP qu'il ne contient pas (convertisseur d'une autre
      // version) : on recharge en ignorant cette annonce avant de conclure à l'échec.
      if (error.tensors && model.profile?.mtp && !current.noNextn) { current = { ...current, noNextn: true, spec: { type: 'none' } }; continue; }
      if (error.fatal || exhausted(current) || model.engine === 'strata') throw error;
      current = smaller(current);
      continue;
    }
    const headroomMiB = await freeVram();
    if (headroomMiB === null || headroomMiB >= HEADROOM_MIN_MIB || exhausted(current) || model.engine === 'strata') {
      return { active, tuning: current, headroomMiB };
    }
    current = smaller(current);
  }
  throw new Error('Impossible de charger le modèle avec une marge mémoire suffisante');
}

// ── Banc par étapes ─────────────────────────────────────────
// Une variable à la fois, à partir du meilleur réglage connu : spéculation, puis DFlash2,
// puis type de KV mesuré en profondeur, puis Flash Attention ou backend selon la carte.
// Chaque variante qui laisse moins de ~1,2 Gio libre est écartée, même si elle va vite.

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

// Pendant un banc ou un test, la carte appartient au modèle mesuré : la passerelle refuse les
// requêtes pour un autre modèle au lieu de le recharger (ce qui casserait la mesure).
let busy = null;
export const busyWith = () => busy;

// File d'attente de la carte : bancs, tests d'intelligence et analyses passent un par un. Sans
// elle, deux installations se volaient la carte (« chargement remplacé ») et faussaient leurs
// mesures. Réentrant : une tâche qui tient déjà la carte pour ce modèle (installation → banc →
// test) continue sans se remettre en file derrière elle-même.
let gpuQueue = Promise.resolve();
export function withGpu(modelId, task) {
  if (busy === modelId) return task();
  update((s) => { if (s.models[modelId]) s.models[modelId].waitingGpu = true; });
  const turn = gpuQueue.then(async () => {
    update((s) => { if (s.models[modelId]) s.models[modelId].waitingGpu = false; });
    busy = modelId;
    try { return await task(); } finally { busy = null; }
  });
  gpuQueue = turn.catch(() => {});
  return turn;
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

  async function trial(stage, tuning, workloads = ['code', 'prose']) {
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
      const result = await measure(getState().active.endpoint, modelId, { workloads, onProgress: say });
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
  const better = (candidate, current) => (candidate.ok && !candidate.error && candidate.tps > current.tps ? candidate : current);

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
  const f16ExtraMiB = best.tuning.context * (model.kvBytesPerToken?.f16 - model.kvBytesPerToken?.[best.tuning.kv]) / 2 ** 20;
  if (gpu && best.tuning.kv !== 'f16' && best.tuning.context >= 32768 && best.headroomMiB !== null && best.headroomMiB - f16ExtraMiB >= HEADROOM_MIN_MIB) {
    const reference = await trial('KV en profondeur', best.tuning, ['code', 'prose', 'deep']);
    const f16 = await trial('KV en profondeur', { ...best.tuning, kv: 'f16' }, ['code', 'prose', 'deep']);
    if (f16.ok && !f16.error && !reference.error && f16.tps > reference.tps) best = f16;
    else if (!reference.error) best = reference;
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
    update((s) => {
      const entry = (s.profiles[model.id] ??= {});
      entry.tuning = best.tuning;
      entry.bench = {
        at: new Date().toISOString(),
        gpu: s.hardware.primary?.name ?? null,
        arch: profile.archLabel,
        arms: results.map(({ tuning, ...rest }) => rest),
        winner: { id: best.id, label: best.label, tps: best.tps, prefillTps: best.prefillTps, throttled: best.throttled },
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

// Activer un modèle installé avec ses réglages gagnants (ou ceux par défaut s'il n'a pas de banc).
const activations = new Map();
// Charger un modèle décharge celui qui tourne (startEngine arrête l'ancien moteur). Refusé
// pendant le banc ou le test d'un autre modèle : la carte lui appartient.
export const activationBlocker = (modelId) => (busy && busy !== modelId ? `Harn mesure « ${modelById(busy)?.name ?? busy} » : attendez la fin du banc pour changer de modèle` : null);

export function activate(modelId) {
  const blocked = activationBlocker(modelId);
  if (blocked) return Promise.reject(new Error(blocked));
  if (!activations.has(modelId)) {
    activations.set(modelId, (async () => {
      const model = modelById(modelId);
      const state = getState();
      const saved = state.profiles[modelId]?.tuning;
      // Un réglage d'une version précédente (sans backend) est refait à partir des a priori.
      const tuning = saved?.backend || model.engine === 'strata' ? saved : startingTuning(model, state.hardware);
      const loaded = await loadWithHeadroom(model, tuning ?? {});
      // Une réduction faite au chargement reste ponctuelle : seul le banc fixe les réglages.
      if (getState().pi.installed) await configurePi().catch(() => {});
      return loaded.active;
    })().finally(() => activations.delete(modelId)));
  }
  return activations.get(modelId);
}

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

// L'IA locale analyse ses propres mesures et l'écrit dans le carnet de la machine.
// Le petit test d'intelligence : sur le modèle demandé (chargé si besoin).
const iqRuns = new Map();
export function runIq(modelId) {
  if (!iqRuns.has(modelId)) {
    iqRuns.set(modelId, withGpu(modelId, async () => {
      update((s) => { (s.profiles[modelId] ??= {}).iqRunning = 'Préparation'; });
      try {
        if (getState().active?.modelId !== modelId || getState().active?.status !== 'ready') await activate(modelId);
        // Le contexte réellement chargé (argument -c du moteur) borne la taille du journal du banc.
        const engineArgs = getState().active?.args ?? [];
        const loaded = engineArgs.includes('-c') ? Number(engineArgs[engineArgs.indexOf('-c') + 1]) : null;
        const context = loaded || getState().profiles[modelId]?.tuning?.context || 32768;
        const result = await runIqTest(modelId, { context, onProgress: (detail) => update((s) => { s.profiles[modelId].iqRunning = detail; }) });
        update((s) => { s.profiles[modelId].iq = result; s.profiles[modelId].iqRunning = null; s.profiles[modelId].iqError = null; });
        await setModelQuality(modelId, result.score);
        // Le classement des modèles dépend du score : le plan est recalculé.
        update((s) => { s.plan = makePlan(s.hardware, iqScores(s), s.profiles); });
        await writeMachineFacts().catch(() => {});
        return result;
      } catch (error) {
        update((s) => { s.profiles[modelId].iqRunning = null; s.profiles[modelId].iqError = error.message; });
        throw error;
      }
    }).finally(() => iqRuns.delete(modelId)));
  }
  return iqRuns.get(modelId);
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

let analysing = null;
export function runAnalysis() {
  analysing ??= (async () => {
    update((s) => { s.machineDoc = { ...(s.machineDoc ?? {}), path: machineDocPath(s.hardware), analysing: true, error: null }; });
    try {
      await askLocalAnalysis();
      update((s) => { s.machineDoc = { ...s.machineDoc, analysing: false, analysedAt: new Date().toISOString() }; });
    } catch (error) {
      update((s) => { s.machineDoc = { ...s.machineDoc, analysing: false, error: error.message }; });
    }
  })().finally(() => { analysing = null; });
  return analysing;
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
  const busyNow = entry.installing || entry.tuning || entry.tuneDetail || busy === modelId || state.profiles[modelId]?.iqRunning
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
  update((s) => { s.plan = makePlan(s.hardware, iqScores(s), s.profiles); });
  return { freedBytes: freed, kept: Object.values(entry.paths ?? {}) };
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

export { stopEngine };

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
  requestApproval({
    kind: 'engine',
    title: `Compiler ${sheet.label} pour ${name ?? arch} ?`,
    detail: `« ${sheet.title} », proposé par ${sheet.author} (${sheet.url}). ${sheet.state === 'closed' ? 'Cette proposition a été fermée sans être acceptée dans llama.cpp' : 'Cette proposition n’est pas encore acceptée dans llama.cpp'} : son code n’a pas été relu par les mainteneurs, et il s’exécutera sur votre machine. Harn compile ce commit précis une fois (${sheet.ref.slice(0, 7)}, 10 à 20 min) et ne s’en sert que pour l’architecture « ${arch} ».`,
    run: () => { addEngine(sheet).then(after).catch(() => {}); },
  });
  return { status: 'approval', message: `${found.label} sait charger ce modèle : acceptez la demande pour le compiler.` };
}
