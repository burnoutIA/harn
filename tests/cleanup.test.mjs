import './helpers/home.mjs';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { decideApproval } from '../src/approvals.mjs';
import { findUnusedModelFiles, proposeCleanup, removeUnusedModelFiles } from '../src/cleanup.mjs';
import { DIRS } from '../src/paths.mjs';
import { getState, loadState, update } from '../src/state.mjs';

await loadState();
const put = (rel, bytes = 10) => { const full = path.join(DIRS.models, rel); mkdirSync(path.dirname(full), { recursive: true }); writeFileSync(full, Buffer.alloc(bytes)); return full; };

// Un modèle installé, un modèle d'images installé, Strata, et des restes autour.
const used = put('qwen-installe/Qwen.gguf', 100);
const elsewhere = put('copie-reprise.gguf', 50);
const strata = put('strata-data/mtp/mtp.gguf', 30);
const image = put('image/flux2-klein-4b/flux.gguf', 40);
const loose = put('Vieux-modele.gguf', 200);
const twin = path.join(DIRS.models, 'Qwen-doublon.gguf');
linkSync(used, twin);
const orphanDir = put('modele-supprime/a.gguf', 70);
update((s) => {
  s.models['qwen-installe'] = { installedAt: new Date().toISOString(), files: ['Qwen.gguf'], paths: { 'Reprise.gguf': elsewhere } };
  s.images = { models: { 'flux2-klein-4b': { installedAt: new Date().toISOString() } } };
});

test('seuls les fichiers qu’aucun modèle ne réclame sont en trop ; un doublon par lien ne compte pas', async () => {
  const { files, freedBytes } = await findUnusedModelFiles();
  assert.deepEqual(files.map((file) => file.path).sort(), [loose, twin, orphanDir].sort());
  assert.equal(freedBytes, 270);
});

test('refusé : la même liste n’est plus proposée ; un nouveau fichier relance la question', async () => {
  const id = await proposeCleanup();
  assert.ok(id);
  assert.equal(getState().approvals.find((a) => a.id === id).kind, 'cleanup');
  decideApproval(id, false);
  assert.equal(await proposeCleanup(), null);
  const fresh = put('Nouveau.gguf', 5);
  assert.ok(await proposeCleanup());
  update((s) => { s.cleanupRefused = []; s.approvals = []; });
  await removeUnusedModelFiles([fresh]);
});

test('accepté : les fichiers en trop partent, les dossiers vidés aussi, le reste ne bouge pas', async () => {
  const { files } = await findUnusedModelFiles();
  const result = await removeUnusedModelFiles(files.map((file) => file.path));
  assert.deepEqual(result, { removed: 3, freedBytes: 270 });
  for (const gone of [loose, twin, orphanDir, path.dirname(orphanDir)]) assert.ok(!existsSync(gone), gone);
  for (const kept of [used, elsewhere, strata, image]) assert.ok(existsSync(kept), kept);
  assert.equal(await proposeCleanup(), null);
});
