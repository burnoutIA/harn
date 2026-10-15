// Les LoRA d'un agent : les fichiers posés dans lora/ de son dossier de travail (lui seul s'en
// sert : un agent par personne, et un LoRA est souvent un visage). Pour chacun, le réseau de
// diffusion visé, lu dans l'en-tête du fichier : un LoRA ne s'applique qu'à son réseau.
import { open, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { ARCH_NAMES, loraArchOf } from './image-families.mjs';

export const LORA_FILE = /\.(safetensors|gguf|ckpt)$/i;
export const loraDirOf = (workspace) => path.join(workspace, 'lora');

// L'en-tête d'un .safetensors : 8 octets (sa longueur), puis du JSON ; ses métadonnées sont dans
// __metadata__. Seul l'en-tête est lu, pas les poids.
const MAX_HEADER = 64 * 1024 * 1024;
async function safetensorsMetadata(file) {
  const handle = await open(file, 'r');
  try {
    const size = Buffer.alloc(8);
    await handle.read(size, 0, 8, 0);
    const length = Number(size.readBigUInt64LE(0));
    if (!length || length > MAX_HEADER) return {};
    const header = Buffer.alloc(length);
    await handle.read(header, 0, length, 8);
    return JSON.parse(header.toString('utf8')).__metadata__ ?? {};
  } catch {
    return {};
  } finally {
    await handle.close();
  }
}

// Le réseau visé, et le mot déclencheur quand l'outil d'entraînement l'a écrit (champ standard
// modelspec.trigger_phrase).
const cache = new Map(); // chemin → { key, arch, trigger }
async function describeFile(file, info) {
  const key = `${info.size}/${info.mtimeMs}`;
  if (cache.get(file)?.key !== key) {
    const metadata = /\.safetensors$/i.test(file) ? await safetensorsMetadata(file) : {};
    const trigger = String(metadata['modelspec.trigger_phrase'] ?? '').trim().slice(0, 200) || null;
    cache.set(file, { key, arch: loraArchOf(metadata), trigger });
  }
  return cache.get(file);
}

// name : ce qui s'écrit dans la description, <lora:name:echelle>. notes : ce que la fiche de
// l'agent en dit (ce qu'il représente, comment s'en servir), par nom.
export async function listLoras(workspace, notes = {}) {
  const dir = loraDirOf(workspace);
  const out = [];
  for (const file of (await readdir(dir).catch(() => [])).filter((name) => LORA_FILE.test(name)).sort()) {
    const full = path.join(dir, file);
    const info = await stat(full).catch(() => null);
    if (!info?.isFile()) continue;
    const { arch, trigger } = await describeFile(full, info);
    const name = file.replace(/\.[^.]+$/, '');
    out.push({ name, file, bytes: info.size, arch, archName: arch ? ARCH_NAMES[arch] ?? arch : null, trigger, note: notes[name] ?? null, modifiedAt: info.mtime.toISOString() });
  }
  return out;
}

// Les LoRA cités dans une description : <lora:nom:echelle>.
export const lorasIn = (prompt) => [...String(prompt).matchAll(/<lora:([^:>]+):[^>]*>/g)].map((m) => m[1]);

export async function deleteLora(workspace, file) {
  if (!LORA_FILE.test(file) || path.basename(file) !== file) throw Object.assign(new Error('Fichier LoRA invalide'), { status: 400 });
  await rm(path.join(loraDirOf(workspace), file));
}
