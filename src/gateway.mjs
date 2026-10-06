import { modelById } from './catalog.mjs';
import { beginRequest, endRequest, onChunk } from './metrics.mjs';
import { getState } from './state.mjs';

// L'endpoint OpenAI unique (/v1) que pi agent et toute autre application utilisent. Il relaie
// au moteur actif, active à la demande un autre modèle installé, et mesure chaque requête.

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
      meta: { name: `${model.name} ${model.variant}`, context: state.profiles[id]?.tuning?.context ?? null, vision: model.vision },
    };
  });
  return { object: 'list', data };
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

export async function handleV1(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/v1/models') return sendJson(res, 200, modelsList());

  const raw = await readBody(req);
  let body = null;
  if (raw.length && (req.headers['content-type'] ?? '').includes('json')) {
    try { body = JSON.parse(raw); } catch { return sendJson(res, 400, { error: { message: 'JSON invalide' } }); }
  }

  // Le modèle demandé : s'il est installé mais pas chargé, on le charge (une requête suffit
  // à basculer). Un nom inconnu tombe sur le modèle actif, comme un serveur mono-modèle.
  const state = getState();
  let modelId = state.active?.modelId ?? null;
  if (body?.model && state.models[body.model]?.installedAt) modelId = body.model;
  if (!modelId) return sendJson(res, 503, { error: { message: 'Aucun modèle installé pour l’instant.' } });
  const busy = busyWith();
  if (busy && busy !== modelId) {
    res.setHeader('Retry-After', '60');
    return sendJson(res, 503, { error: { message: `Harn mesure le modèle « ${busy} » : la carte graphique est occupée. Réessayez dans quelques minutes.` } });
  }
  if (state.active?.modelId !== modelId || state.active?.status !== 'ready') {
    try { await activate(modelId); } catch (error) { return sendJson(res, 503, { error: { message: error.message } }); }
  }
  const active = getState().active;
  const model = modelById(modelId);
  const engine = model.engine === 'strata' ? 'strata' : 'llama';
  const target = `${active.endpoint}${url.pathname}${url.search}`;

  const generative = body && /\/(chat\/)?completions$/.test(url.pathname);
  const payload = generative ? Buffer.from(JSON.stringify(shapeRequest(body, model))) : raw;
  const request = generative ? beginRequest({ model: modelId, client: req.headers['user-agent'] ?? 'client', endpoint: active.endpoint, engine }) : null;

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });

  let upstream;
  try {
    upstream = await fetch(target, {
      method: req.method,
      headers: { 'Content-Type': req.headers['content-type'] ?? 'application/json', Authorization: 'Bearer harn' },
      body: ['GET', 'HEAD'].includes(req.method) ? undefined : payload,
      signal: controller.signal,
    });
  } catch (error) {
    if (request) await endRequest(request, { error: error.message });
    return sendJson(res, 502, { error: { message: `Moteur injoignable : ${error.message}` } });
  }

  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    'Cache-Control': 'no-cache',
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
}
