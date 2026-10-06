import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from './paths.mjs';

// Les clés API des clients de /v1 (repris de Llama Control). Seule l'empreinte SHA-256 de chaque
// clé est gardée, dans data/api-keys.json (hors dépôt). Tant qu'aucune clé n'existe, /v1 reste
// ouvert sur la boucle locale ; créer la première ferme la porte, y compris en local.
// À part : la clé interne de Harn (pi agent, banc d'intelligence, analyse), toujours acceptée en
// local, et qui ne compte pas comme une clé créée.

export const KEYS_FILE = path.join(DIRS.data, 'api-keys.json');
const INTERNAL_FILE = path.join(DIRS.data, 'harn.key');
// Préfixe reconnaissable : une clé retrouvée dans une configuration s'identifie sans la tester.
const PREFIX = 'sk-harn-';
// Le script en ligne de commande peut modifier le fichier pendant que Harn tourne : relu quand
// son horodatage bouge, au plus une fois par seconde.
const RELOAD_TTL_MS = 1000;
const SAVE_DEBOUNCE_MS = 2000;
const MAX_LABEL = 80;

const failure = (status, message) => Object.assign(new Error(message), { status });

export const generateKey = () => `${PREFIX}${randomBytes(32).toString('base64url')}`;
export const hashKey = (token) => createHash('sha256').update(String(token ?? ''), 'utf8').digest('hex');

// Comparer caractère par caractère offrirait un oracle sur les positions déjà devinées.
function same(left, right) {
  const a = Buffer.from(String(left ?? ''), 'utf8');
  const b = Buffer.from(String(right ?? ''), 'utf8');
  return a.length > 0 && a.length === b.length && timingSafeEqual(a, b);
}

export function bearerToken(headers = {}) {
  const match = /^Bearer\s+(.+)$/i.exec(String(headers.authorization ?? '').trim());
  return match ? match[1].trim() : null;
}

// « /k/<clé>/v1/... » : pour les clients qui laissent choisir l'URL mais pas les en-têtes
// (Copilot). Le préfixe est retiré avant tout routage.
const KEY_IN_PATH = /^\/k\/([^/]+)((?:\/.*)?)$/;
export function extractPathKey(pathname) {
  const match = KEY_IN_PATH.exec(pathname);
  if (!match) return { token: null, pathname };
  let token;
  try { token = decodeURIComponent(match[1]); } catch { token = match[1]; }
  return { token, pathname: match[2] || '/' };
}

// Un préfixe suffit à reconnaître la clé qu'on croit avoir collée, sans jamais la journaliser.
export const fingerprint = (token) => (token ? `${String(token).slice(0, 12)}… (${String(token).length} caractères)` : 'aucune');

let keys = [];
let status = 'disabled'; // disabled (aucune clé) · active · invalid (fichier illisible : tout est refusé)
let fileError = null;
let mtimeMs = null;
let checkedAt = 0;
let saveTimer = null;

function normalize(record) {
  if (!record || typeof record.id !== 'string' || typeof record.hash !== 'string' || !record.id || !record.hash) return null;
  return {
    id: record.id,
    label: typeof record.label === 'string' && record.label.trim() ? record.label.trim() : record.id,
    hash: record.hash,
    createdAt: record.createdAt ?? null,
    lastUsedAt: record.lastUsedAt ?? null,
    requests: Number.isFinite(record.requests) ? record.requests : 0,
    tokens: Number.isFinite(record.tokens) ? record.tokens : 0,
  };
}

// L'empreinte ne sort jamais du module : ni vers l'interface, ni vers les journaux.
const publicRecord = ({ hash, ...rest }) => rest;

async function stamp() {
  mtimeMs = (await stat(KEYS_FILE).catch(() => null))?.mtimeMs ?? null;
  checkedAt = Date.now();
}

export async function loadKeys() {
  let payload;
  try {
    payload = JSON.parse(await readFile(KEYS_FILE, 'utf8'));
  } catch (error) {
    keys = [];
    status = error.code === 'ENOENT' ? 'disabled' : 'invalid';
    fileError = error.code === 'ENOENT' ? null : `Fichier de clés illisible : ${error.message}`;
    await stamp();
    return keys;
  }
  const records = Array.isArray(payload?.keys) ? payload.keys.map(normalize) : null;
  if (!records || records.some((r) => !r)) {
    // Un fichier abîmé ne doit surtout pas rouvrir la porte : tout est refusé jusqu'à correction.
    keys = [];
    status = 'invalid';
    fileError = 'Le fichier data/api-keys.json contient un enregistrement invalide';
  } else {
    keys = records;
    status = keys.length ? 'active' : 'disabled';
    fileError = null;
  }
  await stamp();
  return keys;
}

async function refresh() {
  if (Date.now() - checkedAt < RELOAD_TTL_MS) return;
  const current = (await stat(KEYS_FILE).catch(() => null))?.mtimeMs ?? null;
  checkedAt = Date.now();
  if (current !== mtimeMs) await loadKeys();
}

async function saveKeys() {
  await mkdir(DIRS.data, { recursive: true });
  await writeFile(`${KEYS_FILE}.tmp`, JSON.stringify({ version: 1, keys }, null, 2));
  await rename(`${KEYS_FILE}.tmp`, KEYS_FILE);
  await stamp();
}

export const keysEnforced = () => status === 'active';

export async function listKeys() {
  await refresh();
  return { state: status, enforced: keysEnforced(), error: fileError, keys: keys.map(publicRecord) };
}

export async function createKey(label) {
  const name = String(label ?? '').trim();
  if (!name) throw failure(400, 'Donnez un nom à la clé, par exemple « Portable — Copilot »');
  if (name.length > MAX_LABEL) throw failure(400, `Nom de clé limité à ${MAX_LABEL} caractères`);
  await loadKeys();
  if (status === 'invalid') throw failure(409, `${fileError}. Corrigez-le ou supprimez-le avant de créer une clé.`);
  if (keys.some((key) => key.label.toLowerCase() === name.toLowerCase())) throw failure(409, `Une clé porte déjà le nom « ${name} »`);
  const token = generateKey();
  const record = { id: `key_${randomBytes(6).toString('hex')}`, label: name, hash: hashKey(token), createdAt: new Date().toISOString(), lastUsedAt: null, requests: 0, tokens: 0 };
  keys.push(record);
  status = 'active';
  await saveKeys();
  // Le secret n'existe qu'ici : il n'est ni stocké ni réaffichable.
  return { token, key: publicRecord(record) };
}

// Révoquer, c'est supprimer : une clé retirée ne peut pas revenir.
export async function revokeKey(id, { keepOne = false } = {}) {
  await loadKeys();
  if (status === 'invalid') throw failure(409, fileError);
  const record = keys.find((key) => key.id === id);
  if (!record) throw failure(404, `Clé inconnue : ${id}`);
  if (keepOne && keys.length === 1) throw failure(409, 'Coupez d’abord l’accès réseau local : il exige au moins une clé.');
  keys = keys.filter((key) => key.id !== id);
  status = keys.length ? 'active' : 'disabled';
  await saveKeys();
  return publicRecord(record);
}

export function recordUsage(id, tokens = 0) {
  const record = keys.find((key) => key.id === id);
  if (!record) return;
  record.requests += 1;
  if (Number.isFinite(tokens) && tokens > 0) record.tokens += Math.round(tokens);
  record.lastUsedAt = new Date().toISOString();
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveCounters().catch(() => {}); }, SAVE_DEBOUNCE_MS);
  saveTimer.unref?.();
}

// Les compteurs ne valent pas d'écraser une révocation faite entre-temps par le script : si le
// fichier a bougé, on le relit et les derniers compteurs sont perdus.
async function saveCounters() {
  const current = (await stat(KEYS_FILE).catch(() => null))?.mtimeMs ?? null;
  if (current !== mtimeMs) return loadKeys();
  return saveKeys();
}

export async function flushKeys() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  await saveCounters();
}

// La clé de Harn lui-même : créée une fois, gardée en clair (pi doit pouvoir la lire dans sa
// configuration). Elle n'ouvre que la boucle locale, jamais le réseau.
let internal = null;
export async function internalKey() {
  if (internal) return internal;
  const stored = (await readFile(INTERNAL_FILE, 'utf8').catch(() => '')).trim();
  if (stored.startsWith(PREFIX)) return (internal = stored);
  internal = generateKey();
  await mkdir(DIRS.data, { recursive: true });
  await writeFile(INTERNAL_FILE, internal);
  return internal;
}

// Décide d'une requête /v1. lan : la requête arrive par le port réseau, où une clé créée est
// toujours exigée. Rend { ok, key, internal } ou { ok: false, status, message }.
export async function authorize(token, { lan = false } = {}) {
  await refresh();
  if (status === 'invalid') return { ok: false, status: 503, message: `Authentification indisponible : ${fileError}` };
  if (token && !lan && same(token, await internalKey())) return { ok: true, key: null, internal: true };
  if (!token) {
    if (!lan && !keysEnforced()) return { ok: true, key: null };
    return { ok: false, status: 401, message: 'Clé API manquante : renseignez le champ api_key de votre client (en-tête « Authorization: Bearer <clé> ») ou utilisez l’adresse /k/<clé>/v1.' };
  }
  if (!keysEnforced()) {
    // Une clé envoyée alors qu'aucune n'existe : en local on laisse passer (les clients OpenAI
    // en exigent une, souvent « sk-local »), sur le réseau il n'y a rien qui puisse la valider.
    return lan ? { ok: false, status: 401, message: 'Aucune clé API n’est enregistrée dans Harn.' } : { ok: true, key: null };
  }
  const hash = hashKey(token);
  const key = keys.find((k) => same(k.hash, hash));
  return key ? { ok: true, key: publicRecord(key) } : { ok: false, status: 401, message: 'Clé API inconnue ou révoquée.' };
}
