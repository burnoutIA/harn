import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { update } from './state.mjs';

const controllers = new Map();

// L'empreinte SHA-256 d'un fichier déjà sur le disque (reprise, copie locale réutilisée).
export async function hashFile(file, hash = createHash('sha256')) {
  for await (const chunk of createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })) hash.update(chunk);
  return hash;
}

const mismatch = (label, expected, actual) => new Error(`Empreinte SHA-256 différente pour ${label} : attendu ${expected.slice(0, 16)}…, reçu ${actual.slice(0, 16)}… Le fichier est corrompu ou a été modifié ; il a été supprimé.`);

// Téléchargement reprenable : on écrit dans .part et on reprend avec Range là où on s'est
// arrêté. Un modèle de 40 Go interrompu ne repart jamais de zéro.
// sha256 : l'empreinte publiée par la source (Hugging Face, GitHub). Calculée au fil de l'eau ;
// un fichier qui ne correspond pas est supprimé et l'installation échoue.
export async function download({ id, label, url, dest, expectedBytes = null, headers = {}, sha256 = null }) {
  await mkdir(path.dirname(dest), { recursive: true });
  const done = await stat(dest).catch(() => null);
  if (done && (!expectedBytes || Math.abs(done.size - expectedBytes) / expectedBytes < 0.02)) {
    update((s) => { s.downloads[id] = { label, received: done.size, total: done.size, speed: 0, done: true }; });
    return dest;
  }

  const partial = `${dest}.part`;
  const offset = (await stat(partial).catch(() => null))?.size ?? 0;
  const controller = new AbortController();
  controllers.set(id, controller);

  const response = await fetch(url, {
    headers: { 'User-Agent': 'harn', ...headers, ...(offset ? { Range: `bytes=${offset}-` } : {}) },
    signal: controller.signal,
    redirect: 'follow',
  });
  if (!response.ok && response.status !== 206) throw new Error(`Téléchargement refusé (${response.status}) : ${label}`);
  const resumed = response.status === 206;
  const start = resumed ? offset : 0;
  // Une reprise relit d'abord ce qui est déjà reçu : l'empreinte porte sur le fichier entier.
  const hash = sha256 ? (resumed ? await hashFile(partial) : createHash('sha256')) : null;
  const length = Number(response.headers.get('content-length')) || 0;
  const total = length ? start + length : expectedBytes;

  let received = start;
  let windowBytes = 0;
  let windowStart = Date.now();
  let speed = 0;
  let lastEmit = 0;
  update((s) => { s.downloads[id] = { label, received, total, speed, done: false }; });

  const body = Readable.fromWeb(response.body);
  body.on('data', (chunk) => {
    hash?.update(chunk);
    received += chunk.length;
    windowBytes += chunk.length;
    const now = Date.now();
    if (now - windowStart >= 1000) {
      speed = windowBytes / ((now - windowStart) / 1000);
      windowBytes = 0;
      windowStart = now;
    }
    if (now - lastEmit > 400) {
      lastEmit = now;
      update((s) => { Object.assign(s.downloads[id], { received, total, speed }); });
    }
  });

  try {
    await pipeline(body, createWriteStream(partial, { flags: resumed ? 'a' : 'w' }));
  } catch (error) {
    update((s) => { Object.assign(s.downloads[id], { received, speed: 0, paused: true, error: controller.signal.aborted ? null : error.message }); });
    throw error;
  } finally {
    controllers.delete(id);
  }
  if (hash) {
    const actual = hash.digest('hex');
    if (actual !== sha256.toLowerCase()) {
      await rm(partial, { force: true });
      update((s) => { Object.assign(s.downloads[id], { speed: 0, paused: true, error: 'empreinte SHA-256 différente' }); });
      throw mismatch(label, sha256, actual);
    }
  }
  await rename(partial, dest);
  update((s) => { Object.assign(s.downloads[id], { received, total: received, speed: 0, done: true, paused: false, error: null }); });
  return dest;
}

export function cancelDownload(id) {
  controllers.get(id)?.abort();
}
