import './helpers/home.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { claimCard, createAgent, deleteAgent, launchAgent, listAgents, updateAgent } from '../src/agents.mjs';
import { approvalOf, decideApproval } from '../src/approvals.mjs';
import { addViewer, beginRequest, endRequest } from '../src/metrics.mjs';
import { DIRS } from '../src/paths.mjs';
import { configurePiDir } from '../src/pi.mjs';
import { bus } from '../src/state.mjs';

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('un agent naît avec son dossier, ses consignes et le moins de droits possible', async () => {
  const agent = await createAgent({ name: 'Éloïse' });
  assert.equal(agent.id, 'eloise');
  assert.deepEqual(agent.options, { shell: false, harnTools: false, web: true, memory: true, images: false, autostart: false });
  assert.equal(agent.model, null);
  assert.match(agent.prompt, /Consignes de Éloïse/);
  assert.equal(agent.workspace, path.join(DIRS.agents, 'eloise', 'workspace'));
  assert.ok(existsSync(agent.workspace));
  // Le dossier où arrivent les fichiers qu'on lui envoie.
  assert.ok(existsSync(path.join(agent.workspace, 'files')));
  // Deux agents du même nom ne partagent pas leur dossier.
  assert.equal((await createAgent({ name: 'Eloise' })).id, 'eloise-2');
  assert.deepEqual((await listAgents()).map((a) => a.id), ['eloise', 'eloise-2']);
});

test('la fiche se modifie, sans accepter n’importe quoi', async () => {
  const saved = await updateAgent('eloise', { name: 'Élo', prompt: 'Sois brève.', options: { shell: true, inconnu: true, web: 'oui' } });
  assert.equal(saved.name, 'Élo');
  assert.equal(saved.prompt, 'Sois brève.');
  assert.deepEqual(saved.options, { shell: true, harnTools: false, web: true, memory: true, images: false, autostart: false });
  await assert.rejects(updateAgent('eloise', { name: '  ' }), { status: 400 });
  await assert.rejects(updateAgent('eloise', { model: 'pas-installe' }), { status: 409 });
  // L'identifiant est un nom de dossier : rien ne sort de data/agents.
  await assert.rejects(updateAgent('../pi-agent', { name: 'x' }), { status: 404 });
  await assert.rejects(deleteAgent('..'), { status: 404 });
  await assert.rejects(createAgent({ name: '???' }), { status: 400 });
});

test('Telegram : le jeton s’enregistre mais ne ressort jamais', async () => {
  const token = `123456789:${'A'.repeat(35)}`;
  await assert.rejects(updateAgent('eloise', { telegram: { ownerId: '42', token: '' } }), { status: 400 });
  await assert.rejects(updateAgent('eloise', { telegram: { ownerId: 'moi', token } }), { status: 400 });
  await assert.rejects(updateAgent('eloise', { telegram: { ownerId: '42', token: 'pas-un-jeton' } }), { status: 400 });
  const saved = await updateAgent('eloise', { telegram: { ownerId: ' 42 ', token } });
  assert.deepEqual(saved.telegram, { ownerId: 42 });
  assert.ok(!JSON.stringify(await listAgents()).includes(token));
  assert.equal((await json(path.join(DIRS.agents, 'eloise', 'agent.json'))).telegram.token, token);
  // Jeton vide : celui enregistré reste. Identifiant vide : Telegram est retiré.
  assert.deepEqual((await updateAgent('eloise', { telegram: { ownerId: '43', token: '' } })).telegram, { ownerId: 43 });
  assert.equal((await json(path.join(DIRS.agents, 'eloise', 'agent.json'))).telegram.token, token);
  assert.equal((await updateAgent('eloise', { telegram: { ownerId: '', token: '' } })).telegram, null);
});

test('la mémoire se lit et se corrige depuis la fiche, dans la limite de taille', async () => {
  assert.equal((await listAgents())[0].memory, '');
  const saved = await updateAgent('eloise', { memory: '- 2026-10-11 : aime le thé\n' });
  assert.equal(saved.memory, '- 2026-10-11 : aime le thé\n');
  assert.equal(await readFile(path.join(DIRS.agents, 'eloise', 'MEMORY.md'), 'utf8'), saved.memory);
  await assert.rejects(updateAgent('eloise', { memory: 'x'.repeat(saved.memoryMax + 1) }), { status: 400 });
  // Une fiche enregistrée sans toucher à la mémoire la laisse telle que l'agent l'a écrite.
  assert.equal((await updateAgent('eloise', { name: 'Élo' })).memory, saved.memory);
});

test('sans pi installé, un agent ne se lance pas', async () => {
  await assert.rejects(launchAgent('eloise'), { status: 409 });
});

test('le dossier pi d’un agent ne reçoit que ce qui est coché', async () => {
  const dir = path.join(DIRS.agents, 'eloise', 'pi-agent');
  await configurePiDir(dir, { options: { shell: false, harnTools: false, web: true } });
  assert.deepEqual((await json(path.join(dir, 'settings.json'))).defaultTools, ['-bash', '-powershell']);
  assert.equal((await json(path.join(dir, 'mcp.json'))).mcpServers.harn, undefined);
  assert.ok(!existsSync(path.join(dir, 'skills', 'installer-un-modele')));
  assert.ok(existsSync(path.join(dir, 'extensions', 'ctx-optimizer')));
  // L'extension Telegram est copiée partout, sans secret : inerte tant que telegram.json manque.
  assert.ok(!/\d{6,}:[\w-]{30,}/.test(await readFile(path.join(dir, 'extensions', 'telegram-follow', 'index.ts'), 'utf8')));

  await configurePiDir(dir, { options: { shell: true, harnTools: true, web: true } });
  assert.equal((await json(path.join(dir, 'settings.json'))).defaultTools, undefined);
  assert.ok((await json(path.join(dir, 'mcp.json'))).mcpServers.harn);
  assert.ok(existsSync(path.join(dir, 'skills', 'installer-un-modele', 'SKILL.md')));
  // Les consignes de l'agent ne sont jamais réécrites par la configuration.
  assert.equal(await readFile(path.join(dir, 'APPEND_SYSTEM.md'), 'utf8'), 'Sois brève.');
});

test('la carte : libre elle se prend, occupée elle se demande', async () => {
  const toasts = [];
  bus.on('toast', (message) => toasts.push(message));
  assert.deepEqual(await claimCard('eloise'), { status: 'free' });
  assert.deepEqual(toasts, ['Élo utilise l’IA']);
  await assert.rejects(claimCard('inconnu'), { status: 404 });

  // Une réponse en cours pour quelqu'un d'autre : une demande dans la fenêtre, une seule.
  const request = beginRequest({ model: 'un-modele', client: 'pi', engine: 'strata' });
  const claim = await claimCard('eloise');
  assert.equal(claim.status, 'pending');
  assert.deepEqual(await claimCard('eloise'), claim);
  assert.equal(approvalOf(claim.approval).kind, 'card');
  assert.match(approvalOf(claim.approval).title, /Élo veut utiliser l’IA/);
  assert.equal(decideApproval(claim.approval, false).status, 'refused');
  assert.equal(toasts.length, 1);

  // La réponse en cours se termine avant toute décision : la demande passe d'elle-même.
  const second = await claimCard('eloise');
  assert.notEqual(second.approval, claim.approval);
  await endRequest(request, {});
  addViewer()(); // arrête le relevé de la carte lancé par la requête : sans lui, le test ne finit pas
  await new Promise((resolve) => setTimeout(resolve, 1300));
  assert.equal(approvalOf(second.approval).status, 'accepted');
});

test('supprimer un agent emporte tout son dossier', async () => {
  await deleteAgent('eloise-2');
  assert.ok(!existsSync(path.join(DIRS.agents, 'eloise-2')));
  assert.deepEqual((await listAgents()).map((a) => a.id), ['eloise']);
});
