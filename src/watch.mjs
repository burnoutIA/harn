// Veille Hugging Face : les modèles GGUF sortis ou mis à jour ces 30 derniers jours, chez les
// auteurs que le catalogue suit déjà et parmi les tendances, gardés seulement s'ils tournent
// bien sur cette machine (même estimation que le planificateur). Et les modèles installés dont
// les fichiers ont changé sur Hugging Face. Une fois par jour, sans clé (API publique).
import { MODELS, modelById } from './catalog.mjs';
import { buildEntry, inspectRepo } from './custom-models.mjs';
import { OBJECTIVE, assess } from './planner.mjs';
import { paramsOf } from './rating.mjs';
import { getState, update } from './state.mjs';

const HF = 'https://huggingface.co';
// Auteurs de référence pour les GGUF, en plus de ceux du catalogue.
const AUTHORS = ['unsloth', 'bartowski', 'Qwen', 'ggml-org'];
const RECENT_DAYS = 30;
const MAX_INSPECT = 12;       // dépôts analysés par passage (chacun : 3 requêtes + l'en-tête du GGUF)
const MIN_TPS = 15;           // sous ce débit, on ne le propose pas (voir planner, CRAWL_TPS)
const EVERY_MS = 24 * 60 * 60 * 1000;

// Texte ou vision seulement : pas d'image, de son, d'embeddings.
const TEXT_TAGS = /^(text-generation|image-text-to-text|conversational)$/;
const NOT_LLM = /embed|comfyui|diffusers|text-to-image|image-to-image|text-to-speech|speech|whisper|tts|reranker|sentence|feature-extraction|vae|lora/i;

const hf = (pathname) => fetch(`${HF}${pathname}`, { headers: { 'User-Agent': 'harn' }, signal: AbortSignal.timeout(20_000) })
  .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`Hugging Face a répondu ${r.status}`))));

const catalogAuthors = () => [...new Set(MODELS.filter((m) => !m.custom).map((m) => m.repo.split('/')[0]))];
const knownRepos = () => new Set(MODELS.map((m) => m.repo.toLowerCase()));

async function candidates() {
  const lists = await Promise.all([
    ...[...new Set([...catalogAuthors(), ...AUTHORS])].map((author) => hf(`/api/models?author=${encodeURIComponent(author)}&filter=gguf&sort=lastModified&direction=-1&limit=15`).catch(() => [])),
    hf('/api/models?filter=gguf&sort=trendingScore&direction=-1&limit=40').catch(() => []),
  ]);
  const since = Date.now() - RECENT_DAYS * 86_400_000;
  const known = knownRepos();
  const seen = new Map();
  for (const m of lists.flat()) {
    const tags = m.tags ?? [];
    if (seen.has(m.id) || known.has(m.id.toLowerCase())) continue;
    if (!tags.includes('gguf') || !tags.some((t) => TEXT_TAGS.test(t)) || NOT_LLM.test(m.id) || tags.some((t) => NOT_LLM.test(t))) continue;
    if (Date.parse(m.lastModified ?? m.createdAt ?? 0) < since) continue;
    seen.set(m.id, { repo: m.id, createdAt: m.createdAt ?? null, lastModified: m.lastModified ?? null, likes: m.likes ?? 0, downloads: m.downloads ?? 0 });
  }
  // Les plus suivis d'abord : likes, puis téléchargements.
  return [...seen.values()].sort((a, b) => b.likes - a.likes || b.downloads - a.downloads);
}

// La meilleure quantification pour cette machine : celle qui tient l'objectif, sur la carte de
// préférence, la plus grosse à égalité (plus de bits, plus juste).
function bestQuant(report, hardware) {
  // PQ/PTQ : quantifications ternaires du moteur Prism, que l'installation par Hugging Face
  // (llama.cpp) ne sait pas servir.
  const options = report.quants.filter((quant) => !/^(PQ|PTQ)\d/i.test(quant.quant)).map((quant) => {
    const entry = buildEntry({ repo: report.repo, quant, profile: report.profile });
    return { quant, entry, verdict: assess(entry, hardware) };
  }).filter(({ verdict }) => verdict.fit !== 'no' && verdict.tps !== null && verdict.tps >= MIN_TPS && verdict.context >= OBJECTIVE.floorContext);
  const rank = ({ verdict }) => (verdict.meetsContext && verdict.meetsSpeed ? 4 : 0) + (verdict.fit === 'full' ? 2 : 0) + (verdict.meetsContext ? 1 : 0);
  return options.sort((a, b) => rank(b) - rank(a) || b.quant.bytes - a.quant.bytes)[0] ?? null;
}

async function inspectCandidate(candidate, hardware) {
  const base = { ...candidate, author: candidate.repo.split('/')[0], checkedAt: new Date().toISOString() };
  let report;
  try { report = await inspectRepo(candidate.repo); } catch (error) { return { ...base, usable: false, error: error.message }; }
  if (report.gated) return { ...base, usable: false, gated: true, name: report.profile?.name ?? candidate.repo.split('/')[1] };
  const best = bestQuant(report, hardware);
  const projector = report.mmproj.find((m) => /f16/i.test(m.name)) ?? report.mmproj[0] ?? null;
  return {
    ...base,
    name: report.profile?.name ?? candidate.repo.split('/')[1],
    license: report.license,
    paramsB: best ? paramsOf(best.entry) : null,
    moe: Boolean(report.profile?.experts),
    vision: Boolean(projector),
    mmproj: projector?.name ?? null,
    usable: Boolean(best),
    best: best && {
      quant: best.quant.quant,
      gigabytes: +((best.quant.bytes + (projector?.bytes ?? 0)) / 1e9).toFixed(1),
      fit: best.verdict.fit,
      context: best.verdict.context,
      kv: best.verdict.kv,
      tps: best.verdict.tps,
      meetsObjective: Boolean(best.verdict.meetsContext && best.verdict.meetsSpeed),
    },
  };
}

// Les modèles installés dont un fichier a changé sur Hugging Face. Référence : l'empreinte du
// catalogue quand il la donne, sinon celle relevée au premier passage de la veille.
async function installedUpdates(previous = {}) {
  const baseline = { ...(previous.baseline ?? {}) };
  const updates = [];
  const installed = Object.keys(getState().models).filter((id) => getState().models[id].installedAt && modelById(id)?.repo);
  for (const id of installed) {
    const model = modelById(id);
    const tree = await hf(`/api/models/${model.repo}/tree/main?recursive=1`).catch(() => null);
    if (!tree) continue;
    const oids = new Map(tree.filter((f) => f.lfs?.oid).map((f) => [f.path, f.lfs.oid]));
    const changed = [];
    for (const file of model.files) {
      const now = oids.get(file.name);
      if (!now) continue;
      const key = `${id}/${file.name}`;
      const reference = file.sha256 ?? baseline[key];
      if (!reference) baseline[key] = now;
      else if (reference !== now) changed.push(file.name.split('/').pop());
    }
    if (changed.length) updates.push({ id, repo: model.repo, files: changed });
  }
  return { updates, baseline };
}

let running = null;
export function checkHub() {
  running ??= (async () => {
    const hardware = getState().hardware;
    if (!hardware) return getState().watch;
    update((s) => { s.watch = { ...(s.watch ?? {}), checking: true, error: null }; });
    try {
      const previous = getState().watch ?? {};
      const cache = new Map((previous.items ?? []).map((item) => [item.repo, item]));
      const dismissed = new Set(previous.dismissed ?? []);
      const fresh = (await candidates()).filter((c) => !dismissed.has(c.repo));
      // Un dépôt déjà analysé et inchangé n'est pas réanalysé.
      const items = [];
      let inspected = 0;
      for (const candidate of fresh) {
        const cached = cache.get(candidate.repo);
        if (cached && cached.lastModified === candidate.lastModified && cached.hardwareKey === hardwareKey(hardware)) { items.push({ ...cached, likes: candidate.likes, downloads: candidate.downloads }); continue; }
        if (inspected >= MAX_INSPECT) continue;
        inspected += 1;
        items.push({ ...(await inspectCandidate(candidate, hardware)), hardwareKey: hardwareKey(hardware) });
      }
      const { updates, baseline } = await installedUpdates(previous);
      update((s) => { s.watch = { ...s.watch, checking: false, checkedAt: new Date().toISOString(), items, updates, baseline, error: null }; });
    } catch (error) {
      update((s) => { s.watch = { ...(s.watch ?? {}), checking: false, error: error.message }; });
    }
    return getState().watch;
  })().finally(() => { running = null; });
  return running;
}

// Une autre carte ou une autre quantité de RAM change le verdict : on réanalyse.
const hardwareKey = (hardware) => `${hardware.primary?.name ?? 'cpu'}/${Math.round(hardware.vramGiB)}/${Math.round(hardware.ramGiB)}`;

export function dismissHub(repo) {
  update((s) => {
    s.watch = { ...(s.watch ?? {}), dismissed: [...new Set([...(s.watch?.dismissed ?? []), repo])] };
    s.watch.items = (s.watch.items ?? []).filter((item) => item.repo !== repo);
  });
}

export function watchHub() {
  update((s) => { if (s.watch) s.watch.checking = false; });
  const due = () => !getState().watch?.checkedAt || Date.now() - Date.parse(getState().watch.checkedAt) > EVERY_MS;
  setTimeout(() => { if (due()) checkHub(); }, 60_000);
  setInterval(() => { if (due()) checkHub(); }, 60 * 60 * 1000).unref();
}
