import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { fitContext } from '../src/gateway.mjs';

// Un faux vLLM : /tokenize compte 50 700 tokens sur un contexte de 131 072.
const fakeVllm = (count) => new Promise((resolve) => {
  const server = http.createServer(async (req, res) => {
    for await (const _ of req) { /* corps lu */ }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ count, max_model_len: 131072 }));
  }).listen(0, '127.0.0.1', () => resolve(server));
});

test('vLLM : max_tokens ramené à la vraie place quand l’estimation du client était courte', async (t) => {
  const server = await fakeVllm(50700);
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${server.address().port}`;
  // pi a demandé 80 453 (son estimation : 50 619 tokens de prompt).
  const fitted = await fitContext(endpoint, { model: 'm', messages: [{ role: 'user', content: 'x' }], max_tokens: 80453 });
  assert.equal(fitted.count, 50700);
  assert.equal(fitted.room, 131072 - 50700 - 16);
  assert.equal(JSON.parse(fitted.payload).max_tokens, fitted.room);
  // Pas de messages (complétion brute) : rien à faire.
  assert.equal(await fitContext(endpoint, { model: 'm', prompt: 'x', max_tokens: 10 }), null);
});

test('vLLM : prompt qui remplit presque le contexte → pas de rattrapage, le client compacte', async (t) => {
  const server = await fakeVllm(130500);
  t.after(() => server.close());
  assert.equal(await fitContext(`http://127.0.0.1:${server.address().port}`, { model: 'm', messages: [], max_tokens: 4096 }), null);
});
