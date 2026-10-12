import './helpers/home.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { agentForImages, createAgent, updateAgent } from '../src/agents.mjs';
import { IMAGE_MODELS, generateImage, imagesReport } from '../src/images.mjs';
import { loadState, update } from '../src/state.mjs';

await loadState();
const workspace = path.join(process.env.HARN_HOME, 'workspace-images');
mkdirSync(workspace, { recursive: true });

test('chaque modèle d’images a ses poids, son décodeur et son lecteur de consigne', () => {
  for (const model of IMAGE_MODELS) {
    const roles = model.files.map((file) => file.role);
    for (const role of ['diffusion', 'vae', 'llm']) assert.ok(roles.includes(role), `${model.id} : ${role}`);
    assert.ok(model.files.every((file) => /^[\w.-]+\/[\w.-]+$/.test(file.repo)));
  }
  assert.deepEqual(imagesReport().models.map((model) => model.installed), IMAGE_MODELS.map(() => false));
});

test('sans modèle installé, la demande est refusée avec ce qu’il faut faire', async () => {
  await assert.rejects(generateImage({ workspace, prompt: '  ' }), { status: 400 });
  await assert.rejects(generateImage({ workspace, prompt: 'un chat' }), { status: 409, message: /vue Modèles/ });
});

test('modèle inconnu ou image de référence hors du dossier de travail : refusés avant de toucher à la carte', async () => {
  update((s) => { s.images = { models: { 'flux2-klein-4b': { installedAt: new Date().toISOString() } } }; });
  await assert.rejects(generateImage({ workspace, prompt: 'un chat', model: 'pas-installe' }), { status: 404 });
  await assert.rejects(generateImage({ workspace, prompt: 'un chat', references: ['../ailleurs.png'] }), { status: 400, message: /hors du dossier/ });
  await assert.rejects(generateImage({ workspace, prompt: 'un chat', references: ['absente.png'] }), { status: 400, message: /introuvable/ });
  writeFileSync(path.join(workspace, 'la.png'), 'x');
  await assert.rejects(generateImage({ workspace, prompt: 'x'.repeat(4001), references: ['la.png'] }), { status: 400 });
});

test('seul un agent dont la case Images est cochée peut en demander', async () => {
  const agent = await createAgent({ name: 'Peintre' });
  await assert.rejects(agentForImages(agent.id), { status: 403 });
  await updateAgent(agent.id, { options: { images: true } });
  assert.deepEqual(await agentForImages(agent.id), { who: 'Peintre', workspace: agent.workspace });
  await assert.rejects(agentForImages('inconnu'), { status: 404 });
});
