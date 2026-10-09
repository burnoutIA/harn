import assert from 'node:assert/strict';
import test from 'node:test';
import { modelById } from '../src/catalog.mjs';
import { outputBudget, thinkingStyle } from '../src/output-budget.mjs';

const qwen = modelById('qwen3-8-27b-gguf-ud-q4-k-m');
const swift = modelById('swift15-q27-iq3s-mtp');

test('style de réflexion : Qwen officiel long, Swift normal', () => {
  assert.equal(thinkingStyle(qwen), 'long');
  assert.equal(thinkingStyle(swift), 'normal');
  assert.equal(thinkingStyle(swift, { verbosity: { label: 'bavard' } }), 'long');
});

test('sans mesure : l’a priori de la famille', () => {
  const b = outputBudget(qwen, 131072);
  assert.equal(b.maxTokens, 81920);
  assert.equal(b.reserve, 40960);
  assert.equal(outputBudget(swift, 153600).maxTokens, 32768);
});

test('coupé à la limite : sortie et réserve montent', () => {
  const b = outputBudget(qwen, 131072, { runs: 110, p99: 32768, max: 32768, cut: 3, cutAt: 32768 });
  assert.equal(b.maxTokens, 81920);                 // a priori long, les 3/4 du contexte en dessus
  assert.ok(b.reserve > 40000 && b.reserve <= 131072 / 3 + 1024);
});

test('beaucoup de réponses courtes : la réserve reste petite, la sortie généreuse', () => {
  const b = outputBudget(swift, 153600, { runs: 300, p99: 8000, max: 14000, cut: 0, cutAt: 0 });
  assert.equal(b.maxTokens, 32768);
  assert.equal(b.reserve, 16384);
});

test('petit contexte : jamais plus des 3/4 en sortie ni d’un tiers en réserve', () => {
  const b = outputBudget(qwen, 16384);
  assert.equal(b.maxTokens, 12288);
  assert.ok(b.reserve <= 6144);
});
