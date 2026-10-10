import './helpers/home.mjs';
import assert from 'node:assert/strict';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { MODELS, modelById } from '../src/catalog.mjs';
import { defaultTuning, startEngine, stopEngine } from '../src/engine.mjs';
import { recipeFor } from '../src/loading.mjs';
import { DIRS } from '../src/paths.mjs';
import { sandboxAvailable } from '../src/sandbox.mjs';
import { update } from '../src/state.mjs';

// Un moteur ajouté avec l'accord de l'utilisateur tourne dans la bulle : il répond par le relais,
// mais ne lit ni un fichier hors de ses dossiers, ni le dossier personnel, ni le réseau.
// Sauté là où bubblewrap manque (Windows, Linux sans bwrap ou sans espaces de noms utilisateur).
const HERE = path.dirname(new URL(import.meta.url).pathname);
const available = await sandboxAvailable();
after(() => stopEngine());

test('moteur isolé : répond, mais ni fichiers, ni dossier personnel, ni réseau', { skip: !available && 'bubblewrap indisponible', timeout: 60_000 }, async () => {
  // Le moteur et son interpréteur dans son propre dossier : c'est tout ce que la bulle lui montre.
  const dir = path.join(DIRS.runtime, 'llama-pr-test', 'build', 'bin');
  mkdirSync(dir, { recursive: true });
  copyFileSync(process.execPath, path.join(dir, 'node'));
  chmodSync(path.join(dir, 'node'), 0o755);
  copyFileSync(path.join(HERE, 'helpers', 'fake-llama-server.mjs'), path.join(dir, 'fake.mjs'));
  const serverPath = path.join(dir, 'llama-server');
  writeFileSync(serverPath, '#!/bin/sh\nexec "$(dirname "$0")/node" "$(dirname "$0")/fake.mjs" "$@"\n');
  chmodSync(serverPath, 0o755);

  // Ce que le moteur ne doit pas atteindre : un secret ailleurs, un dossier « personnel », un port de la machine.
  const outside = mkdtempSync(path.join(os.tmpdir(), 'harn-outside-'));
  writeFileSync(path.join(outside, 'secret'), 'clé privée');
  process.env.FAKE_SECRET = path.join(outside, 'secret');
  process.env.FAKE_HOME = outside;
  const listener = http.createServer((req, res) => res.end('fuite')).listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
  process.env.FAKE_NET_PORT = String(listener.address().port);

  const base = modelById('swift15-q27-iq3s-mtp');
  MODELS.push({ ...base, id: 't-sandbox', files: [{ name: 'm.gguf', bytes: 1 }], mmproj: null, dflash: null, vision: false });
  mkdirSync(path.join(DIRS.models, 't-sandbox'), { recursive: true });
  writeFileSync(path.join(DIRS.models, 't-sandbox', 'm.gguf'), 'GGUF');
  update((s) => {
    s.hardware = { os: { platform: 'linux' }, cpu: { physical: 4 }, primary: { vendor: 'nvidia', computeCapability: 8.6 } };
    s.engines = { 'llama-pr-test': { id: 'llama-pr-test', label: 'PR de test', repo: 'x/y', ref: 'abc', onlyArchs: ['test'], isolated: true } };
    s.runtimes['llama-pr-test-cuda12'] = { kind: 'llama-pr-test', backend: 'cuda12', dir, serverPath };
    s.models['t-sandbox'] = { installedAt: new Date().toISOString(), files: ['m.gguf'] };
  });

  const model = modelById('t-sandbox');
  const recipe = recipeFor(model, { ...defaultTuning(model, 32768, { cpu: { physical: 4 }, primary: null }), backend: 'cuda12', fork: 'llama-pr-test' });
  assert.equal(recipe.command, 'bwrap');
  assert.ok(recipe.socket.endsWith('.sock'));
  const active = await startEngine(recipe);
  const probe = await fetch(`${active.endpoint}/probe`).then((r) => r.json());
  listener.close();
  assert.equal(probe.secret, null, 'le secret hors de ses dossiers est lisible');
  assert.equal(probe.home, null, 'le dossier « personnel » est lisible');
  assert.equal(probe.network, false, 'le réseau de la machine est joignable');
});
