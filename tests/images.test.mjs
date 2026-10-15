import './helpers/home.mjs';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { agentForImages, createAgent, updateAgent } from '../src/agents.mjs';
import { IMAGE_MODELS, chooseImageModel, generateImage, imagesReport } from '../src/images.mjs';
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
  assert.deepEqual(await agentForImages(agent.id), { who: 'Peintre', workspace: agent.workspace, preferred: null, loraNotes: {} });
  await assert.rejects(agentForImages('inconnu'), { status: 404 });
  // Son modèle d'images : un modèle connu de Harn, ou rien (le premier installé).
  await updateAgent(agent.id, { imageModel: 'qwen-image-2-1-uc' });
  assert.equal((await agentForImages(agent.id)).preferred, 'qwen-image-2-1-uc');
  await assert.rejects(updateAgent(agent.id, { imageModel: 'pas-un-modele' }), { status: 400 });
  await updateAgent(agent.id, { imageModel: null });
  assert.equal((await agentForImages(agent.id)).preferred, null);
});

test('le modèle de l’agent sert quand il n’en demande pas un précis ; une retouche va à un modèle qui sait', () => {
  const fast = { id: 'fast', edit: false };
  const editor = { id: 'editor', edit: true };
  const ready = [editor, fast];
  assert.equal(chooseImageModel(ready).id, 'editor');
  assert.equal(chooseImageModel(ready, { preferred: 'fast' }).id, 'fast');
  assert.equal(chooseImageModel(ready, { preferred: 'fast', editing: true }).id, 'editor');
  assert.equal(chooseImageModel(ready, { preferred: 'fast', wanted: 'editor' }).id, 'editor');
  // Demandé explicitement, il est pris tel quel : le refus de retoucher vient ensuite.
  assert.equal(chooseImageModel(ready, { wanted: 'fast', editing: true }).id, 'fast');
  assert.equal(chooseImageModel(ready, { wanted: 'absent' }), null);
  // Le modèle de l'agent a été désinstallé : le premier installé.
  assert.equal(chooseImageModel([fast], { preferred: 'editor' }).id, 'fast');
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

// Un faux LoRA : un en-tête safetensors avec ses métadonnées, sans poids.
function fakeLora(file, metadata) {
  const header = Buffer.from(JSON.stringify({ __metadata__: metadata }));
  const size = Buffer.alloc(8);
  size.writeBigUInt64LE(BigInt(header.length));
  writeFileSync(file, Buffer.concat([size, header]));
}

test('les LoRA de l’agent : famille lue dans le fichier, modèle compatible choisi, refus clairs sinon', async () => {
  const { listLoras } = await import('../src/loras.mjs');
  const ws = path.join(process.env.HARN_HOME, 'workspace-loras');
  mkdirSync(path.join(ws, 'lora'), { recursive: true });
  fakeLora(path.join(ws, 'lora', 'visage.safetensors'), { ss_base_model_version: 'qwen_image_2', name: 'visage' });
  fakeLora(path.join(ws, 'lora', 'style.safetensors'), { 'modelspec.architecture': 'flux-2-klein-4b/lora' });
  writeFileSync(path.join(ws, 'lora', 'notes.txt'), 'pas un LoRA');
  const loras = await listLoras(ws);
  assert.deepEqual(loras.map((l) => [l.name, l.arch]), [['style', 'flux2-klein-4b'], ['visage', 'qwen-image-2.1']]);

  update((s) => { s.images = { models: { 'flux2-klein-4b': { installedAt: 'x' } } }; });
  await assert.rejects(generateImage({ workspace: ws, prompt: 'un chat <lora:absent:1>' }), { status: 400, message: /LoRA introuvable : absent.*style, visage/ });
  // Seul FLUX.2 klein est installé : le LoRA Qwen-Image n'a pas de modèle compatible.
  await assert.rejects(generateImage({ workspace: ws, prompt: 'a photo of me lora:visage:1' }), { status: 409, message: /fait pour Qwen-Image 2.1/ });
  await assert.rejects(generateImage({ workspace: ws, prompt: 'x <lora:visage:1> <lora:style:1>' }), { status: 400, message: /un seul réseau/ });
  update((s) => { s.images = { models: { 'flux2-klein-4b': { installedAt: 'x' }, 'qwen-image-2-1-uc': { installedAt: 'x' } } }; });
  await assert.rejects(generateImage({ workspace: ws, prompt: 'x <lora:visage:1>', model: 'flux2-klein-4b' }), { status: 400, message: /pas pour FLUX.2 klein 4B.*qwen-image-2-1-uc/ });
  // Sans modèle demandé, celui de la bonne famille est pris, même si l'agent préfère l'autre.
  const ready = IMAGE_MODELS;
  assert.equal(chooseImageModel(ready, { preferred: 'flux2-klein-4b', arch: 'qwen-image-2.1' }).id, 'qwen-image-2-1-uc');
  assert.equal(chooseImageModel(ready, { arch: 'z-image' }), null);
});

test('la fiche dit ce que représente chaque LoRA ; la note suit le LoRA et part avec lui', async () => {
  const { deleteAgentLora } = await import('../src/agents.mjs');
  const agent = await createAgent({ name: 'Modèle' });
  mkdirSync(path.join(agent.workspace, 'lora'), { recursive: true });
  fakeLora(path.join(agent.workspace, 'lora', 'moi.safetensors'), { ss_base_model_version: 'qwen_image_2', 'modelspec.trigger_phrase': 'ohwx man' });
  const saved = await updateAgent(agent.id, { options: { images: true }, loraNotes: { moi: '  Mon visage.  ' } });
  assert.deepEqual(saved.loras.map((l) => [l.name, l.trigger, l.note]), [['moi', 'ohwx man', 'Mon visage.']]);
  assert.deepEqual((await agentForImages(agent.id)).loraNotes, { moi: 'Mon visage.' });
  await assert.rejects(updateAgent(agent.id, { loraNotes: { moi: 'x'.repeat(401) } }), { status: 400 });
  await assert.rejects(deleteAgentLora(agent.id, '../agent.json'), { status: 400 });
  const after = await deleteAgentLora(agent.id, 'moi.safetensors');
  assert.deepEqual(after.loras, []);
  assert.deepEqual((await agentForImages(agent.id)).loraNotes, {});
});
