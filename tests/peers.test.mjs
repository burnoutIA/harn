import './helpers/home.mjs';
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { claimCard, createAgent, deleteAgent, remoteModels } from '../src/agents.mjs';
import { handleV1 } from '../src/gateway.mjs';
import { addPeer, normalizeUrl, peerModels, peerRoute, peersReport, removePeer, slug } from '../src/peers.mjs';

const listen = (handler) => new Promise((resolve) => { const server = http.createServer(handler).listen(0, '127.0.0.1', () => resolve(server)); });
const portOf = (server) => server.address().port;

// Une autre machine Harn : son /v1/models (avec un modèle venu de ses propres pairs) et une
// réponse de chat qui renvoie ce qu'elle a reçu.
async function fakeHarn(key) {
  const received = [];
  const server = await listen(async (req, res) => {
    if (req.headers.authorization !== `Bearer ${key}`) { res.writeHead(401); return res.end('{}'); }
    if (req.url === '/v1/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ object: 'list', data: [
        { id: 'qwen-27b', object: 'model', owned_by: 'harn', meta: { name: 'Qwen 27B', context: 131072, vision: true, reasoning: true } },
        { id: 'autre@pc1', object: 'model', owned_by: 'harn@pc1', meta: { name: 'Boucle' } },
      ] }));
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks)) });
    res.writeHead(503, { 'Content-Type': 'application/json', 'Retry-After': '42' });
    res.end(JSON.stringify({ error: { message: 'carte occupée' } }));
  });
  return { server, received };
}

test('adresse et nom de machine sont normalisés', () => {
  assert.equal(normalizeUrl('http://192.168.1.20:4748'), 'http://192.168.1.20:4748/v1');
  assert.equal(normalizeUrl('http://192.168.1.20:4748/v1/'), 'http://192.168.1.20:4748/v1');
  assert.throws(() => normalizeUrl('http://192.168.1.20:4748/k/sk-harn-x/v1'), /sans la clé/);
  assert.throws(() => normalizeUrl('ftp://x'), /http/);
  assert.equal(slug('Tour du Salon é'), 'tour-du-salon-e');
});

test('une machine ajoutée prête ses modèles, et la passerelle relaie vers elle', async (t) => {
  const key = 'sk-harn-distante';
  const { server, received } = await fakeHarn(key);
  t.after(() => { server.closeAllConnections(); server.close(); });

  await assert.rejects(addPeer({ name: 'pc2', url: `http://127.0.0.1:${portOf(server)}`, key: 'mauvaise' }), /clé refusée/);
  assert.equal(peersReport().length, 0);

  const report = await addPeer({ name: 'PC2', url: `http://127.0.0.1:${portOf(server)}/v1`, key });
  assert.deepEqual(report[0].models.map((m) => m.id), ['qwen-27b@pc2']);
  assert.ok(!JSON.stringify(report).includes(key), 'la clé ne sort jamais vers l’interface');
  await assert.rejects(addPeer({ name: 'pc2', url: `http://127.0.0.1:${portOf(server)}`, key }), /déjà/);

  // Les modèles des pairs de l'autre machine ne sont pas redistribués (pas de boucle).
  assert.deepEqual(peerModels().map((m) => [m.id, m.meta.context, m.meta.peer]), [['qwen-27b@pc2', 131072, 'pc2']]);
  assert.equal(peerRoute('qwen-27b@pc2').remoteId, 'qwen-27b');
  assert.equal(peerRoute('qwen-27b'), null);
  assert.equal(peerRoute('qwen-27b@inconnue'), null);

  const gateway = await listen((req, res) => handleV1(req, res, new URL(req.url, 'http://local')));
  t.after(() => { gateway.closeAllConnections(); gateway.close(); });
  const base = `http://127.0.0.1:${portOf(gateway)}/v1`;

  const listed = await fetch(`${base}/models`).then((r) => r.json());
  assert.ok(listed.data.some((m) => m.id === 'qwen-27b@pc2'));

  const reply = await fetch(`${base}/chat/completions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'qwen-27b@pc2', messages: [{ role: 'user', content: 'salut' }] }) });
  assert.equal(reply.status, 503, 'l’erreur de l’autre machine remonte telle quelle');
  assert.equal(reply.headers.get('retry-after'), '42');
  assert.deepEqual(received.at(-1), { url: '/v1/chat/completions', body: { model: 'qwen-27b', messages: [{ role: 'user', content: 'salut' }] } });

  // Un agent peut prendre un modèle de l'autre machine, et ne demande pas la carte d'ici.
  assert.deepEqual(remoteModels(), [{ id: 'qwen-27b@pc2', name: 'Qwen 27B · PC2', peer: 'pc2' }]);
  const agent = await createAgent({ name: 'Distant', model: 'qwen-27b@pc2' });
  assert.equal(agent.model, 'qwen-27b@pc2');
  assert.equal(agent.modelInstalled, true);
  assert.deepEqual(await claimCard(agent.id), { status: 'free' });
  await assert.rejects(createAgent({ name: 'Fantôme', model: 'absent@pc2' }), { status: 409 });
  await deleteAgent(agent.id);

  await removePeer('pc2');
  assert.equal(peerModels().length, 0);
});
