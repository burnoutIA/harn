import path from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { displayName } from './catalog.mjs';
import { defaultTuning, layersOf, llamaArgs, modelFiles, startEngine } from './engine.mjs';
import { sampleGpu } from './hardware.mjs';
import { PORTS } from './paths.mjs';
import { assess, OBJECTIVE } from './planner.mjs';
import { engineEnv } from './runtimes.mjs';
import { getState } from './state.mjs';
import { HEADROOM_MIN_MIB } from './tuner.mjs';

// Lancer un modèle : recette du moteur, réglage de départ, chargement avec la marge VRAM.
export const runtimeKind = (model, tuning) => (tuning?.fork ?? (model.engine === 'prism' ? 'prism' : 'llama'));
const sharedLayers = { layers: 'auto', fitTargetMiB: HEADROOM_MIN_MIB + 256 };
// Le réglage de départ d'un modèle : contexte et type de KV viennent de l'objectif
// (100k-150k), le reste des a priori de la carte.
export function startingTuning(model, hardware) {
  const verdict = assess(model, hardware);
  const tuning = defaultTuning(model, verdict.context, hardware, verdict.kv === 'int8' ? 'q8_0' : verdict.kv);
  // Partagé avec la RAM : --fit remplit la carte jusqu'à sa cible ; on la met au-dessus de la marge
  // exigée, sinon le contrôle de marge raccourcirait le contexte sans rien gagner.
  if (verdict.fit === 'partial') Object.assign(tuning, sharedLayers);
  return tuning;
}
// Strata répond sous le `model_name` de sa config (« swift-1.5-iq3_xxs ») : on y met l'identifiant
// Harn, comme l'alias de llama-server, pour que les clients retrouvent le nom qu'ils ont demandé.
// Refait à chaque lancement : l'installeur Strata peut régénérer la config.
function nameStrataConfig(file, modelId) {
  const config = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (config.model_name === modelId) return;
  writeFileSync(file, JSON.stringify({ ...config, model_name: modelId }, null, 2));
}
export function recipeFor(model, tuning) {
  const state = getState();
  if (model.engine === 'strata') {
    const runtime = state.runtimes[`strata-${model.strataModel}`];
    nameStrataConfig(path.join(runtime.dir, tuning.strataConfig ?? runtime.config), model.id);
    return {
      modelId: model.id,
      label: displayName(model),
      command: runtime.python,
      args: ['serve/server.py', '--engine', 'strata', '--config', tuning.strataConfig ?? runtime.config, '--port', String(PORTS.strata)],
      cwd: runtime.dir,
      endpoint: `http://127.0.0.1:${PORTS.strata}`,
      health: `http://127.0.0.1:${PORTS.strata}/v1/models`,
    };
  }
  const runtime = state.runtimes[`${runtimeKind(model, tuning)}-${tuning.backend}`];
  if (!runtime) throw new Error(`Moteur ${runtimeKind(model, tuning)} ${tuning.backend} non installé`);
  return {
    modelId: model.id,
    label: displayName(model),
    command: runtime.serverPath,
    args: llamaArgs(model, modelFiles(model.id), tuning, state.hardware),
    cwd: runtime.dir,
    env: engineEnv(runtime.dir),
    endpoint: `http://127.0.0.1:${PORTS.engine}`,
    health: `http://127.0.0.1:${PORTS.engine}/health`,
  };
}
export const freeVram = async () => (getState().hardware?.primary?.vendor === 'nvidia' ? (await sampleGpu())?.freeMiB ?? null : null);
// Charger, puis vérifier la marge VRAM. C'est le levier ×21 du poste de référence : sous
// ~1,5 Gio libre, le préfill retombe sur la mémoire hôte sans la moindre erreur. Pour retrouver
// la marge on cède dans l'ordre de l'objectif : contexte par paliers jusqu'à 100k, puis KV q4_0,
// puis seulement sous 100k, par paliers jusqu'au plancher de 32k. En dernier recours, le partage
// avec le processeur (--fit) : plus lent, mais le modèle tourne.
function smaller(tuning) {
  if (tuning.context - 16384 >= OBJECTIVE.minContext) return { ...tuning, context: tuning.context - 16384 };
  if (tuning.kv !== 'q4_0') return { ...tuning, kv: 'q4_0', kvV: undefined };
  if (tuning.context > OBJECTIVE.floorContext) return { ...tuning, context: Math.max(OBJECTIVE.floorContext, tuning.context - 16384) };
  return { ...tuning, ...sharedLayers };
}
// Plus rien à céder : plancher de contexte atteint et couches déjà partagées.
const exhausted = (tuning) => tuning.context <= OBJECTIVE.floorContext && layersOf(tuning) === 'auto';
// Chaque chargement prend un numéro : si un autre modèle est demandé entre-temps, celui-ci
// abandonne au lieu de réessayer (sinon les deux se tueraient le moteur à tour de rôle).
let loadTicket = 0;
const superseded = () => new Error('Chargement remplacé par celui d’un autre modèle');
export async function loadWithHeadroom(model, tuning) {
  const ticket = ++loadTicket;
  let current = { ...tuning };
  for (let attempt = 0; attempt < 14; attempt += 1) {
    if (ticket !== loadTicket) throw superseded();
    let active;
    try {
      active = await startEngine(recipeFor(model, current));
    } catch (error) {
      if (ticket !== loadTicket) throw superseded();
      // Un fichier qui annonce une couche MTP qu'il ne contient pas (convertisseur d'une autre
      // version) : on recharge en ignorant cette annonce avant de conclure à l'échec.
      if (error.tensors && model.profile?.mtp && !current.noNextn) { current = { ...current, noNextn: true, spec: { type: 'none' } }; continue; }
      if (error.fatal || exhausted(current) || model.engine === 'strata') throw error;
      current = smaller(current);
      continue;
    }
    const headroomMiB = await freeVram();
    if (headroomMiB === null || headroomMiB >= HEADROOM_MIN_MIB || exhausted(current) || model.engine === 'strata') {
      return { active, tuning: current, headroomMiB };
    }
    current = smaller(current);
  }
  throw new Error('Impossible de charger le modèle avec une marge mémoire suffisante');
}

// ── Banc par étapes ─────────────────────────────────────────
// Une variable à la fois, à partir du meilleur réglage connu : spéculation, puis DFlash2,
// puis type de KV mesuré en profondeur, puis Flash Attention ou backend selon la carte.
// Chaque variante qui laisse moins de ~1,2 Gio libre est écartée, même si elle va vite.
