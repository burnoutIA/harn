import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { approvalOf, decideApproval, requestApproval } from './approvals.mjs';
import { displayName, modelById } from './catalog.mjs';
import { getLive } from './metrics.mjs';
import { closePiSession, configurePiDir, openPiTerminal } from './pi.mjs';
import { DIRS, PORTS } from './paths.mjs';
import { bus, getState } from './state.mjs';

// Les agents : un par personne, chacun dans data/agents/<id> (hors dépôt). Sa fiche (agent.json),
// son dossier pi (consignes, sessions, outils) et son workspace y vivent ensemble. Le pi de test
// lancé depuis un modèle garde les siens (data/pi-agent, workspace) : les deux ne se voient pas.

const MAX_NAME = 60;
const MAX_PROMPT = 20_000;
// La mémoire est jointe au prompt de chaque conversation : ~1 500 tokens au plus.
const MAX_MEMORY = 6000;
// Ce qu'un nouvel agent peut faire : le moins possible, on coche ce dont il a besoin.
// autostart : lancé avec Harn, pour que son bot Telegram réponde sans qu'on y pense.
// memory : il note lui-même ce qu'il juge durable, et le relit à chaque conversation.
const DEFAULT_OPTIONS = { shell: false, harnTools: false, web: true, memory: true, autostart: false };

const failure = (status, message) => Object.assign(new Error(message), { status });
const slugify = (text) => text.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

const dirOf = (id) => path.join(DIRS.agents, id);
const piDirOf = (id) => path.join(dirOf(id), 'pi-agent');
const workspaceOf = (id) => path.join(dirOf(id), 'workspace');
const promptFileOf = (id) => path.join(piDirOf(id), 'APPEND_SYSTEM.md');
// Lus par l'extension telegram-follow dans le dossier pi de l'agent : ce qu'elle doit écouter, et
// le pid du pi qui écoute déjà.
const telegramFileOf = (id) => path.join(piDirOf(id), 'telegram.json');
const telegramLockOf = (id) => path.join(piDirOf(id), 'telegram.lock');
// La mémoire de l'agent, et ce que l'extension agent-memory lit pour la trouver.
const memoryFileOf = (id) => path.join(dirOf(id), 'MEMORY.md');
const memoryConfigOf = (id) => path.join(piDirOf(id), 'memory.json');
const sessionOf = (id) => `harn-${id}`;
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
  // Le jeton du bot ne ressort jamais : l'interface sait seulement qu'il y en a un.
  return {
    ...agent,
    telegram: agent.telegram ? { ownerId: agent.telegram.ownerId } : null,
    prompt: await readFile(promptFileOf(agent.id), 'utf8').catch(() => ''),
    memory: await readFile(memoryFileOf(agent.id), 'utf8').catch(() => ''),
    memoryMax: MAX_MEMORY,
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

// Un bot par agent, une personne par bot. Jeton vide : celui déjà enregistré reste. Identifiant
// vide : Telegram est retiré de l'agent.
function checkTelegram(patch, current) {
  const owner = String(patch.ownerId ?? '').trim();
  if (!owner) return null;
  if (!/^\d{1,15}$/.test(owner)) throw failure(400, 'L’identifiant Telegram est un nombre (celui que donne @userinfobot)');
  const token = String(patch.token ?? '').trim() || current?.token;
  if (!token) throw failure(400, 'Collez le jeton du bot, donné par @BotFather');
  if (!/^\d+:[\w-]{30,}$/.test(token)) throw failure(400, 'Ce jeton n’a pas la forme d’un jeton de bot Telegram (123456:ABC…)');
  return { token, ownerId: Number(owner) };
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
  if (patch.telegram) {
    const telegram = checkTelegram(patch.telegram, agent.telegram);
    if (telegram) agent.telegram = telegram; else delete agent.telegram;
  }
  if (typeof patch.prompt === 'string') {
    if (patch.prompt.length > MAX_PROMPT) throw failure(400, `Consignes limitées à ${MAX_PROMPT.toLocaleString('fr-FR')} caractères`);
    await mkdir(piDirOf(id), { recursive: true });
    await writeFile(promptFileOf(id), patch.prompt);
  }
  if (typeof patch.memory === 'string') {
    if (patch.memory.length > MAX_MEMORY) throw failure(400, `Mémoire limitée à ${MAX_MEMORY.toLocaleString('fr-FR')} caractères : retirez ce qui ne sert plus`);
    await writeFile(memoryFileOf(id), patch.memory);
  }
  await writeAgent(agent);
  return describe(agent);
}

// Tout le dossier part : la fiche, les consignes, la mémoire, les sessions et le workspace. Son pi
// s'arrête aussi : un agent recréé sous le même nom ne doit pas retomber dans l'ancien.
export async function deleteAgent(id) {
  const agent = await readAgent(id);
  await closePiSession(sessionOf(id));
  await rm(dirOf(id), { recursive: true, force: true });
  return agent;
}

// Le dossier pi de l'agent est réécrit à chaque lancement : modèles installés, options cochées.
// Son modèle se charge à sa première requête, comme pour toute application branchée sur /v1.
export async function launchAgent(id, { window = true } = {}) {
  const agent = await readAgent(id);
  if (!getState().pi.installed) throw failure(409, 'pi agent n’est pas encore installé');
  if (agent.model && !installed(agent.model)) throw failure(409, 'Le modèle de cet agent n’est plus installé : choisissez-en un autre');
  const { defaultModel } = await configurePiDir(piDirOf(id), { preferredModel: agent.model, options: agent.options });
  if (!defaultModel) throw failure(409, 'Aucun modèle installé pour l’instant');
  // harn, agent : pour demander la carte avant chaque message (claimCard).
  if (agent.telegram) await writeFile(telegramFileOf(id), JSON.stringify({ ...agent.telegram, agent: id, harn: `http://127.0.0.1:${PORTS.app}` }));
  else await rm(telegramFileOf(id), { force: true });
  if (agent.options.memory) await writeFile(memoryConfigOf(id), JSON.stringify({ file: memoryFileOf(id), maxChars: MAX_MEMORY }));
  else await rm(memoryConfigOf(id), { force: true });
  // Le titre passe par la ligne de commande du terminal : sans ses caractères spéciaux.
  // Ce que pi ne lit qu'à son démarrage : modèle, outils, consignes, bot. Changé, son pi est relancé.
  const prompt = await readFile(promptFileOf(id), 'utf8').catch(() => '');
  const { autostart, ...tools } = agent.options;
  const stamp = createHash('sha256').update(JSON.stringify([agent.model, tools, prompt, agent.telegram ?? null])).digest('hex').slice(0, 16);
  const opened = await openPiTerminal({ title: `${agent.name.replace(/["&|<>^%;]/g, ' ')} · Harn`, cwd: workspaceOf(id), piDir: piDirOf(id), session: sessionOf(id), stamp, window });
  return { ...opened, model: defaultModel, workspace: workspaceOf(id) };
}

// Un pi de cet agent écoute déjà son bot (verrou posé par l'extension, pid encore vivant).
async function listening(id) {
  const pid = Number(await readFile(telegramLockOf(id), 'utf8').catch(() => 0));
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// Au démarrage de Harn : les agents cochés repartent, sans fenêtre quand tmux les porte. Celui
// qui tourne encore (Harn seul a redémarré) n'est pas relancé.
export async function startAgents() {
  if (!getState().pi.installed) return;
  for (const agent of await listAgents()) {
    if (!agent.options.autostart || await listening(agent.id)) continue;
    await launchAgent(agent.id, { window: false }).catch((error) => console.error(`[harn] agent « ${agent.name} » non lancé : ${error.message}`));
  }
}

// ── À qui est l'inférence ──────────────────────────────────────
// Avant d'injecter un message reçu, l'agent demande la carte. Aucune réponse en cours : il la
// prend, et la fenêtre de Harn le dit d'un mot. Une réponse en cours pour quelqu'un d'autre : la
// demande s'affiche dans la fenêtre, où l'utilisateur laisse sa place ou non. Sans réponse de sa
// part, elle passe au bout d'une minute, ou dès que la réponse en cours se termine.
const CLAIM_TIMEOUT_MS = 60_000;
const claims = new Map(); // id de l'agent → demande en attente

export async function claimCard(id) {
  const agent = await readAgent(id);
  const pending = claims.get(id);
  if (pending && approvalOf(pending)?.status === 'pending') return { status: 'pending', approval: pending };
  const current = getLive().request;
  if (!current) {
    bus.emit('toast', `${agent.name} utilise l’IA`);
    return { status: 'free' };
  }
  const state = getState();
  const wanted = agent.model ?? (installed(state.favorite) ? state.favorite : state.active?.modelId);
  const busyModel = modelById(current.model);
  const effect = wanted === current.model ? 'Même modèle : rien n’est interrompu, sa demande passe à la suite.' : 'Son modèle est différent : accepter interrompt la réponse en cours.';
  const approval = requestApproval({
    kind: 'card',
    title: `${agent.name} veut utiliser l’IA`,
    detail: `Une réponse est en cours (${busyModel ? displayName(busyModel) : current.model}, ${current.client}). ${effect} Sans réponse de votre part, sa demande passe dans une minute.`,
    run: () => {},
  });
  claims.set(id, approval);
  const since = Date.now();
  const watch = setInterval(() => {
    if (approvalOf(approval)?.status !== 'pending') return clearInterval(watch);
    if (getLive().request && Date.now() - since < CLAIM_TIMEOUT_MS) return;
    clearInterval(watch);
    try { decideApproval(approval, true); } catch { /* décidée entre-temps */ }
  }, 1000);
  watch.unref?.();
  return { status: 'pending', approval };
}
