import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { MODELS, displayName, modelById, totalBytes, variantOf } from './catalog.mjs';
import { globalRating, paramsOf } from './rating.mjs';
import { IQ_VERSION } from './iq-test.mjs';
import { reapOrphans, stopEngine } from './engine.mjs';
import { handleV1, setActivator } from './gateway.mjs';
import { addViewer, getLive, live, loadRecent } from './metrics.mjs';
import { DIRS, PORTS } from './paths.mjs';
import { APPEND_SYSTEM, configurePi, ensureAppendSystem, ketchSearch, launchPi, openInEditor } from './pi.mjs';
import { installKetch } from './runtimes.mjs';
import { proposeEngine } from './setup.mjs';
import { dropUnusedEngines } from './engines.mjs';
import { sandboxAvailable } from './sandbox.mjs';
import { activate, activationBlocker, busyWith, customJobState, deleteModel, installLogPath, pickHelper, inspectForMachine, installAndTune, installCustom, refreshHardware, runAnalysis, runFirstSetup, runIq, tuneModel } from './setup.mjs';
import { inspectRepo, loadCustomModels } from './custom-models.mjs';
import { machineDocPath, writeMachineFacts } from './machine-doc.mjs';
import { bus, getState, loadState, save, update } from './state.mjs';
import { applyCheck } from './system-checks.mjs';
import { createKey, flushKeys, internalKey, keysEnforced, listKeys, loadKeys, revokeKey } from './api-keys.mjs';
import { createAgent, deleteAgent, launchAgent, listAgents, updateAgent } from './agents.mjs';
import { approvalOf, decideApproval, requestApproval } from './approvals.mjs';
import { lanDetails, startLan, stopLan } from './lan.mjs';
import { applyUpdate, checkForUpdate, watchForUpdates } from './updater.mjs';
import { checkHub, dismissHub, watchHub } from './watch.mjs';

const ORIGIN = `http://127.0.0.1:${PORTS.app}`;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2' };

// Le catalogue inclut les modèles ajoutés depuis Hugging Face : il se recalcule à chaque lecture.
const catalog = () => MODELS.map((model) => ({ ...model, variant: variantOf(model), totalBytes: totalBytes(model), paramsB: paramsOf(model), rating: globalRating(model, getState().profiles?.[model.id]) }));

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

// Les actions de contrôle ne viennent que de notre propre page : une autre page web ouverte
// dans le navigateur ne doit pas pouvoir lancer un téléchargement de 70 Go.
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  return !origin || origin === ORIGIN || origin === `http://localhost:${PORTS.app}`;
}

// Un clic dans notre fenêtre, et pas un programme local (pi, son outil bash, un script) : le
// navigateur seul pose ces deux en-têtes. Un programme peut les imiter, mais il faut le vouloir ;
// c'est la frontière entre ce que pi demande et ce que l'utilisateur accorde.
function fromOurPage(req) {
  return req.headers['sec-fetch-site'] === 'same-origin' && Boolean(req.headers.origin) && sameOrigin(req);
}

// DNS rebinding : un site piégé dont le nom pointe vers 127.0.0.1 devient « même origine » pour
// le navigateur et pourrait lire l'état, les chemins, le carnet. Il garde son propre nom dans
// l'en-tête Host : on ne répond qu'aux noms de la boucle locale.
const LOCAL_NAMES = new Set(['127.0.0.1', 'localhost', '[::1]']);
function localHost(req) {
  try { return LOCAL_NAMES.has(new URL(`http://${req.headers.host ?? ''}`).hostname); } catch { return false; }
}

function accessReport(keys) {
  return { ...keys, localUrl: `${ORIGIN}/v1`, lan: { enabled: Boolean(getState().lan), ...lanDetails() } };
}

// Le port réseau ne sert que /v1 (et /k/<clé>/v1) ; tout le reste n'existe pas pour lui.
async function lanHandler(req, res) {
  const url = new URL(req.url, 'http://lan');
  // Un client distant qui échoue ne dit souvent rien d'utile : chaque réponse en erreur laisse
  // une ligne (chemin sans la clé), pour voir s'il frappe à la bonne adresse.
  res.on('finish', () => {
    if (res.statusCode < 400 || res.statusCode === 401) return; // 401 : déjà détaillé par gateway.mjs
    console.warn(`[harn] réseau ${new Date().toLocaleTimeString('fr-FR')} ${req.method} ${url.pathname.replace(/^\/k\/[^/]+/, '/k/<clé>')} → ${res.statusCode} depuis ${req.socket.remoteAddress} (${req.headers['user-agent'] ?? '?'})`);
  });
  try {
    if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/k/')) return await handleV1(req, res, url, { lan: true });
    json(res, 404, { error: 'introuvable' });
  } catch (error) {
    if (!res.headersSent) json(res, 500, { error: error.message });
    else res.end();
  }
}

async function setLan(enabled) {
  if (enabled) {
    if (!keysEnforced()) throw Object.assign(new Error('Créez d’abord une clé API : le réseau local l’exige.'), { status: 409 });
    await startLan(lanHandler);
  } else {
    await stopLan();
  }
  update((s) => { s.lan = enabled; });
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
    // Chaque réglage essayé par le banc et son débit : pi y voit ce qui a déjà été mesuré ici
    // (MTP, DFlash2, KV…) au lieu de le croire absent.
    const tried = (p.bench?.arms ?? []).map((a) => ({ etape: a.stage, reglage: a.label, tps: a.tps ?? null, ...Object.fromEntries((a.workloads ?? []).map((w) => [w.workload, Math.round(w.tps)])), ...(a.error ? { erreur: a.error } : {}), ...(a.ok === false && !a.error ? { ecarte: 'marge VRAM insuffisante' } : {}) }));
    return { id: m.id, name: displayName(m), installed: Boolean(s.models[m.id]?.installedAt), installing: Boolean(s.models[m.id]?.installing), tuning: s.models[m.id]?.tuneDetail ?? null, benchTps: p.bench?.winner?.tps ?? null, setting: p.bench?.winner?.label ?? null, reglagesEssayes: tried.length ? tried : null, context: p.tuning?.context ?? null, paramsB: paramsOf(m), noteGlobale: globalRating(m, p)?.score ?? null, intelligence: p.iq?.version === IQ_VERSION ? { score: p.iq.score, ...Object.fromEntries(Object.entries(p.iq.categories).map(([k, c]) => [k, `${c.points}/100, palier ${c.level}`])), reflexion: p.iq.verbosity.label } : null, iqRunning: p.iqRunning ?? null, quality: m.quality, error: s.models[m.id]?.error ?? null };
  });
  const engines = Object.entries(s.runtimes ?? {}).map(([id, r]) => `${id} ${r.tag ?? r.commit?.slice(0, 7) ?? ''}`.trim());
  return { machine: s.plan?.summary?.machine, engines, objective: '100k-150k de contexte, 40 tok/s minimum, le modèle le plus intelligent possible', active: s.active ? { model: s.active.modelId, status: s.active.status } : null, busyWith: busyWith(), downloads, models };
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
  const name = (id) => { const m = modelById(id); return m ? displayName(m) : id; };
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
  if (req.method === 'GET' && url.pathname === '/api/engine/command') {
    // La commande exacte du moteur chargé, pour la partager. Strata : sa config JSON en plus.
    const active = getState().active;
    if (!active?.command) return json(res, 404, { error: 'Aucun moteur lancé depuis ce démarrage de Harn' });
    const configArg = active.args[active.args.indexOf('--config') + 1];
    const config = active.args.includes('--config') ? await readFile(path.resolve(active.cwd ?? '', configArg), 'utf8').catch(() => null) : null;
    return json(res, 200, { modelId: active.modelId, label: active.label, status: active.status, command: active.command, args: active.args, cwd: active.cwd ?? null, config, configName: config ? configArg : null });
  }
  if (req.method === 'GET' && url.pathname === '/api/access') return json(res, 200, accessReport(await listKeys()));
  if (req.method === 'GET' && url.pathname === '/api/agents') return json(res, 200, { agents: await listAgents() });
  if (req.method === 'GET' && parts[1] === 'approvals' && parts[2]) {
    const entry = approvalOf(parts[2]);
    return entry ? json(res, 200, entry) : json(res, 404, { error: 'Demande inconnue ou expirée (Harn a-t-il redémarré ?)' });
  }
  if (req.method !== 'POST') return json(res, 405, { error: 'méthode' });
  if (!sameOrigin(req)) return json(res, 403, { error: 'origine refusée' });

  // Clés API et réseau local : réservés à la fenêtre de Harn.
  if (parts[1] === 'access' || parts[1] === 'approvals') {
    if (!fromOurPage(req)) return json(res, 403, { error: 'À faire depuis la fenêtre de Harn' });
    const body = await new Response(req).json().catch(() => ({}));
    try {
      if (url.pathname === '/api/access/keys') return json(res, 200, await createKey(body.label));
      if (parts[2] === 'keys' && parts[3] && parts[4] === 'revoke') {
        const revoked = await revokeKey(parts[3], { keepOne: Boolean(getState().lan) });
        return json(res, 200, { revoked, access: accessReport(await listKeys()) });
      }
      if (url.pathname === '/api/access/lan') {
        await setLan(body.enabled === true);
        return json(res, 200, accessReport(await listKeys()));
      }
      if (parts[1] === 'approvals' && parts[2] && ['accept', 'refuse'].includes(parts[3])) return json(res, 200, decideApproval(parts[2], parts[3] === 'accept'));
    } catch (error) {
      return json(res, error.status ?? 500, { error: error.message });
    }
    return json(res, 404, { error: 'inconnu' });
  }

  // Agents : créés, réglés et lancés depuis la fenêtre de Harn seulement (un agent ne s'accorde
  // pas lui-même le shell).
  if (parts[1] === 'agents') {
    if (!fromOurPage(req)) return json(res, 403, { error: 'À faire depuis la fenêtre de Harn' });
    const body = await new Response(req).json().catch(() => ({}));
    try {
      if (!parts[2]) return json(res, 200, await createAgent(body));
      if (!parts[3]) return json(res, 200, await updateAgent(parts[2], body));
      if (parts[3] === 'launch') return json(res, 200, await launchAgent(parts[2]));
      if (parts[3] === 'delete') return json(res, 200, await deleteAgent(parts[2]));
    } catch (error) {
      return json(res, error.status ?? 500, { error: error.message });
    }
    return json(res, 404, { error: 'inconnu' });
  }

  // Mise à jour de Harn : seulement depuis sa fenêtre (elle remplace le code puis relance).
  if (parts[1] === 'update') {
    if (!fromOurPage(req)) return json(res, 403, { error: 'À faire depuis la fenêtre de Harn' });
    if (parts[2] === 'check') return json(res, 200, await checkForUpdate());
    if (parts[2] === 'apply') {
      try { await applyUpdate(activity()); return json(res, 200, { ok: true }); } catch (error) { return json(res, 409, { error: error.message }); }
    }
  }
  // Veille Hugging Face : relancer la recherche, écarter une proposition.
  if (parts[1] === 'watch') {
    if (!fromOurPage(req)) return json(res, 403, { error: 'À faire depuis la fenêtre de Harn' });
    if (parts[2] === 'check') { background(checkHub()); return json(res, 202, { ok: true }); }
    if (parts[2] === 'dismiss') {
      const body = await new Response(req).json().catch(() => ({}));
      dismissHub(String(body.repo ?? ''));
      return json(res, 200, { ok: true });
    }
  }
  // Chercher un moteur pour une architecture inconnue : la compilation d'une PR passe par une
  // demande d'accord, affichée dans la fenêtre.
  if (url.pathname === '/api/engines/find') {
    if (!fromOurPage(req)) return json(res, 403, { error: 'À faire depuis la fenêtre de Harn' });
    const body = await new Response(req).json().catch(() => ({}));
    return json(res, 200, await proposeEngine({ modelId: body.modelId ?? null, arch: body.arch ?? null, name: body.name ?? null }));
  }
  // Ce que l'utilisateur fait surtout (code, texte) : pèse la moyenne des prochains bancs.
  if (url.pathname === '/api/prefs') {
    const body = await new Response(req).json().catch(() => ({}));
    if (body.usage && !['code', 'balanced', 'prose'].includes(body.usage)) return json(res, 400, { error: 'usage : code, balanced ou prose' });
    update((s) => { s.prefs = { ...s.prefs, ...(body.usage ? { usage: body.usage } : {}) }; });
    return json(res, 200, { prefs: getState().prefs });
  }
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
    // Depuis notre page : lancement immédiat. Depuis pi (outil MCP) : une demande que
    // l'utilisateur accepte ou refuse dans la fenêtre. L'avancement se lit sur /api/custom/job.
    const body = await new Response(req).json().catch(() => ({}));
    const options = { url: body.url, quant: body.quant, mmproj: body.mmproj ?? null, sampling: body.sampling ?? null };
    if (fromOurPage(req)) {
      try { installCustom(options); return json(res, 202, customJobState()); } catch (error) { return json(res, 409, { error: error.message }); }
    }
    // La taille annoncée vient du dépôt, pas de ce que pi en dit.
    let report;
    try { report = await inspectRepo(options.url); } catch (error) { return json(res, 400, { error: error.message }); }
    const chosen = report.quants.find((q) => q.quant.toUpperCase() === String(options.quant).toUpperCase());
    if (!chosen) return json(res, 400, { error: `Quantification « ${options.quant} » absente. Disponibles : ${report.quants.map((q) => q.quant).join(', ')}` });
    const projector = options.mmproj ? report.mmproj.find((m) => m.name === options.mmproj) : null;
    const bytes = chosen.bytes + (projector?.bytes ?? 0);
    const approval = requestApproval({
      kind: 'install',
      title: `Installer ${report.repo} · ${chosen.quant}`,
      detail: `${(bytes / 1e9).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Go à télécharger depuis huggingface.co${projector ? ' (vision comprise)' : ''}, puis réglage, banc et test d’intelligence. Licence : ${report.license ?? 'non précisée'}.`,
      run: () => installCustom(options),
    });
    return json(res, 202, { approval, status: 'pending' });
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
    if (parts[3] === 'activate') {
      // Refus immédiat (banc d'un autre modèle en cours) : l'interface l'affiche au lieu de rien.
      const blocked = activationBlocker(id);
      if (blocked) return json(res, 409, { error: blocked });
      background(activate(id));
      return json(res, 202, { ok: true });
    }
    if (parts[3] === 'favorite' && req.method === 'POST') {
      // Le cœur : modèle par défaut (chargé au démarrage, proposé à pi). Un second clic le retire.
      if (!getState().models[id]?.installedAt) return json(res, 409, { error: 'Seul un modèle installé peut être le modèle par défaut' });
      update((s) => { s.favorite = s.favorite === id ? null : id; });
      if (getState().pi.installed) background(configurePi());
      return json(res, 200, { favorite: getState().favorite });
    }
    if (parts[3] === 'delete' && req.method === 'POST') {
      try { return json(res, 200, await deleteModel(id)); } catch (error) { return json(res, 409, { error: error.message }); }
    }
    // Une nouvelle mesure appelle une nouvelle analyse de l'IA locale.
    if (parts[3] === 'log' && req.method === 'POST') { return json(res, 200, { editor: await openInEditor(installLogPath(id)) }); }
    if (parts[3] === 'retry') {
      const body = await new Response(req).json().catch(() => ({}));
      const run = () => background(installAndTune(id, () => {}, { ggufDir: body.gguf_dir ?? null }));
      if (fromOurPage(req)) { run(); return json(res, 202, { ok: true }); }
      const model = modelById(id);
      const approval = requestApproval({
        kind: 'retry',
        title: `Relancer l’installation de ${displayName(model)}`,
        detail: body.gguf_dir ? `Avec les fichiers déjà présents dans ${body.gguf_dir}.` : `Jusqu’à ${(totalBytes(model) / 1e9).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} Go à télécharger, puis réglage et banc.`,
        run,
      });
      return json(res, 202, { approval, status: 'pending' });
    }
    if (parts[3] === 'ask-pi') {
      // pi dépanne avec le meilleur modèle installé qui sait manier des outils ; jamais avec le modèle en cause.
      const helper = pickHelper(id);
      if (!helper) return json(res, 409, { error: 'Aucun modèle installé n’a prouvé qu’il sait manier des outils : pi ne peut pas dépanner de façon fiable ici.' });
      await activate(helper);
      const failed = modelById(id);
      const launched = await launchPi(helper, `L’installation de « ${displayName(failed)} » (identifiant ${id}) a échoué. Utilise le skill depanner-une-installation pour comprendre pourquoi et la relancer si c’est possible.`);
      return json(res, 200, { ...launched, helper });
    }
    if (parts[3] === 'iq') { background(runIq(id).then(() => runAnalysis())); return json(res, 202, { ok: true }); }
    if (parts[3] === 'bench') { background(tuneModel(id).then(() => runAnalysis())); return json(res, 202, { ok: true }); }
  }
  return json(res, 404, { error: 'inconnu' });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, ORIGIN);
  if (!localHost(req)) return json(res, 403, { error: 'Harn ne répond qu’aux adresses de cette machine (127.0.0.1, localhost)' });
  try {
    if (url.pathname.startsWith('/v1/') || url.pathname.startsWith('/k/')) return await handleV1(req, res, url);
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
  // Moteurs ajoutés dont plus aucun modèle n'a besoin (modèle supprimé avant ce nettoyage).
  await dropUnusedEngines().catch(() => {});
  // La bulle des moteurs non relus : vérifiée une fois, lue ensuite sans attendre.
  await sandboxAvailable();
  await loadRecent();
  await loadKeys();
  await internalKey();
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
    watchForUpdates();
    watchHub();
    const state = getState();
    // Le réseau local se rouvre au démarrage s'il l'était, et seulement si une clé le garde.
    if (state.lan) {
      setLan(true).then(() => console.log(`Harn · API réseau local sur le port ${PORTS.lan}`))
        .catch((error) => { console.error(`[harn] réseau local non rouvert : ${error.message}`); update((s) => { s.lan = false; }); });
    }
    if (process.argv.includes('--no-setup')) {
      background(refreshHardware());
    } else if (!state.hardware || state.setup.phase !== 'done') {
      background(runFirstSetup());
    } else {
      background(refreshHardware());
      if (state.pi.installed && !state.ketch) background(installKetch().then(() => configurePi()));
      else if (state.pi.installed) background(configurePi());
      // L'inférence est servie dès l'ouverture : le dernier modèle actif est rechargé.
      // Le modèle par défaut (cœur) s'il y en a un, sinon le dernier chargé.
      const last = (state.models[state.favorite]?.installedAt ? state.favorite : null) ?? state.active?.modelId ?? Object.keys(state.models).find((id) => state.models[id].installedAt);
      if (last && state.models[last]?.installedAt && !state.active?.unloadedByUser) background(activate(last));
    }
  });
}

async function shutdown() {
  await stopLan().catch(() => {});
  await flushKeys().catch(() => {});
  await stopEngine().catch(() => {});
  await save().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

main();
