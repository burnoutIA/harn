#!/usr/bin/env node
// Un faux llama-server pour les tests d'orchestration : mêmes arguments, mêmes routes, mêmes
// messages d'erreur que le vrai, mais sans carte graphique. Son comportement vient d'un fichier
// <modèle>.fake.json posé à côté du faux modèle :
//   { "arch": "qwen35", "unknownArch": false, "phantomNextn": false, "loadMs": 50,
//     "tps": 80, "prefillTps": 1200, "depthSlope": 0.4, "f16DepthBonus": 0 }
// Chaque lancement est noté dans <modèle>.launches.jsonl (arguments utiles), pour les assertions.
import { appendFileSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import http from 'node:http';

const args = process.argv.slice(2);
const arg = (flag) => { const i = args.lastIndexOf(flag); return i >= 0 ? args[i + 1] : null; };
const model = arg('-m');
const config = existsSync(`${model}.fake.json`) ? JSON.parse(readFileSync(`${model}.fake.json`, 'utf8')) : {};
const port = Number(arg('--port'));
const kv = arg('--cache-type-k') ?? 'f16';
const overrides = args.flatMap((a, i) => (a === '--override-kv' ? [args[i + 1]] : []));
const launch = { context: Number(arg('-c')), ngl: arg('-ngl'), fit: arg('--fit'), kv, kvV: arg('--cache-type-v'), spec: arg('--spec-type'), overrides, at: Date.now() };
// Dans la bulle, le dossier du modèle est en lecture seule : le journal des lancements manque alors.
try { appendFileSync(`${model}.launches.jsonl`, `${JSON.stringify(launch)}\n`); } catch {}

if (args.includes('--version')) { console.log('version: 9999 (fake)'); process.exit(0); }

const fail = (lines) => { for (const line of lines) console.error(line); process.exit(1); };
if (config.unknownArch) fail([`E llama_model_load: error loading model: unknown model architecture: '${config.arch}'`, 'E llama_model_load_from_file_impl: failed to load model']);
if (config.phantomNextn && !overrides.some((o) => o.endsWith('nextn_predict_layers=int:0'))) {
  fail(['E llama_model_load: error loading model: done_getting_tensors: wrong number of tensors; expected 953, got 947', 'E llama_model_load_from_file_impl: failed to load model']);
}
if (config.oomAboveContext && launch.context > config.oomAboveContext) {
  fail(['E ggml_backend_cuda_buffer_type_alloc_buffer: allocating 4096.00 MiB on device 0: cudaMalloc failed: out of memory', 'E llama_model_load: error loading model: failed to allocate buffer']);
}

let ready = false;
setTimeout(() => { ready = true; }, config.loadMs ?? 50);

const server = http.createServer((req, res) => {
  const json = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (req.url === '/health' || req.url === '/v1/models') return ready ? json(200, { status: 'ok' }) : json(503, { error: 'loading' });
  // Ce que le moteur peut atteindre : un fichier hors de ses dossiers, le réseau, le dossier personnel.
  if (req.url === '/probe') {
    const secret = (() => { try { return readFileSync(process.env.FAKE_SECRET ?? '/nonexistent', 'utf8'); } catch { return null; } })();
    const home = (() => { try { return readdirSync(process.env.FAKE_HOME ?? os.homedir()).length; } catch { return null; } })();
    const socket = net.connect(Number(process.env.FAKE_NET_PORT ?? 9), '127.0.0.1');
    const done = (reached) => { socket.destroy(); json(200, { secret, home, network: reached }); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(1500, () => done(false));
    return undefined;
  }
  if (req.url === '/v1/chat/completions' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const request = JSON.parse(body || '{}');
      const promptChars = (request.messages ?? []).reduce((sum, m) => sum + String(m.content ?? '').length, 0);
      const promptTokens = Math.max(1, Math.round(promptChars / 3.5));
      const predicted = request.max_tokens ?? 16;
      // La génération ralentit avec la profondeur ; un KV f16 ralentit moins (le cas de Xing4/MLA).
      const slope = (config.depthSlope ?? 0.4) * (kv === 'f16' ? 1 - (config.f16DepthBonus ?? 0) : 1);
      const tps = (config.tps ?? 80) / (1 + slope * promptTokens / 32768);
      json(200, {
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'length' }],
        usage: { prompt_tokens: promptTokens, completion_tokens: predicted },
        timings: { prompt_n: promptTokens, prompt_per_second: config.prefillTps ?? 1200, predicted_n: predicted, predicted_per_second: tps },
      });
    });
    return undefined;
  }
  return json(404, { error: 'not found' });
});
// Comme le vrai : une adresse en .sock = socket Unix (moteur isolé, sans réseau).
const host = arg('--host');
if (host?.endsWith('.sock')) server.listen(host);
else server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
