import { createWriteStream } from 'node:fs';
import { mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { update } from './state.mjs';

const controllers = new Map();

// Téléchargement reprenable : on écrit dans .part et on reprend avec Range là où on s'est
// arrêté. Un modèle de 40 Go interrompu ne repart jamais de zéro.
export async function download({ id, label, url, dest, expectedBytes = null, headers = {} }) {
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
  await rename(partial, dest);
  update((s) => { Object.assign(s.downloads[id], { received, total: received, speed: 0, done: true, paused: false, error: null }); });
  return dest;
}

export function cancelDownload(id) {
  controllers.get(id)?.abort();
}
