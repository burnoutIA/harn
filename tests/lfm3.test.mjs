import './helpers/home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { modelById, ownLauncher } from '../src/catalog.mjs';
import { describe } from '../src/engine.mjs';
import { shapeRequest } from '../src/gateway.mjs';
import { LFM3_TUNING, recipeFor, startingTuning } from '../src/loading.mjs';
import { DIRS, PORTS } from '../src/paths.mjs';
import { assess } from '../src/planner.mjs';
import { LFM3 } from '../src/runtimes.mjs';
import { update } from '../src/state.mjs';

const model = modelById('lfm3-1-7b-qad-lfm3');
const card = (name, vram, vendor) => ({ vramGiB: vram, ramGiB: 32, diskFreeGiB: 500, os: { platform: 'linux' }, primary: { vendor, name, vramMiB: vram * 1024, computeCapability: 8.6 } });

test('moteur sur mesure de LFM3 : une Radeon RDNA4 ou une RTX série 30, 131k dès 8 Go', () => {
  const ok = assess(model, card('AMD Radeon RX 9060 XT', 16, 'amd'));
  assert.deepEqual([ok.fit, ok.context], ['full', 131072]);
  const tools = { nvcc: '13.4', hostCompiler: 'g++', cmake: true, ok: true };
  const rtx = assess(model, { ...card('NVIDIA GeForce RTX 3060', 12, 'nvidia'), buildTools: tools });
  assert.deepEqual([rtx.fit, rtx.context], ['full', 131072]);
  assert.match(assess(model, card('AMD Radeon RX 7900 XTX', 24, 'amd')).reasons.join(), /RDNA4/);
  assert.equal(assess(model, { ...card('AMD Radeon AI PRO R9700', 31.8, 'amd'), os: { platform: 'win32' } }).fit, 'no');
});

test('fiche : le Q4_0 QAD et le tokenizer du modèle, aux empreintes figées ; moteur à un commit figé', () => {
  assert.ok(ownLauncher(model));
  assert.ok(model.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256) && file.bytes > 0));
  assert.deepEqual(model.files.map((f) => f.repo ?? model.repo), ['LiquidAI/LFM3-1.7B-GGUF', 'LiquidAI/LFM3-1.7B', 'LiquidAI/LFM3-1.7B']);
  assert.equal(model.files[0].name, 'LFM3-1.7B-QAD-Q4_0.gguf');
  assert.match(LFM3.commit, /^[0-9a-f]{40}$/);
});

test('lancement : la façade OpenAI devant lfm3-engine, le GGUF là où il est', () => {
  update((s) => { s.runtimes.lfm3 = { python: '/r/venv/bin/python', server: '/r/outils/serveur.py', engine: '/r/build/lfm3-engine', dir: '/r' }; });
  const tuning = startingTuning(model, {});
  assert.equal(describe(tuning), LFM3_TUNING.lfm3Arm);
  const arg = (recipe, flag) => recipe.args[recipe.args.indexOf(flag) + 1];
  const plain = recipeFor(model, tuning);
  assert.equal(plain.command, '/r/venv/bin/python');
  assert.equal(arg(plain, '--model'), path.join(DIRS.models, model.id));
  assert.equal(arg(plain, '--gguf'), path.join(DIRS.models, model.id, 'LFM3-1.7B-QAD-Q4_0.gguf'));
  assert.equal(arg(plain, '--engine'), '/r/build/lfm3-engine');
  assert.equal(arg(plain, '--alias'), model.id);
  assert.equal(arg(plain, '--ctx'), '131072');
  assert.equal(arg(plain, '--port'), String(PORTS.lfm3));
  assert.ok(arg(plain, '--api-key-file').endsWith('engine.key'));
  assert.equal(plain.health, `http://127.0.0.1:${PORTS.lfm3}/health`);
  // Une copie reprise ailleurs (lien vers le GGUF d'une autre fiche) : son vrai chemin.
  update((s) => { s.models[model.id] = { paths: { 'LFM3-1.7B-QAD-Q4_0.gguf': '/ailleurs/LFM3-1.7B-QAD-Q4_0.gguf' } }; });
  assert.equal(arg(recipeFor(model, tuning), '--gguf'), '/ailleurs/LFM3-1.7B-QAD-Q4_0.gguf');
});

test('passerelle : « none » coupe le raisonnement par enable_thinking', () => {
  assert.equal(shapeRequest({ messages: [], reasoning_effort: 'none' }, model).chat_template_kwargs.enable_thinking, false);
  assert.equal(shapeRequest({ messages: [] }, model).chat_template_kwargs.reasoning_effort, 'medium');
});
