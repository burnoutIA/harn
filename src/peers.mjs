import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from './paths.mjs';

// Les autres machines qui font tourner Harn (« pairs »). Celle-ci joint leur API réseau local
// (port lan, clé exigée) et propose leurs modèles sous le nom « modele@pair » : une requête pour
// l'un d'eux part telle quelle vers la machine qui l'a, qui le charge et gère sa propre carte.
// Les clés des pairs vivent dans data/peers.json et ne sortent jamais d'ici : ni vers
// l'interface, ni vers les clients de /v1.

export const PEERS_FILE = path.join(DIRS.data, 'peers.json');
export const SEPARATOR = '@';
const POLL_MS = 30_000;
const TIMEOUT_MS = 4_000;
const MAX_NAME = 40;

let peers = [];            // { id, name, url, key, addedAt }
const seen = new Map();    // id → { ok, error, models, checkedAt }
let timer = null;

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
    seen.set(peer.id, { ok: true, error: null, models, checkedAt: Date.now() });
  } catch (error) {
    const message = error.name === 'TimeoutError' ? 'ne répond pas (machine éteinte, Harn arrêté ou réseau local fermé ?)' : error.cause?.code === 'ECONNREFUSED' ? 'connexion refusée (réseau local fermé sur l’autre machine ?)' : error.message;
    seen.set(peer.id, { ok: false, error: message, models: [], checkedAt: Date.now() });
  }
  return seen.get(peer.id);
}

export const refreshPeers = () => Promise.all(peers.map(poll));

export async function startPeers() {
  await load();
  await refreshPeers();
  clearInterval(timer);
  timer = setInterval(() => { refreshPeers().catch(() => {}); }, POLL_MS);
  timer.unref?.();
}

export function stopPeers() { clearInterval(timer); timer = null; }

// Pour l'interface : jamais la clé.
export function peersReport() {
  return peers.map(({ id, name, url, addedAt }) => {
    const s = seen.get(id) ?? { ok: null, error: null, models: [], checkedAt: null };
    return { id, name, url, addedAt, ok: s.ok, error: s.error, checkedAt: s.checkedAt, models: s.models.map((m) => ({ id: `${m.id}${SEPARATOR}${id}`, name: m.meta?.name ?? m.id, context: m.meta?.context ?? null })) };
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
  for (const [id, s] of Object.entries(states)) seen.set(id, s);
}
