import './helpers/home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { addViewer, beginRequest, endRequest, getLive } from '../src/metrics.mjs';

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
