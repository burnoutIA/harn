// Les moteurs que Harn sait installer : une fiche par moteur. Une fiche dit d'où il vient
// (binaire publié ou compilation d'un commit figé), sur quelles machines il tourne, ce qu'il
// ajoute à la ligne de commande et quels réglages essayer au banc. Un modèle n'est pas lié à un
// moteur : le banc mesure ceux qui savent le charger et garde le plus rapide.
//
// Architectures : un GGUF dit la sienne (general.architecture), un moteur llama.cpp connaît la
// liste écrite dans son src/llama-arch.cpp. Les comparer avant de télécharger évite d'installer
// 14 Go pour découvrir au chargement « unknown model architecture ».
import { readFile, readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { llamAmpereEligible, mtpPlan } from './levers.mjs';
import { github } from './github.mjs';
import { sandboxAvailable, sandboxReady } from './sandbox.mjs';
import { buildEngine, buildHip, installLlama, latestRelease } from './runtimes.mjs';
import { modelById } from './catalog.mjs';
import { DIRS } from './paths.mjs';
import { getState, update } from './state.mjs';

// Compiler demande Linux, une NVIDIA et les outils (nvcc, cmake, g++ accepté par nvcc).
export const canBuild = (hardware) => hardware?.os?.platform === 'linux' && hardware?.primary?.vendor === 'nvidia' && Boolean(hardware?.buildTools?.ok);
// Radeon RDNA4 (RX 9000, R9700) sous Linux, la bulle disponible : le fork RDNA Boosts n'est pas relu.
const rdna4Linux = (hardware) => hardware?.os?.platform === 'linux' && hardware?.primary?.vendor === 'amd'
  && /RX 9\d{3}|R9[67]00/.test(hardware.primary.name ?? '') && sandboxReady();
// Un moteur ajouté (PR, fork) se compile ici : en CUDA sur une NVIDIA, en HIP sur une RDNA4 (dans la bulle).
export const buildable = (hardware) => canBuild(hardware) || rdna4Linux(hardware);
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
  // ngram : accepte --spec-type ngram-mod (vérifié sur b12064 et sur le fork RDNA Boosts).
  llama: { id: 'llama', label: 'llama.cpp', repo: 'ggml-org/llama.cpp', source: 'release', tag: /^b\d+$/, ngram: true },
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
  // RDNA Boosts : la série de correctifs HIP pour RDNA de stew675 (github.com/stew675/llama-cpp-rdna-boosts),
  // dans le fork de Harn (github.com/burnoutIA/llama-cpp-rdna-boosts, branche harn, voir HARN.md) :
  // la publication v16-4f9dfa0e3-r289 de stew675 plus deux blocs de Harn, compilés contre ROCm 10.1
  // (buildRdnaBoosts). Non relu : isolé.
  // - 0090 : la vérification spéculative (2-16 tokens) en WMMA int8, chaque poids décompressé une fois pour
  //   tous les tokens (Q4_K, Q5_K, Q6_K, IQ4_XS au format GGUF d'origine). GGML_CUDA_WMMA_MMVQ=0 le coupe ;
  // - 0091 : la fusion conv + normes q/k des couches DeltaNet, que la vérification refusait sur un faux
  //   chevauchement mémoire. Résultats identiques au bit près. GGML_CUDA_FUSE_GDN_CONV_NORM=0 la coupe.
  // R9700, Qwen3.8-27B UD-Q4_K_M, DFlash2 n=7, 10 graines (code / prose) : r289 de stew675 124 / 51 tok/s,
  // le fork de Harn 131 / 56 (cycle 47,4 → 42,6 ms) ; la version précédente (81e969e + les mêmes
  // correctifs) faisait 131 / 55.
  rdnaboosts: {
    id: 'rdnaboosts', label: 'llama.cpp RDNA Boosts', repo: 'burnoutIA/llama-cpp-rdna-boosts', source: 'build', builder: 'rdna',
    ref: '64f2e8862d4d208354ea0a3d0f29b53967a9f4e5', base: '4f9dfa0e360c2bbc3afdf11cbc6384f54a62c8ad',
    tree: '345e62faed5199208404b625c1e55c49ec5ac9e7', archsFrom: { repo: 'ggml-org/llama.cpp', ref: '4f9dfa0e360c2bbc3afdf11cbc6384f54a62c8ad' },
    isolated: true, eligible: rdna4Linux, ngram: true,
    // Bloc 0092 du fork de Harn : avec --spec-draft-mtp-vocab, le brouillon MTP garde tout le vocabulaire en notant
    // chaque token sur une copie 2 bits (Q2_0) de la tête de sortie, puis recalcule exactement les 64 meilleurs
    // (idée reprise de vllm-radiance). Uncensored Q4_K_M, 10 graines : MTP3 code 88,8 → 88,7, prose 48,2 → 53,4 ;
    // adaptatif ≤9 + n-gramme 115,4 → 115,1 / 43,0 → 47,4. Sans effet sur DFlash2.
    env: { LLAMA_MTP_DRAFT_COARSE: '64', LLAMA_MTP_DRAFT_COARSE_TYPE: 'q2_0' },
    // La fenêtre MTP du brouillon (qui cassait la vision au-delà de la fenêtre : « failed to process mtmd
    // chunk », 2026-11-03) est désactivée par défaut depuis r247 (--spec-draft-kv-window, ex-variable
    // LLAMA_SPEC_DRAFT_WINDOW, que Harn fixait à 0).
    // Les façons d'anticiper, départagées par le banc selon l'usage (R9700, Qwen3.8-27B Q4_K_M,
    // température 1, code / prose / ~32k) :
    // - brouillon DFlash2 : n=4 106 / 68 / 97, n=6 120 / 64 / 107 (n=5 115 / 66 / 105). Le meilleur partout ;
    //   avec le correctif WMMA, vérifier 8 tokens coûte presque autant que 2 : n=7 (le maximum que DFlash2
    //   vérifie) passe devant n=6, code 131 contre 125 ;
    // - MTP 3 sur un brouillon réduit aux 98 304 premiers tokens : 92 / 59 / 85 ;
    // - MTP adaptatif jusqu'à 9 + n-gramme : 116 / 51 / 126 (la profondeur monte trop en prose).
    arms: (tuning, model) => {
      const base = { ...tuning, backend: 'hip', kv: 'f16', kvV: undefined };
      const mtp = { ...base, spec: { type: 'mtp', n: 3, pMin: 0, vocab: 98304 } };
      if (model.dflash) return [{ ...base, spec: { type: 'dflash', n: 4 } }, { ...base, spec: { type: 'dflash', n: 7 } }, ...(model.mtp && !tuning.noNextn ? [mtp] : [])];
      if (!model.mtp || tuning.noNextn) return [{ ...base, spec: tuning.spec }];
      // MTP adaptatif ≤6 avec seuil 0,3 : la profondeur s'arrête dès que le brouillon doute. Uncensored Q4_K_M
      // (2026-11-14, 10 graines) : code 119 / prose 47 contre 116 / 42 pour ≤9 seuil 0 ; ≤9 reste (Swift : n-gramme long).
      return [mtp, { ...base, spec: { type: 'mtp-adaptive', n: 9, vocab: 98304 } }, { ...base, spec: { type: 'mtp-adaptive', n: 6, pMin: 0.3, vocab: 98304 } }];
    },
  },
};

// Une fiche, intégrée ou ajoutée avec l'accord de l'utilisateur (state.addedEngines : PR, fork). Les
// fiches ajoutées ne servent qu'aux architectures pour lesquelles on les a cherchées.
// (state.engines, lui, liste les modèles chargés et repart vide à chaque démarrage : y ranger les
// fiches les effaçait, et un fork compilé tournait ensuite hors de la bulle, faute de fiche.)
const addedSheets = () => getState().addedEngines ?? {};
export function engineSheet(id, hardware = getState().hardware) {
  if (!id) return BUILTIN.llama;
  if (BUILTIN[id]) return BUILTIN[id];
  const added = addedSheets()[id];
  if (added) return { ...added, source: 'build', cudaArch: cudaArchOf(hardware), eligible: buildable };
  // Un moteur hors de la liste intégrée dont la fiche manque (accord perdu) : code non relu, donc
  // isolé, et jamais proposé de lui-même. Un nouvel accord le remet au registre.
  return { id, label: id, source: 'build', isolated: true, orphan: true, onlyArchs: [], eligible: () => false };
}
// Les identifiants que findEngine donne aux moteurs ajoutés : seuls ceux-là sont nettoyés sans fiche.
const ADDED_ID = /^(llama-pr-\d+|fork-[a-z0-9-]+)$/;
const sheets = () => [...Object.keys(BUILTIN), ...Object.keys(addedSheets())].map((id) => engineSheet(id));

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
  // Un fork livré en correctifs (RDNA Boosts) n'a pas de src/ : la liste est celle de sa base.
  archs ??= await rawArchs(sheet.archsFrom?.repo ?? sheet.repo, sheet.archsFrom?.ref ?? ref);
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
  if (sheet.builder === 'rdna') return buildHip(sheet, hardware, onLog);
  // Un moteur ajouté sur une Radeon RDNA4 : même chaîne que RDNA Boosts (ROCm 10.1, dans la bulle).
  if (!canBuild(hardware) && rdna4Linux(hardware)) return buildHip(sheet, hardware, onLog);
  if (!canBuild(hardware)) throw new Error(`${sheet.label} se compile sur cette machine, ce qui demande Linux et une carte NVIDIA (avec les outils de compilation) ou une Radeon RDNA4 (avec bubblewrap)`);
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
  if (['prism', 'strata', 'hyperqwen', 'radiance', 'gemma-challenge'].includes(model.engine)) return [];
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
// 2. une PR ouverte de llama.cpp dont le code la connaît (code non fusionné : accord demandé) ;
// 3. un fork de llama.cpp cité par la fiche Hugging Face du modèle (Olala d'OVHai : « These files
//    need our llama.cpp fork »), accord demandé de la même façon.
const gh = (route) => github(route);
const HF = 'https://huggingface.co';

// Les dépôts GitHub cités par la fiche d'un modèle (et celle de son modèle de base, souvent la
// seule à parler du moteur), dans l'ordre où ils apparaissent.
async function citedRepos(repo) {
  const card = async (id) => {
    const response = await fetch(`${HF}/${id}/raw/main/README.md`, { headers: { 'User-Agent': 'harn' }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
    return response?.ok ? response.text() : '';
  };
  const text = await card(repo);
  const base = text.match(/^base_model:\s*(?:-\s*)?([\w.-]+\/[\w.-]+)\s*$/m)?.[1];
  return cardRepos(`${text}\n${base && base !== repo ? await card(base) : ''}`);
}
export function cardRepos(text) {
  const found = [...text.matchAll(/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?=[\/)\]\s"'#?<]|$)/g)].map(([, owner, name]) => `${owner}/${name}`);
  return [...new Set(found)].filter((full) => full.toLowerCase() !== BUILTIN.llama.repo);
}

// Un fork de llama.cpp cité par la fiche, dont la branche par défaut connaît l'architecture.
async function forkFromCard(arch, repo, exclude) {
  for (const full of (await citedRepos(repo)).slice(0, 8)) {
    const info = await gh(`/repos/${full}`).catch(() => null);
    if (!info || info.parent?.full_name !== BUILTIN.llama.repo) continue;
    const head = await gh(`/repos/${full}/commits/${info.default_branch}`).catch(() => null);
    if (!head?.sha) continue;
    const id = `fork-${full.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    if (exclude.includes(id)) continue;
    const archs = await rawArchs(full, head.sha).catch(() => []);
    if (!archs.includes(arch)) continue;
    return {
      kind: 'fork',
      label: `llama.cpp ${info.owner.login}`,
      sheet: {
        id, label: `llama.cpp ${info.owner.login}`, repo: full, ref: head.sha,
        url: info.html_url, title: head.commit?.message?.split('\n')[0]?.slice(0, 160) ?? full, author: info.owner.login, state: 'fork',
        citedBy: repo, onlyArchs: [arch], foundAt: new Date().toISOString(),
      },
    };
  }
  return null;
}

// exclude : moteurs déjà essayés sans succès pour ce modèle. repo : le dépôt Hugging Face du modèle.
export async function findEngine(arch, { name = null, exclude = [], repo = null } = {}) {
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
  return repo ? forkFromCard(arch, repo, exclude) : null;
}

// Accord donné : la fiche entre dans le registre, ses architectures sont connues tout de suite.
// isolated : compilé et lancé dans la bulle (sandbox.mjs) si bubblewrap est là au moment de l'accord.
export async function addEngine(sheet) {
  const isolated = await sandboxAvailable();
  update((s) => { s.addedEngines = { ...s.addedEngines, [sheet.id]: { ...sheet, isolated, approvedAt: new Date().toISOString() } }; });
  update((s) => { s.engineArchs = { ...s.engineArchs, [`${sheet.id}@${sheet.ref}`]: sheet.onlyArchs }; });
}

// Un moteur ajouté pour une architecture (PR, fork) n'a plus de raison d'être quand plus aucun
// modèle installé ne l'utilise : ses sources, sa compilation et sa fiche sont retirées. Il se
// recompile si un modèle de cette architecture revient (avec un nouvel accord).
async function sizeOf(target) {
  const info = await stat(target).catch(() => null);
  if (!info) return 0;
  if (!info.isDirectory()) return info.size;
  let total = 0;
  for (const name of await readdir(target)) total += await sizeOf(path.join(target, name));
  return total;
}

export async function dropUnusedEngines() {
  const state = getState();
  const installed = Object.keys(state.models ?? {}).filter((id) => state.models[id].installedAt);
  const archsInUse = new Set(installed.map((id) => modelById(id)?.profile?.arch).filter(Boolean));
  const forksInUse = new Set(installed.map((id) => state.profiles?.[id]?.tuning?.fork).filter(Boolean));
  // Les fiches ajoutées, et les moteurs compilés restés sans fiche (voir engineSheet).
  const orphans = [...new Set(Object.values(state.runtimes ?? {}).map((r) => r.kind))]
    .filter((kind) => kind && ADDED_ID.test(kind) && !addedSheets()[kind] && !forksInUse.has(kind))
    .map((id) => ({ id, label: id, onlyArchs: [] }));
  const dropped = [];
  let bytes = 0;
  for (const sheet of [...Object.values(addedSheets()), ...orphans]) {
    if ((sheet.onlyArchs ?? []).some((arch) => archsInUse.has(arch)) || forksInUse.has(sheet.id)) continue;
    const dir = path.join(DIRS.runtime, sheet.id);
    const archives = (await readdir(DIRS.downloads).catch(() => [])).filter((name) => name.startsWith(`${sheet.id}-`)).map((name) => path.join(DIRS.downloads, name));
    for (const target of [dir, ...archives]) { bytes += await sizeOf(target); await rm(target, { recursive: true, force: true }); }
    update((s) => {
      if (s.addedEngines) delete s.addedEngines[sheet.id];
      for (const key of Object.keys(s.runtimes ?? {})) if (key.startsWith(`${sheet.id}-`)) delete s.runtimes[key];
      for (const key of Object.keys(s.engineArchs ?? {})) if (key.startsWith(`${sheet.id}@`)) delete s.engineArchs[key];
      for (const key of Object.keys(s.downloads ?? {})) if (key === `runtime:${sheet.id}`) delete s.downloads[key];
      if (s.buildFailures) delete s.buildFailures[sheet.id];
    });
    dropped.push(sheet.label);
  }
  return { dropped, bytes };
}
