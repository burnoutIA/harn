// Les modèles d'images venus de Hugging Face : analyser un dépôt pour cette machine, l'ajouter à
// la liste, et proposer chaque jour les meilleurs modèles que la carte fait tourner.
// La famille du modèle (FLUX, Qwen-Image, Z-Image…) décide des fichiers d'accompagnement et des
// réglages : voir image-families.mjs. Seuls les GGUF sont pris (comme pour le texte).
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { bestQuant, companionsFor, diffusionVariants, familyOf, memoryNeeds, notImageModel } from './image-families.mjs';
import { DIRS } from './paths.mjs';
import { getState, update } from './state.mjs';

const HF = 'https://huggingface.co';
const FILE = path.join(DIRS.data, 'image-models.json');
const EVERY_MS = 24 * 60 * 60 * 1000;
const PER_FAMILY = 2;          // propositions gardées par famille : les plus aimées
const MAX_ITEMS = 12;
const MAX_INSPECT = 24;        // dépôts analysés par passage (2 requêtes chacun)

const hf = (pathname) => fetch(`${HF}${pathname}`, { headers: { 'User-Agent': 'harn' }, signal: AbortSignal.timeout(20_000) })
  .then((r) => (r.ok ? r.json() : Promise.reject(Object.assign(new Error(`Hugging Face a répondu ${r.status} pour ${pathname.split('?')[0]}`), { status: r.status }))));

export function parseRepo(input) {
  const match = String(input ?? '').trim().match(/(?:huggingface\.co\/)?([\w.-]+\/[\w.-]+)/);
  if (!match) throw Object.assign(new Error('Adresse Hugging Face non reconnue (attendu : https://huggingface.co/auteur/modele)'), { status: 400 });
  return match[1].replace(/\/(tree|blob|resolve)\/.*$/, '');
}

// ── La liste des modèles ajoutés ───────────────────────────────
// Même forme que les modèles du catalogue (images.mjs), avec custom: true.
let added = [];
export const addedImageModels = () => added;

export async function loadImageModels() {
  added = JSON.parse(await readFile(FILE, 'utf8').catch(() => '[]'));
  return added;
}

async function saveImageModels() {
  await mkdir(DIRS.data, { recursive: true });
  await writeFile(`${FILE}.tmp`, JSON.stringify(added, null, 2));
  await rename(`${FILE}.tmp`, FILE);
  // L'interface relit la liste quand ce repère change.
  update((s) => { (s.images ??= {}).listChangedAt = Date.now(); });
}

export async function forgetImageModel(id) {
  added = added.filter((model) => model.id !== id);
  await saveImageModels();
}

// ── Analyser un dépôt ──────────────────────────────────────────
const baseModelsOf = (tags = []) => tags.filter((t) => t.startsWith('base_model:')).map((t) => t.split(':').pop());
const licenseOf = (info) => info.cardData?.license_name ?? info.cardData?.license ?? (info.tags ?? []).find((t) => t.startsWith('license:'))?.slice(8) ?? null;

// La taille des fichiers d'accompagnement : lue une fois par passage, ils sont partagés.
const sizes = new Map();
async function sizeOf(file) {
  const key = `${file.repo}/${file.name}`;
  if (!sizes.has(key)) {
    sizes.set(key, fetch(`${HF}/${file.repo}/resolve/main/${file.name.split('/').map(encodeURIComponent).join('/')}`, { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': 'harn' }, signal: AbortSignal.timeout(20_000) })
      .then((r) => Number(r.headers.get('x-linked-size')) || 0).catch(() => 0));
  }
  return sizes.get(key);
}

const machine = () => {
  const hardware = getState().hardware;
  return { vramGiB: (hardware?.primary?.vramMiB ?? 0) / 1024, ramGiB: hardware?.ramGiB ?? 0 };
};

async function analyse(repo) {
  const [card, tree] = await Promise.all([
    hf(`/api/models/${repo}`).catch((error) => { throw Object.assign(new Error(error.status === 404 ? `Dépôt introuvable : ${repo}` : error.message), { status: 400 }); }),
    hf(`/api/models/${repo}/tree/main?recursive=1`).catch(() => []),
  ]);
  const files = tree.filter((f) => f.type === 'file').map((f) => ({ name: f.path, bytes: f.size, sha256: f.lfs?.oid ?? null }));
  const baseModels = baseModelsOf(card.tags);
  const variants = (notImageModel(repo) ? [] : diffusionVariants(files)).map((variant) => ({ ...variant, family: familyOf({ repo, file: variant.stem, baseModels }) }));
  return { card, files, baseModels, variants };
}

// Ce qu'une quantification demande sur cette machine, fichiers d'accompagnement compris.
async function weigh(family, weights) {
  const { vramGiB, ramGiB } = machine();
  const companions = companionsFor(family, vramGiB);
  const companionBytes = await Promise.all(companions.map(sizeOf));
  const needs = memoryNeeds(weights.bytes, companionBytes);
  return { companions, needs, ramGiB, gigabytes: +((weights.bytes + companionBytes.reduce((sum, b) => sum + b, 0)) / 1e9).toFixed(1) };
}

// Tout ce qu'il faut pour choisir : chaque variante du dépôt, sa famille, la quantification qui
// tient sur cette carte et ce qu'elle demande.
export async function inspectImageRepo(input) {
  const repo = parseRepo(input);
  const { card, files, baseModels, variants } = await analyse(repo);
  const { vramGiB } = machine();
  const known = [];
  for (const variant of variants.filter((v) => v.family)) {
    const best = bestQuant(variant, vramGiB);
    const chosen = best ?? variant.quants.find((q) => !/^(BF16|F16|F32)$/.test(q.quant)) ?? variant.quants[0];
    const { needs, ramGiB, gigabytes } = await weigh(variant.family, chosen);
    known.push({
      stem: variant.stem,
      family: variant.family.id,
      familyName: variant.family.name,
      edit: variant.family.edit,
      file: chosen.name,
      quant: chosen.quant,
      quants: variant.quants.map((q) => q.quant),
      gigabytes,
      needs,
      fits: Boolean(best) && needs.ramGiB <= ramGiB,
    });
  }
  return {
    repo,
    name: repo.split('/')[1].replace(/[-_]?(gguf|ggufs|quantized)$/i, ''),
    license: licenseOf(card),
    gated: Boolean(card.gated),
    likes: card.likes ?? 0,
    downloads: card.downloads ?? 0,
    lastModified: card.lastModified ?? null,
    baseModels,
    variants: known,
    unknown: variants.filter((v) => !v.family).map((v) => v.stem),
    problem: card.gated ? 'Dépôt à accès restreint : Hugging Face refuse ses fichiers sans compte autorisé.'
      : !files.some((f) => /\.gguf$/i.test(f.name)) ? 'Aucun fichier GGUF dans ce dépôt : Harn ne sait installer que des modèles d’images en GGUF.'
      : !known.length ? 'Famille de modèle non reconnue : stable-diffusion.cpp la sait peut-être faire tourner, mais Harn ne sait pas encore quels fichiers aller chercher avec.'
      : null,
  };
}

// ── Ajouter un modèle ──────────────────────────────────────────
export const imageIdOf = (repo, file) => `${repo.split('/')[1]}-${path.basename(file, '.gguf')}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);

// Une entrée comme celles du catalogue. file : le fichier de poids choisi dans le dépôt ; sans lui,
// la quantification conseillée de la variante principale.
export async function addImageModel({ repo: input, file = null }) {
  const repo = parseRepo(input);
  const { card, variants } = await analyse(repo);
  const fail = (message) => Object.assign(new Error(message), { status: 400 });
  if (card.gated) throw fail('Dépôt à accès restreint : Hugging Face refuse ses fichiers sans compte autorisé.');
  const variant = file ? variants.find((v) => v.quants.some((q) => q.name === file)) : variants.find((v) => v.family);
  if (!variant) throw fail(file ? `« ${file} » n’est pas un fichier de poids de ${repo}` : `Aucun modèle d’images reconnu dans ${repo}`);
  if (!variant.family) throw fail(`Famille de modèle non reconnue pour ${file}`);
  const weights = file ? variant.quants.find((q) => q.name === file) : (bestQuant(variant, machine().vramGiB) ?? variant.quants[0]);
  const { companions, needs, gigabytes } = await weigh(variant.family, weights);
  const name = repo.split('/')[1].replace(/[-_]?(gguf|ggufs|quantized)$/i, '');
  const entry = {
    id: imageIdOf(repo, weights.name),
    custom: true,
    addedAt: new Date().toISOString(),
    name: `${name}${variant.stem.includes('/') ? ` · ${path.basename(variant.stem)}` : ''} · ${weights.quant}`,
    family: variant.family.id,
    tagline: `${variant.family.name}. ${variant.family.tagline}`,
    license: licenseOf(card) ?? 'voir le dépôt',
    repo,
    gigabytes,
    vramGiB: Math.ceil(needs.vramGiB),
    ramGiB: Math.ceil(needs.ramGiB),
    edit: variant.family.edit,
    files: [{ role: 'diffusion', repo, name: weights.name, sha256: weights.sha256 }, ...companions],
    args: variant.family.args,
  };
  added = [...added.filter((model) => model.id !== entry.id), entry];
  await saveImageModels();
  return entry;
}

// ── Propositions ───────────────────────────────────────────────
// Les modèles d'images en GGUF les plus aimés et les plus en vogue, gardés seulement si leur
// famille est connue et qu'ils tiennent sur cette machine ; deux par famille au plus.
async function candidates() {
  const lists = await Promise.all([
    hf('/api/models?filter=gguf&pipeline_tag=text-to-image&sort=likes&direction=-1&limit=100').catch(() => []),
    hf('/api/models?filter=gguf&pipeline_tag=text-to-image&sort=trendingScore&direction=-1&limit=60').catch(() => []),
    hf('/api/models?filter=gguf&pipeline_tag=image-to-image&sort=likes&direction=-1&limit=40').catch(() => []),
  ]);
  const seen = new Map();
  for (const m of lists.flat()) {
    if (seen.has(m.id) || m.gated || notImageModel(m.id)) continue;
    const family = familyOf({ repo: m.id, baseModels: baseModelsOf(m.tags) });
    if (!family) continue;
    seen.set(m.id, { repo: m.id, family: family.id, likes: m.likes ?? 0, downloads: m.downloads ?? 0, lastModified: m.lastModified ?? null });
  }
  return [...seen.values()].sort((a, b) => b.likes - a.likes || b.downloads - a.downloads);
}

const hardwareKey = () => { const { vramGiB, ramGiB } = machine(); return `${Math.round(vramGiB)}/${Math.round(ramGiB)}`; };
const isInstalledRepo = (repo) => added.some((model) => model.repo?.toLowerCase() === repo.toLowerCase());

let running = null;
export function checkImageHub() {
  running ??= (async () => {
    if (!getState().hardware) return getState().imageWatch;
    update((s) => { s.imageWatch = { ...(s.imageWatch ?? {}), checking: true, error: null }; });
    try {
      const previous = getState().imageWatch ?? {};
      const cache = new Map((previous.items ?? []).map((item) => [item.repo, item]));
      const dismissed = new Set(previous.dismissed ?? []);
      const perFamily = new Map();
      const items = [];
      let inspected = 0;
      for (const candidate of (await candidates()).filter((c) => !dismissed.has(c.repo))) {
        if ((perFamily.get(candidate.family) ?? 0) >= PER_FAMILY) continue;
        let item = cache.get(candidate.repo);
        if (!item || item.lastModified !== candidate.lastModified || item.hardwareKey !== hardwareKey()) {
          if (inspected >= MAX_INSPECT) continue;
          inspected += 1;
          const report = await inspectImageRepo(candidate.repo).catch(() => null);
          const main = report?.variants[0];
          if (!report || report.problem || !main) continue;
          item = { repo: report.repo, name: report.name, license: report.license, lastModified: candidate.lastModified, hardwareKey: hardwareKey(), ...main };
        }
        item = { ...item, likes: candidate.likes, downloads: candidate.downloads };
        if (!item.fits) continue;
        perFamily.set(candidate.family, (perFamily.get(candidate.family) ?? 0) + 1);
        items.push(item);
      }
      update((s) => { s.imageWatch = { ...s.imageWatch, checking: false, checkedAt: new Date().toISOString(), items, error: null }; });
    } catch (error) {
      update((s) => { s.imageWatch = { ...(s.imageWatch ?? {}), checking: false, error: error.message }; });
    }
    return getState().imageWatch;
  })().finally(() => { running = null; });
  return running;
}

// Ce que l'interface montre : sans les dépôts déjà ajoutés ni les familles déjà dans la liste
// (covered : les familles des modèles proposés par Harn et de ceux ajoutés).
export function imageSuggestions(covered = new Set()) {
  return (getState().imageWatch?.items ?? [])
    .filter((item) => !isInstalledRepo(item.repo) && !covered.has(item.family))
    .slice(0, MAX_ITEMS);
}

export function dismissImageSuggestion(repo) {
  update((s) => {
    s.imageWatch = { ...(s.imageWatch ?? {}), dismissed: [...new Set([...(s.imageWatch?.dismissed ?? []), repo])] };
    s.imageWatch.items = (s.imageWatch.items ?? []).filter((item) => item.repo !== repo);
  });
}

export function watchImageHub() {
  update((s) => { if (s.imageWatch) s.imageWatch.checking = false; });
  const due = () => !getState().imageWatch?.checkedAt || Date.now() - Date.parse(getState().imageWatch.checkedAt) > EVERY_MS;
  setTimeout(() => { if (due()) checkImageHub(); }, 90_000);
  setInterval(() => { if (due()) checkImageHub(); }, 60 * 60 * 1000).unref();
}
