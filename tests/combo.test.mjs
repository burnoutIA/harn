import './helpers/home.mjs';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { activate } from '../src/activation.mjs';
import { MODELS, modelById } from '../src/catalog.mjs';
import { comboIdleCheck, comboRequest, planCombo, startCombo, stopCombo } from '../src/combo.mjs';
import { defaultTuning, stopEngine } from '../src/engine.mjs';
import { setGpuSampler } from '../src/hardware.mjs';
import { unloadIfIdle } from '../src/idle.mjs';
import { DIRS } from '../src/paths.mjs';
import { _setPeers } from '../src/peers.mjs';
import { makePlan } from '../src/planner.mjs';
import { getState, update } from '../src/state.mjs';
import { voiceFamilyById } from '../src/voice-models.mjs';
import { startVoice, stopVoice, voiceActivity } from '../src/voice.mjs';

// Un combo sur une 3090 simulée : un 27B de 13,4 Go à côté de Qwen3-TTS 1.7B, comme sur le PC 2.
// Faux llama-server (tests/helpers) et faux vLLM-Omni ; la carte compte les poids, le cache du
// contexte de chaque moteur chargé et la voix quand elle tourne.

const FAKE = fileURLToPath(new URL('./helpers/fake-llama-server.mjs', import.meta.url));
const MiB = 2 ** 20;
const HARDWARE = {
  os: { platform: 'linux' }, cpu: { physical: 8, model: 'x' }, ramGiB: 64, freeRamGiB: 48, diskFreeGiB: 500, gitBash: true, buildTools: null, python: null,
  primary: { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3090', vramMiB: 24576, freeMiB: 23500, cuda: '12.4', computeCapability: 8.6 },
  gpus: [], vramGiB: 24,
};
const KV = { f16: 69_632, q8_0: 36_992, q4_0: 19_584 };
const weights = new Map();
const VOICE_MIB = 5300;

function sampler() {
  let used = 1000;
  for (const engine of Object.values(getState().engines ?? {})) {
    if (engine.status !== 'ready' && engine.status !== 'loading') continue;
    const args = engine.args ?? [];
    const context = Number(args[args.indexOf('-c') + 1]) || 0;
    const kv = args[args.indexOf('--cache-type-k') + 1] ?? 'f16';
    used += (weights.get(engine.modelId) ?? 12000) + 1000 + context * KV[kv] / MiB;
  }
  if (voiceActivity().running) used += VOICE_MIB;
  return { util: 0, usedMiB: used, freeMiB: Math.round(24576 - used), totalMiB: 24576, powerW: 100, tempC: 40, pstate: 'P2', smMHz: 1800 };
}

function addModel(id, weightsMiB, context, kv = 'q8_0') {
  const base = modelById('swift15-q27-iq3s-mtp');
  MODELS.push({ ...base, id, name: id, variant: null, files: [{ name: 'm.gguf', bytes: weightsMiB * MiB }], mmproj: null, dflash: null, vision: false, kvBytesPerToken: KV });
  const dir = path.join(DIRS.models, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'm.gguf'), 'GGUF');
  writeFileSync(path.join(dir, 'm.gguf.fake.json'), JSON.stringify({ tps: 90 }));
  weights.set(id, weightsMiB);
  const model = modelById(id);
  update((s) => {
    s.models[id] = { installedAt: new Date().toISOString(), files: ['m.gguf'] };
    (s.profiles[id] ??= {}).tuning = { ...defaultTuning(model, context, HARDWARE, kv), layers: 'all' };
  });
  return model;
}

// Le faux vLLM-Omni : il note sa deploy-config et répond à /health.
async function fakeVoiceEngine() {
  const dir = path.join(DIRS.runtime, 'vllm-omni');
  const venv = path.join(dir, 'venv');
  await mkdir(path.join(venv, 'bin'), { recursive: true });
  await mkdir(path.join(venv, 'lib', 'python3.12', 'site-packages', 'vllm_omni', 'deploy'), { recursive: true });
  const record = path.join(dir, 'record.json');
  await writeFile(path.join(venv, 'bin', 'vllm'), `#!${process.execPath}
const http = require('node:http'); const fs = require('node:fs');
const args = process.argv.slice(2); const port = Number(args[args.indexOf('--port') + 1]);
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ config: fs.readFileSync(args[args.indexOf('--deploy-config') + 1], 'utf8') }));
http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('ok'); }); }).listen(port, '127.0.0.1');
`);
  await chmod(path.join(venv, 'bin', 'vllm'), 0o755);
  for (const id of ['qwen3-tts-1.7b-base', 'qwen3-tts-0.6b-base']) await mkdir(path.join(DIRS.models, 'voice', id), { recursive: true });
  update((s) => {
    s.runtimes['vllm-omni'] = { kind: 'vllm-omni', dir, venv, installedAt: 'x' };
    s.voice = { models: Object.fromEntries(['qwen3-tts-1.7b-base', 'qwen3-tts-0.6b-base'].map((id) => [id, { installedAt: 'x', path: path.join(DIRS.models, 'voice', id) }])) };
  });
  return record;
}

let record;
before(async () => {
  const dir = path.join(DIRS.runtime, 'llama', 'fake');
  mkdirSync(dir, { recursive: true });
  setGpuSampler(async () => sampler());
  update((s) => {
    s.hardware = HARDWARE;
    s.plan = makePlan(HARDWARE);
    s.vramBaselineMiB = 1000;
    s.runtimes['llama-cuda12'] = { kind: 'llama', backend: 'cuda12', tag: 'fake', dir, serverPath: process.execPath, serverArgs: [FAKE] };
  });
  record = await fakeVoiceEngine();
  addModel('c-27b', 13700, 131072);
  addModel('c-8b', 3000, 65536);
  addModel('c-gros', 9000, 32768);
  addModel('c-f16', 13700, 131072, 'f16');
});
after(async () => { await stopCombo(); await stopVoice(); await stopEngine(); });

const LIMIT = { timeout: 90_000 };
const contextOf = (id) => { const args = getState().engines[id]?.args ?? []; return Number(args[args.indexOf('-c') + 1]); };

test('plan : le contexte du texte cède pour laisser la place à la voix, refusé sous le contexte demandé', LIMIT, async () => {
  const plan = await planCombo(['c-27b', 'qwen3-tts-1.7b-base']);
  assert.equal(plan.ok, true);
  const [text, voice] = plan.models;
  // 24 576 − 1 000 (bureau) − 1 536 (marge) − 5 500 (voix en fp8) : ~28k de contexte en q8_0.
  assert.deepEqual({ kind: voice.kind, compact: voice.compact, needMiB: voice.needMiB }, { kind: 'voice', compact: true, needMiB: 5500 });
  assert.equal(text.context, 28672);
  assert.equal(text.benchContext, 131072);
  assert.ok(plan.budget.spareMiB >= 0);

  const tight = await planCombo(['c-27b', 'qwen3-tts-1.7b-base'], { minContext: 65536 });
  assert.equal(tight.ok, false);
  assert.match(tight.problem, /Il manque .* Go/);

  // Deux modèles de texte : le plus large cède d'abord.
  const pair = await planCombo(['c-27b', 'c-8b']);
  assert.equal(pair.ok, true);
  const [a, b] = pair.models.map((m) => m.context);
  assert.ok(a < 65536 && b < 65536 && Math.abs(a - b) <= 4096 && Math.min(a, b) >= 16384, JSON.stringify([a, b]));

  await assert.rejects(planCombo(['qwen3-tts-1.7b-base', 'qwen3-tts-0.6b-base']), /Une seule voix/);
  await assert.rejects(planCombo(['c-27b']), /deux modèles/);
  await assert.rejects(planCombo(['c-27b', 'inconnu']), (error) => error.status === 404);
});

test('plan : un cache f16 qu’il faudrait raccourcir passe en q8_0 s’il laisse plus de contexte', LIMIT, async () => {
  const plan = await planCombo(['c-f16', 'qwen3-tts-1.7b-base']);
  assert.equal(plan.ok, true);
  const text = plan.models.find((m) => m.kind === 'text');
  assert.equal(text.kv, 'q8_0');
  assert.equal(text.tuning.kvV, 'q8_0');
  assert.equal(text.context, 28672);
  // Un modèle qui tient avec son cache du banc le garde.
  const roomy = await planCombo(['c-8b', 'qwen3-tts-1.7b-base']);
  assert.equal(roomy.models.find((m) => m.kind === 'text').kv, 'q8_0');
});

test('combo : voix en fp8 puis texte au contexte du plan ; ce qui les déchargerait est refusé', LIMIT, async () => {
  const report = await startCombo(['c-27b', 'qwen3-tts-1.7b-base']);
  assert.equal(report.combo.status, 'ready');
  assert.equal(voiceActivity().running, 'qwen3-tts-1.7b-base');
  assert.equal(voiceActivity().compact, true);
  const { config } = JSON.parse(await readFile(record, 'utf8'));
  assert.match(config, /stage_id: 0\n {4}max_num_seqs: 1\n {4}gpu_memory_utilization: 0.140\n {4}quantization: fp8\n {4}max_model_len: 2048\n {2}- stage_id: 1/);
  assert.equal(contextOf('c-27b'), 28672);
  assert.equal(getState().engines['c-27b'].slots ?? 1, 1);

  // Un autre modèle qui ne tient pas à côté : refusé, le combo reste entier.
  await assert.rejects(activate('c-gros'), (error) => error.status === 409 && /combo/.test(error.message));
  assert.equal(getState().engines['c-27b']?.status, 'ready');
  // Une autre voix : refusée aussi.
  await assert.rejects(startVoice({ here: true, model: 'qwen3-tts-0.6b-base' }), (error) => error.status === 409);
  assert.equal(voiceActivity().running, 'qwen3-tts-1.7b-base');
  // Les images et le banc attendent la fin du combo.
  const { tuneModel } = await import('../src/bench.mjs');
  await assert.rejects(tuneModel('c-8b'), (error) => error.status === 409);
  // Le même combo redemandé : rien ne bouge. Un autre : refusé.
  assert.equal((await startCombo(['qwen3-tts-1.7b-base', 'c-27b'])).combo.status, 'ready');
  await assert.rejects(startCombo(['c-8b', 'qwen3-tts-1.7b-base']), /tient déjà la carte/);

  // L'inactivité de chaque modèle ne les sépare pas ; celle du combo entier l'arrête.
  await unloadIfIdle(Date.now() + 60 * 60_000);
  assert.equal(getState().engines['c-27b']?.status, 'ready');
  assert.equal(await comboIdleCheck(Date.now() + 5 * 60_000), false);
  assert.equal(await comboIdleCheck(Date.now() + 16 * 60_000), true);
  assert.equal(getState().combo, null);
  assert.equal(getState().engines['c-27b'], undefined);
  assert.equal(voiceActivity().running, null);
});

test('combo de deux modèles de texte, puis arrêt : les autres modèles reprennent leurs droits', LIMIT, async () => {
  await startCombo(['c-27b', 'c-8b'], { idleMinutes: 0 });
  assert.equal(getState().engines['c-27b']?.status, 'ready');
  assert.equal(getState().engines['c-8b']?.status, 'ready');
  await assert.rejects(activate('c-gros'), (error) => error.status === 409);
  assert.equal(await comboIdleCheck(Date.now() + 10 * 60 * 60_000), false);
  await comboRequest('stop', { unload: false });
  // Sans réserve : le gros modèle fait de la place comme d'habitude.
  await activate('c-gros');
  assert.equal(getState().engines['c-gros']?.status, 'ready');
  await stopEngine();
});

test('combo d’une autre machine : relayé tel quel, sans le suffixe ; pas de mélange de machines', LIMIT, async (t) => {
  const received = [];
  const server = await new Promise((resolve) => {
    const s = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      received.push({ method: req.method, url: req.url, auth: req.headers.authorization, hop: req.headers['x-harn-hop'], body: chunks.length ? JSON.parse(Buffer.concat(chunks)) : null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ combo: { status: 'ready', models: [] } }));
    }).listen(0, '127.0.0.1', () => resolve(s));
  });
  t.after(() => { server.closeAllConnections(); server.close(); _setPeers([]); });
  _setPeers([{ id: 'pc2', name: 'pc2', url: `http://127.0.0.1:${server.address().port}/v1`, key: 'sk-pc2' }]);

  const answer = await comboRequest('start', { models: ['c-27b@pc2', 'qwen3-tts-1.7b-base@pc2'], minContext: 32768 });
  assert.equal(answer.machine, 'pc2');
  assert.deepEqual(received[0], { method: 'POST', url: '/v1/combos/start', auth: 'Bearer sk-pc2', hop: '1', body: { models: ['c-27b', 'qwen3-tts-1.7b-base'], minContext: 32768 } });
  await comboRequest('stop', { machine: 'pc2' });
  assert.deepEqual([received[1].method, received[1].url], ['POST', '/v1/combos/stop']);
  await comboRequest('status', { machine: 'pc2' });
  assert.deepEqual([received[2].method, received[2].url], ['GET', '/v1/combos']);

  await assert.rejects(comboRequest('start', { models: ['c-27b', 'qwen3-tts-1.7b-base@pc2'] }), (error) => error.status === 400 && /une seule carte/.test(error.message));
  await assert.rejects(comboRequest('start', { models: ['c-27b@pc2', 'c-8b@pc2'] }, { hopped: true }), (error) => error.status === 400);
  assert.equal(getState().combo, null);
});

test('voix compacte : seulement pour le 1.7B de Qwen3-TTS, profil d’origine sinon', () => {
  const family = voiceFamilyById('qwen3-tts');
  assert.equal(family.compact({ size: '0b6' }), null);
  const compact = family.compact({ size: '1b7' });
  assert.deepEqual(compact.stage0, { quantization: 'fp8', max_model_len: 2048 });
  assert.doesNotMatch(family.deploy({ share: ['0.2', '0.06'], deployDir: '/d' }), /quantization/);
});
