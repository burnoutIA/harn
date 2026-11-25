import './helpers/home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { modelById, ownLauncher } from '../src/catalog.mjs';
import { prefersDspark } from '../src/bench.mjs';
import { describe } from '../src/engine.mjs';
import { shapeRequest } from '../src/gateway.mjs';
import { STRATA_INKLING_ARMS, recipeFor, startingTuning } from '../src/loading.mjs';
import { DIRS, PORTS } from '../src/paths.mjs';
import { assess } from '../src/planner.mjs';
import { STRATA_INKLING } from '../src/runtimes.mjs';
import { update } from '../src/state.mjs';

const sq10 = modelById('inkling-2-mini-sq-10');
const sq20 = modelById('inkling-2-mini-sq-20');
const card = (name, vram, vendor) => ({ vramGiB: vram, ramGiB: 64, diskFreeGiB: 500, os: { platform: 'linux' }, primary: { vendor, name, vramMiB: vram * 1024, computeCapability: 8.6 } });
const tools = { nvcc: '13.4', hostCompiler: 'g++', cmake: true, ok: true };

test('Strata pour Inkling : SQ-10 dès 16 Go, SQ-20 sur 24 Go ; RDNA4 ou RTX série 30, Linux, cmake', () => {
  assert.deepEqual([assess(sq10, card('AMD Radeon AI PRO R9700', 31.8, 'amd')).fit, assess(sq20, card('AMD Radeon AI PRO R9700', 31.8, 'amd')).fit], ['full', 'full']);
  assert.equal(assess(sq10, { ...card('NVIDIA GeForce RTX 4060 Ti', 16, 'nvidia'), buildTools: tools }).context, 131072);
  assert.equal(assess(sq20, { ...card('NVIDIA GeForce RTX 4060 Ti', 16, 'nvidia'), buildTools: tools }).fit, 'no');
  assert.equal(assess(sq20, { ...card('NVIDIA GeForce RTX 3090', 24, 'nvidia'), buildTools: tools }).fit, 'full');
  assert.match(assess(sq20, { ...card('NVIDIA GeForce RTX 3090', 24, 'nvidia'), buildTools: { ...tools, cmake: false } }).reasons.join(), /cmake/);
  assert.match(assess(sq10, card('AMD Radeon RX 7900 XTX', 24, 'amd')).reasons.join(), /RDNA4/);
  assert.equal(assess(sq10, { ...card('AMD Radeon AI PRO R9700', 31.8, 'amd'), os: { platform: 'win32' } }).fit, 'no');
});

test('fiches : le pack, l’encodeur d’image, le tokenizer et le gabarit aux empreintes figées ; Strata à un commit figé', () => {
  for (const model of [sq10, sq20]) {
    assert.ok(ownLauncher(model));
    assert.ok(model.files.every((file) => /^[0-9a-f]{64}$/.test(file.sha256) && file.bytes > 0));
    assert.deepEqual(model.files.map((f) => f.name).slice(1), ['Inkling-2-Mini-Vision.strata', 'tokenizer.json', 'chat_template.jinja']);
    assert.equal(model.files[0].name, model.strataFile);
    assert.ok(model.vision && model.strataVision);
    // Pas un Flash-Next ajouté : strataPack voudrait dire « préparer un pack avec iq_pack ».
    assert.equal(model.strataPack, undefined);
  }
  assert.match(STRATA_INKLING.commit, /^[0-9a-f]{40}$/);
});

test('lancement : server.py de Strata avec une config écrite pour ce modèle et ce réglage', () => {
  update((s) => { s.runtimes['strata-inkling'] = { python: '/r/venv/bin/python', server: '/r/src/terminal/serve/server.py', engine: '/r/src/engine/b/strata-inkling', dir: path.join(DIRS.runtime, 'strata-inkling'), libDirs: [], backend: 'hip' }; });
  const tuning = startingTuning(sq10, {});
  assert.equal(describe(tuning), STRATA_INKLING_ARMS.plain.strataInklingArm);
  const arg = (recipe, flag) => recipe.args[recipe.args.indexOf(flag) + 1];
  const plain = recipeFor(sq10, tuning);
  assert.equal(plain.command, '/r/venv/bin/python');
  assert.equal(plain.args[0], '-I');
  assert.equal(arg(plain, '--engine'), 'strata');
  assert.equal(arg(plain, '--port'), String(PORTS.strataInkling));
  assert.ok(plain.args.includes('--offline'));
  assert.ok(plain.env.STRATA_API_KEY);
  assert.ok(!plain.args.includes(plain.env.STRATA_API_KEY), 'la clé reste hors de la ligne de commande');
  assert.equal(plain.health, `http://127.0.0.1:${PORTS.strataInkling}/v1/models`);
  const config = JSON.parse(readFileSync(arg(plain, '--config'), 'utf8'));
  assert.equal(config.exe, '/r/src/engine/b/strata-inkling');
  assert.equal(config.model_name, sq10.id);
  assert.equal(config.backend, 'hip');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.drafting, 'off');
  assert.deepEqual(config.args, ['--native', path.join(DIRS.models, sq10.id, 'Inkling-2-Mini-SQ-10.strata'), '--max-context', '131072', '--draft', 'off',
    '--vision', path.join(DIRS.models, sq10.id, 'Inkling-2-Mini-Vision.strata')]);
  // DSpark : pas de --draft off, server.py ajoute lui-même --draft dspark et ses blocs adaptatifs.
  update((s) => { s.models[sq10.id] = { paths: { 'Inkling-2-Mini-Vision.strata': '/ailleurs/Inkling-2-Mini-Vision.strata' } }; });
  const dspark = JSON.parse(readFileSync(arg(recipeFor(sq10, STRATA_INKLING_ARMS.dspark), '--config'), 'utf8'));
  assert.equal(dspark.drafting, 'dspark');
  assert.ok(!dspark.args.includes('--draft'));
  assert.equal(dspark.args[dspark.args.indexOf('--vision') + 1], '/ailleurs/Inkling-2-Mini-Vision.strata');
});

test('passerelle : le niveau de réflexion passe par chat_template_kwargs, que le dialecte Inkling de Strata lit', () => {
  assert.equal(shapeRequest({ messages: [], reasoning_effort: 'none' }, sq20).chat_template_kwargs.reasoning_effort, 'none');
  assert.equal(shapeRequest({ messages: [] }, sq20).chat_template_kwargs.reasoning_effort, 'medium');
});

test('banc : DSpark gardé quand il gagne en code, même si la prose recule un peu', () => {
  const arm = (tps, code, prose) => ({ ok: true, tps, workloads: [{ workload: 'code', tps: code }, { workload: 'prose', tps: prose }] });
  // 3090, SQ-20, 2026-11-25 : refusé par isBetter (prose −11 %).
  assert.ok(prefersDspark(arm(94.6, 124.7, 76.15), arm(83.4, 81.5, 85.45)));
  // R9700 : DSpark perd partout.
  assert.ok(!prefersDspark(arm(63, 63.1, 63), arm(69.1, 67.7, 72.75)));
  // Gain en code mais prose effondrée.
  assert.ok(!prefersDspark(arm(95, 130, 60), arm(83, 81, 85)));
  assert.ok(!prefersDspark({ ok: false, error: 'mort' }, arm(83, 81, 85)));
});
