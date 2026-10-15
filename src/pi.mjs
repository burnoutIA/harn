import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { internalKey } from './api-keys.mjs';
import { displayName, modelById } from './catalog.mjs';
import { agentInstructions } from './machine-doc.mjs';
import { outputBudget, outputUsage } from './output-budget.mjs';
import { DIRS, PORTS, fromRoot } from './paths.mjs';
import { getState, update } from './state.mjs';

const run = promisify(execFile);
const PACKAGE = '@earendil-works/pi-coding-agent';
const PREFIX = path.join(DIRS.runtime, 'pi');

// pi s'installe dans le dépôt, avec son propre dossier d'agent (PI_CODING_AGENT_DIR) :
// rien ne touche au ~/.pi de l'utilisateur s'il en a déjà un.
export async function installPi(onLog = () => {}) {
  await mkdir(PREFIX, { recursive: true });
  onLog(`npm install ${PACKAGE}`);
  await run('npm', ['install', '--prefix', PREFIX, '--ignore-scripts', '--no-fund', '--no-audit', PACKAGE], {
    shell: true, windowsHide: true, timeout: 600_000, maxBuffer: 32 * 1024 * 1024,
  });
  const pkg = JSON.parse(await readFile(path.join(PREFIX, 'node_modules', ...PACKAGE.split('/'), 'package.json'), 'utf8'));
  update((s) => { s.pi = { ...s.pi, installed: true, version: pkg.version }; });
  return pkg.version;
}

async function piCli() {
  const dir = path.join(PREFIX, 'node_modules', ...PACKAGE.split('/'));
  const pkg = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
  const bin = typeof pkg.bin === 'string' ? pkg.bin : Object.values(pkg.bin ?? {})[0];
  return path.join(dir, bin);
}

async function readJson(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return {}; }
}

// La configuration que pi lit : un fournisseur « harn » qui pointe sur notre /v1, un modèle
// par modèle installé. La fenêtre annoncée est la vraie (la réduire étrangle les réponses du
// client près du seuil). Sortie et place garantie avant compaction : calculées par modèle
// (output-budget.mjs) d'après sa famille et son vrai usage. pi ramène de lui-même max_tokens à la
// place qui reste ; il compacte quand il en reste moins que la réserve du modèle.
export async function configurePi(preferredModel = null) {
  const configured = await configurePiDir(DIRS.piAgent, { preferredModel });
  await ensureAppendSystem();
  return configured;
}

// Le pi de test reçoit tout. Un agent (agents.mjs) a son propre dossier et choisit : shell,
// outils de Harn, recherche web.
const EVERYTHING = { shell: true, harnTools: true, web: true, images: true };
const NO_SHELL = ['-bash', '-powershell'];

// agent : l'identifiant de l'agent à qui est ce dossier (null pour le pi de test).
export async function configurePiDir(dir, { preferredModel = null, options = EVERYTHING, agent = null, imageModel = null } = {}) {
  const state = getState();
  await mkdir(dir, { recursive: true });
  const installed = Object.keys(state.models).filter((id) => state.models[id].installedAt && modelById(id));
  const usage = await outputUsage();
  const budgets = {};
  const models = installed.map((id) => {
    const model = modelById(id);
    const context = state.profiles[id]?.tuning?.context ?? model.contextByVram[0][1];
    const budget = budgets[id] = outputBudget(model, context, usage[id], state.profiles[id]?.iq);
    return {
      id,
      name: displayName(model),
      reasoning: model.reasoning,
      input: model.vision ? ['text', 'image'] : ['text'],
      contextWindow: context,
      maxTokens: budget.maxTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  });
  const modelsFile = path.join(dir, 'models.json');
  const existing = await readJson(modelsFile);
  existing.providers = {
    ...(existing.providers ?? {}),
    harn: { baseUrl: `http://127.0.0.1:${PORTS.app}/v1`, api: 'openai-completions', apiKey: await internalKey(), models },
  };
  await writeFile(modelsFile, JSON.stringify(existing, null, 2));

  const settingsFile = path.join(dir, 'settings.json');
  const settings = await readJson(settingsFile);
  // Un modèle demandé explicitement (lancement de pi), sinon le modèle par défaut (cœur), sinon le chargé.
  const favorite = installed.includes(state.favorite) ? state.favorite : null;
  const defaultModel = preferredModel ?? favorite ?? state.active?.modelId ?? installed[0];
  Object.assign(settings, { defaultProvider: 'harn', defaultModel, defaultThinkingLevel: settings.defaultThinkingLevel ?? 'medium' });
  settings.compaction = { ...(settings.compaction ?? {}), modelOverrides: { ...(settings.compaction?.modelOverrides ?? {}) } };
  for (const model of models) settings.compaction.modelOverrides[`harn/${model.id}`] = { reserveTokens: budgets[model.id].reserve };
  // Sans shell : les deux outils de commande sont retirés de la sélection de départ. La case
  // recochée, on ne retire que ce que Harn avait posé.
  if (!options.shell) settings.defaultTools = NO_SHELL;
  else if (JSON.stringify(settings.defaultTools) === JSON.stringify(NO_SHELL)) delete settings.defaultTools;
  await writeFile(settingsFile, JSON.stringify(settings, null, 2));
  // Consignes globales de pi : la référence des leviers et le carnet de cette machine. Elles et
  // les skills ne servent qu'à qui a les outils de Harn.
  if (!options.harnTools) await rm(path.join(dir, 'AGENTS.md'), { force: true });
  else if (state.hardware) await writeFile(path.join(dir, 'AGENTS.md'), agentInstructions(state.hardware));
  await installSkills(dir, options);
  await installExtensions(dir);
  await configureMcp(dir, options);
  // Lu par l'extension image-gen : sans ce fichier, pas d'outil de génération d'images.
  const imageFile = path.join(dir, 'image.json');
  if (options.images) await writeFile(imageFile, JSON.stringify({ harn: `http://127.0.0.1:${PORTS.app}`, agent, imageModel }));
  else await rm(imageFile, { force: true });
  return { modelsFile, settingsFile, defaultModel };
}

// ── Recherche web : ketch en serveur MCP ───────────────────────
// Config et marque-pages isolés dans data/ketch : on ne touche pas à une éventuelle config
// ketch personnelle (%AppData%\ketch), et le moteur « auto » essaie les fournisseurs sans clé.
export const KETCH_ENV = {
  KETCH_CONFIG: path.join(DIRS.data, 'ketch', 'config.json'),
  KETCH_TAGS_PATH: path.join(DIRS.data, 'ketch', 'tags.db'),
};

async function configureMcp(dir, { harnTools, web }) {
  const ketch = getState().ketch;
  const file = path.join(dir, 'mcp.json');
  const config = await readJson(file);
  config.mcpServers = { ...(config.mcpServers ?? {}) };
  config.autoEnableCodemode ??= false;
  // Les deux serveurs appartiennent à Harn : retirés, puis reposés selon les options.
  delete config.mcpServers.harn;
  delete config.mcpServers.ketch;
  // Les outils de Harn lui-même : analyser, installer, mesurer et tester un modèle.
  if (harnTools) config.mcpServers.harn = {
    command: process.execPath,
    args: [fromRoot('src', 'harn-mcp.mjs')],
    env: { HARN_PORT: String(PORTS.app) },
    timeout: 900,
    exposure: 'direct',
    description: 'Harn, le serveur d’IA locale de cette machine : analyser un modèle Hugging Face, l’installer, le mesurer et tester son intelligence.',
  };
  if (web && ketch?.path) {
    config.mcpServers.ketch = {
      command: ketch.path,
      args: ['mcp', 'serve'],
      env: KETCH_ENV,
      timeout: 120,
      // Outils déclarés directement au modèle : un modèle local appelle un outil plus sûrement
      // qu'il n'écrit un script codemode. crawl et tag ne servent pas ici.
      exposure: 'direct',
      toolExposure: { crawl: 'hidden', tag: 'hidden' },
      description: 'Recherche web, documentation de librairies, code open source et lecture de pages web (ketch, sans clé API).',
    };
  }
  await mkdir(path.join(DIRS.data, 'ketch'), { recursive: true });
  await writeFile(file, JSON.stringify(config, null, 2));
}

export async function ketchSearch(query) {
  const ketch = getState().ketch;
  if (!ketch?.path) throw new Error('ketch n’est pas installé');
  await mkdir(path.join(DIRS.data, 'ketch'), { recursive: true });
  const started = Date.now();
  const { stdout } = await run(ketch.path, ['search', query, '-l', '3', '--json'], {
    env: { ...process.env, ...KETCH_ENV }, windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024,
  });
  const results = JSON.parse(stdout);
  return { seconds: (Date.now() - started) / 1000, results: [].concat(results).map(({ title, url, description }) => ({ title, url, description: description?.slice(0, 180) })) };
}

// ── Instructions de pi : APPEND_SYSTEM.md ──────────────────────
// pi ajoute ce fichier à son prompt système à chaque démarrage. Harn en crée un s'il n'existe
// pas, puis ne le réécrit jamais : il appartient à l'utilisateur.
export const APPEND_SYSTEM = path.join(DIRS.piAgent, 'APPEND_SYSTEM.md');
const DEFAULT_APPEND_SYSTEM = `# Consignes personnelles pour pi agent

Ce texte est ajouté au prompt système de pi à chaque démarrage. Modifiez-le librement :
les changements comptent au prochain lancement de pi, ou après la commande /reload.

- Réponds en français, de façon claire et concise.
- Tu tournes en local sur cette machine, servi par Harn.
- Pour un fait que tu ne connais pas avec certitude, cherche dans cet ordre, et cite tes sources :
  1. les sources locales : la référence des leviers, le carnet de la machine, l'outil
     \`harn_status\` et les fichiers du projet. Sur cette machine, elles font foi ;
  2. sinon, la recherche web ketch (search, scrape, docs, code) ;
  3. jamais deviner.
`;

export async function ensureAppendSystem() {
  await mkdir(DIRS.piAgent, { recursive: true });
  const existing = await readFile(APPEND_SYSTEM, 'utf8').catch(() => null);
  if (existing === null) await writeFile(APPEND_SYSTEM, DEFAULT_APPEND_SYSTEM);
  return readFile(APPEND_SYSTEM, 'utf8');
}

// Ouvre un fichier dans l'éditeur Windows associé aux .md, sinon dans le Bloc-notes.
export async function openInEditor(file) {
  if (process.platform !== 'win32') {
    spawn('xdg-open', [file], { detached: true, stdio: 'ignore' }).unref();
    return 'éditeur par défaut';
  }
  const associated = await run('cmd.exe', ['/c', 'assoc', path.extname(file)], { windowsHide: true }).then(() => true).catch(() => false);
  if (associated) {
    spawn('cmd.exe', ['/c', 'start', '""', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return 'éditeur par défaut';
  }
  spawn('notepad.exe', [file], { detached: true, stdio: 'ignore' }).unref();
  return 'Bloc-notes';
}

// Les skills fournis par Harn (réécrits à chaque configuration : ils appartiennent à Harn).
// Chaque skill va avec une case : les outils de Harn par défaut, sauf ceux nommés ici.
const SKILL_OPTION = { 'ecrire-une-image': 'images' };
async function installSkills(piDir, options) {
  const source = fromRoot('src', 'skills');
  for (const name of await readdir(source).catch(() => [])) {
    if (!name.endsWith('.md')) continue;
    const skill = name.replace(/\.md$/, '');
    const dir = path.join(piDir, 'skills', skill);
    if (!options[SKILL_OPTION[skill] ?? 'harnTools']) { await rm(dir, { recursive: true, force: true }); continue; }
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), await readFile(path.join(source, name), 'utf8'));
  }
}

// Les extensions pi fournies par Harn (src/pi-extensions, un dossier par extension), recopiées
// à chaque configuration comme les skills. ctx-optimizer vient du projet ctx_optimizer/pi : on
// l'y fait évoluer, puis on recopie ses fichiers ici.
// L'empreinte des extensions fournies : un pi lancé avant leur dernière version tourne encore avec
// l'ancienne, et doit être relancé pour prendre la nouvelle.
export async function extensionsDigest() {
  const hash = createHash('sha256');
  const source = fromRoot('src', 'pi-extensions');
  for (const entry of (await readdir(source, { recursive: true, withFileTypes: true }).catch(() => [])).filter((e) => e.isFile()).sort((a, b) => path.join(a.parentPath, a.name).localeCompare(path.join(b.parentPath, b.name)))) {
    hash.update(entry.name).update(await readFile(path.join(entry.parentPath, entry.name)));
  }
  return hash.digest('hex').slice(0, 12);
}

async function installExtensions(piDir) {
  const source = fromRoot('src', 'pi-extensions');
  for (const entry of await readdir(source, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await cp(path.join(source, entry.name), path.join(piDir, 'extensions', entry.name), { recursive: true, force: true });
  }
}

async function hasWindowsTerminal() {
  return run('where', ['wt.exe'], { windowsHide: true }).then(() => true).catch(() => false);
}

// Sous Linux, pi et tout ce qu'il lance (son shell, ses scripts, ses serveurs MCP) tournent dans
// un groupe à mémoire plafonnée : un script qui s'emballe est tué par le noyau, au lieu de
// remplir la RAM et de figer la machine. Un quart de la mémoire, 4 Go au moins, sans échange.
let memoryCap;
async function cappedMemory() {
  if (process.platform !== 'linux') return [];
  if (!memoryCap) {
    const max = Math.max(4 * 1024 ** 3, Math.round(os.totalmem() / 4));
    const prefix = ['systemd-run', '--user', '--scope', '--quiet', '--collect', '-p', `MemoryMax=${max}`, '-p', 'MemorySwapMax=0', '--'];
    // Sans systemd utilisateur (conteneur, session sans bus) : pi se lance quand même, sans plafond.
    memoryCap = await run(prefix[0], [...prefix.slice(1), 'true']).then(() => prefix, () => []);
  }
  return memoryCap;
}

const STAMP = '@harn-stamp';
// Les agents tournent sur un serveur tmux à part (tmux -L harn) : Harn y pose ses réglages sans
// toucher aux sessions tmux de l'utilisateur. Pour s'y rattacher à la main : tmux -L harn attach.
// HARN_TMUX : un autre nom de serveur, pour que les tests ne voient jamais les vrais agents.
const TMUX_SERVER = process.env.HARN_TMUX ?? 'harn';
const tmux = (args) => run('tmux', ['-L', TMUX_SERVER, ...args]);
// Posés avant le premier pi : sans extended-keys, Maj+Entrée lui arrive comme une Entrée simple.
const TMUX_SETUP = [
  'start-server', ';', 'set-option', '-s', 'extended-keys', 'on', ';', 'set-option', '-s', 'extended-keys-format', 'csi-u', ';', 'set-option', '-as', 'terminal-features', 'xterm*:extkeys', ';',
];

// Ferme la session tmux d'un pi, et le pi avec. Sans tmux ou sans session : rien à faire.
export async function closePiSession(session) {
  await tmux(['kill-session', '-t', `=${session}`]).catch(() => {});
}

// Les sessions de pi en marche sur le serveur de Harn (sans tmux : aucune).
export async function piSessions() {
  const { stdout } = await tmux(['list-sessions', '-F', '#{session_name}']).catch(() => ({ stdout: '' }));
  return stdout.split('\n').filter((name) => name && name !== OVERVIEW);
}

// Tous les pi en marche dans une seule fenêtre : une session à part, découpée en panneaux, chacun
// rattaché à la session d'un pi. Elle ne porte rien elle-même : la fermer n'arrête personne. La
// souris choisit le panneau ; son titre dit de qui il s'agit. Un pi qui s'arrête ferme son panneau.
const OVERVIEW = 'vue-ensemble';
const SHOWN = '@harn-session';
const overview = `=${OVERVIEW}:`;

// Les sessions affichées en ce moment, lues sur les panneaux eux-mêmes. null : pas de vue.
async function overviewSessions() {
  return tmux(['list-panes', '-t', overview, '-F', `#{${SHOWN}}`]).then((r) => r.stdout.split('\n').filter(Boolean), () => null);
}

async function addOverviewPane({ session, title }, first) {
  const attach = ['env', '-u', 'TMUX', 'tmux', '-L', TMUX_SERVER, 'attach', '-t', `=${session}`];
  const made = first
    ? await tmux(['new-session', '-d', '-P', '-F', '#{pane_id}', '-s', OVERVIEW, '-x', '220', '-y', '60', ...attach])
    : await tmux(['split-window', '-d', '-P', '-F', '#{pane_id}', '-t', overview, ...attach]);
  const pane = made.stdout.trim();
  await tmux(['select-pane', '-t', pane, '-T', title]);
  await tmux(['set-option', '-p', '-t', pane, SHOWN, session]);
  // Rangés à chaque ajout (un panneau trop petit ne se laisse plus découper). Jusqu'à trois : côte
  // à côte, chacun sur toute la hauteur. Au-delà, la grille.
  const count = (await overviewSessions())?.length ?? 1;
  await tmux(['select-layout', '-t', overview, count <= 3 ? 'even-horizontal' : 'tiled']);
}

export async function openPiOverview(panes) {
  if (!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) throw new Error('Pas d’écran où ouvrir un terminal');
  const open = () => spawn('x-terminal-emulator', ['-e', 'tmux', '-L', TMUX_SERVER, 'attach', '-t', `=${OVERVIEW}`], { detached: true, stdio: 'ignore' }).unref();
  // Déjà là avec les mêmes pi : on n'y touche pas (la refaire fermerait la fenêtre sous les yeux de
  // l'utilisateur). Fenêtre encore ouverte : rien à faire ; refermée : on la rouvre sur la même vue.
  const shown = await overviewSessions();
  const wanted = panes.map((pane) => pane.session);
  if (shown && shown.length === wanted.length && wanted.every((session) => shown.includes(session))) {
    const clients = await tmux(['display-message', '-p', '-t', overview, '#{session_attached}']).then((r) => Number(r.stdout), () => 0);
    if (clients > 0) return { already: true };
    open();
    return { already: false };
  }
  await closePiSession(OVERVIEW);
  for (const [index, pane] of panes.entries()) await addOverviewPane(pane, index === 0);
  for (const [option, value] of [['mouse', 'on'], ['pane-border-status', 'top'], ['pane-border-format', ' #{pane_title} ']]) await tmux(['set-option', '-t', overview, option, value]);
  open();
  return { already: false };
}

// Un pi qui démarre rejoint la vue d'ensemble si elle existe : elle suit les pi en marche sans
// qu'il faille la rouvrir.
export async function joinPiOverview(pane) {
  const shown = await overviewSessions();
  if (shown && !shown.includes(pane.session)) await addOverviewPane(pane, false).catch(() => {});
}

// pi est une application de terminal : on lui ouvre sa propre fenêtre, déjà branchée sur son
// dossier (piDir). session : sous Linux avec tmux, pi tourne dans une session de ce nom, qui
// survit à la fenêtre et se passe d'écran ; la relancer s'y rattache au lieu d'ouvrir un second pi.
// stamp : l'empreinte des réglages avec lesquels pi démarre, gardée sur la session. Changée
// depuis, le pi qui tourne est remplacé (il ne relit rien en route) et reprend sa conversation.
// window : false la laisse tourner sans fenêtre (tmux seulement).
// model : imposé au démarrage. Une conversation reprise (--continue) garde sinon le modèle
// qu'elle avait, quoi que dise la fiche de l'agent.
export async function openPiTerminal({ title, cwd, piDir, prompt = null, session = null, stamp = null, window = true, model = null }) {
  await mkdir(cwd, { recursive: true });
  const cli = await piCli();
  const env = { ...process.env, PI_CODING_AGENT_DIR: piDir };
  if (process.platform === 'win32') {
    if (await hasWindowsTerminal()) {
      spawn('wt.exe', ['-w', 'new', '--title', title, '-d', cwd, process.execPath, cli, ...(prompt ? [prompt.replaceAll(';', ',')] : [])], { env, detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('cmd.exe', ['/c', 'start', `"${title}"`, '/D', cwd, `"${process.execPath}"`, `"${cli}"`, ...(prompt ? [`"${prompt.replace(/["&|<>^%]/g, ' ')}"`] : [])], { env, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    }
    return { resumed: false };
  }
  const capped = await cappedMemory();
  if (session && await run('tmux', ['-V']).then(() => true).catch(() => false)) {
    const target = `=${session}`;
    // « =nom » : ce nom exactement ; les options d'une session se visent par « =nom: ».
    let resumed = await tmux(['has-session', '-t', target]).then(() => true).catch(() => false);
    let restarted = false;
    let hadWindow = false;
    if (resumed && stamp) {
      const running = await tmux(['show-options', '-t', `${target}:`, '-v', STAMP]).then((r) => r.stdout.trim()).catch(() => '');
      if (running !== stamp) {
        // Une fenêtre de terminal y était ouverte (la vue d'ensemble, elle, s'y rattache depuis
        // tmux) : elle se ferme avec la session, on en rouvre une sur le nouveau pi.
        hadWindow = await tmux(['list-clients', '-t', target, '-F', '#{client_termname}']).then((r) => r.stdout.split('\n').some((term) => term && !/^(tmux|screen)/.test(term)), () => false);
        await closePiSession(session);
        resumed = false;
        restarted = true;
      }
    }
    if (!resumed) {
      // Un serveur tmux déjà lancé ne reprend pas notre environnement : la variable passe par env.
      await tmux([...TMUX_SETUP, 'new-session', '-d', '-s', session, '-c', cwd, 'env', `PI_CODING_AGENT_DIR=${piDir}`, ...capped, process.execPath, cli, ...(restarted ? ['--continue'] : []), ...(model ? ['--model', `harn/${model}`] : [])]);
      if (stamp) await tmux(['set-option', '-t', `${target}:`, STAMP, stamp]).catch(() => {});
    }
    if ((window || hadWindow) && (process.env.DISPLAY || process.env.WAYLAND_DISPLAY)) spawn('x-terminal-emulator', ['-e', 'tmux', '-L', TMUX_SERVER, 'attach', '-t', target], { detached: true, stdio: 'ignore' }).unref();
    return { resumed, restarted, session };
  }
  // Dossier et variable passent par la commande elle-même : un terminal déjà ouvert qui reprend la
  // demande à son compte (une seule instance par application) ne garde ni l'un ni l'autre.
  spawn('x-terminal-emulator', ['-e', 'env', '-C', cwd, `PI_CODING_AGENT_DIR=${piDir}`, ...capped, process.execPath, cli, ...(prompt ? [prompt] : [])], { env, cwd, detached: true, stdio: 'ignore' }).unref();
  return { resumed: false };
}

export async function launchPi(modelId = null, prompt = null) {
  const { defaultModel } = await configurePi(modelId);
  await openPiTerminal({ title: 'pi · Harn', cwd: DIRS.workspace, piDir: DIRS.piAgent, prompt });
  update((s) => { s.pi = { ...s.pi, lastLaunch: new Date().toISOString(), lastModel: defaultModel }; });
  return { model: defaultModel, workspace: DIRS.workspace };
}
