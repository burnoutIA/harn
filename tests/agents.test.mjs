import './helpers/home.mjs';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createAgent, deleteAgent, launchAgent, listAgents, updateAgent } from '../src/agents.mjs';
import { DIRS } from '../src/paths.mjs';
import { configurePiDir } from '../src/pi.mjs';

const json = async (file) => JSON.parse(await readFile(file, 'utf8'));

test('un agent naît avec son dossier, ses consignes et le moins de droits possible', async () => {
  const agent = await createAgent({ name: 'Éloïse' });
  assert.equal(agent.id, 'eloise');
  assert.deepEqual(agent.options, { shell: false, harnTools: false, web: true });
  assert.equal(agent.model, null);
  assert.match(agent.prompt, /Consignes de Éloïse/);
  assert.equal(agent.workspace, path.join(DIRS.agents, 'eloise', 'workspace'));
  assert.ok(existsSync(agent.workspace));
  // Deux agents du même nom ne partagent pas leur dossier.
  assert.equal((await createAgent({ name: 'Eloise' })).id, 'eloise-2');
  assert.deepEqual((await listAgents()).map((a) => a.id), ['eloise', 'eloise-2']);
});

test('la fiche se modifie, sans accepter n’importe quoi', async () => {
  const saved = await updateAgent('eloise', { name: 'Élo', prompt: 'Sois brève.', options: { shell: true, inconnu: true, web: 'oui' } });
  assert.equal(saved.name, 'Élo');
  assert.equal(saved.prompt, 'Sois brève.');
  assert.deepEqual(saved.options, { shell: true, harnTools: false, web: true });
  await assert.rejects(updateAgent('eloise', { name: '  ' }), { status: 400 });
  await assert.rejects(updateAgent('eloise', { model: 'pas-installe' }), { status: 409 });
  // L'identifiant est un nom de dossier : rien ne sort de data/agents.
  await assert.rejects(updateAgent('../pi-agent', { name: 'x' }), { status: 404 });
  await assert.rejects(deleteAgent('..'), { status: 404 });
  await assert.rejects(createAgent({ name: '???' }), { status: 400 });
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

  await configurePiDir(dir, { options: { shell: true, harnTools: true, web: true } });
  assert.equal((await json(path.join(dir, 'settings.json'))).defaultTools, undefined);
  assert.ok((await json(path.join(dir, 'mcp.json'))).mcpServers.harn);
  assert.ok(existsSync(path.join(dir, 'skills', 'installer-un-modele', 'SKILL.md')));
  // Les consignes de l'agent ne sont jamais réécrites par la configuration.
  assert.equal(await readFile(path.join(dir, 'APPEND_SYSTEM.md'), 'utf8'), 'Sois brève.');
});

test('supprimer un agent emporte tout son dossier', async () => {
  await deleteAgent('eloise-2');
  assert.ok(!existsSync(path.join(DIRS.agents, 'eloise-2')));
  assert.deepEqual((await listAgents()).map((a) => a.id), ['eloise']);
});
