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

test('sous Linux : Strata proposé comme sous Windows', () => {
  const linux = makePlan({ ...machine(24, 128), os: { platform: 'linux' } });
  const windows = makePlan({ ...machine(24, 128), os: { platform: 'win32' } });
  assert.equal(linux.upgradeModel, windows.upgradeModel);
  assert.ok(linux.verdicts.some((v) => /strata/.test(v.id) && v.fit !== 'no'));
});

test('sous Linux sans Python venv : Strata hors de portée, avec la commande à lancer', () => {
  const plan = makePlan({ ...machine(24, 128), os: { platform: 'linux' }, python: { ok: false } });
  const strata = plan.verdicts.filter((v) => /strata/.test(v.id));
  assert.ok(strata.every((v) => v.fit === 'no' && v.reasons.some((r) => /python3-venv/.test(r))));
});

test('sous macOS : pas de Strata', () => {
  const plan = makePlan({ ...machine(24, 128), os: { platform: 'darwin' } });
  assert.ok(plan.verdicts.filter((v) => /strata/.test(v.id)).every((v) => v.fit === 'no'));
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
  // 32 Go suffisent sur une 3090 (mode faible RAM de Strata : la carte garde 19 Go d'experts) ;
  // avec 16 Go, seul le Coder (moitié des experts) passe encore.
  assert.equal(makePlan(machine(24, 32)).upgradeModel, 'swift15-flashnext-iq2xs-strata');
  assert.doesNotMatch(makePlan(machine(24, 16)).upgradeModel ?? '', /swift15-flashnext/);
  assert.equal(makePlan(machine(24, 16)).firstModel, 'swift15-q27-iq3s-mtp');
});

test('Strata en mode faible RAM : 5060 Ti 16 Go + 32 Go, experts en partie sur le SSD', () => {
  const m = machine(16, 31.8);
  const plan = makePlan({ ...m, vramGiB: 15.9, primary: { ...m.primary, name: 'NVIDIA GeForce RTX 5060 Ti', computeCapability: 12.0 } });
  const iq2 = plan.verdicts.find((v) => v.id === 'swift15-flashnext-iq2xs-strata');
  assert.equal(iq2.fit, 'full');
  assert.ok(iq2.tps >= 45 && iq2.tps <= 55);  // 50 tok/s mesurés
  assert.equal(plan.verdicts.find((v) => v.id === 'swift15-flashnext-iq3xxs-strata').fit, 'no');
  assert.match(plan.advice, /48 Go.*IQ3_XXS/);
  assert.equal(makePlan(machine(12, 32)).verdicts.find((v) => v.id === 'swift15-flashnext-iq2xs-strata').fit, 'no');
  // Le Coder (23,4 Go d'experts) tient en RAM avec 32 Go, sans SSD.
  assert.equal(plan.verdicts.find((v) => v.id === 'flashnext-coder-iq1m-strata').fit, 'full');
  assert.equal(makePlan(machine(12, 32)).verdicts.find((v) => v.id === 'flashnext-coder-iq1m-strata').fit, 'full');
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
  const m = machine(24, 16);
  const target = makePlan(m).targetModel;
  // Un modèle testé plus bas que son estimation perd sa place.
  const plan = makePlan(m, { [target]: 60 });
  assert.notEqual(plan.targetModel, target);
  assert.equal(plan.verdicts.find((v) => v.id === target).tested, true);
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

test('toutes les couches sur la carte, --fit seulement pour un modèle partagé', async () => {
  const { defaultTuning, llamaArgs } = await import('../src/engine.mjs');
  const model = modelById('swift15-q27-iq3s-mtp');
  const hw = machine(24, 64);
  const files = { model: 'm.gguf' };
  const full = llamaArgs(model, files, defaultTuning(model, 131072, hw), hw);
  assert.equal(full[full.indexOf('-ngl') + 1], '999');
  assert.equal(full[full.indexOf('--fit') + 1], 'off');
  const shared = llamaArgs(model, files, { ...defaultTuning(model, 131072, hw), layers: 'auto', fitTargetMiB: 1792 }, hw);
  assert.equal(shared[shared.indexOf('-ngl') + 1], 'auto');
  // Réglage enregistré avant le champ `layers` : cible --fit relevée = modèle partagé.
  const legacy = llamaArgs(model, files, { ...defaultTuning(model, 131072, hw), layers: undefined, fitTargetMiB: 1792 }, hw);
  assert.equal(legacy[legacy.indexOf('-ngl') + 1], 'auto');
});

test('llamAmpere : KV K/V distincts, cache de prompts aligné sur l’officiel', async () => {
  const { defaultTuning, describe, llamaArgs } = await import('../src/engine.mjs');
  const model = modelById('swift15-q27-iq3s-mtp');
  const hw = machine(24, 64);
  const tuning = { ...defaultTuning(model, 131072, hw), fork: 'llamampere', kv: 'tq5_0', kvV: 'turbo4' };
  const args = llamaArgs(model, { model: 'm.gguf' }, tuning, hw);
  assert.equal(args[args.indexOf('--cache-type-k') + 1], 'tq5_0');
  assert.equal(args[args.indexOf('--cache-type-v') + 1], 'turbo4');
  assert.ok(args.includes('--no-cache-disk'));
  assert.match(describe(tuning), /KV tq5_0\/turbo4.*llamAmpere/);
});

test('llamAmpere proposé seulement aux RTX 30 sous Linux avec les outils', async () => {
  const { llamAmpereEligible } = await import('../src/levers.mjs');
  const tools = { ok: true, nvcc: '12.4', cmake: true, hostCompiler: 'g++-13' };
  assert.ok(llamAmpereEligible({ ...machine(24, 64), os: { platform: 'linux' }, buildTools: tools }));
  assert.ok(!llamAmpereEligible({ ...machine(24, 64), os: { platform: 'win32' }, buildTools: tools }));
  assert.ok(!llamAmpereEligible({ ...machine(24, 64), os: { platform: 'linux' }, buildTools: { ...tools, ok: false } }));
});

test('échec de chargement : architecture inconnue = définitif, manque de mémoire = on réessaie', async () => {
  const { loadFailure } = await import('../src/engine.mjs');
  assert.match(loadFailure("E llama_model_load: error loading model: unknown model architecture: 'xing4_0'\n", 'Xing4'), /architecture « xing4_0 » de Xing4/);
  assert.equal(loadFailure('E ggml_backend_cuda_buffer_type_alloc_buffer: allocating 2048 MiB on device 0: cudaMalloc failed: out of memory\nE llama_model_load: error loading model: failed to allocate buffer\n'), null);
  assert.equal(loadFailure('I srv llama_server: model loaded\n'), null);
});

test('architectures d’un moteur lues dans llama-arch.cpp', async () => {
  const { parseArchs } = await import('../src/engines.mjs');
  const source = 'static const std::map<llm_arch, const char *> LLM_ARCH_NAMES = {\n    { LLM_ARCH_LLAMA,  "llama" },\n    { LLM_ARCH_QWEN35, "qwen35" },\n    { LLM_ARCH_UNKNOWN, "(unknown)" },\n};';
  assert.deepEqual(parseArchs(source), ['llama', 'qwen35', '(unknown)']);
});

test('fiches moteur : llamAmpere proposé au banc sur RTX 30 Linux, l’officiel face à un fork', async () => {
  const { alternates } = await import('../src/engines.mjs');
  const { gpuProfile } = await import('../src/levers.mjs');
  const model = modelById('swift15-q27-iq3s-mtp');
  const tools = { ok: true, nvcc: '12.4', cmake: true, hostCompiler: 'g++-13' };
  const linux = { ...machine(24, 64), os: { platform: 'linux' }, buildTools: tools };
  const profile = gpuProfile(linux);
  const official = { context: 131072, backend: 'cuda12', kv: 'q8_0', spec: { type: 'mtp', n: 3, pMin: 0 } };

  const fromOfficial = await alternates(model, official, profile, linux);
  assert.deepEqual(fromOfficial.map((a) => a.id), ['llamampere']);
  const [compressed, plain] = fromOfficial[0].arms('cuda12');
  assert.equal(compressed.fork, 'llamampere');
  assert.equal(compressed.kvV, 'turbo4');
  assert.equal(plain.spec.n, 'auto');

  const fromFork = await alternates(model, { ...compressed }, profile, linux);
  assert.deepEqual(fromFork.map((a) => a.id), ['llama']);
  const [back] = fromFork[0].arms('cuda12');
  assert.equal(back.fork, undefined);
  assert.equal(back.kv, 'q8_0');
  assert.equal(back.kvV, undefined);
  assert.equal(typeof back.spec.n, 'number');

  assert.deepEqual(await alternates(model, official, profile, { ...linux, os: { platform: 'win32' } }), []);
  assert.deepEqual(await alternates({ ...model, engine: 'prism' }, official, profile, linux), []);
});

test('GGUF qui annonce une couche MTP absente : métadonnée corrigée, sans anticipation', async () => {
  const { defaultTuning, llamaArgs } = await import('../src/engine.mjs');
  const model = { ...modelById('swift15-q27-iq3s-mtp'), profile: { arch: 'xing4_0', mtp: true } };
  const hw = machine(24, 64);
  const args = llamaArgs(model, { model: 'm.gguf' }, { ...defaultTuning(model, 131072, hw), noNextn: true }, hw);
  assert.equal(args[args.indexOf('--override-kv') + 1], 'xing4_0.nextn_predict_layers=int:0');
  assert.equal(args[args.indexOf('--spec-type') + 1], 'none');
});
