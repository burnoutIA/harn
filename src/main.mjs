import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { MODELS, modelById, totalBytes } from './catalog.mjs';
import { globalRating, paramsOf } from './rating.mjs';
import { reapOrphans, stopEngine } from './engine.mjs';
import { handleV1, setActivator } from './gateway.mjs';
import { addViewer, getLive, live, loadRecent } from './metrics.mjs';
import { DIRS, PORTS } from './paths.mjs';
import { APPEND_SYSTEM, configurePi, ensureAppendSystem, ketchSearch, launchPi, openInEditor } from './pi.mjs';
import { installKetch } from './runtimes.mjs';
import { activate, busyWith, customJobState, deleteModel, installLogPath, pickHelper, inspectForMachine, installAndTune, installCustom, refreshHardware, runAnalysis, runFirstSetup, runIq, tuneModel } from './setup.mjs';
import { loadCustomModels } from './custom-models.mjs';
import { machineDocPath, writeMachineFacts } from './machine-doc.mjs';
import { bus, getState, loadState, save, update } from './state.mjs';
import { applyCheck } from './system-checks.mjs';

const ORIGIN = `http://127.0.0.1:${PORTS.app}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

// Le catalogue inclut les modèles ajoutés depuis Hugging Face : il se recalcule à chaque lecture.
const catalog = () => MODELS.map((model) => ({ ...model, totalBytes: totalBytes(model), paramsB: paramsOf(model), rating: globalRating(model, getState().profiles?.[model.id]) }));

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

// Les actions de contrôle ne viennent que de notre propre page : une autre page web ouverte
// dans le navigateur ne doit pas pouvoir lancer un téléchargement de 70 Go.
function sameOrigin(req) {
  const origin = req.headers.origin;
  return !origin || origin === ORIGIN || origin === `http://localhost:${PORTS.app}`;
}

async function serveStatic(res, pathname) {
  const file = path.normalize(path.join(DIRS.public, pathname === '/' ? 'index.html' : pathname));
  if (!file.startsWith(DIRS.public)) return json(res, 403, { error: 'interdit' });
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(body);
  } catch {
    json(res, 404, { error: 'introuvable' });
  }
}

// Un résumé lisible par un agent : ce qui tourne, ce qui se télécharge, ce qui se mesure.
function compactStatus() {
  const s = getState();
  const downloads = Object.entries(s.downloads).filter(([, d]) => !d.done).map(([id, d]) => ({ id, file: d.label, percent: d.total ? Math.round((d.received / d.total) * 100) : null, speedMBps: d.speed ? +(d.speed / 1e6).toFixed(0) : null }));
  const models = MODELS.filter((m) => s.models[m.id]?.installedAt || s.models[m.id]?.installing).map((m) => {
    const p = s.profiles[m.id] ?? {};
    return { id: m.id, name: `${m.name} · ${m.variant}`, installed: Boolean(s.models[m.id]?.installedAt), installing: Boolean(s.models[m.id]?.installing), tuning: s.models[m.id]?.tuneDetail ?? null, benchTps: p.bench?.winner?.tps ?? null, setting: p.bench?.winner?.label ?? null, context: p.tuning?.context ?? null, paramsB: paramsOf(m), noteGlobale: globalRating(m, p)?.score ?? null, intelligence: p.iq?.version === 2 ? { score: p.iq.score, raisonnement: `${p.iq.categories.raisonnement.points}/${p.iq.categories.raisonnement.total}`, outils: `${p.iq.categories.outils.points}/${p.iq.categories.outils.total}`, debogage: `${Math.round(p.iq.categories.debogage.ratio * 100)} %`, honnetete: `${p.iq.categories.honnetete.points}/${p.iq.categories.honnetete.total}`, reflexion: p.iq.verbosity.label } : null, iqRunning: p.iqRunning ?? null, quality: m.quality, error: s.models[m.id]?.error ?? null };
  });
  return { machine: s.plan?.summary?.machine, objective: '100k-150k de contexte, 40 tok/s minimum, le modèle le plus intelligent possible', active: s.active ? { model: s.active.modelId, status: s.active.status } : null, busyWith: busyWith(), downloads, models };
}

function events(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  const send = (type, payload) => res.write(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`);
  send('state', getState());
  send('live', getLive());
  const onState = (state) => send('state', state);
  const onLive = (snapshot) => send('live', snapshot);
  bus.on('state', onState);
  live.on('live', onLive);
  const release = addViewer();
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15_000);
  req.on('close', () => {
    bus.off('state', onState);
    live.off('live', onLive);
    clearInterval(keepAlive);
    release();
  });
}

// Ce qu'un arrêt interromprait : installations, réglages, bancs, téléchargements, analyse,
// requête d'inférence en vol. Sert à « npm run stop » et « npm run restart ».
function activity() {
  const s = getState();
  const name = (id) => { const m = modelById(id); return m ? `${m.name} · ${m.variant}` : id; };
  const out = [];
  if (s.setup?.phase === 'running') out.push('Première installation de Harn');
  const job = customJobState();
  if (job?.running) out.push(`Ajout d’un modèle depuis Hugging Face (${job.detail ?? job.step})`);
  for (const [id, m] of Object.entries(s.models ?? {})) {
    if (m.installing) out.push(`Installation de ${name(id)}`);
    else if (m.tuneDetail) out.push(`Réglage de ${name(id)} (${m.tuneDetail})`);
  }
  if (busyWith() && !s.models?.[busyWith()]?.tuneDetail) out.push(`Banc de vitesse sur ${name(busyWith())}`);
  for (const [id, p] of Object.entries(s.profiles ?? {})) if (p.iqRunning) out.push(`Test d’intelligence de ${name(id)} (${p.iqRunning})`);
  for (const [, d] of Object.entries(s.downloads ?? {})) if (!d.done) out.push(`Téléchargement de ${d.label}`);
  if (s.machineDoc?.analysing) out.push('Analyse de la machine par pi');
  if (s.active?.status === 'loading') out.push(`Chargement de ${name(s.active.modelId)}`);
  if (getLive().request) out.push('Une réponse est en cours de génération');
  return out;
}

// Les actions longues répondent tout de suite ; leur avancement passe par /api/events.
const background = (promise) => { promise.catch((error) => console.error(`[harn] ${error.message}`)); };

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // api, ...
  if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, { state: getState(), live: getLive(), catalog: catalog() });
  if (req.method === 'GET' && url.pathname === '/api/catalog') return json(res, 200, catalog());
  if (req.method === 'GET' && url.pathname === '/api/status') return json(res, 200, compactStatus());
  if (req.method === 'GET' && url.pathname === '/api/custom/job') return json(res, 200, customJobState() ?? { running: false });
  if (req.method === 'GET' && url.pathname === '/api/activity') return json(res, 200, { pid: process.pid, activity: activity() });
  if (req.method === 'POST' && url.pathname === '/api/shutdown') {
    // Arrêt demandé par « npm run stop » / « npm run restart » : on répond, puis on ferme proprement.
    json(res, 200, { ok: true, pid: process.pid });
    setTimeout(shutdown, 50);
    return;
  }
  if (req.method === 'GET' && url.pathname === '/api/events') return events(req, res);
  if (req.method === 'GET' && parts[1] === 'models' && parts[3] === 'log' && modelById(parts[2])) {
    const text = await readFile(installLogPath(parts[2]), 'utf8').catch(() => '');
    const entry = getState().models[parts[2]] ?? {};
    return json(res, 200, { model: parts[2], error: entry.error ?? null, installed: Boolean(entry.installedAt), installing: Boolean(entry.installing), log: text.split(/\r?\n/).slice(-200).join('\n') });
  }
  if (req.method === 'GET' && url.pathname === '/api/pi/system') {
    return json(res, 200, { file: APPEND_SYSTEM, text: await ensureAppendSystem() });
  }
  if (req.method === 'GET' && url.pathname === '/api/machine-doc') {
    const file = getState().hardware ? machineDocPath(getState().hardware) : null;
    const text = file ? await readFile(file, 'utf8').catch(() => '') : '';
    return json(res, 200, { file, text });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'méthode' });
  if (!sameOrigin(req)) return json(res, 403, { error: 'origine refusée' });

  if (url.pathname === '/api/setup/start') { background(runFirstSetup()); return json(res, 202, { ok: true }); }
  if (url.pathname === '/api/hardware/refresh') return json(res, 200, await refreshHardware());
  if (parts[1] === 'checks' && parts[2] && parts[3] === 'apply') {
    try {
      const message = await applyCheck(parts[2]);
      await refreshHardware();
      return json(res, 200, { message });
    } catch (error) {
      return json(res, 500, { error: error.message });
    }
  }
  if (url.pathname === '/api/hf/inspect') {
    const body = await new Response(req).json().catch(() => ({}));
    try { return json(res, 200, await inspectForMachine(body.url)); } catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (url.pathname === '/api/custom/install') {
    // Lancement immédiat ; l'avancement se lit sur /api/custom/job (l'outil MCP de pi l'attend).
    const body = await new Response(req).json().catch(() => ({}));
    if (body.user_confirmed !== true) return json(res, 400, { error: 'Installation refusée : il faut la confirmation explicite de l’utilisateur (user_confirmed: true).' });
    try { installCustom(body); return json(res, 202, customJobState()); } catch (error) { return json(res, 409, { error: error.message }); }
  }
  if (url.pathname === '/api/pi/system/open') {
    await ensureAppendSystem();
    return json(res, 200, { editor: await openInEditor(APPEND_SYSTEM) });
  }
  if (url.pathname === '/api/ketch/test') {
    try { return json(res, 200, await ketchSearch('modèles de langage locaux llama.cpp')); } catch (error) { return json(res, 500, { error: error.message.split('\n')[0] }); }
  }
  if (url.pathname === '/api/machine-doc/analyse') { background(runAnalysis()); return json(res, 202, { ok: true }); }
  if (url.pathname === '/api/machine-doc/open') {
    // Le carnet s'ouvre dans l'éditeur Markdown par défaut de l'utilisateur.
    const file = (await writeMachineFacts()) ?? machineDocPath(getState().hardware);
    spawn('cmd.exe', ['/c', 'start', '""', file], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return json(res, 200, { file });
  }
  if (url.pathname === '/api/engine/stop') {
    // Libérer la carte : le moteur s'arrête et Harn s'en souvient (pas de rechargement au
    // prochain démarrage). Une requête d'une application le rechargera quand même.
    await stopEngine();
    update((s) => { if (s.active) s.active.unloadedByUser = true; });
    return json(res, 200, { ok: true });
  }
  if (url.pathname === '/api/pi/launch') {
    const body = await new Response(req).json().catch(() => ({}));
    try { return json(res, 200, await launchPi(body.model ?? null, body.prompt ?? null)); } catch (error) { return json(res, 500, { error: error.message }); }
  }
  if (parts[1] === 'models' && parts[2] && modelById(parts[2])) {
    const id = parts[2];
    if (parts[3] === 'install') { background(installAndTune(id)); return json(res, 202, { ok: true }); }
    if (parts[3] === 'activate') { background(activate(id)); return json(res, 202, { ok: true }); }
    if (parts[3] === 'delete' && req.method === 'POST') {
      try { return json(res, 200, await deleteModel(id)); } catch (error) { return json(res, 409, { error: error.message }); }
    }
    // Une nouvelle mesure appelle une nouvelle analyse de l'IA locale.
    if (parts[3] === 'log' && req.method === 'POST') { return json(res, 200, { editor: await openInEditor(installLogPath(id)) }); }
    if (parts[3] === 'retry') {
      const body = await new Response(req).json().catch(() => ({}));
      background(installAndTune(id, () => {}, { ggufDir: body.gguf_dir ?? null }));
      return json(res, 202, { ok: true });
    }
    if (parts[3] === 'ask-pi') {
      // pi dépanne avec le meilleur modèle installé qui sait manier des outils ; jamais avec le modèle en cause.
      const helper = pickHelper(id);
      if (!helper) return json(res, 409, { error: 'Aucun modèle installé n’a prouvé qu’il sait manier des outils : pi ne peut pas dépanner de façon fiable ici.' });
      await activate(helper);
      const failed = modelById(id);
      const launched = await launchPi(helper, `L’installation de « ${failed.name} · ${failed.variant} » (identifiant ${id}) a échoué. Utilise le skill depanner-une-installation pour comprendre pourquoi et la relancer si c’est possible.`);
      return json(res, 200, { ...launched, helper });
    }
    if (parts[3] === 'iq') { background(runIq(id).then(() => runAnalysis())); return json(res, 202, { ok: true }); }
    if (parts[3] === 'bench') { background(tuneModel(id).then(() => runAnalysis())); return json(res, 202, { ok: true }); }
  }
  return json(res, 404, { error: 'inconnu' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  try {
    if (url.pathname.startsWith('/v1/')) return await handleV1(req, res, url);
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    return await serveStatic(res, url.pathname);
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: error.message });
    else res.end();
  }
});

function openWindow() {
  if (process.argv.includes('--no-open')) return;
  // Une fenêtre d'application (sans barre d'adresse) quand Edge ou Chrome est là.
  if (process.platform === 'win32') {
    spawn('cmd.exe', ['/c', 'start', '""', 'msedge', `--app=${ORIGIN}`, '--window-size=1360,900'], { detached: true, stdio: 'ignore', windowsHide: true })
      .on('exit', (code) => { if (code) spawn('cmd.exe', ['/c', 'start', '""', ORIGIN], { detached: true, stdio: 'ignore' }); })
      .unref();
  } else {
    spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [ORIGIN], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function main() {
  await loadState();
  await loadCustomModels();
  await loadRecent();
  setActivator(activate, busyWith);

  server.on('error', (error) => {
    if (error.code === 'EADDRINUSE') {
      // Déjà lancé : on ouvre simplement la fenêtre de l'instance existante.
      console.log(`Harn tourne déjà sur ${ORIGIN}`);
      openWindow();
      process.exit(0);
    }
    throw error;
  });
  server.listen(PORTS.app, '127.0.0.1', async () => {
    console.log(`Harn · interface ${ORIGIN} · API OpenAI ${ORIGIN}/v1`);
    openWindow();
    await reapOrphans();
    const state = getState();
    if (process.argv.includes('--no-setup')) {
      background(refreshHardware());
    } else if (!state.hardware || state.setup.phase !== 'done') {
      background(runFirstSetup());
    } else {
      background(refreshHardware());
      if (state.pi.installed && !state.ketch) background(installKetch().then(() => configurePi()));
      else if (state.pi.installed) background(configurePi());
      // L'inférence est servie dès l'ouverture : le dernier modèle actif est rechargé.
      const last = state.active?.modelId ?? Object.keys(state.models).find((id) => state.models[id].installedAt);
      if (last && state.models[last]?.installedAt && !state.active?.unloadedByUser) background(activate(last));
    }
  });
}

async function shutdown() {
  await stopEngine().catch(() => {});
  await save().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
