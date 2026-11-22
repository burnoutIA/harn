import './helpers/home.mjs';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import { handleV1, handleV1Upgrade, setVoice } from '../src/gateway.mjs';
import { setGpuSampler } from '../src/hardware.mjs';
import { migrate } from '../src/migrations.mjs';
import { DIRS } from '../src/paths.mjs';
import { _setPeers, peerWithVoice, refreshPeers } from '../src/peers.mjs';
import { getState, update } from '../src/state.mjs';
import { voiceFamilyById, voiceFamilyOf } from '../src/voice-models.mjs';
import { addVoiceSample, openStream, selectVoice, speak, startVoice, stopVoice, voiceOffer, voiceReport } from '../src/voice.mjs';

const listen = (handler) => new Promise((resolve) => { const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(server)); });
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4000, 1)]).toString('base64');

// Une autre machine Harn qui prête sa voix. legacy : un Harn d'avant les modèles de voix
// (Voxtral seul, sans liste de modèles). Elle renvoie un faux Ogg.
async function harnWithVoice(key, { legacy = false } = {}) {
  const received = [];
  const server = await listen(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); return res.end('{}'); }
    if (req.url === '/v1/models') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ data: [] })); }
    if (req.url === '/v1/audio/voices') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(legacy ? { installed: true, voices: ['fr_female'], status: 'stopped' }
        : { installed: true, status: 'stopped', running: null, voices: [], models: [{ id: 'qwen3-tts-1.7b-base', name: 'Qwen3-TTS 1.7B Base', kind: 'clone', voices: [] }] }));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks)), hop: req.headers['x-harn-hop'] ?? null });
    if (req.url === '/v1/audio/start') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"ok":true}'); }
    if (req.url === '/v1/audio/speech') { res.writeHead(200, { 'Content-Type': 'audio/ogg' }); return res.end(Buffer.from('OggS-faux')); }
    res.writeHead(404); res.end();
  });
  return { server, received };
}

test('sans carte Nvidia, la voix est celle d’une machine reliée, même d’un Harn d’avant les modèles de voix', async (t) => {
  update((s) => { s.hardware = { primary: { vendor: 'amd', name: 'R9700' } }; s.runtimes = {}; s.voice = {}; });
  const key = 'sk-harn-voix';
  const { server, received } = await harnWithVoice(key, { legacy: true });
  t.after(() => { server.closeAllConnections(); server.close(); _setPeers([]); });
  _setPeers([{ id: 'pc2', name: 'pc2', url: `http://127.0.0.1:${server.address().port}/v1`, key }]);
  await refreshPeers();

  assert.equal(peerWithVoice('voxtral').peer.id, 'pc2');
  assert.equal(getState().voiceRemote[0].models[0].id, 'voxtral');
  const report = voiceReport();
  assert.equal(report.canInstall, false);
  assert.deepEqual(report.choice, { model: 'voxtral', name: 'Voxtral TTS 4B', kind: 'preset', voice: 'fr_female', language: 'French', where: 'pc2' });

  await startVoice();
  const audio = await speak('Bonjour');
  assert.equal(audio.toString(), 'OggS-faux');
  assert.deepEqual(received.map((r) => [r.url, r.hop]), [['/v1/audio/start', '1'], ['/v1/audio/speech', '1']]);
  assert.deepEqual(received[1].body, { input: 'Bonjour', model: 'voxtral', voice: 'fr_female', language: 'French', response_format: 'opus' });

  // Demandée par une autre machine, la voix n'est jamais renvoyée plus loin.
  await assert.rejects(speak('Bonjour', {}, { here: true }), /Aucun modèle de voix installé|Pas de voix ici/);
});

test('une voix clonée d’ici part avec la demande vers la machine qui a le modèle', async (t) => {
  update((s) => { s.hardware = { primary: { vendor: 'amd', name: 'R9700' } }; s.runtimes = {}; s.voice = {}; });
  const key = 'sk-harn-clone';
  const { server, received } = await harnWithVoice(key);
  t.after(() => { server.closeAllConnections(); server.close(); _setPeers([]); });
  _setPeers([{ id: 'pc2', name: 'pc2', url: `http://127.0.0.1:${server.address().port}/v1`, key }]);
  await refreshPeers();

  // Un modèle qui imite une voix, sans voix clonée : refusé avec la marche à suivre.
  await assert.rejects(speak('Bonjour'), /ajoutez une voix clonée/);
  const sample = await addVoiceSample({ name: 'Estelle', text: 'Bonjour, je suis Estelle.', language: 'French', mime: 'audio/wav', audio: WAV });
  assert.equal(sample.id, 'estelle');
  selectVoice({ model: 'qwen3-tts-1.7b-base', voice: 'estelle' });
  assert.equal((await speak('Salut')).toString(), 'OggS-faux');
  const body = received.at(-1).body;
  assert.equal(body.model, 'qwen3-tts-1.7b-base');
  assert.equal(body.ref_text, 'Bonjour, je suis Estelle.');
  assert.equal(body.ref_audio, `data:audio/wav;base64,${WAV}`);
  assert.equal(body.language, 'French');
  await assert.rejects(addVoiceSample({ name: 'X', mime: 'video/mp4', audio: WAV }), /WAV, FLAC/);
});

test('/v1/audio/speech : une demande venue du réseau local est servie avec la voix d’ici', async () => {
  const calls = [];
  setVoice({ speak: async (text, options, opts) => { calls.push([text, options, opts]); return Buffer.from('ogg'); }, start: async () => {}, offer: () => ({ installed: true, models: [{ id: 'voxtral', kind: 'preset', voices: ['fr_female'] }], voices: ['fr_female'], status: 'ready' }) });
  const server = await listen((req, res) => handleV1(req, res, new URL(req.url, 'http://x')));
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const voices = await (await fetch(`${base}/v1/audio/voices`)).json();
    assert.deepEqual(voices.voices, ['fr_female']);
    assert.equal(voices.models[0].id, 'voxtral');
    const res = await fetch(`${base}/v1/audio/speech`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-harn-hop': '1' }, body: JSON.stringify({ input: 'Salut', voice: 'fr_female', ref_text: 'abc' }) });
    assert.equal(res.headers.get('content-type'), 'audio/ogg');
    assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'ogg');
    assert.deepEqual(calls, [['Salut', { voice: 'fr_female', ref_text: 'abc' }, { here: true }]]);
  } finally { server.closeAllConnections(); server.close(); setVoice(null); }
});

// Un faux vLLM-Omni : il note ses arguments et la deploy-config, répond à /health et renvoie
// le corps de la requête de parole en guise d'audio.
async function fakeEngine() {
  const dir = path.join(DIRS.runtime, 'vllm-omni');
  const venv = path.join(dir, 'venv');
  await mkdir(path.join(venv, 'bin'), { recursive: true });
  await mkdir(path.join(venv, 'lib', 'python3.12', 'site-packages', 'vllm_omni', 'deploy'), { recursive: true });
  const record = path.join(dir, 'record.json');
  await writeFile(path.join(venv, 'bin', 'vllm'), `#!${process.execPath}
const http = require('node:http'); const fs = require('node:fs');
const args = process.argv.slice(2); const port = Number(args[args.indexOf('--port') + 1]);
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({ args, config: fs.readFileSync(args[args.indexOf('--deploy-config') + 1], 'utf8') }));
const server = http.createServer((req, res) => {
  if (req.url === '/health') { res.writeHead(200); return res.end('ok'); }
  let body = ''; req.on('data', (c) => { body += c; }); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'audio/ogg' }); res.end(body); });
});
// Le flux : une poignée de main WebSocket, puis une trame texte qui dit le chemin demandé.
server.on('upgrade', (req, socket) => {
  const accept = require('node:crypto').createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  const text = Buffer.from('flux ' + req.url);
  socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: ' + accept + '\\r\\n\\r\\n');
  socket.write(Buffer.concat([Buffer.from([0x81, text.length]), text]));
});
server.listen(port, '127.0.0.1');
`);
  await chmod(path.join(venv, 'bin', 'vllm'), 0o755);
  return { dir, venv, record };
}

test('Qwen3-TTS Base ici : profil d’origine dérivé, extrait et transcription dans la requête', async (t) => {
  const { dir, venv, record } = await fakeEngine();
  const weights = path.join(DIRS.models, 'voice', 'qwen3-tts-0.6b-base');
  await mkdir(weights, { recursive: true });
  setGpuSampler(async () => ({ freeMiB: 20000, totalMiB: 24576 }));
  update((s) => {
    s.hardware = { primary: { vendor: 'nvidia', name: 'RTX 3090', vramMiB: 24576 } };
    s.runtimes = { 'vllm-omni': { kind: 'vllm-omni', dir, venv, installedAt: 'x' } };
    s.voice = { models: { 'qwen3-tts-0.6b-base': { installedAt: 'x', path: weights } } };
  });
  t.after(async () => { await stopVoice(); setGpuSampler(null); });
  await addVoiceSample({ name: 'Moi', text: 'Ceci est ma voix.', language: 'French', mime: 'audio/wav', audio: WAV });
  selectVoice({ model: 'qwen3-tts-0.6b-base', voice: 'moi' });

  const said = JSON.parse((await speak('Bonjour à tous')).toString());
  assert.deepEqual({ ...said, ref_audio: said.ref_audio.slice(0, 22) }, { input: 'Bonjour à tous', model: 'qwen3-tts-0.6b-base', response_format: 'opus', task_type: 'Base', language: 'French', ref_audio: 'data:audio/wav;base64,', ref_text: 'Ceci est ma voix.' });
  const { args, config } = JSON.parse(await readFile(record, 'utf8'));
  assert.deepEqual(args.slice(0, 3), ['serve', weights, '--omni']);
  assert.equal(args[args.indexOf('--served-model-name') + 1], 'qwen3-tts-0.6b-base');
  assert.match(config, new RegExp(`base_config: ${venv}/lib/python3.12/site-packages/vllm_omni/deploy/qwen3_tts.yaml`));
  assert.match(config, /stage_id: 0\n {4}max_num_seqs: 1\n {4}gpu_memory_utilization: 0.142/);
  assert.equal(voiceReport().running, 'qwen3-tts-0.6b-base');

  // La parole en flux, à travers la passerelle (WebSocket), jusqu'au moteur.
  setVoice({ stream: openStream });
  const gateway = await listen(() => {});
  gateway.on('upgrade', (req, socket, head) => handleV1Upgrade(req, socket, head));
  t.after(() => { gateway.closeAllConnections(); gateway.close(); setVoice(null); });
  const message = await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/audio/speech/stream?model=qwen3-tts-0.6b-base`);
    ws.onmessage = (event) => { resolve(event.data); ws.close(); };
    ws.onerror = () => reject(new Error('flux refusé'));
  });
  assert.equal(message, 'flux /v1/audio/speech/stream');
  // Ce qu'une autre machine voit d'ici.
  assert.deepEqual(voiceOffer().models, [{ id: 'qwen3-tts-0.6b-base', name: 'Qwen3-TTS 0.6B Base', kind: 'clone', voices: [] }]);
});

test('migration 7 : le Voxtral installé devient un modèle de voix, sans rien déplacer', () => {
  const state = migrate({ version: 6, runtimes: { voxtral: { kind: 'voxtral', dir: '/r/voxtral', venv: '/r/voxtral/venv', model: '/r/voxtral/models/V', revision: 'abc', installedAt: 't' } }, voice: { status: 'stopped', installing: false, detail: null } });
  assert.equal(state.runtimes.voxtral, undefined);
  assert.deepEqual(state.runtimes['vllm-omni'], { kind: 'vllm-omni', dir: '/r/voxtral', venv: '/r/voxtral/venv', version: '0.32.0', installedAt: 't' });
  assert.deepEqual(state.voice, { status: 'stopped', models: { voxtral: { installedAt: 't', path: '/r/voxtral/models/V', revision: 'abc' } }, selected: { model: 'voxtral', voice: 'fr_female', language: 'French' } });
});

test('familles de voix : reconnues par le dépôt ou le config.json', () => {
  assert.equal(voiceFamilyOf({ repo: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice' })?.id, 'qwen3-tts');
  assert.equal(voiceFamilyOf({ repo: 'quelquun/mon-reglage', modelType: 'qwen3_tts' })?.id, 'qwen3-tts');
  assert.equal(voiceFamilyOf({ repo: 'mistralai/Voxtral-4B-TTS-2603' })?.id, 'voxtral');
  assert.equal(voiceFamilyOf({ repo: 'mistralai/Voxtral-Mini-3B-2507' }), null);
  const qwen = voiceFamilyById('qwen3-tts');
  assert.equal(qwen.kind({ ttsType: 'custom_voice' }), 'preset');
  assert.equal(qwen.kind({ ttsType: 'voice_design' }), null);
  assert.deepEqual(qwen.request({ kind: 'clone', sample: { audio: 'data:x', text: '' }, language: 'French' }), { task_type: 'Base', language: 'French', ref_audio: 'data:x', x_vector_only_mode: true });
  assert.deepEqual(qwen.request({ kind: 'preset', voice: 'vivian', language: 'French' }), { task_type: 'CustomVoice', language: 'French', voice: 'vivian' });
});

test('la parole en flux passe à la machine reliée qui a le modèle, avec sa clé', async (t) => {
  update((s) => { s.hardware = { primary: { vendor: 'amd', name: 'R9700' } }; s.runtimes = {}; s.voice = {}; });
  const key = 'sk-harn-flux';
  const { server } = await harnWithVoice(key);
  let seen = null;
  server.on('upgrade', (req, socket) => {
    seen = { url: req.url, auth: req.headers.authorization, hop: req.headers['x-harn-hop'] };
    socket.end('HTTP/1.1 409 Conflict\r\nConnection: close\r\n\r\n');
  });
  const gateway = await listen(() => {});
  gateway.on('upgrade', (req, socket, head) => handleV1Upgrade(req, socket, head));
  setVoice({ stream: openStream });
  t.after(() => { for (const s of [server, gateway]) { s.closeAllConnections(); s.close(); } _setPeers([]); setVoice(null); });
  _setPeers([{ id: 'pc2', name: 'pc2', url: `http://127.0.0.1:${server.address().port}/v1`, key }]);
  await refreshPeers();
  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${gateway.address().port}/v1/audio/speech/stream`);
    ws.onerror = resolve; ws.onclose = resolve;
  });
  assert.deepEqual(seen, { url: '/v1/audio/speech/stream?model=qwen3-tts-1.7b-base', auth: `Bearer ${key}`, hop: '1' });
});
