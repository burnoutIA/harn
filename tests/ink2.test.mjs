import './helpers/home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import path from 'node:path';
import { modelById, ownLauncher } from '../src/catalog.mjs';
import { describe } from '../src/engine.mjs';
import { shapeRequest } from '../src/gateway.mjs';
import { INK2_ARMS, recipeFor, startingTuning } from '../src/loading.mjs';
import { DIRS, PORTS } from '../src/paths.mjs';
import { assess } from '../src/planner.mjs';
import { INK2 } from '../src/runtimes.mjs';
import { update } from '../src/state.mjs';

const model = modelById('inkling-2-mini-ink2');
const card = (name, vram, vendor) => ({ vramGiB: vram, ramGiB: 64, diskFreeGiB: 500, os: { platform: 'linux' }, primary: { vendor, name, vramMiB: vram * 1024, computeCapability: 8.6 } });

test('moteur sur mesure d’Inkling : une Radeon RDNA4 de 24 Go ou plus, sous Linux', () => {
  const ok = assess(model, card('AMD Radeon AI PRO R9700', 31.8, 'amd'));
  assert.deepEqual([ok.fit, ok.context], ['full', 131072]);
  assert.match(assess(model, card('NVIDIA GeForce RTX 3090', 24, 'nvidia')).reasons.join(), /RDNA4/);
  assert.match(assess(model, card('AMD Radeon RX 9070 XT', 16, 'amd')).reasons.join(), /24 Go/);
  assert.equal(assess(model, { ...card('AMD Radeon AI PRO R9700', 31.8, 'amd'), os: { platform: 'win32' } }).fit, 'no');
});

test('fiche : checkpoint officiel aux empreintes figées, moteur à un commit figé', () => {
  assert.ok(ownLauncher(model));
  assert.ok(model.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256) && file.bytes > 0));
  assert.deepEqual(model.files.map((f) => f.name).sort(), ['chat_template.jinja', 'model-00001-of-00001.safetensors', 'mtp.safetensors', 'tokenizer.json']);
  assert.match(INK2.commit, /^[0-9a-f]{40}$/);
});

test('lancement : la façade OpenAI devant strata-ink2, avec la clé du moteur et l’id Harn', () => {
  update((s) => { s.runtimes.ink2 = { python: '/r/venv/bin/python', server: '/r/outils/serveur.py', engine: '/r/build/strata-ink2', dir: '/r' }; });
  const tuning = startingTuning(model, {});
  assert.equal(describe(tuning), INK2_ARMS.plain.ink2Arm);
  const plain = recipeFor(model, tuning);
  const arg = (recipe, flag) => recipe.args[recipe.args.indexOf(flag) + 1];
  assert.equal(plain.command, '/r/venv/bin/python');
  assert.equal(arg(plain, '--model'), path.join(DIRS.models, model.id));
  assert.equal(arg(plain, '--engine'), '/r/build/strata-ink2');
  assert.equal(arg(plain, '--alias'), model.id);
  assert.equal(arg(plain, '--ctx'), '131072');
  assert.equal(arg(plain, '--port'), String(PORTS.ink2));
  assert.ok(arg(plain, '--api-key-file').endsWith('engine.key'));
  assert.ok(!plain.args.includes('--spec'));
  assert.equal(plain.health, `http://127.0.0.1:${PORTS.ink2}/health`);
  assert.ok(recipeFor(model, INK2_ARMS.drafter).args.includes('--spec'));
});

test('passerelle : l’effort passe dans le gabarit, « none » compris', () => {
  assert.equal(shapeRequest({ messages: [], reasoning_effort: 'none' }, model).chat_template_kwargs.reasoning_effort, 'none');
  assert.equal(shapeRequest({ messages: [], reasoning_effort: 'high' }, model).chat_template_kwargs.reasoning_effort, 'xhigh');
  assert.equal(shapeRequest({ messages: [] }, model).chat_template_kwargs.reasoning_effort, 'medium');
});
