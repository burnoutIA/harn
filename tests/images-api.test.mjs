import './helpers/home.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { handleV1, setImages } from '../src/gateway.mjs';

const listen = (handler) => new Promise((resolve) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => resolve(s)); });

test('/v1/images/generations : au format d’OpenAI, l’image en base64', async () => {
  const calls = [];
  setImages({ generate: async (o) => { calls.push(o); return { b64: Buffer.from('png').toString('base64'), model: 'flux-schnell', width: o.width, height: o.height, seed: 7, seconds: 3, warnings: [] }; } });
  const server = await listen((req, res) => handleV1(req, res, new URL(req.url, 'http://x')));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const post = (body) => fetch(`${base}/v1/images/generations`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const r = await post({ prompt: 'a red fox', size: '768x512', model: 'flux-schnell', negative_prompt: 'blur', seed: 7 });
    assert.equal(r.status, 200);
    const j = await r.json();
    assert.equal(Buffer.from(j.data[0].b64_json, 'base64').toString(), 'png');
    assert.equal(j.size, '768x512');
    assert.deepEqual(calls[0], { model: 'flux-schnell', prompt: 'a red fox', negative: 'blur', width: 768, height: 512, seed: 7 });
    assert.equal((await post({ prompt: '' })).status, 400);
    assert.equal((await post({ prompt: 'x', size: 'grand' })).status, 400);
    assert.equal((await post({ prompt: 'x', response_format: 'url' })).status, 400);
    assert.equal((await (await post({ prompt: 'x', n: 2 })).json()).data.length, 2);
    setImages({ generate: async () => { throw Object.assign(new Error('Modèle d’images inconnu'), { status: 404 }); } });
    assert.equal((await post({ prompt: 'x', model: 'dall-e-3' })).status, 404);
  } finally { server.closeAllConnections(); server.close(); setImages(null); }
});
