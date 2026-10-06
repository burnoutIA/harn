import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { internalKey } from './api-keys.mjs';
import { displayName, modelById } from './catalog.mjs';
import { agentInstructions } from './machine-doc.mjs';
import { DIRS, PORTS, fromRoot } from './paths.mjs';
import { getState, update } from './state.mjs';

const run = promisify(execFile);
const PACKAGE = '@earendil-works/pi-coding-agent';
const PREFIX = fromRoot('runtime', 'pi');

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
// client près du seuil) et le plafond de sortie ne dépend pas de la fenêtre.
export async function configurePi(preferredModel = null) {
  const state = getState();
  await mkdir(DIRS.piAgent, { recursive: true });
  const installed = Object.keys(state.models).filter((id) => state.models[id].installedAt && modelById(id));
  const models = installed.map((id) => {
    const model = modelById(id);
    const context = state.profiles[id]?.tuning?.context ?? model.contextByVram[0][1];
    return {
      id,
      name: displayName(model),
      reasoning: model.reasoning,
      input: model.vision ? ['text', 'image'] : ['text'],
      contextWindow: context,
      maxTokens: Math.min(32768, Math.floor(context / 2)),
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    };
  });
  const modelsFile = path.join(DIRS.piAgent, 'models.json');
  const existing = await readJson(modelsFile);
  existing.providers = {
    ...(existing.providers ?? {}),
    harn: { baseUrl: `http://127.0.0.1:${PORTS.app}/v1`, api: 'openai-completions', apiKey: await internalKey(), models },
  };
  await writeFile(modelsFile, JSON.stringify(existing, null, 2));

  const settingsFile = path.join(DIRS.piAgent, 'settings.json');
  const settings = await readJson(settingsFile);
  // Un modèle demandé explicitement (lancement de pi), sinon le modèle par défaut (cœur), sinon le chargé.
  const favorite = installed.includes(state.favorite) ? state.favorite : null;
  const defaultModel = preferredModel ?? favorite ?? state.active?.modelId ?? installed[0];
  Object.assign(settings, { defaultProvider: 'harn', defaultModel, defaultThinkingLevel: settings.defaultThinkingLevel ?? 'medium' });
  await writeFile(settingsFile, JSON.stringify(settings, null, 2));
  // Consignes globales de pi : la référence des leviers et le carnet de cette machine.
  if (state.hardware) await writeFile(path.join(DIRS.piAgent, 'AGENTS.md'), agentInstructions(state.hardware));
  await ensureAppendSystem();
  await installSkills();
  await configureMcp();
  return { modelsFile, settingsFile, defaultModel };
}

// ── Recherche web : ketch en serveur MCP ───────────────────────
// Config et marque-pages isolés dans data/ketch : on ne touche pas à une éventuelle config
// ketch personnelle (%AppData%\ketch), et le moteur « auto » essaie les fournisseurs sans clé.
export const KETCH_ENV = {
  KETCH_CONFIG: path.join(DIRS.data, 'ketch', 'config.json'),
  KETCH_TAGS_PATH: path.join(DIRS.data, 'ketch', 'tags.db'),
};

async function configureMcp() {
  const ketch = getState().ketch;
  const file = path.join(DIRS.piAgent, 'mcp.json');
  const config = await readJson(file);
  config.mcpServers = { ...(config.mcpServers ?? {}) };
  config.autoEnableCodemode ??= false;
  // Les outils de Harn lui-même : analyser, installer, mesurer et tester un modèle.
  config.mcpServers.harn = {
    command: process.execPath,
    args: [fromRoot('src', 'harn-mcp.mjs')],
    env: { HARN_PORT: String(PORTS.app) },
    timeout: 900,
    exposure: 'direct',
    description: 'Harn, le serveur d’IA locale de cette machine : analyser un modèle Hugging Face, l’installer, le mesurer et tester son intelligence.',
  };
  if (ketch?.path) {
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
- Pour une information récente, une documentation ou un fait que tu ne connais pas avec
  certitude, utilise les outils de recherche web ketch (search, scrape, docs, code) plutôt
  que de deviner, et cite tes sources.
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
async function installSkills() {
  const source = fromRoot('src', 'skills');
  for (const name of await readdir(source).catch(() => [])) {
    if (!name.endsWith('.md')) continue;
    const dir = path.join(DIRS.piAgent, 'skills', name.replace(/\.md$/, ''));
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, 'SKILL.md'), await readFile(path.join(source, name), 'utf8'));
  }
}

async function hasWindowsTerminal() {
  return run('where', ['wt.exe'], { windowsHide: true }).then(() => true).catch(() => false);
}

// pi est une application de terminal : on lui ouvre sa propre fenêtre, déjà branchée.
export async function launchPi(modelId = null, prompt = null) {
  const { defaultModel } = await configurePi(modelId);
  await mkdir(DIRS.workspace, { recursive: true });
  const cli = await piCli();
  const env = { ...process.env, PI_CODING_AGENT_DIR: DIRS.piAgent };
  const title = 'pi · Harn';
  if (process.platform === 'win32') {
    if (await hasWindowsTerminal()) {
      spawn('wt.exe', ['-w', 'new', '--title', title, '-d', DIRS.workspace, process.execPath, cli, ...(prompt ? [prompt.replaceAll(';', ',')] : [])], { env, detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('cmd.exe', ['/c', 'start', `"${title}"`, '/D', DIRS.workspace, `"${process.execPath}"`, `"${cli}"`, ...(prompt ? [`"${prompt.replace(/["&|<>^%]/g, ' ')}"`] : [])], { env, detached: true, stdio: 'ignore', windowsVerbatimArguments: true }).unref();
    }
  } else {
    spawn('x-terminal-emulator', ['-e', process.execPath, cli], { env, cwd: DIRS.workspace, detached: true, stdio: 'ignore' }).unref();
  }
  update((s) => { s.pi = { ...s.pi, lastLaunch: new Date().toISOString(), lastModel: defaultModel }; });
  return { model: defaultModel, workspace: DIRS.workspace };
}
