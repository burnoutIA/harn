import { EventEmitter } from 'node:events';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from './paths.mjs';

const FILE = path.join(DIRS.data, 'state.json');

// L'état durable de l'installation, et le bus qui prévient l'interface de chaque changement.
// Les écritures sont atomiques (fichier temporaire puis renommage) et regroupées.
export const bus = new EventEmitter();
bus.setMaxListeners(100);

const initial = () => ({
  version: 1,
  hardware: null,
  plan: null,
  // Une étape par phase du premier démarrage : l'interface les affiche telles quelles.
  setup: { phase: 'idle', steps: [], error: null, startedAt: null, finishedAt: null },
  runtimes: {},   // id → { version, path, installedAt }
  models: {},     // id → { files: [...], installedAt, bytes }
  downloads: {},  // id → { label, received, total, speed, done, error }
  profiles: {},   // id du modèle → { recipe, bench: { arms: [...], winner, at }, measured }
  active: null,   // { modelId, engine, status, since, error }
  pi: { installed: false, version: null, lastLaunch: null },
});

let state = initial();
let saveTimer = null;

export async function loadState() {
  await mkdir(DIRS.data, { recursive: true });
  try {
    state = { ...initial(), ...JSON.parse(await readFile(FILE, 'utf8')) };
  } catch {
    state = initial();
  }
  // Ce qui tournait au dernier arrêt ne tourne plus : on repart d'un état honnête.
  if (state.active) state.active = { ...state.active, status: 'stopped' };
  for (const download of Object.values(state.downloads)) if (!download.done) download.paused = true;
  if (state.setup.phase === 'running') state.setup.phase = 'interrupted';
  return state;
}

export const getState = () => state;

export function update(mutator) {
  mutator(state);
  bus.emit('state', state);
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => save().catch(() => {}), 250);
}

export async function save() {
  const temporary = `${FILE}.tmp`;
  await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await rename(temporary, FILE);
}
