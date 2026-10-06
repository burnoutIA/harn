import assert from 'node:assert/strict';
import test from 'node:test';
import { modelById } from '../src/catalog.mjs';
import { shapeRequest } from '../src/gateway.mjs';
import { makePlan, pickBackend } from '../src/planner.mjs';

const machine = (vramGiB, ramGiB, vendor = 'nvidia', cuda = '13.4') => ({
  vramGiB, ramGiB, diskFreeGiB: 500, gitBash: true, cpu: { physical: 8, model: 'x' },
  primary: vendor ? { vendor, name: { 24: 'NVIDIA GeForce RTX 3090', 16: 'NVIDIA GeForce RTX 4060 Ti', 12: 'NVIDIA GeForce RTX 5070' }[vramGiB] ?? 'gpu', vramMiB: vramGiB * 1024, cuda, computeCapability: 8.6 } : null,
});

test('moins de 8 Go de VRAM : Bonsai', () => {
  assert.match(makePlan(machine(6, 16)).firstModel, /bonsai2/);
  assert.match(makePlan(machine(0, 8, null)).firstModel, /bonsai2-1bit/);
});

test('16 Go de VRAM : le 27B GSQ-RCO qui atteint 100k', () => {
  assert.match(makePlan(machine(16, 32)).firstModel, /swift15-q27-/);
  assert.ok(makePlan(machine(16, 32)).verdicts.find((v) => v.id === makePlan(machine(16, 32)).firstModel).context >= 100 * 1024);
});

test('objectif : contexte entre 100k et 150k', () => {
  const plan = makePlan(machine(24, 32));
  const target = plan.verdicts.find((v) => v.id === plan.targetModel);
  assert.ok(target.context >= 100 * 1024 && target.context <= 150 * 1024);
});

test('petite carte + beaucoup de RAM : Flash-Next via Strata visé', () => {
  assert.match(makePlan(machine(12, 64)).targetModel, /flashnext.*strata/);
  assert.ok(makePlan(machine(12, 32)).advice);
});

test('24 Go : IQ3_S d’abord, Flash-Next Strata proposé si la RAM suit', () => {
  const plan = makePlan(machine(24, 128));
  assert.equal(plan.firstModel, 'swift15-q27-iq3s-mtp');
  // Sans mesure, la note globale estimée préfère l'IQ2_XS (bien plus rapide, à peine moins juste).
  assert.equal(plan.upgradeModel, 'swift15-flashnext-iq2xs-strata');
  assert.equal(makePlan(machine(24, 32)).upgradeModel, null);
  assert.equal(makePlan(machine(24, 32)).targetModel, 'swift15-q27-iq3s-mtp');
});

test('Strata exige NVIDIA', () => {
  const plan = makePlan(machine(24, 128, 'amd'));
  assert.equal(plan.verdicts.find((v) => v.id === 'swift15-flashnext-iq3xxs-strata').fit, 'no');
});

test('backend selon le pilote', () => {
  assert.equal(pickBackend(machine(24, 64, 'nvidia', '13.4')).id, 'cuda13');
  assert.equal(pickBackend(machine(24, 64, 'nvidia', '12.8')).id, 'cuda12');
  assert.equal(pickBackend(machine(24, 64, 'nvidia', '11.8')).id, 'vulkan');
  assert.equal(pickBackend(machine(16, 32, 'amd')).id, 'vulkan');
  assert.equal(pickBackend(machine(0, 16, null)).id, 'cpu');
});

test('raisonnement : medium par défaut, niveaux du client traduits', () => {
  const model = modelById('swift15-q27-iq3s-mtp');
  assert.equal(shapeRequest({ messages: [] }, model).chat_template_kwargs.reasoning_effort, 'medium');
  assert.equal(shapeRequest({ reasoning_effort: 'high' }, model).chat_template_kwargs.reasoning_effort, 'xhigh');
  assert.equal(shapeRequest({ reasoning_effort: 'none' }, model).chat_template_kwargs.enable_thinking, false);
  assert.equal(shapeRequest({ reasoning_effort: 'low' }, model).reasoning_effort, undefined);
  assert.equal(shapeRequest({ stream: true }, model).stream_options.include_usage, true);
});

import { gpuProfile, mtpPlan, backendCandidates } from '../src/levers.mjs';

const named = (name, cc, vram = 24, vendor = 'nvidia') => ({ vramGiB: vram, ramGiB: 64, primary: { vendor, name, vramMiB: vram * 1024, cuda: '13.4', computeCapability: cc } });

test('architecture et classe de bande passante', () => {
  assert.deepEqual([gpuProfile(named('NVIDIA GeForce RTX 5090', 12.0, 32)).arch, gpuProfile(named('NVIDIA GeForce RTX 5090', 12.0, 32)).bandwidthClass], ['blackwell', 'high']);
  assert.equal(gpuProfile(named('NVIDIA GeForce RTX 3090', 8.6)).bandwidthClass, 'mid');
  assert.equal(gpuProfile(named('NVIDIA GeForce RTX 4060 Ti', 8.9, 16)).bandwidthClass, 'low');
  assert.equal(gpuProfile(named('NVIDIA GeForce RTX 4090 Laptop GPU', 8.9, 16)).laptop, true);
  assert.equal(gpuProfile(named('NVIDIA GeForce RTX 2080', 7.5, 8)).flashAttentionUncertain, true);
});

test('MTP : seuil sur cartes lentes, pas sur cartes rapides', () => {
  assert.deepEqual(mtpPlan(gpuProfile(named('NVIDIA GeForce RTX 4060 Ti', 8.9, 16))).base, { n: 2, pMin: 0.7 });
  assert.equal(mtpPlan(gpuProfile(named('NVIDIA GeForce RTX 5090', 12.0, 32))).base.pMin, 0);
});

test('Radeon RDNA 3/4 : Vulkan et HIP mesurés', () => {
  const amd = named('AMD Radeon RX 7900 XTX', 0, 24, 'amd');
  assert.deepEqual(backendCandidates(amd, gpuProfile(amd)), ['vulkan', 'hip']);
});

test('échelle commune : le score du banc remplace la note estimée', () => {
  const m = machine(24, 32);
  assert.equal(makePlan(m).targetModel, 'swift15-q27-iq3s-mtp');
  // Un modèle testé plus bas que son estimation perd sa place.
  const plan = makePlan(m, { 'swift15-q27-iq3s-mtp': 60 });
  assert.notEqual(plan.targetModel, 'swift15-q27-iq3s-mtp');
  assert.equal(plan.verdicts.find((v) => v.id === 'swift15-q27-iq3s-mtp').tested, true);
});

test('deux modèles au même nom : on affiche ce qui les distingue', async () => {
  const { MODELS, variantOf } = await import('../src/catalog.mjs');
  const twin = (id, repo, extra = {}) => ({ id, name: 'Qwen3.8-27B', variant: 'Q4_K_M', repo, files: [], ...extra });
  const added = [twin('a', 'unsloth/Qwen3.8-27B-GGUF'), twin('b', 'bartowski/Qwen3.8-27B-GGUF'), twin('c', 'bartowski/Qwen3.8-27B-GGUF', { dflash: {} }), twin('d', 'bartowski/Qwen3.8-27B-GGUF')];
  MODELS.push(...added);
  try {
    assert.deepEqual(added.map(variantOf), ['Q4_K_M · unsloth', 'Q4_K_M · bartowski', 'Q4_K_M · bartowski · DFlash', 'Q4_K_M · bartowski · 2']);
    assert.equal(variantOf(MODELS[0]), MODELS[0].variant);
  } finally {
    MODELS.splice(MODELS.length - added.length, added.length);
  }
});

test('« Meilleur choix ici » suit la note globale mesurée, pas l’intelligence seule', () => {
  const profile = (score, tps, context) => ({ iq: { version: 3, score }, bench: { winner: { tps } }, tuning: { context } });
  // Même intelligence mesurée : le plus gros (125B) passe devant le plus rapide (27B).
  const profiles = { 'swift15-flashnext-iq3xxs-strata': profile(100, 90, 131072), 'swift15-q27-iq2xs-mtp': profile(100, 190, 153600) };
  const scores = { 'swift15-flashnext-iq3xxs-strata': 100, 'swift15-q27-iq2xs-mtp': 100 };
  assert.equal(makePlan(machine(24, 128), scores, profiles).targetModel, 'swift15-flashnext-iq3xxs-strata');
});
