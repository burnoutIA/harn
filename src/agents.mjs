import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { modelById } from './catalog.mjs';
import { configurePiDir, openPiTerminal } from './pi.mjs';
import { DIRS } from './paths.mjs';
import { getState } from './state.mjs';

// Les agents : un par personne, chacun dans data/agents/<id> (hors dépôt). Sa fiche (agent.json),
// son dossier pi (consignes, sessions, outils) et son workspace y vivent ensemble. Le pi de test
// lancé depuis un modèle garde les siens (data/pi-agent, workspace) : les deux ne se voient pas.

const MAX_NAME = 60;
const MAX_PROMPT = 20_000;
// Ce qu'un nouvel agent peut faire : le moins possible, on coche ce dont il a besoin.
const DEFAULT_OPTIONS = { shell: false, harnTools: false, web: true };

const failure = (status, message) => Object.assign(new Error(message), { status });
const slugify = (text) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

const dirOf = (id) => path.join(DIRS.agents, id);
const piDirOf = (id) => path.join(dirOf(id), 'pi-agent');
const workspaceOf = (id) => path.join(dirOf(id), 'workspace');
const promptFileOf = (id) => path.join(piDirOf(id), 'APPEND_SYSTEM.md');
const installed = (modelId) => Boolean(getState().models[modelId]?.installedAt && modelById(modelId));

const defaultPrompt = (name) => `# Consignes de ${name}

Ce texte est ajouté au prompt système de cet agent à chaque démarrage.

- Réponds en français, de façon claire et concise.
- Tu tournes en local sur cette machine, servi par Harn.
`;

// L'identifiant sert de nom de dossier : rien d'autre que ce que slugify produit.
async function readAgent(id) {
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(id)) throw failure(404, 'Agent inconnu');
  try {
    const agent = JSON.parse(await readFile(path.join(dirOf(id), 'agent.json'), 'utf8'));
    return { ...agent, id, options: { ...DEFAULT_OPTIONS, ...agent.options } };
  } catch {
    throw failure(404, 'Agent inconnu');
  }
}

async function writeAgent(agent) {
  await writeFile(path.join(dirOf(agent.id), 'agent.json'), JSON.stringify(agent, null, 2));
}

async function describe(agent) {
  return {
    ...agent,
    prompt: await readFile(promptFileOf(agent.id), 'utf8').catch(() => ''),
    workspace: workspaceOf(agent.id),
    modelInstalled: agent.model ? installed(agent.model) : true,
  };
}

function checkName(value) {
  const name = String(value ?? '').trim();
  if (!name) throw failure(400, 'Donnez un nom à l’agent, par exemple le prénom de la personne');
  if (name.length > MAX_NAME) throw failure(400, `Nom limité à ${MAX_NAME} caractères`);
  return name;
}

// null : pas de modèle attaché, l'agent prend le modèle par défaut de Harn.
function checkModel(value) {
  if (!value) return null;
  if (!installed(value)) throw failure(409, 'Seul un modèle installé peut être attaché à un agent');
  return value;
}

export async function listAgents() {
  const entries = await readdir(DIRS.agents, { withFileTypes: true }).catch(() => []);
  const agents = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const agent = await readAgent(entry.name).catch(() => null);
    if (agent) agents.push(await describe(agent));
  }
  return agents.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

export async function createAgent({ name, model } = {}) {
  const label = checkName(name);
  const base = slugify(label);
  if (!base) throw failure(400, 'Le nom doit contenir au moins une lettre ou un chiffre');
  const taken = new Set((await readdir(DIRS.agents).catch(() => [])));
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  const agent = { id, name: label, model: checkModel(model), options: { ...DEFAULT_OPTIONS }, createdAt: new Date().toISOString() };
  await mkdir(piDirOf(id), { recursive: true });
  await mkdir(workspaceOf(id), { recursive: true });
  await writeAgent(agent);
  await writeFile(promptFileOf(id), defaultPrompt(label));
  return describe(agent);
}

export async function updateAgent(id, patch = {}) {
  const agent = await readAgent(id);
  if ('name' in patch) agent.name = checkName(patch.name);
  if ('model' in patch) agent.model = checkModel(patch.model);
  for (const key of Object.keys(DEFAULT_OPTIONS)) {
    if (typeof patch.options?.[key] === 'boolean') agent.options[key] = patch.options[key];
  }
  if (typeof patch.prompt === 'string') {
    if (patch.prompt.length > MAX_PROMPT) throw failure(400, `Consignes limitées à ${MAX_PROMPT.toLocaleString('fr-FR')} caractères`);
    await mkdir(piDirOf(id), { recursive: true });
    await writeFile(promptFileOf(id), patch.prompt);
  }
  await writeAgent(agent);
  return describe(agent);
}

// Tout le dossier part : la fiche, les consignes, les sessions et le workspace.
export async function deleteAgent(id) {
  const agent = await readAgent(id);
  await rm(dirOf(id), { recursive: true, force: true });
  return agent;
}

// Le dossier pi de l'agent est réécrit à chaque lancement : modèles installés, options cochées.
// Son modèle se charge à sa première requête, comme pour toute application branchée sur /v1.
export async function launchAgent(id) {
  const agent = await readAgent(id);
  if (!getState().pi.installed) throw failure(409, 'pi agent n’est pas encore installé');
  if (agent.model && !installed(agent.model)) throw failure(409, 'Le modèle de cet agent n’est plus installé : choisissez-en un autre');
  const { defaultModel } = await configurePiDir(piDirOf(id), { preferredModel: agent.model, options: agent.options });
  if (!defaultModel) throw failure(409, 'Aucun modèle installé pour l’instant');
  // Le titre passe par la ligne de commande du terminal : sans ses caractères spéciaux.
  const opened = await openPiTerminal({ title: `${agent.name.replace(/["&|<>^%;]/g, ' ')} · Harn`, cwd: workspaceOf(id), piDir: piDirOf(id), session: `harn-${id}` });
  return { ...opened, model: defaultModel, workspace: workspaceOf(id) };
}
