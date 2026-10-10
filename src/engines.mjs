// Les moteurs que Harn sait installer, et les architectures de modèles que chacun charge.
// Un GGUF dit son architecture (general.architecture) ; un moteur llama.cpp connaît la liste
// écrite dans son src/llama-arch.cpp. Les comparer avant de télécharger évite d'installer
// 14 Go pour découvrir au chargement « unknown model architecture ».
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { llamAmpereEligible } from './levers.mjs';
import { LLAMAMPERE, latestRelease } from './runtimes.mjs';
import { getState, update } from './state.mjs';

export const ENGINES = {
  llama: { label: 'llama.cpp', repo: 'ggml-org/llama.cpp', tag: /^b\d+$/ },
  prism: { label: 'llama.cpp Prism', repo: 'PrismML-Eng/llama.cpp', tag: /^prism-/ },
  llamampere: { label: 'llamAmpere', repo: 'JakeATX/llamAmpere', ref: LLAMAMPERE.commit, eligible: llamAmpereEligible },
};

const ARCH = /\{\s*LLM_ARCH_[A-Z0-9_]+,\s*"([^"]+)"\s*\}/g;
export const parseArchs = (source) => [...source.matchAll(ARCH)].map((m) => m[1]);

// Le code source d'un moteur compilé ici est sur le disque ; sinon on lit celui de sa version sur GitHub.
async function archSource(engineId, ref) {
  const runtime = Object.values(getState().runtimes ?? {}).find((r) => r.kind === engineId && (r.tag === ref || r.commit === ref));
  if (runtime?.dir) {
    for (const up of ['..', '../..', '../../..']) {
      const local = await readFile(path.join(runtime.dir, up, 'src', 'llama-arch.cpp'), 'utf8').catch(() => null);
      if (local) return local;
    }
  }
  const response = await fetch(`https://raw.githubusercontent.com/${ENGINES[engineId].repo}/${ref}/src/llama-arch.cpp`, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Liste des architectures de ${ENGINES[engineId].label} ${ref} illisible (${response.status})`);
  return response.text();
}

// Mise en cache par version : une version publiée ne change plus.
export async function engineArchs(engineId, ref) {
  const key = `${engineId}@${ref}`;
  const cached = getState().engineArchs?.[key];
  if (cached) return cached;
  const archs = parseArchs(await archSource(engineId, ref));
  if (!archs.length) throw new Error(`Aucune architecture trouvée pour ${key}`);
  update((s) => { s.engineArchs = { ...s.engineArchs, [key]: archs }; });
  return archs;
}

// La version de chaque moteur utilisable sur cette machine : celle installée, sinon celle que
// Harn installerait (dernière publiée, ou commit figé).
async function engineRefs(hardware) {
  const runtimes = Object.values(getState().runtimes ?? {});
  const refs = [];
  for (const [id, engine] of Object.entries(ENGINES)) {
    if (engine.eligible && !engine.eligible(hardware)) continue;
    if (engine.ref) { refs.push([id, engine.ref]); continue; }
    const installed = runtimes.find((r) => r.kind === id && r.tag)?.tag;
    const ref = installed ?? (await latestRelease({ repo: engine.repo, tag: engine.tag }).catch(() => null))?.tag_name;
    if (ref) refs.push([id, ref]);
  }
  return refs;
}

// Les moteurs de cette machine qui savent charger une architecture. null : on ne sait pas
// (GitHub injoignable) ; on ne bloque alors rien, le chargement tranchera.
export async function enginesFor(arch, hardware = getState().hardware) {
  if (!arch) return null;
  let known = false;
  const found = [];
  for (const [id, ref] of await engineRefs(hardware)) {
    const archs = await engineArchs(id, ref).catch(() => null);
    if (!archs) continue;
    known = true;
    if (archs.includes(arch)) found.push({ id, ref, label: ENGINES[id].label });
  }
  return known ? found : null;
}

export const archMissing = (arch) => `Architecture « ${arch} » : aucun moteur de Harn ne sait encore la charger`;
