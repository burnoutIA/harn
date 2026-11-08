import './helpers/home.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { MODELS, modelById } from '../src/catalog.mjs';
import { defaultTuning, startEngine, stopEngine } from '../src/engine.mjs';
import { setGpuSampler } from '../src/hardware.mjs';
import { IDLE_MS, engineInUse, unloadIfIdle } from '../src/idle.mjs';
import { DIRS, PORTS } from '../src/paths.mjs';
import { makePlan } from '../src/planner.mjs';
import { loadWithHeadroom, tuneModel } from '../src/setup.mjs';
import { activate } from '../src/activation.mjs';
import { followDemand, updateSharing } from '../src/placement.mjs';
import { getState, update } from '../src/state.mjs';

// Les scénarios qui ont cassé sur une vraie machine, rejoués avec un faux llama-server
// (tests/helpers/fake-llama-server.mjs) et une carte simulée de 24 Go : la VRAM libre dépend du
// contexte et du type de KV du moteur lancé, comme sur la 3090 de référence.

const FAKE = fileURLToPath(new URL('./helpers/fake-llama-server.mjs', import.meta.url));
const MiB = 2 ** 20;
const HARDWARE = {
  os: { platform: 'linux' }, cpu: { physical: 8, model: 'x' }, ramGiB: 64, freeRamGiB: 48, diskFreeGiB: 500, gitBash: true, buildTools: null, python: null,
  primary: { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3090', vramMiB: 24576, freeMiB: 23500, cuda: '12.4', computeCapability: 8.6 },
  gpus: [], vramGiB: 24,
};
const weights = new Map(); // modèle → Mio de poids sur la carte

// Carte simulée : bureau 1 Gio + poids + KV du contexte de chaque modèle chargé.
function sampler() {
  let used = 1000;
  for (const engine of Object.values(getState().engines ?? {})) {
    if (engine.status !== 'ready' && engine.status !== 'loading') continue;
    const args = engine.args ?? [];
    const context = Number(args[args.indexOf('-c') + 1]) || 0;
    const kv = args[args.indexOf('--cache-type-k') + 1] ?? 'f16';
    const model = modelById(engine.modelId);
    used += (weights.get(engine.modelId) ?? 12000) + context * (model?.kvBytesPerToken?.[kv] ?? 35_000) / MiB;
  }
  return { util: 0, usedMiB: used, freeMiB: Math.round(24576 - used), totalMiB: 24576, powerW: 100, tempC: 40, pstate: 'P2', smMHz: 1800 };
}

function addModel(id, config, { weightsMiB = 12000, ...extra } = {}) {
  const base = modelById('swift15-q27-iq3s-mtp');
  MODELS.push({ ...base, id, name: id, files: [{ name: 'm.gguf', bytes: 1 }], mmproj: null, dflash: null, vision: false, ...extra });
  const dir = path.join(DIRS.models, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'm.gguf'), 'GGUF');
  writeFileSync(path.join(dir, 'm.gguf.fake.json'), JSON.stringify(config));
  weights.set(id, weightsMiB);
  update((s) => { s.models[id] = { installedAt: new Date().toISOString(), files: ['m.gguf'] }; });
  return modelById(id);
}

const launches = (id) => {
  const file = path.join(DIRS.models, id, 'm.gguf.launches.jsonl');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((line) => JSON.parse(line)) : [];
};

before(() => {
  const dir = path.join(DIRS.runtime, 'llama', 'fake');
  mkdirSync(dir, { recursive: true });
  // Le faux moteur est lancé par node, sans script intermédiaire : pareil sous Windows et Linux.
  setGpuSampler(async () => sampler());
  update((s) => {
    s.hardware = HARDWARE;
    s.plan = makePlan(HARDWARE);
    s.runtimes['llama-cuda12'] = { kind: 'llama', backend: 'cuda12', tag: 'fake', dir, serverPath: process.execPath, serverArgs: [FAKE] };
  });
});
after(() => stopEngine());

const LIMIT = { timeout: 90_000 }; // une régression qui bloque doit échouer, pas pendre

test('chargement : toutes les couches sur la carte, le contexte cède pour garder 1,5 Gio', LIMIT, async () => {
  const model = addModel('t-headroom', { tps: 80 }, { weightsMiB: 17500 });
  const { tuning, headroomMiB } = await loadWithHeadroom(model, defaultTuning(model, 153600, HARDWARE));
  assert.equal(tuning.context, 120832);
  assert.ok(headroomMiB >= 1536);
  assert.ok(launches(model.id).every((l) => l.ngl === '999' && l.fit === 'off'), 'jamais de couche laissée au processeur');
});

test('architecture inconnue : échec définitif, cause affichée, pas de nouvel essai', LIMIT, async () => {
  const model = addModel('t-arch', { arch: 'xing4_0', unknownArch: true });
  await assert.rejects(loadWithHeadroom(model, defaultTuning(model, 131072, HARDWARE)), /architecture « xing4_0 »/);
  assert.equal(launches(model.id).length, 1);
});

test('moteur introuvable : échec immédiat et lisible, sans attendre le délai de chargement', LIMIT, async () => {
  const endpoint = `http://127.0.0.1:${PORTS.engine}`;
  const recipe = { modelId: 't-missing', label: 't-missing', command: path.join(DIRS.runtime, 'absent', 'llama-server'), args: [], endpoint, health: `${endpoint}/health` };
  await assert.rejects(startEngine(recipe), (error) => error.fatal && /n’a pas pu être lancé/.test(error.message));
  assert.equal(getState().active.status, 'error');
});

test('GGUF qui annonce une couche MTP absente : rechargé sans elle', LIMIT, async () => {
  const model = addModel('t-nextn', { phantomNextn: true }, { profile: { arch: 'xing4_0', mtp: true } });
  const { tuning } = await loadWithHeadroom(model, defaultTuning(model, 131072, HARDWARE));
  assert.equal(tuning.noNextn, true);
  const [first, second] = launches(model.id);
  assert.equal(first.overrides.length, 0);
  assert.deepEqual(second.overrides, ['xing4_0.nextn_predict_layers=int:0']);
  assert.equal(second.spec, 'none');
});

test('banc : deux bancs lancés ensemble passent l’un après l’autre, profondeur mesurée, f16 retenu', LIMIT, async () => {
  const a = addModel('t-bench-a', { tps: 90, depthSlope: 0.6, f16DepthBonus: 0.5 });
  const b = addModel('t-bench-b', { tps: 70 });
  const [ra, rb] = await Promise.all([tuneModel(a.id), tuneModel(b.id)]);
  assert.ok(ra.bench.winner && rb.bench.winner);
  // La file : tous les lancements de l'un avant le premier de l'autre.
  const la = launches(a.id).map((l) => l.at);
  const lb = launches(b.id).map((l) => l.at);
  assert.ok(Math.max(...la) < Math.min(...lb) || Math.max(...lb) < Math.min(...la), 'les bancs se sont croisés sur la carte');
  // Profondeur : mesurée et retenue dans le choix du KV.
  assert.ok(ra.bench.depth?.tokens > 20_000);
  assert.equal(ra.tuning.kv, 'f16');
  assert.ok(ra.bench.arms.some((arm) => arm.stage === 'KV en profondeur'));
});

test('inactivité : le modèle est déchargé après dix minutes sans requête, pas pendant une réponse', LIMIT, async () => {
  const model = addModel('t-idle', { tps: 80 });
  await loadWithHeadroom(model, defaultTuning(model, 32768, HARDWARE));
  assert.equal(await unloadIfIdle(Date.now() + IDLE_MS - 60_000), false, 'déchargé trop tôt');
  const release = engineInUse();
  assert.equal(await unloadIfIdle(Date.now() + 2 * IDLE_MS), false, 'déchargé pendant une réponse');
  release();
  assert.equal(await unloadIfIdle(Date.now() + IDLE_MS - 60_000), false, 'le délai repart de la fin de la réponse');
  assert.equal(await unloadIfIdle(Date.now() + IDLE_MS + 60_000), true);
  assert.equal(getState().active.status, 'stopped');
  assert.ok(!getState().active.unloadedByUser, 'un déchargement automatique ne vaut pas un choix de l’utilisateur');
});

// ── Plusieurs modèles sur la carte (placement.mjs) ──────────────
// Un modèle « placé » : réglage de banc à 32k, et une taille de fichier qui dit ses poids.
function placed(id, weightsMiB) {
  const model = addModel(id, { tps: 80 }, { weightsMiB, files: [{ name: 'm.gguf', bytes: weightsMiB * MiB }] });
  update((s) => { (s.profiles[id] ??= {}).tuning = { ...defaultTuning(model, 32768, HARDWARE), backend: 'cuda12' }; });
  return model;
}

test('placement : deux petits modèles cohabitent, un gros fait partir le plus ancien des inactifs', LIMIT, async () => {
  await stopEngine();
  const a = placed('t-place-a', 4000);
  const b = placed('t-place-b', 4000);
  const big = placed('t-place-big', 14000);
  await activate(a.id);
  await activate(b.id);
  const engines = getState().engines;
  assert.deepEqual(Object.keys(engines).sort(), [a.id, b.id].sort(), 'les deux tiennent ensemble');
  assert.notEqual(engines[a.id].endpoint, engines[b.id].endpoint, 'un port chacun');
  // a a servi en dernier : b, le plus ancien, part pour le gros.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const release = engineInUse(a.id);
  release();
  await activate(big.id);
  assert.deepEqual(Object.keys(getState().engines).sort(), [a.id, big.id].sort());
  assert.ok(getState().profiles[big.id].vram?.mib > 10_000, 'mémoire réellement prise notée au chargement');
});

test('placement : un modèle qui répond n’est pas déchargé, le nouveau attend la fin', LIMIT, async () => {
  await stopEngine();
  const a = placed('t-busy-a', 9000);
  const b = placed('t-busy-b', 12000);
  await activate(a.id);
  const release = engineInUse(a.id);
  let loaded = false;
  const loading = activate(b.id).then(() => { loaded = true; });
  await new Promise((resolve) => setTimeout(resolve, 1500));
  assert.equal(loaded, false, 'chargé en déchargeant un modèle en pleine réponse');
  assert.equal(getState().engines[a.id]?.status, 'ready');
  release();
  await loading;
  assert.deepEqual(Object.keys(getState().engines), [b.id]);
});

test('sessions : la demande en ajoute une, jamais au milieu d’une réponse ; la carte partagée est signalée', LIMIT, async () => {
  await stopEngine();
  const a = placed('t-slots-a', 4000);
  const b = placed('t-slots-b', 4000);
  await activate(a.id);
  assert.equal(getState().engines[a.id].slots, 1);
  // Deux demandes à la fois, la première déjà partie au moteur : on ne relance pas.
  assert.equal(followDemand(a.id, 2, 1, activate), null);
  // Plus tard, le moteur ne répond à personne : il repart avec deux sessions de 32k chacune.
  const resize = followDemand(a.id, 1, 0, activate);
  assert.ok(resize, 'rechargement attendu');
  await resize;
  const engine = getState().engines[a.id];
  assert.equal(engine.slots, 2);
  assert.equal(engine.args[engine.args.indexOf('--parallel') + 1], '2');
  assert.equal(engine.args[engine.args.indexOf('-c') + 1], '65536');
  // Deux modèles chargés : l'avis de partage le dit.
  await activate(b.id);
  updateSharing();
  assert.equal(getState().sharing?.[0]?.kind, 'models');
  assert.deepEqual(getState().sharing[0].models.map((m) => m.id).sort(), [a.id, b.id].sort());
});
