import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { MODELS } from './catalog.mjs';
import { profileFromMetadata, readGgufFile, readGgufMetadata } from './gguf.mjs';
import { findLocalCopies } from './local-files.mjs';
import { DIRS } from './paths.mjs';
import { paramsOf } from './rating.mjs';

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
// « …-MTP-draft.gguf », ou tout fichier rangé dans un dossier MTP/ (le nom y reprend souvent la
// quantification des poids : « MTP/gemma-4-12B-it-MTP-Q8_0.gguf » n'est pas une Q8_0 du modèle).
const MTP_DRAFT = /mtp[-_]?draft|(^|\/)mtp\//i;
const SHARD = /-(\d{5})-of-(\d{5})\.gguf$/i;
// Architectures des brouillons de spéculation (DFlash/DSpark, têtes MTP de Gemma 4, EAGLE).
const DRAFT_ARCH = /^(dflash|dspark|eagle\d*)$|-assistant$/i;
// Aucune quantification ne descend sous ~1,5 bit par poids (IQ1_S) : un fichier bien plus petit
// que ne le veut la taille annoncée n'est pas le modèle (brouillon, correctif, adaptateur…).
const MIN_BITS_PER_WEIGHT = 1.2;
export const plausibleWeights = (bytes, paramsB) => !paramsB || (bytes * 8) / (paramsB * 1e9) >= MIN_BITS_PER_WEIGHT;

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
  // La tête MTP livrée dans un fichier à part (« …-MTP-draft.gguf ») : les poids ne la contiennent
  // pas, le moteur la charge comme brouillon de spéculation, quelle que soit la quantification.
  const drafts = files.filter((f) => MTP_DRAFT.test(f.path)).map((f) => ({ name: f.path, bytes: f.size, sha256: f.lfs?.oid ?? null }));
  const groups = new Map();
  // Les têtes MTP et brouillons de spéculation sont des fichiers annexes, pas des quantifications.
  for (const file of files.filter((f) => !/mmproj|imatrix/i.test(f.path) && !MTP_DRAFT.test(f.path) && !/(^|\/)(mtp|draft|dflash|dspark|eagle\d*)[-_/]/i.test(f.path))) {
    const base = file.path.replace(SHARD, '.gguf');
    const quant = (path.basename(base).match(QUANT)?.[1] ?? path.basename(base, '.gguf')).toUpperCase();
    const group = groups.get(base) ?? { quant, files: [], bytes: 0 };
    group.files.push({ name: file.path, bytes: file.size, sha256: file.lfs?.oid ?? null });
    group.bytes += file.size;
    groups.set(base, group);
  }
  const all = [...groups.values()].map((g) => ({ ...g, files: g.files.sort((a, b) => a.name.localeCompare(b.name)) })).sort((a, b) => a.bytes - b.bytes);
  if (!all.length) throw new Error('Aucun fichier GGUF dans ce dépôt : Harn ne sait servir que des GGUF (llama.cpp).');
  // Les annexes au nom inconnu (« lilicorr-…-NVFP4.gguf ») trahies par leur taille, d'après celle du dépôt.
  const quants = all.filter((q) => plausibleWeights(q.bytes, paramsOf({ repo })));
  if (!quants.length) throw new Error(`Aucun fichier de ce dépôt n’a la taille d’un modèle de ${paramsOf({ repo })}B : seulement des annexes (brouillons, projecteurs…).`);

  // L'architecture est la même pour toutes les quantifications : on lit l'en-tête de la plus petite.
  // Dépôt à accès restreint : Hugging Face liste les fichiers mais refuse leur contenu. Un fichier
  // déjà sur la machine (même nom, même taille) donne le même en-tête, et servira à l'installation.
  let local = {};
  const readHeader = async () => {
    const sample = quants[0].files[0];
    return readGgufMetadata(`${HF}/${repo}/resolve/main/${encodeURIComponent(sample.name).replace(/%2F/g, '/')}`).then((metadata) => ({ metadata, group: quants[0] })).catch(async (error) => {
      local = await findLocalCopies([...quants.flatMap((q) => q.files), ...drafts, ...mmproj], { timeBudgetMs: 6000 });
      // N'importe quelle quantification déjà là fait l'affaire : son premier fichier porte l'en-tête.
      const group = quants.find((q) => local[q.files[0].name]);
      if (group) return { metadata: await readGgufFile(local[group.files[0].name]), group };
      if (!info.gated) throw error;
      throw new Error(`Dépôt à accès restreint : Hugging Face refuse de donner ses fichiers sans compte autorisé. Harn sait l’installer si le fichier est déjà sur cette machine : placez ${sample.name} (${(sample.bytes / 1e9).toFixed(1)} Go) dans le dossier models/ de Harn, puis relancez.`);
    });
  };
  // Un brouillon de spéculation au nom trompeur (« dspark-…-Q8_0.gguf ») passe le tri par nom : son
  // architecture le trahit. Il sort de la liste, sinon il serait proposé comme une petite quantification.
  let { metadata, group } = await readHeader();
  while (DRAFT_ARCH.test(metadata.meta['general.architecture'] ?? '')) {
    quants.splice(quants.indexOf(group), 1);
    if (!quants.length) throw new Error(`Ce dépôt ne contient qu’un brouillon de spéculation (architecture « ${metadata.meta['general.architecture']} ») : il accélère un modèle, il ne se sert pas seul.`);
    ({ metadata, group } = await readHeader());
  }
  // Même contrôle avec la taille lue dans l'en-tête, quand le nom du dépôt ne la donnait pas.
  const headerB = paramsOf({ profile: { sizeLabel: metadata.meta['general.size_label'] } });
  for (const q of [...quants]) if (!plausibleWeights(q.bytes, headerB)) quants.splice(quants.indexOf(q), 1);
  if (!quants.length) throw new Error(`Aucun fichier de ce dépôt n’a la taille d’un modèle de ${headerB}B.`);
  const profile = profileFromMetadata(metadata);
  const sampling = readme.split('\n').filter((line) => /temperature|temp=|top_p|top-p|top_k|top-k|min_p|presence_penalty|--spec|mmproj/i.test(line)).slice(0, 12).map((line) => line.trim().slice(0, 240));
  return {
    repo,
    license: info.cardData?.license ?? null,
    gated: Boolean(info.gated),
    // Fichiers du dépôt déjà sur cette machine (cherchés quand Hugging Face refuse le contenu).
    local,
    tags: (info.tags ?? []).filter((t) => !t.includes(':')).slice(0, 12),
    profile,
    quants,
    mmproj,
    // Plusieurs précisions de la même tête : Q8_0 suffit à un brouillon, deux fois moins lourde que BF16.
    mtpDraft: drafts.find((d) => /Q8_0/i.test(d.name)) ?? drafts[0] ?? null,
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

// strata : un Flash-Next que Strata sait servir (voir installStrataPack) plutôt que llama.cpp.
export function buildEntry({ repo, quant, profile, mmproj = null, mtpDraft = null, sampling = null, name = null, tagline = null, strata = false }) {
  const id = `${repo.split('/')[1]}-${quant.quant}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  const bytes = quant.bytes;
  const weightsGiB = bytes / 1024 ** 3;
  const entry = {
    id,
    custom: true,
    addedAt: new Date().toISOString(),
    name: name ?? profile.name ?? repo.split('/')[1],
    variant: `${quant.quant}${profile.mtp || mtpDraft ? ' · MTP' : ''}${profile.experts ? ' · MoE' : ''}`,
    tagline: tagline ?? `Ajouté depuis huggingface.co/${repo}.`,
    engine: 'llama',
    repo,
    files: quant.files,
    mmproj: mmproj ? { repo, ...mmproj } : undefined,
    mtpDraft: mtpDraft ? { repo, ...mtpDraft } : undefined,
    kvBytesPerToken: profile.kvBytesPerToken,
    needs: { vramGiB: 0, ramGiB: Math.ceil(weightsGiB / 2) + 8 },
    fullGpuVramGiB: +(weightsGiB + 3.8).toFixed(1),
    contextByVram: [[0, 32768]],
    quality: null,
    reasoning: true,
    vision: Boolean(mmproj),
    mtp: profile.mtp || Boolean(mtpDraft),
    moe: profile.experts ? { experts: profile.experts, used: profile.expertsUsed } : null,
    sampling: normalizeSampling({ temperature: 0.7, top_p: 0.95, top_k: 20, min_p: 0, ...(sampling ?? {}) }),
    reasoningLevels: ['low', 'medium', 'xhigh'],
    evidence: null,
    profile,
  };
  if (!strata) return entry;
  // Sous Strata : sa propre tête MTP et pas de vision pour l'instant ; les experts (les deux tiers
  // du fichier environ) vivent en RAM, la carte garde les plus demandés.
  return {
    ...entry,
    variant: `${quant.quant} · Strata`,
    engine: 'strata',
    strataModel: `pack-${id}`,
    strataPack: true,
    arenaGB: +(bytes / 1e9 * 0.66).toFixed(1),
    mmproj: undefined,
    mtpDraft: undefined,
    vision: false,
    mtp: true,
    sparse: true,
    needs: { vramGiB: 11.5, ramGiB: 48, nvidiaCc: 7.5 },
    contextByVram: [[11.5, 65536], [20, 131072]],
    reasoningLevels: ['low', 'medium', 'high'],
  };
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
