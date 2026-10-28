import './helpers/home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { addViewer, beginRequest, endRequest, getLive, onChunk } from '../src/metrics.mjs';

// Strata : pas de relevé /slots, le test ne touche pas au réseau.
const start = (client) => beginRequest({ model: 'm', client, endpoint: 'http://127.0.0.1:9', engine: 'strata' });

test('deux requêtes en parallèle : le moteur n’est libre qu’après la dernière', async () => {
  const a = start('a');
  const b = start('b');
  assert.equal(getLive().running, 2);
  await endRequest(a, { error: 'test' });
  assert.equal(getLive().request, b, 'la seconde tourne encore');
  assert.equal(getLive().running, 1);
  await endRequest(b, { error: 'test' });
  assert.equal(getLive().request, null);
  assert.equal(getLive().running, 0);
  addViewer()(); // arrête le relevé GPU, sinon le test ne rend pas la main
});

test('sans /slots : le compte du moteur dans chaque morceau fait foi, sinon un token par morceau', async () => {
  const vllm = beginRequest({ model: 'm', client: 'c', endpoint: 'http://127.0.0.1:1', engine: 'hyperqwen' });
  onChunk(vllm, 3);
  onChunk(vllm, 7);
  assert.equal(vllm.decoded, 7);
  await endRequest(vllm, { usage: { completion_tokens: 7 } });
  const strata = beginRequest({ model: 'm', client: 'c', endpoint: 'http://127.0.0.1:1', engine: 'strata' });
  onChunk(strata);
  onChunk(strata);
  assert.equal(strata.decoded, 2);
  await endRequest(strata, { usage: { completion_tokens: 2 } });
  addViewer()(); // arrête le relevé GPU, sinon le test ne rend pas la main
});
