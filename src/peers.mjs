import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from './paths.mjs';
import { getState, update } from './state.mjs';

// Les autres machines qui font tourner Harn (« pairs »). Celle-ci joint leur API réseau local
// (port lan, clé exigée) et propose leurs modèles sous le nom « modele@pair » : une requête pour
// l'un d'eux part telle quelle vers la machine qui l'a, qui le charge et gère sa propre carte.
// Les clés des pairs vivent dans data/peers.json et ne sortent jamais d'ici : ni vers
// l'interface, ni vers les clients de /v1.

export const PEERS_FILE = path.join(DIRS.data, 'peers.json');
export const SEPARATOR = '@';
const POLL_MS = 30_000;
// Les demandes d'accord des machines pilotées : relevées plus souvent, une demande attend un clic.
const PILOT_POLL_MS = 4_000;
const TIMEOUT_MS = 4_000;
const MAX_NAME = 40;

let peers = [];            // { id, name, url, key, addedAt, pilotKey? }
const seen = new Map();    // id → { ok, error, models, checkedAt }
let timer = null;
let pilotTimer = null;
const asked = new Map();   // id → { ok, error, approvals } : les demandes en attente chez un pair piloté

const failure = (status, message) => Object.assign(new Error(message), { status });

// « pc2 », « Tour du salon » → « tour-du-salon » : le suffixe des noms de modèles.
export const slug = (name) => String(name ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_NAME);

// Ce que l'autre machine affiche dans « Réseau local » (…:4748/v1), avec ou sans /v1. L'adresse
// avec la clé dans le chemin est refusée : la clé a son propre champ.
export function normalizeUrl(raw) {
  let url;
  try { url = new URL(String(raw ?? '').trim()); } catch { throw failure(400, 'Adresse invalide : http://192.168.1.20:4748/v1 par exemple'); }
  if (!['http:', 'https:'].includes(url.protocol)) throw failure(400, 'Adresse en http:// ou https://');
  if (/^\/k\//.test(url.pathname)) throw failure(400, 'Collez l’adresse sans la clé (…/v1), et la clé dans son champ');
  const base = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${url.origin}${base}/v1`;
}

async function load() {
  try {
    const parsed = JSON.parse(await readFile(PEERS_FILE, 'utf8'));
    peers = (Array.isArray(parsed.peers) ? parsed.peers : []).filter((p) => p?.id && p?.url && p?.key);
  } catch (error) {
    if (error.code !== 'ENOENT') console.error(`[harn] ${PEERS_FILE} illisible : ${error.message}`);
    peers = [];
  }
}

async function persist() {
  await mkdir(DIRS.data, { recursive: true });
  const temp = `${PEERS_FILE}.tmp`;
  await writeFile(temp, JSON.stringify({ peers }, null, 2), { mode: 0o600 });
  await rename(temp, PEERS_FILE);
}

const headersOf = (peer) => ({ Authorization: `Bearer ${peer.key}` });

// Ne reprend que les modèles de la machine elle-même (owned_by « harn ») : si elle a ses propres
// pairs, on ne les redistribue pas, ce qui évite les boucles (A → B → A).
async function poll(peer) {
  try {
    const response = await fetch(`${peer.url}/models`, { headers: headersOf(peer), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.status === 401) throw new Error('clé refusée par l’autre machine');
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const models = (body.data ?? []).filter((m) => m?.id && (m.owned_by ?? 'harn') === 'harn' && !String(m.id).includes(SEPARATOR));
    const [voice, combo] = await Promise.all([voiceOf(peer), comboOf(peer)]);
    seen.set(peer.id, { ok: true, error: null, models, voice, combo, checkedAt: Date.now() });
  } catch (error) {
    const message = error.name === 'TimeoutError' ? 'ne répond pas (machine éteinte, Harn arrêté ou réseau local fermé ?)' : error.cause?.code === 'ECONNREFUSED' ? 'connexion refusée (réseau local fermé sur l’autre machine ?)' : error.message;
    seen.set(peer.id, { ok: false, error: message, models: [], checkedAt: Date.now() });
  }
  return seen.get(peer.id);
}

// Ses modèles de voix (voice.mjs) : installés chez elle, sur sa propre carte. Un Harn d'avant la
// voix répond 404 : pas de voix. Un Harn d'avant les modèles de voix (Voxtral seul) ne donne que
// ses voix : c'est Voxtral.
async function voiceOf(peer) {
  try {
    const response = await fetch(`${peer.url}/audio/voices`, { headers: headersOf(peer), signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!response.ok) return null;
    const body = await response.json();
    if (!body?.installed) return null;
    const models = Array.isArray(body.models) ? body.models.filter((m) => m?.id && m.kind)
      : [{ id: 'voxtral', name: 'Voxtral TTS 4B', kind: 'preset', voices: Array.isArray(body.voices) ? body.voices : [] }];
    return models.length ? { models, status: body.status ?? null, running: body.running ?? (body.models ? null : 'voxtral') } : null;
  } catch { return null; }
}

// Son combo (combo.mjs), s'il en a un. Un Harn d'avant les combos répond 404 : aucun.
async function comboOf(peer) {
  try {
    const response = await fetch(`${peer.url}/combos`, { headers: headersOf(peer), signal: AbortSignal.timeout(TIMEOUT_MS) });
    return response.ok ? (await response.json())?.combo ?? null : null;
  } catch { return null; }
}

// ── Pilotage ─────────────────────────────────────────────────────────────────────────────
// Avec une clé de pilotage (créée sur l'autre machine : npm run keys -- create --pilot), ses
// demandes d'accord s'affichent ici et se décident d'un clic dans cette fenêtre : l'installation
// qu'on lance sur elle n'attend plus quelqu'un devant son écran. La clé ne sert qu'à ça.
const pilotHeaders = (peer) => ({ Authorization: `Bearer ${peer.pilotKey}` });

async function fetchApprovals(peer) {
  const response = await fetch(`${peer.url}/harn/approvals`, { headers: pilotHeaders(peer), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (response.status === 401) throw failure(401, 'clé de pilotage refusée par l’autre machine');
  if (response.status === 403) throw failure(403, 'cette clé n’est pas une clé de pilotage');
  // Un Harn d'avant le pilotage.
  if (response.status === 404) throw failure(404, 'l’autre machine ne connaît pas encore le pilotage (Harn à mettre à jour)');
  if (!response.ok) throw failure(502, `HTTP ${response.status}`);
  const body = await response.json();
  return (Array.isArray(body?.approvals) ? body.approvals : []).filter((a) => a?.id && a.title);
}

async function pollApprovals(peer) {
  try {
    asked.set(peer.id, { ok: true, error: null, approvals: await fetchApprovals(peer) });
  } catch (error) {
    const message = error.name === 'TimeoutError' ? 'ne répond pas' : error.cause?.code === 'ECONNREFUSED' ? 'connexion refusée' : error.message;
    asked.set(peer.id, { ok: false, error: message, approvals: [] });
  }
}

export async function refreshApprovals() {
  await Promise.all(peers.filter((p) => p.pilotKey).map(pollApprovals));
  for (const id of asked.keys()) if (!peers.some((p) => p.id === id && p.pilotKey)) asked.delete(id);
  showApprovals();
}

function showApprovals() {
  const next = peers.flatMap((p) => (asked.get(p.id)?.approvals ?? []).map((a) => ({ ...a, peer: p.name, peerId: p.id })));
  if (JSON.stringify(getState().approvalsRemote ?? []) !== JSON.stringify(next)) update((s) => { s.approvalsRemote = next; });
}

// Un clic dans cette fenêtre (main.mjs le vérifie) : la décision part vers la machine pilotée.
export async function decideRemote(peerId, approvalId, accept) {
  const peer = peers.find((p) => p.id === peerId);
  if (!peer) throw failure(404, 'Machine inconnue');
  if (!peer.pilotKey) throw failure(409, `${peer.name} n’est pas pilotée d’ici`);
  let response;
  try {
    response = await fetch(`${peer.url}/harn/approvals/${encodeURIComponent(approvalId)}/${accept ? 'accept' : 'refuse'}`, { method: 'POST', headers: pilotHeaders(peer), signal: AbortSignal.timeout(15_000) });
  } catch (error) {
    throw failure(502, `${peer.name} : ${error.name === 'TimeoutError' ? 'ne répond pas' : error.message}`);
  }
  const body = await response.json().catch(() => ({}));
  await pollApprovals(peer);
  showApprovals();
  if (!response.ok) throw failure(response.status, `${peer.name} : ${body?.error?.message ?? `HTTP ${response.status}`}`);
  return { ...body, peer: peer.name, peerId: peer.id };
}

// Poser (vérifiée d'abord) ou retirer (null) la clé de pilotage d'une machine.
export async function setPilotKey(id, key) {
  const peer = peers.find((p) => p.id === id);
  if (!peer) throw failure(404, 'Machine inconnue');
  const token = key == null ? '' : String(key).trim();
  if (token) {
    try { await fetchApprovals({ ...peer, pilotKey: token }); } catch (error) { throw failure(error.status === 401 || error.status === 403 || error.status === 404 ? 400 : 502, `${peer.name} : ${error.message}`); }
    peer.pilotKey = token;
  } else {
    delete peer.pilotKey;
  }
  await persist();
  await refreshApprovals();
  return peersReport();
}

export const refreshPeers = () => Promise.all(peers.map(poll)).then((all) => { showVoice(); showCombos(); return all; });

// Pour la vue Modèles : les combos des autres machines.
function showCombos() {
  const next = peers.filter((p) => seen.get(p.id)?.ok && seen.get(p.id).combo).map((p) => ({ peer: p.name, peerId: p.id, combo: seen.get(p.id).combo }));
  if (JSON.stringify(getState().comboRemote ?? []) !== JSON.stringify(next)) update((s) => { s.comboRemote = next; });
}

// Pour la vue Voix et la fiche d'agent : les modèles de voix que prêteraient les autres machines.
function showVoice() {
  const next = peersWithVoice().map(({ peer, voice }) => ({ peer: peer.name, peerId: peer.id, status: voice.status, running: voice.running, models: voice.models }));
  if (JSON.stringify(getState().voiceRemote ?? null) !== JSON.stringify(next)) update((s) => { s.voiceRemote = next; });
}

// Le premier relevé : ceux qui ont besoin de la liste (lancement d'un agent) l'attendent.
let ready = null;
export const peersReady = () => ready ?? Promise.resolve();

export async function startPeers() {
  ready = load().then(refreshPeers);
  await ready;
  clearInterval(timer);
  timer = setInterval(() => { refreshPeers().catch(() => {}); }, POLL_MS);
  timer.unref?.();
  await refreshApprovals();
  clearInterval(pilotTimer);
  pilotTimer = setInterval(() => { refreshApprovals().catch(() => {}); }, PILOT_POLL_MS);
  pilotTimer.unref?.();
}

export function stopPeers() { clearInterval(timer); timer = null; clearInterval(pilotTimer); pilotTimer = null; }

// Pour l'interface : jamais la clé.
export function peersReport() {
  return peers.map(({ id, name, url, addedAt, pilotKey }) => {
    const s = seen.get(id) ?? { ok: null, error: null, models: [], checkedAt: null };
    const pilot = pilotKey ? { on: true, ok: asked.get(id)?.ok ?? null, error: asked.get(id)?.error ?? null } : { on: false };
    return { id, name, url, addedAt, pilot, ok: s.ok, error: s.error, checkedAt: s.checkedAt, models: s.models.map((m) => ({ id: `${m.id}${SEPARATOR}${id}`, name: m.meta?.name ?? m.id, context: m.meta?.context ?? null })) };
  });
}

export async function addPeer({ name, url, key }) {
  const id = slug(name);
  if (!id) throw failure(400, 'Donnez un nom à la machine (pc2, tour…)');
  if (peers.some((p) => p.id === id)) throw failure(409, `Une machine s’appelle déjà « ${id} »`);
  const token = String(key ?? '').trim();
  if (!token) throw failure(400, 'La clé API créée sur l’autre machine est nécessaire');
  const peer = { id, name: String(name).trim().slice(0, MAX_NAME), url: normalizeUrl(url), key: token, addedAt: new Date().toISOString() };
  // Vérifiée avant d'être gardée : une adresse ou une clé fausse se corrige tout de suite.
  const check = await poll(peer);
  if (!check.ok) { seen.delete(id); throw failure(502, `${peer.url} : ${check.error}`); }
  peers.push(peer);
  await persist();
  return peersReport();
}

export async function removePeer(id) {
  const before = peers.length;
  peers = peers.filter((p) => p.id !== id);
  if (peers.length === before) throw failure(404, 'Machine inconnue');
  seen.delete(id);
  asked.delete(id);
  showApprovals();
  await persist();
  return peersReport();
}

// Les modèles des pairs joignables, au format de /v1/models.
export function peerModels() {
  return peers.flatMap((peer) => (seen.get(peer.id)?.ok ? seen.get(peer.id).models : []).map((m) => ({
    ...m,
    id: `${m.id}${SEPARATOR}${peer.id}`,
    owned_by: `harn${SEPARATOR}${peer.id}`,
    meta: { ...(m.meta ?? {}), name: `${m.meta?.name ?? m.id} · ${peer.name}`, peer: peer.id },
  })));
}

// Les machines joignables qui ont ce modèle (nom sans @), avec ce qu'elles en disaient au dernier
// relevé : chargé, et avec une session libre.
export function peersWith(modelId) {
  return peers.flatMap((peer) => {
    const m = seen.get(peer.id)?.ok ? seen.get(peer.id).models.find((x) => x.id === modelId) : null;
    return m ? [{ peer: peer.id, loaded: Boolean(m.meta?.loaded), free: Boolean(m.meta?.free) }] : [];
  });
}

// Les machines joignables qui ont des modèles de voix.
export function peersWithVoice() {
  return peers.filter((p) => seen.get(p.id)?.ok && seen.get(p.id).voice)
    .map((peer) => ({ peer: { id: peer.id, name: peer.name, url: peer.url }, headers: headersOf(peer), voice: seen.get(peer.id).voice }));
}
// La première qui a ce modèle de voix (n'importe lequel sans modelId).
export function peerWithVoice(modelId = null) {
  return peersWithVoice().find((route) => !modelId || route.voice.models.some((m) => m.id === modelId)) ?? null;
}

// Une machine par son identifiant (« pc2 »), pour lui parler directement.
export function peerById(id) {
  const peer = peers.find((p) => p.id === id);
  return peer ? { peer: { id: peer.id, name: peer.name, url: peer.url }, headers: headersOf(peer) } : null;
}

// « modele@pc2 » → la machine et le nom du modèle chez elle ; null pour un modèle d'ici.
export function peerRoute(modelId) {
  const at = String(modelId ?? '').lastIndexOf(SEPARATOR);
  if (at <= 0) return null;
  const peer = peers.find((p) => p.id === modelId.slice(at + 1));
  return peer ? { peer: { id: peer.id, name: peer.name, url: peer.url }, remoteId: modelId.slice(0, at), headers: headersOf(peer) } : null;
}

// Pour les tests.
export function _setPeers(list, states = {}) {
  peers = list;
  seen.clear();
  asked.clear();
  for (const [id, s] of Object.entries(states)) seen.set(id, s);
}
