import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
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
const EVERYTHING = { shell: true, harnTools: true, web: true };
const NO_SHELL = ['-bash', '-powershell'];

export async function configurePiDir(dir, { preferredModel = null, options = EVERYTHING } = {}) {
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
  await installSkills(dir, options.harnTools);
  await installExtensions(dir);
  await configureMcp(dir, options);
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
async function installSkills(piDir, wanted) {
  const source = fromRoot('src', 'skills');
  for (const name of await readdir(source).catch(() => [])) {
    if (!name.endsWith('.md')) continue;
    const dir = path.join(piDir, 'skills', name.replace(/\.md$/, ''));
    if (!wanted) { await rm(dir, { recursive: true, force: true }); continue; }
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), await readFile(path.join(source, name), 'utf8'));
  }
}

// Les extensions pi fournies par Harn (src/pi-extensions, un dossier par extension), recopiées
// à chaque configuration comme les skills. ctx-optimizer vient du projet ctx_optimizer/pi : on
// l'y fait évoluer, puis on recopie ses fichiers ici.
async function installExtensions(piDir) {
  const source = fromRoot('src', 'pi-extensions');
  for (const entry of await readdir(source, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) await cp(path.join(source, entry.name), path.join(piDir, 'extensions', entry.name), { recursive: true, force: true });
  }
}

async function hasWindowsTerminal() {
  return run('where', ['wt.exe'], { windowsHide: true }).then(() => true).catch(() => false);
}

// pi est une application de terminal : on lui ouvre sa propre fenêtre, déjà branchée sur son
// dossier (piDir). session : sous Linux avec tmux, pi tourne dans une session de ce nom, qui
// survit à la fenêtre et se passe d'écran ; la relancer s'y rattache au lieu d'ouvrir un second pi.
export async function openPiTerminal({ title, cwd, piDir, prompt = null, session = null }) {
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
  if (session && await run('tmux', ['-V']).then(() => true).catch(() => false)) {
    const target = `=${session}`;
    const resumed = await run('tmux', ['has-session', '-t', target]).then(() => true).catch(() => false);
    // Un serveur tmux déjà lancé ne reprend pas notre environnement : la variable passe par env.
    if (!resumed) await run('tmux', ['new-session', '-d', '-s', session, '-c', cwd, 'env', `PI_CODING_AGENT_DIR=${piDir}`, process.execPath, cli]);
    if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) spawn('x-terminal-emulator', ['-e', 'tmux', 'attach', '-t', target], { detached: true, stdio: 'ignore' }).unref();
    return { resumed, session };
  }
  spawn('x-terminal-emulator', ['-e', process.execPath, cli], { env, cwd, detached: true, stdio: 'ignore' }).unref();
  return { resumed: false };
}

export async function launchPi(modelId = null, prompt = null) {
  const { defaultModel } = await configurePi(modelId);
  await openPiTerminal({ title: 'pi · Harn', cwd: DIRS.workspace, piDir: DIRS.piAgent, prompt });
  update((s) => { s.pi = { ...s.pi, lastLaunch: new Date().toISOString(), lastModel: defaultModel }; });
  return { model: defaultModel, workspace: DIRS.workspace };
}
