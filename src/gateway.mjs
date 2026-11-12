import { authorize, bearerToken, extractPathKey, fingerprint, recordUsage } from './api-keys.mjs';
import { displayName, modelById } from './catalog.mjs';
import { engineHeaders, setEngine } from './engine.mjs';
import { engineInUse, inFlightOf } from './idle.mjs';
import { beginRequest, endRequest, onChunk } from './metrics.mjs';
import { peerModels, peerRoute, peersWith } from './peers.mjs';
import { freeVram } from './loading.mjs';
import { followDemand, needMiB, parallelAsked } from './placement.mjs';
import { HEADROOM_MIN_MIB } from './tuner.mjs';
import { getState } from './state.mjs';

// L'endpoint OpenAI unique (/v1) que pi agent et toute autre application utilisent. Il relaie
// au moteur actif, active à la demande un autre modèle installé, et mesure chaque requête.
// Servi sur la boucle locale, et sur le réseau local quand l'utilisateur l'ouvre (clé exigée).

let activate = async () => { throw new Error('Aucun moteur'); };
let busyWith = () => null;
let gpuFree = async () => {};
export function setActivator(fn, busy = () => null, free = async () => {}) { activate = fn; busyWith = busy; gpuFree = free; }

// Les niveaux de Qwen3.8 sont low / medium / xhigh. Le défaut du gabarit est xhigh, le plus
// bavard : sur un run long il épuise le budget de sortie en pleine réflexion et rend une
// réponse vide. On pose medium quand le client ne dit rien (décision du poste de référence).
const EFFORT = { minimal: 'low', low: 'low', medium: 'medium', high: 'xhigh', xhigh: 'xhigh', max: 'xhigh' };

const VLLM = new Set(['hyperqwen', 'radiance', 'gemma-challenge']);

// vLLM refuse (400) une requête dont prompt + max_tokens dépasse le contexte, même d'un token.
// pi ramène max_tokens à la place qui reste d'après SA estimation du prompt, qui peut être un
// peu courte : la requête était refusée et pi compactait pour rien. Le message de vLLM ne donne
// qu'une borne (« at least »), pas le vrai compte : on le demande à /tokenize (~60 ms), puis
// max_tokens = la place réelle. Rien si elle est trop petite pour une réponse : l'erreur remonte
// et le client compacte, ce qu'il doit faire.
const FIT_MARGIN = 16;
const FIT_MIN_OUTPUT = 1024;
export async function fitContext(endpoint, shaped) {
  if (!Array.isArray(shaped?.messages)) return null;
  const response = await fetch(`${endpoint}/tokenize`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...engineHeaders() },
    body: JSON.stringify({ model: shaped.model, messages: shaped.messages, tools: shaped.tools, chat_template_kwargs: shaped.chat_template_kwargs, add_generation_prompt: true }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) return null;
  const { count, max_model_len: context } = await response.json();
  const room = context - count - FIT_MARGIN;
  if (!(count > 0) || !(room >= FIT_MIN_OUTPUT)) return null;
  const fitted = { ...shaped };
  for (const field of ['max_tokens', 'max_completion_tokens']) if (fitted[field] != null) fitted[field] = Math.min(fitted[field], room);
  if (fitted.max_tokens == null && fitted.max_completion_tokens == null) fitted.max_tokens = room;
  return { payload: Buffer.from(JSON.stringify(fitted)), count, room };
}

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
  // vLLM livre plusieurs tokens par morceau en décodage spéculatif (~2 avec DFlash2) : il donne le
  // compte exact dans chaque morceau, sinon le direct afficherait la moitié de la vitesse.
  const vllm = VLLM.has(model.engine);
  if (shaped.stream) shaped.stream_options = { include_usage: true, ...(vllm ? { continuous_usage_stats: true } : {}), ...(body.stream_options ?? {}) };
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
      // loaded, free : ce qu'une autre machine Harn regarde pour choisir où envoyer une requête.
      meta: { name: displayName(model), context: state.profiles[id]?.tuning?.context ?? null, vision: model.vision, reasoning: Boolean(model.reasoning),
        loaded: state.engines?.[id]?.status === 'ready', free: state.engines?.[id]?.status === 'ready' && inFlightOf(id) < (state.engines[id].slots ?? 1) },
    };
  });
  // Les modèles des autres machines (peers.mjs) suivent, sous le nom « modele@machine ».
  return { object: 'list', data: [...data, ...peerModels()] };
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
// Le même modèle ici et sur une autre machine (ou seulement là-bas) : la requête va là où elle sera
// servie le plus tôt. Ici s'il y est chargé avec une session libre ; sinon sur une machine qui l'a
// chargé et libre ; sinon ici s'il tient sans rien décharger ; sinon sur une machine joignable.
// null : servi ici.
async function bestMachine(modelId) {
  if (!modelId || String(modelId).includes('@')) return null;
  const remotes = peersWith(modelId);
  if (!remotes.length) return null;
  const state = getState();
  const local = Boolean(state.models[modelId]?.installedAt && modelById(modelId));
  const pick = (peer) => peerRoute(`${modelId}@${peer}`);
  if (!local) return pick((remotes.find((r) => r.free) ?? remotes.find((r) => r.loaded) ?? remotes[0]).peer);
  const engine = state.engines?.[modelId];
  if (engine?.status === 'ready' && inFlightOf(modelId) < (engine.slots ?? 1)) return null;
  const freeThere = remotes.find((r) => r.free);
  if (freeThere) return pick(freeThere.peer);
  if (!engine) {
    const free = await freeVram();
    if (free === null || free - needMiB(modelById(modelId), state.profiles[modelId]?.tuning ?? {}) >= HEADROOM_MIN_MIB) return null;
    return pick((remotes.find((r) => r.loaded) ?? remotes[0]).peer);
  }
  return null;
}

// Réponses déjà relayées au moteur de chaque modèle (les autres attendent un chargement).
const relayed = new Map();
const relayedOf = (modelId) => relayed.get(modelId) ?? 0;

export async function handleV1(req, res, url, { lan = false } = {}) {
  const cors = lan ? { 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'X-Harn-Parallel-Granted' } : {};
  if (lan && req.method === 'OPTIONS') {
    res.writeHead(204, { ...cors, 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'authorization, content-type, x-harn-parallel' });
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

  // Un modèle d'une autre machine (« modele@pc2 ») : relayé tel quel, elle le charge elle-même.
  // Rien ne bouge ici : ni la carte, ni le modèle actif.
  const generative = body && /\/(chat\/)?completions$/.test(url.pathname);
  // Venue d'une autre machine Harn : servie ici, jamais renvoyée (pas d'aller-retour).
  const hopped = Boolean(req.headers['x-harn-hop']);
  const route = peerRoute(body?.model) ?? (hopped ? null : await bestMachine(body?.model));
  if (route) {
    return relay(req, res, {
      target: `${route.peer.url}${url.pathname.slice('/v1'.length)}${url.search}`,
      headers: { ...route.headers, 'X-Harn-Hop': '1', ...(req.headers['x-harn-parallel'] ? { 'X-Harn-Parallel': req.headers['x-harn-parallel'] } : {}) },
      payload: Buffer.from(JSON.stringify({ ...body, model: route.remoteId })),
      measure: generative ? { model: `${route.remoteId}@${route.peer.id}`, endpoint: route.peer.url, engine: 'peer' } : null,
      unreachable: `Machine « ${route.peer.name} » injoignable`,
      decision, cors,
    });
  }

  // Le modèle demandé : s'il est installé mais pas chargé, on le charge (une requête suffit
  // à basculer). Un nom inconnu tombe sur le modèle actif, comme un serveur mono-modèle.
  const state = getState();
  let modelId = state.active?.modelId ?? null;
  if (body?.model && state.models[body.model]?.installedAt) modelId = body.model;
  if (!modelId) return sendJson(res, 503, { error: { message: 'Aucun modèle installé pour l’instant.' } }, cors);
  if (String(busyWith() ?? '').startsWith('image:')) await gpuFree();
  const busy = busyWith();
  if (busy && busy !== modelId) {
    return sendJson(res, 503, { error: { message: `Harn mesure le modèle « ${busy} » : la carte graphique est occupée. Réessayez dans quelques minutes.` } }, { ...cors, 'Retry-After': '60' });
  }
  // Le moteur sert jusqu'à la fin de la réponse : pas de déchargement (inactivité, place pour un
  // autre modèle) d'ici là.
  res.once('close', engineInUse(modelId));
  // Plus de demandes en même temps que de sessions : le moteur en reçoit plus, à un moment où il
  // ne répond à personne (placement.mjs). Sinon la requête attend son tour dans le moteur.
  // Le client peut annoncer d'avance combien de sessions il lui faut (X-Harn-Parallel: N, 4 au plus).
  const resize = followDemand(modelId, inFlightOf(modelId), relayedOf(modelId), activate, parallelAsked(req.headers['x-harn-parallel']));
  if (resize) await resize.catch(() => {});
  // Pas chargé : on le charge, à côté des autres s'il tient (placement.mjs).
  if (getState().engines?.[modelId]?.status !== 'ready') {
    try { await activate(modelId); } catch (error) { return sendJson(res, error.status ?? 503, { error: { message: error.message } }, { ...cors, ...(error.status === 503 ? { 'Retry-After': '30' } : {}) }); }
  }
  // Partie au moteur : un rechargement pour plus de sessions attendra qu'elle finisse.
  relayed.set(modelId, relayedOf(modelId) + 1);
  res.once('close', () => relayed.set(modelId, relayedOf(modelId) - 1));
  const active = getState().engines[modelId];
  if (active?.status !== 'ready') return sendJson(res, 503, { error: { message: 'Le moteur de ce modèle vient de s’arrêter : réessayez' } }, { ...cors, 'Retry-After': '5' });
  // Le dernier modèle servi devient celui affiché comme actif.
  if (getState().active?.modelId !== modelId) setEngine(modelId, { lastUse: Date.now() }, { focus: true });
  const model = modelById(modelId);
  // Seul llama-server a /slots ; les autres sont suivis par morceaux, puis par l'usage final.
  const engine = ['strata', 'hyperqwen', 'radiance', 'gemma-challenge'].includes(model.engine) ? model.engine : 'llama';
  const shaped = generative ? shapeRequest(body, model) : null;
  return relay(req, res, {
    target: `${active.endpoint}${url.pathname}${url.search}`,
    headers: engineHeaders(),
    payload: generative ? Buffer.from(JSON.stringify(shaped)) : raw,
    // vLLM : prompt + max_tokens au-delà du contexte → max_tokens ramené à la place réelle, une fois.
    fit: generative && VLLM.has(model.engine) ? async () => {
      const fitted = await fitContext(active.endpoint, shaped);
      if (fitted) console.log(`[harn] ${modelId} : max_tokens ramené à ${fitted.room} (prompt de ${fitted.count} tokens, plus long que l'estimation du client)`);
      return fitted?.payload ?? null;
    } : null,
    measure: generative ? { model: modelId, endpoint: active.endpoint, engine } : null,
    unreachable: 'Moteur injoignable',
    decision, cors,
    // Ce que le client a réellement : le plafond (4) et la place sur la carte peuvent donner moins
    // que X-Harn-Parallel. Vaut pour cette machine seulement.
    granted: active.slots ?? 1,
  });
}

// Relaie la requête vers target (le moteur d'ici ou une autre machine) octet pour octet, en
// lisant au passage les compteurs pour le direct et l'historique.
async function relay(req, res, { target, headers, payload, measure, unreachable, decision, cors, granted = null, fit = null }) {
  const request = measure ? beginRequest({ ...measure, client: req.headers['user-agent'] ?? 'client', key: decision.key?.label ?? null }) : null;

  const controller = new AbortController();
  res.on('close', () => { if (!res.writableFinished) controller.abort(); });

  const send = (body) => fetch(target, {
    method: req.method,
    headers: { 'Content-Type': req.headers['content-type'] ?? 'application/json', ...headers },
    body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    signal: controller.signal,
  });
  let upstream;
  try {
    upstream = await send(payload);
    // Prompt + max_tokens au-delà du contexte (vLLM) : renvoyée une fois avec la place réelle.
    if (upstream.status === 400 && fit) {
      const text = await upstream.text();
      const fitted = /maximum context length/i.test(text) ? await fit().catch(() => null) : null;
      if (fitted) upstream = await send(fitted);
      else {
        if (request) await endRequest(request, { error: 'HTTP 400' });
        res.writeHead(400, { 'Content-Type': upstream.headers.get('content-type') ?? 'application/json', ...cors });
        return res.end(text);
      }
    }
  } catch (error) {
    if (request) await endRequest(request, { error: error.message });
    return sendJson(res, 502, { error: { message: `${unreachable} : ${error.message}` } }, cors);
  }

  res.writeHead(upstream.status, {
    'Content-Type': upstream.headers.get('content-type') ?? 'application/json',
    // Sessions accordées : celles du moteur d'ici, ou celles qu'a accordées l'autre machine.
    ...(granted ? { 'X-Harn-Parallel-Granted': String(granted) } : upstream.headers.get('x-harn-parallel-granted') ? { 'X-Harn-Parallel-Granted': upstream.headers.get('x-harn-parallel-granted') } : {}),
    'Cache-Control': 'no-cache',
    // « Carte occupée » chez l'autre machine : le client sait quand réessayer.
    ...(upstream.headers.get('retry-after') ? { 'Retry-After': upstream.headers.get('retry-after') } : {}),
    ...cors,
  });

  if (!request) {
    for await (const chunk of upstream.body) res.write(chunk);
    return res.end();
  }

  // On relaie octet pour octet, en lisant au passage les compteurs du moteur.
  let timings = null;
  let usage = null;
  let finish = null;   // « length » : réponse coupée à la limite de sortie (voir output-budget.mjs)
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
          if (event.choices?.[0]?.finish_reason) finish = event.choices[0].finish_reason;
          if (event.choices?.[0]?.delta && Object.keys(event.choices[0].delta).length) onChunk(request, event.usage?.completion_tokens ?? null);
        } catch { /* ligne partielle : ignorée */ }
      }
    }
    if (!streaming) {
      try {
        const parsed = JSON.parse(buffer);
        timings = parsed.timings ?? null;
        usage = parsed.usage ?? null;
        finish = parsed.choices?.[0]?.finish_reason ?? null;
      } catch { /* réponse non JSON */ }
    }
  } catch (caught) {
    error = controller.signal.aborted ? 'annulée par le client' : caught.message;
  }
  if (upstream.status >= 400) error ??= `HTTP ${upstream.status}`;
  res.end();
  await endRequest(request, { timings, usage, error, finish });
  if (decision.key) recordUsage(decision.key.id, timings?.predicted_n ?? usage?.completion_tokens ?? request.decoded);
}
