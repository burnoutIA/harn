import { authorize, bearerToken, extractPathKey, fingerprint, recordUsage } from './api-keys.mjs';
import { displayName, modelById } from './catalog.mjs';
import { engineHeaders } from './engine.mjs';
import { beginRequest, endRequest, onChunk } from './metrics.mjs';
import { getState } from './state.mjs';

// L'endpoint OpenAI unique (/v1) que pi agent et toute autre application utilisent. Il relaie
// au moteur actif, active à la demande un autre modèle installé, et mesure chaque requête.
// Servi sur la boucle locale, et sur le réseau local quand l'utilisateur l'ouvre (clé exigée).

let activate = async () => { throw new Error('Aucun moteur'); };
let busyWith = () => null;
export function setActivator(fn, busy = () => null) { activate = fn; busyWith = busy; }

// Les niveaux de Qwen3.8 sont low / medium / xhigh. Le défaut du gabarit est xhigh, le plus
// bavard : sur un run long il épuise le budget de sortie en pleine réflexion et rend une
// réponse vide. On pose medium quand le client ne dit rien (décision du poste de référence).
const EFFORT = { minimal: 'low', low: 'low', medium: 'medium', high: 'xhigh', xhigh: 'xhigh', max: 'xhigh' };

export function shapeRequest(body, model) {
  const shaped = { ...body, model: model.id };
  if (model.engine !== 'strata' && model.reasoning) {
    const kwargs = { ...(body.chat_template_kwargs ?? {}) };
    const asked = body.reasoning_effort ?? body.reasoning?.effort;
    if (asked === 'none' || asked === 'off') kwargs.enable_thinking = false;
    else if (!kwargs.reasoning_effort) kwargs.reasoning_effort = EFFORT[asked] ?? 'medium';
    shaped.chat_template_kwargs = kwargs;
    delete shaped.reasoning_effort;
    delete shaped.reasoning;
  }
  if (shaped.stream) shaped.stream_options = { include_usage: true, ...(body.stream_options ?? {}) };
  return shaped;
}

export function modelsList() {
  const state = getState();
  const data = Object.keys(state.models).filter((id) => state.models[id].installedAt && modelById(id)).map((id) => {
    const model = modelById(id);
    return {
      id,
      object: 'model',
      owned_by: 'harn',
      created: Math.floor(new Date(state.models[id].installedAt).getTime() / 1000),
      meta: { name: displayName(model), context: state.profiles[id]?.tuning?.context ?? null, vision: model.vision },
    };
  });
  return { object: 'list', data };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sendJson(res, status, payload, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(payload));
}

// lan : la requête arrive par le port ouvert au réseau. Là seulement, les pages web d'une autre
// origine sont admises (CORS) : une clé y est toujours exigée, une page ne peut pas la deviner.
// Sur la boucle locale, pas de CORS : une page web ne lit jamais une réponse de /v1.
export async function handleV1(req, res, url, { lan = false } = {}) {
  const cors = lan ? { 'Access-Control-Allow-Origin': '*' } : {};
  if (lan && req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type' });
    return res.end();
  }
  const pathKey = extractPathKey(url.pathname);
  url.pathname = pathKey.pathname;
  if (!url.pathname.startsWith('/v1/')) return sendJson(res, 404, { error: { message: 'Introuvable : l’API est sous /v1' } }, cors);

  const token = pathKey.token ?? bearerToken(req.headers);
  const decision = await authorize(token, { lan });
  if (!decision.ok) {
    // Sans cette trace, « ça ne marche pas côté client » ne se diagnostique pas. La clé n'y
    // figure que par son début.
    console.warn(`[harn] accès refusé ${req.method} ${pathKey.token ? '/k/<clé>' : ''}${url.pathname} depuis ${req.socket.remoteAddress} : ${decision.message} (clé : ${fingerprint(token)}, client : ${req.headers['user-agent'] ?? '?'})`);
    return sendJson(res, decision.status, { error: { message: decision.message, type: 'authentication_error', code: 'invalid_api_key' } }, { ...cors, 'WWW-Authenticate': 'Bearer realm="harn"' });
  }

  if (req.method === 'GET' && url.pathname === '/v1/models') return sendJson(res, 200, modelsList(), cors);
  if (req.method === 'GET' && url.pathname.startsWith('/v1/models/')) {
    const found = modelsList().data.find((m) => m.id === decodeURIComponent(url.pathname.slice('/v1/models/'.length)));
    return found ? sendJson(res, 200, found, cors) : sendJson(res, 404, { error: { message: 'Modèle inconnu ou non installé', type: 'invalid_request_error' } }, cors);
  }
  // Un POST sans JSON est la seule forme qu'une page web peut envoyer sans demander la permission
  // (formulaire, fetch « no-cors ») : il chargerait un modèle et occuperait la carte. Aucun client
  // OpenAI n'envoie autre chose que du JSON.
  if (req.method === 'POST' && !(req.headers['content-type'] ?? '').includes('json')) {
    return sendJson(res, 415, { error: { message: 'Corps attendu en JSON (Content-Type: application/json)' } }, cors);
  }

  const raw = await readBody(req);
  let body = null;
  if (raw.length && (req.headers['content-type'] ?? '').includes('json')) {
    try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: { message: 'JSON invalide' } }, cors); }
  }

  // Le modèle demandé : s'il est installé mais pas chargé, on le charge (une requête suffit
  // à basculer). Un nom inconnu tombe sur le modèle actif, comme un serveur mono-modèle.
  const state = getState();
  let modelId = state.active?.modelId ?? null;
  if (body?.model && state.models[body.model]?.installedAt) modelId = body.model;
  if (!modelId) return sendJson(res, 503, { error: { message: 'Aucun modèle installé pour l’instant.' } }, cors);
  const busy = busyWith();
  if (busy && busy !== modelId) {
    return sendJson(res, 503, { error: { message: `Harn mesure le modèle « ${busy} » : la carte graphique est occupée. Réessayez dans quelques minutes.` } }, { ...cors, 'Retry-After': '60' });
  }
  if (state.active?.modelId !== modelId || state.active?.status !== 'ready') {
    try { await activate(modelId); } catch (error) { return sendJson(res, 503, { error: { message: error.message } }, cors); }
  }
  const active = getState().active;
  const model = modelById(modelId);
  const engine = model.engine === 'strata' ? 'strata' : 'llama';
  const target = `${active.endpoint}${url.pathname}${url.search}`;

  const generative = body && /\/(chat\/)?completions$/.test(url.pathname);
  const payload = generative ? Buffer.from(JSON.stringify(shapeRequest(body, model))) : raw;
  const request = generative ? beginRequest({ model: modelId, client: req.headers['user-agent'] ?? 'client', key: decision.key?.label ?? null, endpoint: active.endpoint, engine }) : null;

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: { 'Content-Type': req.headers['content-type'] ?? 'application/json', ...engineHeaders() },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : payload,
      signal: controller.signal,
    });
  } catch (error) {
    if (request) await endRequest(request, { error: error.message });
    return sendJson(res, 502, { error: { message: `Moteur injoignable : ${error.message}` } }, cors);
  }

  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    'Cache-Control': 'no-cache',
    ...cors,
  });

  if (!request) {
    for await (const chunk of upstream.body) res.write(chunk);
    return res.end();
  }

  // On relaie octet pour octet, en lisant au passage les compteurs du moteur.
  let timings = null;
  let usage = null;
  let buffer = '';
  const decoder = new TextDecoder();
  const streaming = (upstream.headers.get('content-type') ?? '').includes('event-stream');
  let error = null;
  try {
    for await (const chunk of upstream.body) {
      res.write(chunk);
      const text = decoder.decode(chunk, { stream: true });
      if (!streaming) { buffer += text; continue; }
      buffer += text;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        try {
          const event = JSON.parse(line.slice(5));
          if (event.timings) timings = event.timings;
          if (event.usage) usage = event.usage;
          if (event.choices?.[0]?.delta && Object.keys(event.choices[0].delta).length) onChunk(request);
        } catch { /* ligne partielle : ignorée */ }
      }
    }
    if (!streaming) {
      try {
        const parsed = JSON.parse(buffer);
        timings = parsed.timings ?? null;
        usage = parsed.usage ?? null;
      } catch { /* réponse non JSON */ }
    }
  } catch (caught) {
    error = controller.signal.aborted ? 'annulée par le client' : caught.message;
  }
  if (upstream.status >= 400) error ??= `HTTP ${upstream.status}`;
  res.end();
  await endRequest(request, { timings, usage, error });
  if (decision.key) recordUsage(decision.key.id, timings?.predicted_n ?? usage?.completion_tokens ?? request.decoded);
}
