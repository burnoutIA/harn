import './helpers/home.mjs';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { MODELS, modelById } from '../src/catalog.mjs';
import { defaultTuning, stopEngine } from '../src/engine.mjs';
import { setGpuSampler } from '../src/hardware.mjs';
import { DIRS } from '../src/paths.mjs';
import { makePlan } from '../src/planner.mjs';
import { loadWithHeadroom, tuneModel } from '../src/setup.mjs';
import { getState, update } from '../src/state.mjs';

// Les scénarios qui ont cassé sur une vraie machine, rejoués avec un faux llama-server
// (tests/helpers/fake-llama-server.mjs) et une carte simulée de 24 Go : la VRAM libre dépend du
// contexte et du type de KV du moteur lancé, comme sur la 3090 de référence.

const FAKE = path.join(path.dirname(new URL(import.meta.url).pathname), 'helpers', 'fake-llama-server.mjs');
const MiB = 2 ** 20;
const HARDWARE = {
  os: { platform: 'linux' }, cpu: { physical: 8, model: 'x' }, ramGiB: 64, freeRamGiB: 48, diskFreeGiB: 500, gitBash: true, buildTools: null, python: null,
  primary: { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3090', vramMiB: 24576, freeMiB: 23500, cuda: '12.4', computeCapability: 8.6 },
  gpus: [], vramGiB: 24,
};
const weights = new Map(); // modèle → Mio de poids sur la carte

// Carte simulée : bureau 1 Gio + poids + KV du contexte chargé.
function sampler() {
  const active = getState().active;
  let used = 1000;
  if (active?.status === 'ready' || active?.status === 'loading') {
    const args = active.args ?? [];
    const context = Number(args[args.indexOf('-c') + 1]) || 0;
    const kv = args[args.indexOf('--cache-type-k') + 1] ?? 'f16';
    const model = modelById(active.modelId);
    used += (weights.get(active.modelId) ?? 12000) + context * (model?.kvBytesPerToken?.[kv] ?? 35_000) / MiB;
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
  const serverPath = path.join(dir, 'llama-server');
  writeFileSync(serverPath, `#!/bin/sh\nexec "${process.execPath}" "${FAKE}" "$@"\n`);
  chmodSync(serverPath, 0o755);
  setGpuSampler(async () => sampler());
  update((s) => {
    s.hardware = HARDWARE;
    s.plan = makePlan(HARDWARE);
    s.runtimes['llama-cuda12'] = { kind: 'llama', backend: 'cuda12', tag: 'fake', dir, serverPath };
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
