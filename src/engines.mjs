// Les moteurs que Harn sait installer : une fiche par moteur. Une fiche dit d'où il vient
// (binaire publié ou compilation d'un commit figé), sur quelles machines il tourne, ce qu'il
// ajoute à la ligne de commande et quels réglages essayer au banc. Un modèle n'est pas lié à un
// moteur : le banc mesure ceux qui savent le charger et garde le plus rapide.
//
// Architectures : un GGUF dit la sienne (general.architecture), un moteur llama.cpp connaît la
// liste écrite dans son src/llama-arch.cpp. Les comparer avant de télécharger évite d'installer
// 14 Go pour découvrir au chargement « unknown model architecture ».
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { llamAmpereEligible, mtpPlan } from './levers.mjs';
import { buildEngine, installLlama, latestRelease } from './runtimes.mjs';
import { getState, update } from './state.mjs';

// Compiler demande Linux, une NVIDIA et les outils (nvcc, cmake, g++ accepté par nvcc).
export const canBuild = (hardware) => hardware?.os?.platform === 'linux' && hardware?.primary?.vendor === 'nvidia' && Boolean(hardware?.buildTools?.ok);
const cudaArchOf = (hardware) => String(Math.round((hardware?.primary?.computeCapability ?? 8.6) * 10));

// Réglage repris d'un autre moteur : K/V et profondeur MTP propres à un fork ramenés au commun.
function portable(tuning, profile) {
  return {
    ...tuning,
    kv: tuning.kvV ? 'q8_0' : tuning.kv,
    kvV: undefined,
    spec: tuning.spec?.n === 'auto' ? { type: 'mtp', ...mtpPlan(profile).base } : tuning.spec,
  };
}

const BUILTIN = {
  llama: { id: 'llama', label: 'llama.cpp', repo: 'ggml-org/llama.cpp', source: 'release', tag: /^b\d+$/ },
  // Prism ne sert que les modèles ternaires Bonsai, qui le désignent eux-mêmes.
  prism: { id: 'prism', label: 'llama.cpp Prism', repo: 'PrismML-Eng/llama.cpp', source: 'release', tag: /^prism-/, alternate: false },
  // llamAmpere (github.com/JakeATX/llamAmpere) : noyaux écrits pour les RTX 30. Mesuré sur la 3090
  // de référence : code +15-20 %, ~3 Gio de VRAM en moins avec son KV tq5_0/turbo4.
  llamampere: {
    id: 'llamampere', label: 'llamAmpere', repo: 'JakeATX/llamAmpere', source: 'build',
    ref: '83aa38c18e5c73f2eaff5ca7aacf9b9eab882318', version: 'v0.5', cudaArch: '86',
    eligible: llamAmpereEligible,
    // Par défaut il garde la moitié de la RAM et 16 Gio de disque pour son cache de prompts :
    // aligné sur l'officiel (8 Gio de RAM, rien sur le disque).
    args: ['--cache-ram', '8192', '--no-cache-disk'],
    // Sa propre profondeur MTP (adaptative 3-4) : l'optimum de l'officiel (souvent 2-3) le bride.
    arms: (tuning, model) => {
      const base = { ...tuning, kvV: undefined, kv: tuning.kvV ? 'q8_0' : tuning.kv, spec: model.mtp ? { type: 'mtp', n: 'auto' } : tuning.spec };
      return [{ ...base, kv: 'tq5_0', kvV: 'turbo4' }, base];
    },
  },
};

// Une fiche, intégrée ou ajoutée avec l'accord de l'utilisateur (state.engines : PR, fork). Les
// fiches ajoutées ne servent qu'aux architectures pour lesquelles on les a cherchées.
export function engineSheet(id, hardware = getState().hardware) {
  if (!id) return BUILTIN.llama;
  if (BUILTIN[id]) return BUILTIN[id];
  const added = getState().engines?.[id];
  return added && { ...added, source: 'build', cudaArch: cudaArchOf(hardware), eligible: canBuild };
}
const sheets = () => [...Object.keys(BUILTIN), ...Object.keys(getState().engines ?? {})].map((id) => engineSheet(id));

export const parseArchs = (source) => [...source.matchAll(/\{\s*LLM_ARCH_[A-Z0-9_]+,\s*"([^"]+)"\s*\}/g)].map((m) => m[1]);

async function rawArchs(repo, ref) {
  const response = await fetch(`https://raw.githubusercontent.com/${repo}/${ref}/src/llama-arch.cpp`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Liste des architectures de ${repo}@${ref} illisible (${response.status})`);
  return parseArchs(await response.text());
}

// Mise en cache par version : une version publiée ou un commit ne change plus. Le code source
// d'un moteur compilé ici est lu sur le disque.
export async function engineArchs(id, ref) {
  const key = `${id}@${ref}`;
  const cached = getState().engineArchs?.[key];
  if (cached) return cached;
  const sheet = engineSheet(id);
  let archs = null;
  const runtime = Object.values(getState().runtimes ?? {}).find((r) => r.kind === id && (r.tag === ref || r.commit === ref));
  for (const up of runtime?.dir ? ['..', '../..', '../../..'] : []) {
    const local = await readFile(path.join(runtime.dir, up, 'src', 'llama-arch.cpp'), 'utf8').catch(() => null);
    if (local) { archs = parseArchs(local); break; }
  }
  archs ??= await rawArchs(sheet.repo, ref);
  if (!archs.length) throw new Error(`Aucune architecture trouvée pour ${key}`);
  update((s) => { s.engineArchs = { ...s.engineArchs, [key]: archs }; });
  return archs;
}

// La dernière version publiée d'un moteur, gardée une heure : GitHub limite à 60 requêtes par
// heure sans compte, et la veille vérifie une vingtaine de dépôts d'affilée.
const latestTags = new Map();
async function latestTag(sheet) {
  const hit = latestTags.get(sheet.id);
  if (hit && Date.now() - hit.at < 3_600_000) return hit.tag;
  const tag = (await latestRelease({ repo: sheet.repo, tag: sheet.tag }).catch(() => null))?.tag_name ?? null;
  if (tag) latestTags.set(sheet.id, { tag, at: Date.now() });
  return tag;
}

// Les versions à considérer pour chaque moteur utilisable ici : celle installée, et pour un
// moteur publié la dernière version si elle est plus récente (refresh : il faudra la mettre à jour).
async function candidates(hardware) {
  const runtimes = Object.values(getState().runtimes ?? {});
  const list = [];
  for (const sheet of sheets()) {
    if (sheet.eligible && !sheet.eligible(hardware)) continue;
    if (sheet.source === 'build') { list.push({ id: sheet.id, ref: sheet.ref }); continue; }
    const installed = runtimes.find((r) => r.kind === sheet.id && r.tag)?.tag;
    const latest = await latestTag(sheet);
    if (installed) list.push({ id: sheet.id, ref: installed });
    if (latest && latest !== installed) list.push({ id: sheet.id, ref: latest, refresh: Boolean(installed) });
  }
  return list;
}

// Les moteurs de cette machine qui savent charger une architecture, le moteur officiel en tête.
// null : on ne sait pas (GitHub injoignable) ; on ne bloque rien, le chargement tranchera.
export async function enginesFor(arch, hardware = getState().hardware) {
  if (!arch) return null;
  let known = false;
  const found = [];
  for (const candidate of await candidates(hardware)) {
    const sheet = engineSheet(candidate.id);
    if (sheet.onlyArchs && !sheet.onlyArchs.includes(arch)) continue;
    const archs = await engineArchs(candidate.id, candidate.ref).catch(() => null);
    if (!archs) continue;
    known = true;
    // La version installée suffit : inutile de proposer aussi la mise à jour.
    if (archs.includes(arch) && !found.some((f) => f.id === candidate.id)) found.push({ ...candidate, label: sheet.label });
  }
  return known ? found : null;
}

export const archMissing = (arch) => `Architecture « ${arch} » : aucun moteur de Harn ne sait encore la charger`;

// Installer (ou compiler) le moteur d'une fiche. Rend le runtime, avec son backend.
export async function ensureEngine(candidate, { hardware = getState().hardware, backend = getState().plan?.backend?.id, onLog = () => {} } = {}) {
  const sheet = engineSheet(candidate.id);
  if (sheet.source === 'release') return installLlama(sheet.id, backend, { refresh: Boolean(candidate.refresh) });
  if (!canBuild(hardware)) throw new Error(`${sheet.label} se compile sur cette machine, ce qui demande Linux, une carte NVIDIA et les outils de compilation`);
  return buildEngine(sheet, hardware.buildTools, onLog);
}

// Une compilation ratée n'est retentée que si les outils ont changé (paquet ajouté).
export function failedBuild(id, hardware = getState().hardware) {
  const failure = getState().buildFailures?.[id];
  return Boolean(failure) && JSON.stringify(failure.tools) === JSON.stringify(hardware?.buildTools);
}
export function recordBuildFailure(id, error, hardware = getState().hardware) {
  update((s) => { s.buildFailures = { ...s.buildFailures, [id]: { error: error.message.slice(0, 300), at: new Date().toISOString(), tools: hardware?.buildTools } }; });
}

// Les autres moteurs à mesurer au banc pour ce modèle, et les réglages à essayer sur chacun.
export async function alternates(model, tuning, profile, hardware = getState().hardware) {
  if (model.engine === 'prism' || model.engine === 'strata') return [];
  const current = tuning.fork ?? 'llama';
  const arch = model.profile?.arch;
  // Sans architecture connue (catalogue intégré) : les moteurs généraux utilisables ici.
  const list = (arch ? await enginesFor(arch, hardware) : null)
    ?? sheets().filter((s) => !s.onlyArchs && (!s.eligible || s.eligible(hardware))).map((s) => ({ id: s.id, ref: s.ref, label: s.label }));
  return list
    .filter((c) => c.id !== current && !c.refresh && engineSheet(c.id).alternate !== false && !failedBuild(c.id, hardware))
    .map((c) => {
      const sheet = engineSheet(c.id);
      const arms = (backend) => {
        const base = { ...portable(tuning, profile), fork: c.id === 'llama' ? undefined : c.id, backend };
        return sheet.arms ? sheet.arms(base, model) : [base];
      };
      return { ...c, label: sheet.label, arms };
    });
}

// ── Chercher le moteur qui manque ─────────────────────────
// 1. une version officielle plus récente qui connaît l'architecture ;
// 2. une PR ouverte de llama.cpp dont le code la connaît (code non fusionné : accord demandé).
const GH = 'https://api.github.com';
const gh = (route) => fetch(`${GH}${route}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'harn' }, signal: AbortSignal.timeout(20_000) })
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`GitHub ne répond pas (${r.status})`))));

// exclude : moteurs déjà essayés sans succès pour ce modèle.
export async function findEngine(arch, { name = null, exclude = [] } = {}) {
  const official = BUILTIN.llama;
  const latest = await latestTag(official);
  if (latest && (await engineArchs('llama', latest).catch(() => [])).includes(arch)) {
    return { kind: 'official', candidate: { id: 'llama', ref: latest, refresh: true }, label: `llama.cpp ${latest}` };
  }
  const seen = new Set();
  // Les PR ouvertes d'abord, puis les fermées sans fusion (une variante « cleanup » peut être
  // celle qui a servi à produire le GGUF). Une PR fusionnée est déjà dans les versions officielles.
  for (const state of ['open', 'closed']) for (const query of [arch, name?.split(/[\s-]/)[0]].filter(Boolean)) {
    const search = await gh(`/search/issues?q=${encodeURIComponent(`${query} repo:${official.repo} is:pr is:${state}`)}&per_page=5`).catch(() => ({ items: [] }));
    for (const item of search.items ?? []) {
      if (seen.has(item.number) || exclude.includes(`llama-pr-${item.number}`)) continue;
      seen.add(item.number);
      const pr = await gh(`/repos/${official.repo}/pulls/${item.number}`).catch(() => null);
      if (!pr?.head?.repo || pr.merged) continue;
      const archs = await rawArchs(pr.head.repo.full_name, pr.head.sha).catch(() => []);
      if (!archs.includes(arch)) continue;
      return {
        kind: 'pr',
        label: `llama.cpp PR #${pr.number}`,
        sheet: {
          id: `llama-pr-${pr.number}`, label: `llama.cpp PR #${pr.number}`, repo: pr.head.repo.full_name, ref: pr.head.sha,
          url: pr.html_url, title: pr.title, author: pr.user?.login ?? '?', state: pr.state, onlyArchs: [arch], foundAt: new Date().toISOString(),
        },
      };
    }
  }
  return null;
}

// Accord donné : la fiche entre dans le registre, ses architectures sont connues tout de suite.
export async function addEngine(sheet) {
  update((s) => { s.engines = { ...s.engines, [sheet.id]: { ...sheet, approvedAt: new Date().toISOString() } }; });
  update((s) => { s.engineArchs = { ...s.engineArchs, [`${sheet.id}@${sheet.ref}`]: sheet.onlyArchs }; });
}
