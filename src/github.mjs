// L'API GitHub, en un seul endroit : versions des moteurs, PR de llama.cpp, mises à jour de Harn.
// Sans compte, GitHub limite à 60 requêtes par heure et par adresse IP : une veille et deux
// recherches de moteur suffisent à l'atteindre. D'où un cache, et un jeton facultatif lu dans
// GITHUB_TOKEN (ou GH_TOKEN), sinon dans data/github.token — jamais dans l'état, qui part à
// l'interface. Un jeton sans aucune permission suffit (lecture de dépôts publics) : 5 000 / heure.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { DIRS } from './paths.mjs';

const API = 'https://api.github.com';
const TTL_MS = 10 * 60_000;
const cache = new Map(); // route → { at, data }

function token() {
  if (process.env.GITHUB_TOKEN || process.env.GH_TOKEN) return process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
  try { return readFileSync(path.join(DIRS.data, 'github.token'), 'utf8').trim() || null; } catch { return null; }
}

export function githubHeaders() {
  const value = token();
  return { 'User-Agent': 'harn', Accept: 'application/vnd.github+json', ...(value ? { Authorization: `Bearer ${value}` } : {}) };
}

// route : chemin après api.github.com (« /repos/ggml-org/llama.cpp/releases?per_page=15 »).
export async function github(route, { ttl = TTL_MS, timeout = 20_000 } = {}) {
  const hit = cache.get(route);
  if (hit && Date.now() - hit.at < ttl) return hit.data;
  const response = await fetch(`${API}${route}`, { headers: githubHeaders(), signal: AbortSignal.timeout(timeout) });
  if (!response.ok) {
    if ((response.status === 403 || response.status === 429) && response.headers.get('x-ratelimit-remaining') === '0') {
      const reset = Number(response.headers.get('x-ratelimit-reset')) * 1000;
      const minutes = reset ? Math.max(1, Math.ceil((reset - Date.now()) / 60_000)) : null;
      throw new Error(`Limite de l’API GitHub atteinte${minutes ? ` (encore ${minutes} min)` : ''}${token() ? '' : ' : sans jeton, 60 requêtes par heure ; un jeton dans data/github.token en donne 5 000'}`);
    }
    throw new Error(`GitHub ne répond pas (${response.status})`);
  }
  const data = await response.json();
  cache.set(route, { at: Date.now(), data });
  return data;
}
