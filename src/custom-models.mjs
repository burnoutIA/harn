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
  // Un dossier « Mainline_Support » (Unsloth, Inkling 2) range les mêmes poids dans la disposition
  // que lit llama.cpp officiel, sous l'extension .gguf_file : les fichiers de la racine, eux, ne se
  // chargent que dans le build d'Unsloth. Harn sert des moteurs issus de llama.cpp : ce sont ceux-là
  // qu'il prend, à la place des fichiers de la racine du même nom.
  const MAINLINE = /(^|\/)mainline[^/]*\/[^/]+\.gguf_file$/i;
  const mainline = tree.filter((f) => f.type === 'file' && MAINLINE.test(f.path));
  const replaced = new Set(mainline.map((f) => path.basename(f.path).replace(/\.gguf_file$/i, '.gguf').toLowerCase()));
  const files = [...tree.filter((f) => f.type === 'file' && /\.gguf$/i.test(f.path) && !(f.path === path.basename(f.path) && replaced.has(f.path.toLowerCase()))), ...mainline];
  const mmproj = files.filter((f) => /mmproj/i.test(f.path)).map((f) => ({ name: f.path, bytes: f.size, sha256: f.lfs?.oid ?? null }));
  // La tête MTP livrée dans un fichier à part (« …-MTP-draft.gguf ») : les poids ne la contiennent
  // pas, le moteur la charge comme brouillon de spéculation, quelle que soit la quantification.
  const drafts = files.filter((f) => MTP_DRAFT.test(f.path)).map((f) => ({ name: f.path, bytes: f.size, sha256: f.lfs?.oid ?? null }));
  // Le brouillon DSpark (Inkling 2 : « dspark-Inkling-2-Mini-Q8_0.gguf », 0,4 Go) : essayé au banc
  // (--spec-type draft-dspark), sur un moteur qui le connaît (PR #32218 de llama.cpp).
  const sparks = files.filter((f) => /^dspark[-_]/i.test(path.basename(f.path))).map((f) => ({ name: f.path, bytes: f.size, sha256: f.lfs?.oid ?? null }));
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
    dspark: sparks.find((d) => /Q8_0/i.test(d.name)) ?? sparks.sort((a, b) => a.bytes - b.bytes)[0] ?? null,
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
// card : ce que la fiche du modèle dit et que le GGUF ne dit pas, lu par pi (readModelCard) :
// maxContext (Olala : le GGUF annonce 100 000, la fiche « -c at most 32,768 »), les niveaux de
// raisonnement de son gabarit (Olala : disabled, low, medium, high), et les mises en garde à garder
// avec le modèle (« use bf16 on GPUs »).
export const REASONING_LEVELS = ['disabled', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export function cardFacts(card) {
  if (!card) return null;
  const maxContext = Number.isInteger(card.maxContext) && card.maxContext >= 2048 && card.maxContext <= 1 << 21 ? card.maxContext : null;
  const levels = Array.isArray(card.reasoningLevels) ? card.reasoningLevels.map(String).filter((l) => REASONING_LEVELS.includes(l)) : [];
  const notes = Array.isArray(card.notes) ? card.notes.map((n) => String(n).slice(0, 300)).filter(Boolean).slice(0, 8) : [];
  // requiredPr : la ou les PR sans lesquelles la fiche dit que le modèle répond faux ou perd un
  // levier, même si la version officielle connaît déjà l'architecture (Inkling 2 : #32704, perplexité
  // 130 au lieu de 7,65 ; puis DSpark #32218 et unslothai/llama.cpp#385). Un numéro est une PR de
  // llama.cpp ; « propriétaire/dépôt#n » celle d'un fork. Toujours une liste (ou null).
  const prRef = (ref) => (Number.isInteger(ref) && ref > 0 ? ref : typeof ref === 'string' && /^([\w.-]+\/[\w.-]+)?#\d+$/.test(ref.trim()) ? ref.trim() : null);
  const refs = (Array.isArray(card.requiredPr) ? card.requiredPr : card.requiredPr != null ? [card.requiredPr] : []).map(prRef);
  const requiredPr = refs.length && refs.length <= 6 && refs.every(Boolean) ? [...new Set(refs)] : null;
  return { maxContext, reasoningLevels: levels.length ? levels : null, notes: notes.length ? notes : null, requiredPr };
}

// engineOnly : le seul moteur qui sert ce modèle (fiche de engines.mjs), quand les autres le chargent
// mais répondent faux. Le banc ne lui oppose aucun autre moteur.
export function buildEntry({ repo, quant, profile, mmproj = null, mtpDraft = null, dspark = null, sampling = null, name = null, tagline = null, strata = false, card = null, engineOnly = null }) {
  const facts = cardFacts(card);
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
    dspark: dspark ? { repo, ...dspark } : undefined,
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
    reasoningLevels: facts?.reasoningLevels ?? ['low', 'medium', 'xhigh'],
    cardNotes: facts?.notes ?? undefined,
    evidence: null,
    profile: facts?.maxContext ? { ...profile, maxContext: facts.maxContext } : profile,
    engineOnly: engineOnly ?? undefined,
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

// ── LoRA de texte ─────────────────────────────────────────
// Un adaptateur GGUF (general.type = adapter, adapter.type = lora) chargé par llama.cpp au-dessus
// d'un modèle déjà installé (--lora) : un profil à part, qui reprend les fichiers de sa base.
const ADAPTER_MAX_BYTES = 8 * 1024 ** 3;
async function adapterFiles(repo) {
  const tree = await fetch(`${HF}/api/models/${repo}/tree/main?recursive=1`, { headers: { 'User-Agent': 'harn' } }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const found = [];
  for (const file of tree.filter((f) => f.type === 'file' && /\.gguf$/i.test(f.path) && f.size <= ADAPTER_MAX_BYTES && !/mmproj/i.test(f.path))) {
    const { meta } = await readGgufMetadata(`${HF}/${repo}/resolve/main/${encodeURIComponent(file.path).replace(/%2F/g, '/')}`).catch(() => ({ meta: {} }));
    if (meta['general.type'] !== 'adapter' || meta['adapter.type'] !== 'lora') continue;
    found.push({ name: file.path, bytes: file.size, sha256: file.lfs?.oid ?? null, arch: meta['general.architecture'] ?? null, alpha: meta['adapter.lora.alpha'] ?? null, baseName: meta['general.base_model.0.name'] ?? null });
  }
  return found;
}

// baseArch : l'architecture du modèle installé qui recevra l'adaptateur (lue dans son GGUF).
export async function inspectLora(input, { baseArch = null } = {}) {
  const requested = parseRepo(input);
  let repo = requested;
  let found = await adapterFiles(repo);
  // Un LoRA PEFT (adapter_model.safetensors) ne se charge pas tel quel dans llama.cpp : sa
  // conversion en GGUF est d'habitude publiée à côté, sous « …-GGUF ».
  for (const candidate of [`${requested}-GGUF`, `${requested}-gguf`]) {
    if (found.length) break;
    found = await adapterFiles(candidate);
    if (found.length) repo = candidate;
  }
  if (!found.length) throw new Error(`Aucun LoRA au format GGUF dans ${requested}${requested === repo ? ` (ni dans ${requested}-GGUF)` : ''} : llama.cpp ne charge que des adaptateurs GGUF (convert_lora_to_gguf.py convertit un LoRA PEFT).`);
  const fitting = found.filter((f) => !baseArch || !f.arch || f.arch === baseArch);
  if (!fitting.length) throw new Error(`Ce LoRA vise l’architecture « ${found[0].arch} », le modèle de base choisi est « ${baseArch} » : il ne s’y applique pas.`);
  // F16 (ou BF16) d'abord : quelques centaines de Mo, et au plus près des poids entraînés.
  const lora = fitting.find((f) => /(^|[-_.])b?f16([-_.]|$)/i.test(f.name)) ?? fitting[0];
  return { repo, requested, lora, alternatives: found.map((f) => f.name) };
}

export const loraModelId = (baseId, loraRepo) => `${baseId}-lora-${loraRepo.split('/')[1].toLowerCase().replace(/-gguf$/, '')}`.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// reasoning : false pour un adaptateur entraîné sans réflexion (le moteur la coupe, pi ne la propose plus).
export function buildLoraEntry({ base, loraRepo, lora, name = null, tagline = null, sampling = null, reasoning = null, card = null }) {
  const facts = cardFacts(card);
  const { name: file, bytes, sha256 } = lora;
  return {
    ...structuredClone(base),
    id: loraModelId(base.id, loraRepo),
    custom: true,
    addedAt: new Date().toISOString(),
    name: name ?? `${base.name} + ${loraRepo.split('/')[1].replace(/-GGUF$/i, '')}`,
    variant: `${base.variant} · LoRA`,
    tagline: tagline ?? `${base.name} avec le LoRA huggingface.co/${loraRepo}.`,
    lora: { repo: loraRepo, name: file, bytes, sha256 },
    loraOf: base.id,
    quality: null,
    evidence: null,
    sampling: normalizeSampling({ ...base.sampling, ...(sampling ?? {}) }),
    reasoning: reasoning ?? base.reasoning,
    reasoningLevels: facts?.reasoningLevels ?? base.reasoningLevels,
    cardNotes: facts?.notes ?? undefined,
  };
}

export function registerLoraModel(options) {
  const entry = buildLoraEntry(options);
  const index = MODELS.findIndex((m) => m.id === entry.id);
  if (index >= 0) MODELS[index] = entry; else MODELS.push(entry);
  return saveCustomModels().then(() => entry);
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
