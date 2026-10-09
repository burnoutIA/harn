import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MODELS } from './catalog.mjs';
import { profileFromMetadata, readGgufMetadata } from './gguf.mjs';
import { DIRS } from './paths.mjs';

// Les modèles ajoutés depuis Hugging Face rejoignent le catalogue : même planification, même
// banc, même affichage. Leur description vit dans data/custom-models.json.
const FILE = path.join(DIRS.data, 'custom-models.json');
const HF = 'https://huggingface.co';

export async function loadCustomModels() {
  const list = JSON.parse(await readFile(FILE, 'utf8').catch(() => '[]'));
  for (const model of list) if (!MODELS.some((m) => m.id === model.id)) MODELS.push(model);
  return list;
}

async function saveCustomModels() {
  await mkdir(DIRS.data, { recursive: true });
  const list = MODELS.filter((model) => model.custom);
  await writeFile(`${FILE}.tmp`, JSON.stringify(list, null, 2));
  await rename(`${FILE}.tmp`, FILE);
}

export function parseRepo(input) {
  const match = String(input).trim().match(/(?:huggingface\.co\/)?([\w.-]+\/[\w.-]+)/);
  if (!match) throw new Error('Adresse Hugging Face non reconnue (attendu : https://huggingface.co/auteur/modele)');
  return match[1].replace(/\/(tree|blob|resolve)\/.*$/, '');
}

const QUANT = /(?:^|[-_.])((?:UD-)?(?:IQ\d_[A-Z]+|Q\d_K(?:_[A-Z]+)?|Q\d_\d|MXFP4(?:_MOE)?|NVFP4|BF16|F16|F32|TQ\d_\d|PQ\d_\d|PTQ\d_\d))/i;
const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/i;

// Tout ce qu'il faut pour choisir : fichiers regroupés par quantification (fragments réunis),
// projecteurs vision, licence, accès, réglages recommandés par l'auteur, architecture exacte.
export async function inspectRepo(input) {
  const repo = parseRepo(input);
  const [info, tree, readme] = await Promise.all([
    fetch(`${HF}/api/models/${repo}`, { headers: { 'User-Agent': 'harn' } }).then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Dépôt introuvable : ${repo} (${r.status})`)))),
    fetch(`${HF}/api/models/${repo}/tree/main?recursive=1`, { headers: { 'User-Agent': 'harn' } }).then((r) => (r.ok ? r.json() : [])),
    fetch(`${HF}/${repo}/raw/main/README.md`, { headers: { 'User-Agent': 'harn' } }).then((r) => (r.ok ? r.text() : '')),
  ]);
  const files = tree.filter((f) => f.type === 'file' && /\.gguf$/i.test(f.path));
  const mmproj = files.filter((f) => /mmproj/i.test(f.path)).map((f) => ({ name: f.path, bytes: f.size, sha256: f.lfs?.oid ?? null }));
  const groups = new Map();
  // Les têtes MTP et brouillons de spéculation sont des fichiers annexes, pas des quantifications.
  for (const file of files.filter((f) => !/mmproj|imatrix/i.test(f.path) && !/(^|\/)(mtp|draft|dflash)[-_]/i.test(f.path))) {
    const base = file.path.replace(SHARD, '.gguf');
    const quant = (path.basename(base).match(QUANT)?.[1] ?? path.basename(base, '.gguf')).toUpperCase();
    const group = groups.get(base) ?? { quant, files: [], bytes: 0 };
    group.files.push({ name: file.path, bytes: file.size, sha256: file.lfs?.oid ?? null });
    group.bytes += file.size;
    groups.set(base, group);
  }
  const quants = [...groups.values()].map((g) => ({ ...g, files: g.files.sort((a, b) => a.name.localeCompare(b.name)) })).sort((a, b) => a.bytes - b.bytes);
  if (!quants.length) throw new Error('Aucun fichier GGUF dans ce dépôt : Harn ne sait servir que des GGUF (llama.cpp).');

  // L'architecture est la même pour toutes les quantifications : on lit l'en-tête de la plus petite.
  const sample = quants[0].files[0].name;
  const metadata = await readGgufMetadata(`${HF}/${repo}/resolve/main/${encodeURIComponent(sample).replace(/%2F/g, '/')}`);
  const profile = profileFromMetadata(metadata);
  const sampling = readme.split('\n').filter((line) => /temperature|temp=|top_p|top-p|top_k|top-k|min_p|presence_penalty|--spec|mmproj/i.test(line)).slice(0, 12).map((line) => line.trim().slice(0, 240));
  return {
    repo,
    license: info.cardData?.license ?? null,
    gated: Boolean(info.gated),
    tags: (info.tags ?? []).filter((t) => !t.includes(':')).slice(0, 12),
    profile,
    quants,
    mmproj,
    readmeHints: sampling,
  };
}

// Enregistre un modèle choisi : une entrée de catalogue comme les autres.
// Les noms varient selon les sources (llama.cpp, vLLM, transformers) : on ramène aux nôtres.
function normalizeSampling(sampling) {
  const out = { ...sampling };
  if (out.repetition_penalty !== undefined && out.repeat_penalty === undefined) out.repeat_penalty = out.repetition_penalty;
  delete out.repetition_penalty;
  return out;
}

export function buildEntry({ repo, quant, profile, mmproj = null, sampling = null, name = null, tagline = null }) {
  const id = `${repo.split('/')[1]}-${quant.quant}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const bytes = quant.bytes;
  const weightsGiB = bytes / 1024 ** 3;
  const entry = {
    id,
    custom: true,
    addedAt: new Date().toISOString(),
    name: name ?? profile.name ?? repo.split('/')[1],
    variant: `${quant.quant}${profile.mtp ? ' · MTP' : ''}${profile.experts ? ' · MoE' : ''}`,
    tagline: tagline ?? `Ajouté depuis huggingface.co/${repo}.`,
    engine: 'llama',
    repo,
    files: quant.files,
    mmproj: mmproj ? { repo, ...mmproj } : undefined,
    kvBytesPerToken: profile.kvBytesPerToken,
    needs: { vramGiB: 0, ramGiB: Math.ceil(weightsGiB / 2) + 8 },
    fullGpuVramGiB: +(weightsGiB + 3.8).toFixed(1),
    contextByVram: [[0, 32768]],
    quality: null,
    reasoning: true,
    vision: Boolean(mmproj),
    mtp: profile.mtp,
    moe: profile.experts ? { experts: profile.experts, used: profile.expertsUsed } : null,
    sampling: normalizeSampling({ temperature: 0.7, top_p: 0.95, top_k: 20, min_p: 0, ...(sampling ?? {}) }),
    reasoningLevels: ['low', 'medium', 'xhigh'],
    evidence: null,
    profile,
  };
  return entry;
}

export function registerModel(options) {
  const entry = buildEntry(options);
  const id = entry.id;
  const index = MODELS.findIndex((m) => m.id === id);
  if (index >= 0) MODELS[index] = entry; else MODELS.push(entry);
  return saveCustomModels().then(() => entry);
}

// Retirer un modèle ajouté : il disparaît du catalogue (on peut le rajouter depuis Hugging Face).
export async function unregisterModel(id) {
  const index = MODELS.findIndex((m) => m.id === id && m.custom);
  if (index < 0) return;
  MODELS.splice(index, 1);
  await saveCustomModels();
}

export async function setModelQuality(id, quality) {
  const model = MODELS.find((m) => m.id === id);
  if (!model?.custom) return;
  model.quality = quality;
  await saveCustomModels();
}
