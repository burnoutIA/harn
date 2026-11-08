import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import net from 'node:net';
import { mkdir, readFile, readdir, readlink, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { modelById } from './catalog.mjs';
import { engineSheet } from './engines.mjs';
import { busyWith, isImageJob } from './gpu-queue.mjs';
import { backendCandidates, gpuProfile, mtpPlan } from './levers.mjs';
import { sampleGpu } from './hardware.mjs';
import { DIRS, PORTS } from './paths.mjs';
import { getState, update } from './state.mjs';

const run = promisify(execFile);

// Le moteur n'écoute que la boucle locale, mais llama-server répond aux pages web de toute
// origine (CORS ouvert) : sans clé, n'importe quel site ouvert dans le navigateur pourrait s'en
// servir et lire /slots. Une clé neuve à chaque lancement de Harn, connue de lui seul, passée par
// fichier pour ne paraître ni dans la ligne de commande, ni dans l'état, ni dans les journaux.
const ENGINE_KEY = randomBytes(32).toString('base64url');
export const ENGINE_KEY_FILE = path.join(DIRS.data, 'engine.key');
export const engineHeaders = () => ({ Authorization: `Bearer ${ENGINE_KEY}` });
// Pour un moteur qui prend sa clé dans l'environnement plutôt que dans un fichier (vLLM).
export const engineKey = () => ENGINE_KEY;

// Le point de départ d'un modèle sur CETTE machine. Les a priori viennent de levers.mjs
// (classe de bande passante, architecture) ; le banc les remet en cause un par un.
// - fit avec 1 Gio de marge : sans marge VRAM le préfill s'effondre en silence (×21 perdu) ;
// - MTP sans seuil sur les cartes rapides, n-max 2 avec seuil p-min sur les cartes lentes ;
// - KV q8_0 (K et V du même type, sinon l'attention repasse sur le CPU) ;
// - vision sur CPU : ~0,9 Gio de VRAM rendus au contexte, débit de génération identique ;
// - batch 1024 / ubatch 512 (4096 pour un modèle partagé avec la RAM, voir loading.mjs) ;
// - toutes les couches sur la carte dès que le modèle y tient : --fit, prudent, en laissait 15 sur 66
//   au processeur sur une 3090 à 150k (59 tok/s au lieu de 95). La marge se reprend sur le contexte
//   (loadWithHeadroom) ; --fit ne sert qu'aux modèles qui débordent vraiment (layers « auto »).
export function defaultTuning(model, context, hardware, kv = 'q8_0') {
  const profile = gpuProfile(hardware);
  const backend = backendCandidates(hardware, profile)[0];
  const mtp = mtpPlan(profile).base;
  return {
    context,
    backend,
    kv,
    spec: model.mtp && backend !== 'cpu' ? { type: 'mtp', n: mtp.n, pMin: mtp.pMin } : { type: 'none' },
    fa: 'on',
    visionOnCpu: true,
    layers: 'all',
    fitTargetMiB: 1024,
    batch: 1024,
    ubatch: 512,
  };
}

export function describe(tuning) {
  if (tuning.strataArm) return tuning.strataArm;
  if (tuning.hyperqwenArm) return tuning.hyperqwenArm;
  if (tuning.challengeArm) return tuning.challengeArm;
  const parts = [`${Math.round(tuning.context / 1024)}k`, `KV ${tuning.kv}${tuning.kvV ? `/${tuning.kvV}` : ''}`];
  if (tuning.spec?.type === 'mtp') parts.push(tuning.spec.n === 'auto' ? 'MTP auto' : `MTP${tuning.spec.n}${tuning.spec.pMin ? ` p${tuning.spec.pMin}` : ''}`);
  if (tuning.spec?.type === 'dflash') parts.push(`DFlash2 n${tuning.spec.n}`);
  if (tuning.fa === 'off') parts.push('sans FA');
  if (tuning.noNextn) parts.push('sans MTP (absent du fichier)');
  if (layersOf(tuning) === 'auto') parts.push('partagé CPU');
  if (tuning.fork) parts.push(engineSheet(tuning.fork)?.label ?? tuning.fork);
  if (tuning.backend && !tuning.backend.startsWith('cuda')) parts.push(tuning.backend.toUpperCase());
  return parts.join(' · ');
}

// Les anciens réglages ont reçu `layers` par migration (migrations.mjs, v2).
export const layersOf = (tuning) => tuning.layers ?? 'all';

export function llamaArgs(model, files, tuning, hardware) {
  const gpu = tuning.backend !== 'cpu';
  const threads = Math.max(4, hardware.cpu.physical ?? 4);
  const args = [
    '-m', files.model,
    '--host', '127.0.0.1', '--port', String(PORTS.engine),
    '--alias', model.id,
    '--api-key-file', ENGINE_KEY_FILE,
    '--jinja', '--metrics', '--slots', '--no-webui',
    '-c', String(tuning.context),
    '--parallel', '1',
    '-t', String(threads),
    '-b', String(tuning.batch), '-ub', String(tuning.ubatch),
    // K et V du même type, sauf les paires prévues par un fork (llamAmpere : tq5_0/turbo4, noyau fusionné).
    '--cache-type-k', tuning.kv, '--cache-type-v', tuning.kvV ?? tuning.kv,
  ];
  // Les options propres au moteur, écrites dans sa fiche.
  if (tuning.fork) args.push(...(engineSheet(tuning.fork)?.args ?? []));
  if (gpu && layersOf(tuning) === 'auto') args.push('-ngl', 'auto', '--fit', 'on', '--fit-target', String(tuning.fitTargetMiB), '-fa', tuning.fa ?? 'on');
  else if (gpu) args.push('-ngl', '999', '--fit', 'off', '-fa', tuning.fa ?? 'on');
  else args.push('-ngl', '0');
  // GGUF qui annonce une couche d'anticipation (MTP) absente du fichier : on corrige la métadonnée
  // au chargement, le modèle tourne sur ses couches réelles, sans anticipation.
  if (tuning.noNextn && model.profile?.arch) args.push('--override-kv', `${model.profile.arch}.nextn_predict_layers=int:0`);
  const spec = tuning.noNextn ? { type: 'none' } : tuning.spec ?? { type: 'none' };
  // Tête MTP livrée dans un fichier à part : le moteur la charge comme brouillon.
  const draft = files.mtpDraft ? ['--spec-draft-model', files.mtpDraft] : [];
  if (spec.type === 'mtp' && spec.n === 'auto') {
    // Profondeur choisie par le moteur lui-même (llamAmpere : adaptative 3-4, réglée pour ses noyaux).
    if (draft.length) args.push('--spec-type', 'draft-mtp', ...draft);
  } else if (spec.type === 'mtp') {
    args.push('--spec-type', 'draft-mtp', ...draft, '--spec-draft-n-max', String(spec.n), '--spec-draft-n-min', '0', '--spec-draft-p-min', String(spec.pMin));
    // Brouillon calculé sur les N premiers tokens seulement (fork RDNA Boosts) : la tête de sortie
    // (248k × 5120 pour Qwen3.8) n'est plus relue en entier à chaque passe du brouillon.
    if (spec.vocab) args.push('--spec-draft-mtp-vocab', String(spec.vocab));
  } else if (spec.type === 'mtp-adaptive') {
    // Fork RDNA Boosts : profondeur MTP adaptative jusqu'à n, doublée d'un brouillon n-gramme qui
    // reprend les passages déjà vus dans le contexte (code, agents). --spec-type s'y additionne :
    // jamais draft-mtp en plus, le moteur refuserait et coupait l'anticipation sans le dire.
    args.push('--spec-type', 'draft-mtp-adaptive,ngram-mod', ...draft, '--spec-ngram-mod-n-match', String(spec.n * 5),
      '--spec-draft-n-max', String(spec.n), '--spec-draft-n-start', String(spec.n), '--spec-draft-n-min', '0', '--spec-draft-p-min', '0');
    if (spec.vocab) args.push('--spec-draft-mtp-vocab', String(spec.vocab));
  } else if (spec.type === 'dflash' && files.dflash) {
    // Le brouillon entier sur la carte (sinon le moteur peut le laisser au processeur).
    args.push('--spec-type', 'draft-dflash', '--spec-draft-model', files.dflash, '--spec-draft-n-max', String(spec.n), '-ngld', '999');
  } else if (model.mtp) {
    // Sans spéculation demandée, on le dit : certains builds activent la tête MTP d'office.
    args.push('--spec-type', 'none');
  }
  if (files.mmproj) {
    args.push('--mmproj', files.mmproj);
    if (tuning.visionOnCpu || !gpu) args.push('--no-mmproj-offload');
  }
  const sampling = model.sampling;
  args.push('--temp', String(sampling.temperature), '--top-p', String(sampling.top_p), '--top-k', String(sampling.top_k), '--min-p', String(sampling.min_p));
  if (sampling.repeat_penalty) args.push('--repeat-penalty', String(sampling.repeat_penalty));
  if (sampling.presence_penalty) args.push('--presence-penalty', String(sampling.presence_penalty));
  return args;
}

// Les moteurs chargés, un par modèle. Plusieurs modèles peuvent tenir ensemble sur la carte
// (placement.mjs décide) : chacun a son processus, son port, son relais et son propre arrêt.
// state.engines les décrit pour l'interface ; state.active reste le dernier utilisé, pour tout ce
// qui ne parle que d'« un » modèle (interface, carnet, pi).
const running = new Map(); // id du modèle → { child, relay, stopping, stopInFlight }
const slotOf = (modelId) => {
  if (!running.has(modelId)) running.set(modelId, { child: null, relay: null, stopping: false, stopInFlight: null });
  return running.get(modelId);
};
export const loadedModels = () => Object.keys(getState().engines ?? {});

// Met à jour la fiche d'un moteur ; focus : il devient le modèle « actif » affiché. null : retiré.
// Le modèle actif qui s'arrête laisse la place au plus récemment utilisé des autres ; s'il n'en
// reste aucun, il reste affiché « arrêté » (reprise au démarrage, « En pause »).
export function setEngine(modelId, patch, { focus = false } = {}) {
  update((s) => {
    s.engines ??= {};
    if (patch === null) {
      delete s.engines[modelId];
      if (s.active?.modelId !== modelId) return;
      const next = Object.values(s.engines).sort((a, b) => (b.lastUse ?? b.since ?? 0) - (a.lastUse ?? a.since ?? 0))[0];
      s.active = next ? { ...next } : { ...s.active, status: 'stopped' };
      return;
    }
    s.engines[modelId] = { ...(s.engines[modelId] ?? {}), ...patch };
    if (focus || s.active?.modelId === modelId) s.active = { ...s.engines[modelId] };
  });
}

export function engineEndpoint(modelId = getState().active?.modelId) {
  const engine = getState().engines?.[modelId];
  return engine?.status === 'ready' ? engine.endpoint : null;
}

// Un port libre pour un moteur de plus : le système en donne un, on le rend aussitôt.
export function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => { const { port } = probe.address(); probe.close(() => resolve(port)); });
  });
}

// Un moteur peut lancer ses propres processus : Strata (Python) démarre un moteur natif qui tient
// la VRAM. Sous Linux, chaque moteur a son groupe de processus (spawn détaché) : on arrête le
// groupe entier, poliment puis de force, sinon un petit-enfant garderait la carte.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
async function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') return void await run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  // Un orphelin repris par reapOrphans n'est pas forcément chef de groupe : on vise alors le seul PID.
  const target = alive(-pid) ? -pid : pid;
  try { process.kill(target, 'SIGTERM'); } catch {}
  // 30 s de politesse : un moteur en conteneur (Radiance) arrête son conteneur sur SIGTERM
  // (podman stop -t 15). Tué avant, le lanceur laissait vLLM tourner hors de toute trace.
  for (let i = 0; i < 60 && alive(target); i += 1) await new Promise((resolve) => setTimeout(resolve, 500));
  if (alive(target)) try { process.kill(target, 'SIGKILL'); } catch {}
}

// Un seul moteur sur la carte : tout llama-server ou Strata lancé depuis nos dossiers et
// resté orphelin (crash, arrêt brutal) est repris. On vérifie les PID, pas les ports.
// Le moteur d'images (runtime/sdcpp) est épargné tant qu'une image tient la carte : un modèle de
// texte rechargé à ce moment-là le tuait en plein travail.
export async function reapOrphans() {
  const sparing = isImageJob(busyWith());
  // Les moteurs vivants et leurs enfants (même groupe de processus) ne sont pas des orphelins.
  const ours = new Set([...running.values()].map((r) => r.child?.pid).filter(Boolean));
  const pids = (process.platform === 'win32' ? await windowsRuntimePids(sparing) : await linuxRuntimePids(sparing));
  const orphans = [];
  for (const pid of pids) if (!ours.has(pid) && !ours.has(await groupOf(pid))) orphans.push(pid);
  for (const pid of orphans) await killTree(pid);
  return orphans;
}
// Le groupe de processus (5e champ de /proc/<pid>/stat, après le nom entre parenthèses).
async function groupOf(pid) {
  if (process.platform !== 'linux') return null;
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => '');
  return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[2]) || null;
}

async function windowsRuntimePids(sparingImages = false) {
  const root = DIRS.runtime.replaceAll("'", "''");
  const images = path.join(DIRS.runtime, 'sdcpp').replaceAll("'", "''");
  const spare = sparingImages ? ` -and -not $_.ExecutablePath.StartsWith('${images}', 'OrdinalIgnoreCase')` : '';
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${root}', 'OrdinalIgnoreCase')${spare} } | Select-Object -ExpandProperty ProcessId`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }).catch(() => ({ stdout: '' }));
  return stdout.split(/\s+/).filter(Boolean).map(Number);
}

// Linux : l'exécutable de chaque processus se lit dans /proc/<pid>/exe. ketch, lui aussi dans
// runtime/, sert la recherche web des sessions pi ouvertes : on le laisse.
async function linuxRuntimePids(sparingImages = false) {
  if (process.platform !== 'linux') return [];
  const root = DIRS.runtime + path.sep;
  const images = path.join(DIRS.runtime, 'sdcpp') + path.sep;
  const pids = [];
  for (const entry of await readdir('/proc').catch(() => [])) {
    if (!/^\d+$/.test(entry)) continue;
    // Le python du venv de Strata est un lien vers /usr/bin/python3 : exe ne le montre pas, la
    // ligne de commande (lancée par son chemin complet) si.
    const exe = await readlink(`/proc/${entry}/exe`).catch(() => '');
    const argv0 = (await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '')).split('\0')[0];
    if (sparingImages && (exe.startsWith(images) || argv0.startsWith(images))) continue;
    if ((exe.startsWith(root) || argv0.startsWith(root)) && path.basename(exe) !== 'ketch') { pids.push(Number(entry)); continue; }
    // vLLM lancé dans un conteneur (Radiance) : son exécutable n'est pas dans runtime/, mais il
    // sert un modèle de notre catalogue sous son id. Resté seul, il tenait 29 Go de la carte
    // sans que Harn l'affiche.
    if (argv0.endsWith('python3') || argv0.endsWith('vllm')) {
      const argv = (await readFile(`/proc/${entry}/cmdline`, 'utf8').catch(() => '')).split('\0');
      const served = argv.find((a) => a.startsWith('--served-model-name='))?.split('=')[1];
      if (argv.includes('serve') && served && modelById(served)) pids.push(Number(entry));
    }
  }
  return pids;
}

async function waitReady(url, timeoutMs, exited, logFile = engineLog('moteur')) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited()) throw new Error(`Le moteur s’est arrêté pendant le chargement (voir data/logs/${path.basename(logFile)})`);
    // Avec la clé : la santé de la pile du Gemma Challenge passe par /v1/models, gardée par vLLM.
    const ok = await fetch(url, { headers: engineHeaders() }).then((response) => response.ok).catch(() => false);
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error('Le moteur n’a pas répondu à temps');
}

// Un échec que plus de mémoire ne réglerait pas : réessayer avec moins de contexte ne sert à rien,
// et l'utilisateur doit lire la vraie cause plutôt qu'un « moteur arrêté ».
export function loadFailure(tail, label = 'ce modèle') {
  const arch = tail.match(/unknown model architecture: '([^']+)'/);
  if (arch) return `Ce moteur ne connaît pas encore l’architecture « ${arch[1]} » de ${label} : il faudra une version plus récente de llama.cpp`;
  if (/out of memory|failed to allocate|cudaMalloc|unable to allocate|CUDA error/i.test(tail)) return null;
  const load = tail.match(/llama_model_load: error loading model: ([^\n]+)/);
  if (load) return `Le fichier de ${label} n’a pas pu être chargé : ${load[1].trim().slice(0, 200)}`;
  return null;
}

// Un moteur isolé (sandbox.mjs) n'a pas de réseau : il écoute sur un socket Unix, et ce relais
// le rend joignable au port habituel. Le reste de Harn ne voit pas la différence.
// Le relais garde ses connexions : à l'arrêt, il les coupe. server.close() seul attend la fin de
// chacune, sans limite : une seule restée à moitié ouverte (moteur tué en pleine réponse) suffisait
// à bloquer l'arrêt du moteur pour toujours, et avec lui tout chargement et toute relance de Harn.
export function startRelay(endpoint, socket) {
  const port = Number(new URL(endpoint).port);
  const sockets = new Set();
  return new Promise((resolve, reject) => {
    const server = net.createServer((client) => {
      const upstream = net.connect(socket);
      sockets.add(client).add(upstream);
      client.pipe(upstream).pipe(client);
      // Un côté fermé ou en erreur ferme l'autre : pas de demi-connexion qui traîne.
      const drop = () => { client.destroy(); upstream.destroy(); sockets.delete(client); sockets.delete(upstream); };
      for (const end of [client, upstream]) { end.on('error', drop); end.on('close', drop); }
    });
    server.sockets = sockets;
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}
function stopRelay(slot) {
  const server = slot.relay;
  slot.relay = null;
  return closeRelay(server);
}
export function closeRelay(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    server.close(() => { clearTimeout(timer); resolve(); });
    for (const socket of server.sockets ?? []) socket.destroy();
  });
}

// Lance le moteur d'un modèle. Seul un moteur du même modèle est remplacé : les autres restent
// (placement.mjs a fait la place avant). alone : la carte pour lui seul (banc, premier démarrage).
export async function startEngine({ modelId, command, args, cwd, health, endpoint, env = {}, label, socket = null }, { alone = false } = {}) {
  if (alone) await stopEngine();
  else await stopEngine(modelId);
  const slot = slotOf(modelId);
  if (socket) {
    await rm(socket, { force: true });
    slot.relay = await startRelay(endpoint, socket);
  }
  await reapOrphans();
  await mkdir(DIRS.logs, { recursive: true });
  await writeFile(ENGINE_KEY_FILE, `${ENGINE_KEY}\n`);
  // Un journal par modèle : plusieurs moteurs tournent ensemble.
  const logFile = engineLog(modelId);
  const log = createWriteStream(logFile, { flags: 'w' });
  log.write(`# ${new Date().toISOString()}\n# ${command} ${args.join(' ')}\n\n`);

  setEngine(modelId, { modelId, label, status: 'loading', since: Date.now(), endpoint, command, args, cwd, error: null, log: logFile }, { focus: true });
  let exited = false;
  const process_ = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, detached: process.platform !== 'win32' });
  slot.child = process_;
  process_.stdout.pipe(log, { end: false });
  process_.stderr.pipe(log, { end: false });
  // La fin du journal, pour dire pourquoi un chargement a échoué.
  let tail = '';
  const keep = (chunk) => { tail = (tail + chunk).slice(-16_384); };
  process_.stdout.on('data', keep);
  process_.stderr.on('data', keep);
  // Exécutable absent ou bloqué (antivirus, fichier supprimé) : pas d'« exit », seulement « error ».
  let spawnError = null;
  process_.on('error', (error) => {
    spawnError = error;
    exited = true;
    if (slot.child === process_) slot.child = null;
  });
  process_.on('exit', (code) => {
    exited = true;
    if (slot.child !== process_) return;
    slot.child = null;
    // Un moteur mort sans qu'on l'arrête : l'état le dit, et son relais est fermé (sinon une
    // requête attendrait un moteur disparu). La prochaine requête le recharge.
    if (!slot.stopping && getState().engines?.[modelId]) {
      setEngine(modelId, { status: 'crashed', error: `Le moteur s’est arrêté (code ${code})` });
      stopRelay(slot);
    }
  });

  try {
    await waitReady(health, 900_000, () => exited, logFile);
  } catch (error) {
    await killTree(process_.pid);
    await stopRelay(slot);
    const cause = loadFailure(tail, label);
    // tensors : le fichier ne contient pas les tenseurs (ou la tête MTP) que ses métadonnées annoncent.
    const failure = spawnError ? Object.assign(new Error(`Le moteur n’a pas pu être lancé : ${spawnError.message}`), { fatal: true })
      : cause ? Object.assign(new Error(cause), { fatal: true, tensors: /wrong number of tensors|doesn't contain MTP layers/.test(tail) }) : error;
    setEngine(modelId, { status: 'error', error: failure.message });
    throw failure;
  }
  const now = Date.now();
  setEngine(modelId, { status: 'ready', readyAt: now, lastUse: now, loadSeconds: (now - getState().engines[modelId].since) / 1000 });
  return getState().engines[modelId];
}
export const engineLog = (modelId) => path.join(DIRS.logs, `engine-${String(modelId).replace(/[^\w.-]/g, '_')}.log`);

// Arrête le moteur d'un modèle, ou tous sans argument (libérer la carte, image, arrêt de Harn).
// Deux arrêts demandés ensemble (inactivité, puis une requête qui recharge) n'en font qu'un : le
// second ne doit pas reprendre comme orphelin le moteur que le premier vient de laisser lancer.
export function stopEngine(modelId) {
  if (modelId === undefined) return Promise.all([...new Set([...running.keys(), ...loadedModels()])].map((id) => stopEngine(id))).then(() => {});
  const slot = slotOf(modelId);
  slot.stopInFlight ??= stopNow(modelId, slot).finally(() => { slot.stopInFlight = null; });
  return slot.stopInFlight;
}

// Tous les moteurs sauf celui de keep (banc : le modèle mesuré seul sur la carte).
export const stopOthers = (keep) => Promise.all(loadedModels().filter((id) => id !== keep).map((id) => stopEngine(id))).then(() => {});

async function stopNow(modelId, slot) {
  if (!slot.child) {
    await stopRelay(slot);
    if (getState().engines?.[modelId]) setEngine(modelId, null);
    return;
  }
  slot.stopping = true;
  const child = slot.child;
  await killTree(child.pid);
  await new Promise((resolve) => {
    if (slot.child !== child) return resolve();
    child.once('exit', resolve);
    setTimeout(resolve, 10_000);
  });
  slot.child = null;
  slot.stopping = false;
  await stopRelay(slot);
  setEngine(modelId, null);
  // Ce qui aurait échappé au groupe (processus détaché de son parent) : repris par son chemin.
  await reapOrphans();
  // Le pilote rend la VRAM avec un temps de retard : on attend qu'elle se stabilise, sinon le
  // moteur suivant mesurerait une marge fausse et réduirait son contexte pour rien.
  let previous = null;
  for (let i = 0; i < 20; i += 1) {
    const free = (await sampleGpu())?.freeMiB ?? null;
    if (free === null || (previous !== null && Math.abs(free - previous) < 128)) break;
    previous = free;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

export function modelFiles(modelId) {
  const model = modelById(modelId);
  const dir = path.join(DIRS.models, modelId);
  // Un fichier réutilisé sur un autre disque garde son chemin d'origine.
  const where = (name) => getState().models[modelId]?.paths?.[name] ?? path.join(dir, name);
  return {
    model: where(model.files[0].name),
    mmproj: model.mmproj ? where(model.mmproj.name) : null,
    mtpDraft: model.mtpDraft ? where(model.mtpDraft.name) : null,
    dflash: model.dflash ? path.join(dir, model.dflash.name) : null,
  };
}
