import { execFile, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { modelById } from './catalog.mjs';
import { backendCandidates, gpuProfile, mtpPlan } from './levers.mjs';
import { sampleGpu } from './hardware.mjs';
import { DIRS, PORTS, ROOT } from './paths.mjs';
import { getState, update } from './state.mjs';

const run = promisify(execFile);

// Le point de départ d'un modèle sur CETTE machine. Les a priori viennent de levers.mjs
// (classe de bande passante, architecture) ; le banc les remet en cause un par un.
// - fit avec 1 Gio de marge : sans marge VRAM le préfill s'effondre en silence (×21 perdu) ;
// - MTP sans seuil sur les cartes rapides, n-max 2 avec seuil p-min sur les cartes lentes ;
// - KV q8_0 (K et V du même type, sinon l'attention repasse sur le CPU) ;
// - vision sur CPU : ~0,9 Gio de VRAM rendus au contexte, débit de génération identique ;
// - batch 1024 / ubatch 512, couches GPU en auto (forcer « all » ne rapporte rien).
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
    fitTargetMiB: 1024,
    batch: 1024,
    ubatch: 512,
  };
}

export function describe(tuning) {
  if (tuning.strataArm) return tuning.strataArm;
  const parts = [`${Math.round(tuning.context / 1024)}k`, `KV ${tuning.kv}`];
  if (tuning.spec?.type === 'mtp') parts.push(`MTP${tuning.spec.n}${tuning.spec.pMin ? ` p${tuning.spec.pMin}` : ''}`);
  if (tuning.spec?.type === 'dflash') parts.push(`DFlash2 n${tuning.spec.n}`);
  if (tuning.fa === 'off') parts.push('sans FA');
  if (tuning.backend && !tuning.backend.startsWith('cuda')) parts.push(tuning.backend.toUpperCase());
  return parts.join(' · ');
}

export function llamaArgs(model, files, tuning, hardware) {
  const gpu = tuning.backend !== 'cpu';
  const threads = Math.max(4, hardware.cpu.physical ?? 4);
  const args = [
    '-m', files.model,
    '--host', '127.0.0.1', '--port', String(PORTS.engine),
    '--alias', model.id,
    '--jinja', '--metrics', '--slots', '--no-webui',
    '-c', String(tuning.context),
    '--parallel', '1',
    '-t', String(threads),
    '-b', String(tuning.batch), '-ub', String(tuning.ubatch),
    '--cache-type-k', tuning.kv, '--cache-type-v', tuning.kv,
  ];
  if (gpu) args.push('-ngl', 'auto', '--fit', 'on', '--fit-target', String(tuning.fitTargetMiB), '-fa', tuning.fa ?? 'on');
  else args.push('-ngl', '0');
  const spec = tuning.spec ?? { type: 'none' };
  if (spec.type === 'mtp') {
    args.push('--spec-type', 'draft-mtp', '--spec-draft-n-max', String(spec.n), '--spec-draft-n-min', '0', '--spec-draft-p-min', String(spec.pMin));
  } else if (spec.type === 'dflash' && files.dflash) {
    args.push('--spec-type', 'draft-dflash', '--spec-draft-model', files.dflash, '--spec-draft-n-max', String(spec.n));
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

let child = null;
let stopping = false;

export function engineEndpoint() {
  const active = getState().active;
  if (!active || active.status !== 'ready') return null;
  return active.endpoint;
}

async function killTree(pid) {
  if (!pid) return;
  if (process.platform === 'win32') await run('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }).catch(() => {});
  else try { process.kill(pid, 'SIGTERM'); } catch {}
}

// Un seul moteur sur la carte : tout llama-server ou Strata lancé depuis nos dossiers et
// resté orphelin (crash, arrêt brutal) est repris. On vérifie les PID, pas les ports.
export async function reapOrphans() {
  if (process.platform !== 'win32') return [];
  const root = path.join(ROOT, 'runtime').replaceAll("'", "''");
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${root}', 'OrdinalIgnoreCase') } | Select-Object -ExpandProperty ProcessId`;
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true }).catch(() => ({ stdout: '' }));
  const pids = stdout.split(/\s+/).filter(Boolean).map(Number).filter((pid) => pid !== child?.pid);
  for (const pid of pids) await killTree(pid);
  return pids;
}

async function waitReady(url, timeoutMs, exited) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (exited()) throw new Error('Le moteur s’est arrêté pendant le chargement (voir data/logs/engine.log)');
    const ok = await fetch(url).then((response) => response.ok).catch(() => false);
    if (ok) return;
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
  throw new Error('Le moteur n’a pas répondu à temps');
}

export async function startEngine({ modelId, command, args, cwd, health, endpoint, env = {}, label }) {
  await stopEngine();
  await reapOrphans();
  await mkdir(DIRS.logs, { recursive: true });
  const log = createWriteStream(path.join(DIRS.logs, 'engine.log'), { flags: 'w' });
  log.write(`# ${new Date().toISOString()}\n# ${command} ${args.join(' ')}\n\n`);

  update((s) => { s.active = { modelId, label, status: 'loading', since: Date.now(), endpoint, args, error: null }; });
  let exited = false;
  const process_ = spawn(command, args, { cwd, env: { ...process.env, ...env }, windowsHide: true });
  child = process_;
  process_.stdout.pipe(log, { end: false });
  process_.stderr.pipe(log, { end: false });
  process_.on('exit', (code) => {
    exited = true;
    if (child === process_) child = null;
    if (!stopping && getState().active?.modelId === modelId) {
      update((s) => { s.active = { ...s.active, status: 'crashed', error: `Le moteur s’est arrêté (code ${code})` }; });
    }
  });

  try {
    await waitReady(health, 900_000, () => exited);
  } catch (error) {
    await killTree(process_.pid);
    update((s) => { s.active = { ...s.active, status: 'error', error: error.message }; });
    throw error;
  }
  update((s) => { s.active = { ...s.active, status: 'ready', readyAt: Date.now(), loadSeconds: (Date.now() - s.active.since) / 1000 }; });
  return getState().active;
}

export async function stopEngine() {
  if (!child) return;
  stopping = true;
  const pid = child.pid;
  await killTree(pid);
  await new Promise((resolve) => {
    if (!child) return resolve();
    child.once('exit', resolve);
    setTimeout(resolve, 10_000);
  });
  child = null;
  stopping = false;
  // Le pilote rend la VRAM avec un temps de retard : on attend qu'elle se stabilise, sinon le
  // moteur suivant mesurerait une marge fausse et réduirait son contexte pour rien.
  let previous = null;
  for (let i = 0; i < 20; i += 1) {
    const free = (await sampleGpu())?.freeMiB ?? null;
    if (free === null || (previous !== null && Math.abs(free - previous) < 128)) break;
    previous = free;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  update((s) => { if (s.active) s.active.status = 'stopped'; });
}

export function modelFiles(modelId) {
  const model = modelById(modelId);
  const dir = path.join(DIRS.models, modelId);
  // Un fichier réutilisé sur un autre disque garde son chemin d'origine.
  const where = (name) => getState().models[modelId]?.paths?.[name] ?? path.join(dir, name);
  return {
    model: where(model.files[0].name),
    mmproj: model.mmproj ? where(model.mmproj.name) : null,
    dflash: model.dflash ? path.join(dir, model.dflash.name) : null,
  };
}
