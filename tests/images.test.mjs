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

test('un modèle ajouté depuis Hugging Face rejoint la liste ; le supprimer garde les fichiers partagés encore utilisés', async () => {
  const { DIRS } = await import('../src/paths.mjs');
  const { loadImageModels } = await import('../src/image-hub.mjs');
  const { deleteImageModel } = await import('../src/images.mjs');
  const { existsSync } = await import('node:fs');
  const vae = { role: 'vae', repo: 'Comfy-Org/z_image_turbo', name: 'split_files/vae/ae.safetensors', shared: true };
  const entry = (id) => ({ id, custom: true, name: id, family: 'z-image-turbo', tagline: 'test', license: 'apache-2.0', repo: `x/${id}`, gigabytes: 1, vramGiB: 4, ramGiB: 8, edit: false,
    files: [{ role: 'diffusion', repo: `x/${id}`, name: `${id}-Q8_0.gguf` }, vae], args: [] });
  mkdirSync(DIRS.data, { recursive: true });
  writeFileSync(path.join(DIRS.data, 'image-models.json'), JSON.stringify([entry('za'), entry('zb')]));
  await loadImageModels();
  const shared = path.join(DIRS.models, 'image', 'shared', 'Comfy-Org--z_image_turbo', 'ae.safetensors');
  mkdirSync(path.dirname(shared), { recursive: true });
  writeFileSync(shared, 'vae');
  update((s) => { s.images = { models: { za: { installedAt: 'x' }, zb: { installedAt: 'x' } } }; });
  const report = imagesReport();
  assert.ok(report.models.some((m) => m.id === 'za' && m.custom && m.edit === false && m.installed));

  // Il ne sait pas retoucher : la demande est refusée avant de toucher à la carte.
  writeFileSync(path.join(workspace, 'ref.png'), 'x');
  await assert.rejects(generateImage({ workspace, prompt: 'un chat', model: 'za', references: ['ref.png'] }), { status: 400, message: /ne sait pas retoucher/ });

  await deleteImageModel('za');
  assert.ok(existsSync(shared), 'zb se sert encore du décodeur');
  assert.ok(!imagesReport().models.some((m) => m.id === 'za'));
  await deleteImageModel('zb');
  assert.ok(!existsSync(shared));
});
