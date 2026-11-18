import './helpers/home.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { handleV1, setVoice } from '../src/gateway.mjs';
import { _setPeers, peerWithVoice, refreshPeers } from '../src/peers.mjs';
import { getState, update } from '../src/state.mjs';
import { speak, startVoice, voiceReport } from '../src/voice.mjs';

const listen = (handler) => new Promise((resolve) => { const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(server)); });

// Une machine avec une 3090 et la voix installée : elle renvoie un faux Ogg.
async function harnWithVoice(key) {
  const received = [];
  const server = await listen(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); return res.end('{}'); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
    if (req.url === '/v1/audio/voices') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ installed: true, voices: ['fr_female'], status: 'stopped' })); }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks)), hop: req.headers['x-harn-hop'] ?? null });
    if (req.url === '/v1/audio/start') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    if (req.url === '/v1/audio/speech') { res.writeHead(200, { 'Content-Type': 'audio/ogg' }); return res.end(Buffer.from('OggS-faux')); }
    res.writeHead(404); res.end();
  });
  return { server, received };
}

test('sans carte Nvidia, la voix est celle d’une machine reliée qui l’a', async (t) => {
  update((s) => { s.hardware = { primary: { vendor: 'amd', name: 'R9700' } }; s.runtimes = {}; });
  const key = 'sk-harn-voix';
  const { server, received } = await harnWithVoice(key);
  t.after(() => { server.closeAllConnections(); server.close(); _setPeers([]); });
  _setPeers([{ id: 'pc2', name: 'pc2', url: `http://127.0.0.1:${server.address().port}/v1`, key }]);
  await refreshPeers();

  assert.equal(peerWithVoice().peer.id, 'pc2');
  assert.deepEqual(getState().voiceRemote, { name: 'pc2', status: 'stopped' });
  assert.equal(voiceReport().remote.name, 'pc2');
  assert.equal(voiceReport().canInstall, false);

  await startVoice();
  const audio = await speak('Bonjour', 'fr_female');
  assert.equal(audio.toString(), 'OggS-faux');
  assert.deepEqual(received.map((r) => [r.url, r.hop]), [['/v1/audio/start', '1'], ['/v1/audio/speech', '1']]);
  assert.deepEqual(received[1].body, { input: 'Bonjour', model: 'voxtral', voice: 'fr_female', response_format: 'opus' });

  // Demandée par une autre machine, la voix n'est jamais renvoyée plus loin.
  await assert.rejects(speak('Bonjour', 'fr_female', { here: true }), /Pas de voix ici/);
});

test('/v1/audio/speech : une demande venue du réseau local est servie avec la voix d’ici', async () => {
  const calls = [];
  setVoice({ speak: async (text, voice, opts) => { calls.push([text, voice, opts]); return Buffer.from('ogg'); }, start: async () => {}, report: () => ({ installed: true, voices: ['fr_female'], status: 'ready' }) });
  const server = await listen((req, res) => handleV1(req, res, new URL(req.url, 'http://x')));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const voices = await (await fetch(`${base}/v1/audio/voices`)).json();
    assert.deepEqual(voices, { installed: true, voices: ['fr_female'], status: 'ready' });
    const res = await fetch(`${base}/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-harn-hop': '1' }, body: JSON.stringify({ input: 'Salut', voice: 'fr_female' }) });
    assert.equal(res.headers.get('content-type'), 'audio/ogg');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'ogg');
    assert.deepEqual(calls, [['Salut', 'fr_female', { here: true }]]);
  } finally { server.closeAllConnections(); server.close(); setVoice(null); }
});
