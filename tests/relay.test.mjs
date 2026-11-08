import './helpers/home.mjs';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeRelay, startRelay } from '../src/engine.mjs';

// Le moteur en bac à sable répond sur une socket Unix, relayée sur un port local. Une connexion
// encore ouverte à l'arrêt (client en pleine réponse) bloquait server.close() pour toujours :
// plus d'arrêt du moteur, plus de chargement, plus de relance de Harn.
test('le relais se ferme même avec une connexion encore ouverte', async (t) => {
  const socket = path.join(os.tmpdir(), `harn-relay-${process.pid}.sock`);
  rmSync(socket, { force: true });
  const engine = net.createServer(() => { /* reçoit et ne répond jamais */ });
  await new Promise((resolve) => engine.listen(socket, resolve));
  t.after(() => { engine.close(); rmSync(socket, { force: true }); });

  const port = 20_000 + Math.floor(Math.random() * 20_000);
  const relay = await startRelay(`http://127.0.0.1:${port}`, socket);
  const client = net.connect(port, '127.0.0.1');
  await new Promise((resolve) => client.once('connect', resolve));
  client.write('POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\n\r\n');
  client.on('error', () => {});
  await new Promise((resolve) => setTimeout(resolve, 100));

  const started = Date.now();
  await closeRelay(relay);
  assert.ok(Date.now() - started < 1_000, `fermé en ${Date.now() - started} ms`);
  client.destroy();
});
