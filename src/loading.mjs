import path from 'node:path';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { displayName, ownLauncher } from './catalog.mjs';
import { ENGINE_KEY_FILE, defaultTuning, engineKey, layersOf, llamaArgs, modelFiles, startEngine } from './engine.mjs';
import { engineSheet } from './engines.mjs';
import { sampleGpu } from './hardware.mjs';
import { DIRS, PORTS } from './paths.mjs';
import { assess, OBJECTIVE } from './planner.mjs';
import { engineEnv } from './runtimes.mjs';
import { SANDBOX_INSTALL, sandboxReady, sandboxed } from './sandbox.mjs';
import { getState } from './state.mjs';
import { HEADROOM_MIN_MIB } from './tuner.mjs';

// Lancer un modèle : recette du moteur, réglage de départ, chargement avec la marge VRAM.
export const runtimeKind = (model, tuning) => (tuning?.fork ?? (model.engine === 'prism' ? 'prism' : 'llama'));
// Partagé avec la RAM, le préfill copie les poids restés côté hôte vers la carte à chaque
// micro-lot : des lots de 4096 les amortissent. Mistral Small 4 119B sur une 3090 : 190 tok/s
// en ubatch 512, 470 en 4096, génération inchangée (--fit reprend la VRAM sur le cache d'experts).
const sharedLayers = { layers: 'auto', fitTargetMiB: HEADROOM_MIN_MIB + 256, batch: 4096, ubatch: 4096 };
// Le réglage de départ d'un modèle : contexte et type de KV viennent de l'objectif
// (100k-150k), le reste des a priori de la carte.
// HyperQwen à 131k, KV int8 (pthfa). MTP tient même quand le bureau prend ~1 Go de la carte ;
// DFlash2 demande la carte libre (bureau sur la puce intégrée) mais génère plus vite jusqu'à ~50k
// (3090 : code +49 %, français +19 %), MTP restant devant de ~10 % vers 130k. Le banc tranche.
// KVarN (CTX=huge) tient aussi, mais génère trois fois moins vite à 130k : écarté.
export const HYPERQWEN_ARMS = {
  mtp: { context: 131072, spec: 'mtp', ctx: 'long', hyperqwenArm: 'MTP · KV int8 · 128k' },
  dflash2: { context: 131072, spec: 'dflash2', ctx: 'long', hyperqwenArm: 'DFlash2 · KV int8 · 128k' },
};
// Les fiches du moteur du Gemma Challenge : un seul réglage chacune.
export const GEMMA_CHALLENGE_TUNING = {
  submission: { context: 4096, challengeArm: 'Soumission gemma-slayer · 4k' },
  qat: { context: 131072, challengeArm: 'QAT W4A16 · MTP K7 · 128k' },
};
// Sans perte : ni lm_head élagué, ni fenêtre réduite, ni bake amputé, ni glouton imposé. Le reste du
// manifeste (boucle MTP en un graphe CUDA, split-KV, échauffement, chemins rapides) est gardé.
const QAT_DROPPED = ['LM_HEAD_PRUNE', 'LM_HEAD_PRUNE_REQUIRE', 'LM_HEAD_PRUNE_DST', 'LM_HEAD_KEEPSET_BUCKET', 'PCK04_KEEPSET', 'HF_OVERRIDES', 'SLIDING_WINDOW',
  'WEIGHTS_BUCKET', 'DRAFTER_BUCKET', 'DRAFTER_SHA256', 'OVERRIDE_GENERATION_CONFIG', 'PRECACHE_DATASET'];
// serve.py n'a pas d'argument libre : ses arguments de vLLM reçoivent les parseurs au moment où il
// les passe à execvpe, sans modifier son code.
const withArgs = (extra) => `import os, serve; _exec = os.execvpe; os.execvpe = lambda f, a, e: _exec(f, a + ${JSON.stringify(extra)}, e); serve.main()`;
function challengeRecipe(model, runtime) {
  const stack = model.challengeStack === 'qat' ? runtime?.qat : (runtime?.submissionStack ?? (runtime?.model && { model: runtime.model, drafter: runtime.drafter }));
  if (!stack) throw new Error('Ce modèle du Gemma Challenge n’est pas installé');
  const endpoint = `http://127.0.0.1:${PORTS.gemmaChallenge}`;
  const manifest = JSON.parse(readFileSync(path.join(runtime.submission, 'manifest.json'), 'utf8'));
  let env;
  let args = ['serve.py'];
  if (model.challengeStack === 'qat') {
    env = Object.fromEntries(Object.entries(manifest.env).filter(([key]) => !QAT_DROPPED.includes(key)));
    Object.assign(env, {
      SPECULATIVE_CONFIG: JSON.stringify({ method: 'mtp', model: stack.drafter, num_speculative_tokens: 7 }),
      MAX_MODEL_LEN: String(GEMMA_CHALLENGE_TUNING.qat.context),
      // 2048 plutôt que 512 : lecture des longs prompts +11 % (3 284 tok/s à 92k), génération égale.
      MAX_NUM_BATCHED_TOKENS: '2048',
      // L'échantillonnage du modèle (generation_config.json), pas le glouton du challenge.
      GENERATION_CONFIG: 'auto',
      // Le partage de KV commence à la couche 24 sur les 42 couches : ses sources sont 22 et 23.
      FA_SLIDING_EXCLUDE: '22,23',
    });
    args = ['-c', withArgs(['--enable-auto-tool-choice', '--tool-call-parser', 'gemma4', '--reasoning-parser', 'gemma4'])];
  } else {
    // L'environnement du manifeste, ses chemins /tmp (ceux du job HF) ramenés dans runtime/.
    const local = { '/tmp/qat-assistant': stack.drafter, '/tmp/osoi5-12k-baked': stack.model, '/tmp/osoi5-v0-baked': stack.model };
    env = Object.fromEntries(Object.entries(manifest.env).map(([key, value]) => [key, Object.entries(local).reduce((text, [from, to]) => text.replaceAll(from, to), value)]));
    Object.assign(env, { LM_HEAD_PRUNE_DST: stack.model, PCK04_KEEPSET: path.join(stack.model, 'pck04_keepset.json') });
  }
  // tcmalloc (allocateur côté processeur) n'est pas toujours installé : serve.py s'en passe.
  if (!existsSync(env.LD_PRELOAD ?? '')) delete env.LD_PRELOAD;
  return {
    modelId: model.id,
    label: displayName(model),
    command: path.join(runtime.dir, 'venv', 'bin', 'python'),
    args,
    cwd: runtime.submission,
    env: {
      ...env,
      LOCAL_MODEL_DIR: stack.model,
      PLE_FOLD_TARGET_MODEL: stack.model,
      LOCAL_DRAFTER_DIR: stack.drafter,
      // Le venv du banc du job HF n'existe pas ici.
      PATCH_BENCH_JINJA2: '0',
      HOST: '127.0.0.1',
      PORT: String(PORTS.gemmaChallenge),
      SERVED_MODEL_NAME: model.id,
      VLLM_API_KEY: engineKey(),
      VLLM_NO_USAGE_STATS: '1',
      DO_NOT_TRACK: '1',
      HF_HUB_OFFLINE: '1',
      // serve.py appelle sys.executable et hf, vLLM compile avec ninja : ceux du venv.
      PATH: `${path.join(runtime.dir, 'venv', 'bin')}${path.delimiter}${process.env.PATH}`,
    },
    endpoint,
    // /health répond dès le démarrage ; /v1/models attend la fin de l'échauffement de la soumission.
    health: `${endpoint}/v1/models`,
  };
}
export function startingTuning(model, hardware) {
  if (model.engine === 'hyperqwen') return HYPERQWEN_ARMS.mtp;
  if (model.engine === 'gemma-challenge') return GEMMA_CHALLENGE_TUNING[model.challengeStack];
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
  if (model.engine === 'hyperqwen') {
    const runtime = state.runtimes.hyperqwen;
    if (!runtime) throw new Error('HyperQwen n’est pas installé');
    const endpoint = `http://127.0.0.1:${PORTS.hyperqwen}`;
    return {
      modelId: model.id,
      label: displayName(model),
      command: 'bash',
      args: ['single-user/start_qwen.sh'],
      cwd: runtime.dir,
      // Avec une clé, le lanceur écouterait sur toutes les interfaces : HOST le garde en local.
      // Le nom servi est l'identifiant Harn, comme l'alias de llama-server ; la dernière
      // occurrence de --served-model-name l'emporte sur celle du lanceur.
      // La variante française ne change que le brouillon MTP ; DFlash2 a son propre drafter et
      // sert le modèle de base, que le lanceur choisit seul quand MODEL n'est pas donné.
      env: {
        ...((tuning.spec ?? 'mtp') === 'mtp' ? { MODEL: runtime.model } : {}),
        SPEC: tuning.spec ?? 'mtp',
        CTX: tuning.ctx ?? 'long',
        MAX_LEN: String(tuning.context ?? 131072),
        PORT: String(PORTS.hyperqwen),
        HOST: '127.0.0.1',
        VLLM_API_KEY: engineKey(),
        EXTRA_ARGS: `--served-model-name ${model.id}`,
      },
      endpoint,
      // /health ne demande pas de clé, et ne répond qu'une fois le moteur prêt.
      health: `${endpoint}/health`,
    };
  }
  if (model.engine === 'gemma-challenge') return challengeRecipe(model, state.runtimes['gemma-challenge']);
  const runtime = state.runtimes[`${runtimeKind(model, tuning)}-${tuning.backend}`];
  if (!runtime) throw new Error(`Moteur ${runtimeKind(model, tuning)} ${tuning.backend} non installé`);
  const files = modelFiles(model.id);
  const recipe = {
    modelId: model.id,
    label: displayName(model),
    command: runtime.serverPath,
    args: [...(runtime.serverArgs ?? []), ...llamaArgs(model, files, tuning, state.hardware)],
    cwd: runtime.dir,
    env: engineEnv(runtime.dir),
    endpoint: `http://127.0.0.1:${PORTS.engine}`,
    health: `http://127.0.0.1:${PORTS.engine}/health`,
  };
  // Moteur ajouté avec l'accord de l'utilisateur (PR, fork) : il tourne dans la bulle, sans
  // réseau, et ne voit que ses fichiers, ceux du modèle et la clé du moteur (sandbox.mjs).
  if (!engineSheet(tuning.fork)?.isolated) return recipe;
  if (!sandboxReady()) throw new Error(`${engineSheet(tuning.fork).label} doit tourner isolé, et bubblewrap ne répond plus : ${SANDBOX_INSTALL}`);
  const socketDir = path.join(DIRS.runtime, tuning.fork, 'run');
  mkdirSync(socketDir, { recursive: true });
  const socket = path.join(socketDir, 'engine.sock');
  const args = [...recipe.args];
  args[args.indexOf('--host') + 1] = socket;
  // Tous les fichiers du modèle (un GGUF découpé en parties compris), là où ils sont vraiment ;
  // seulement ceux présents (un brouillon DFlash pas encore téléchargé n'existe pas).
  const where = (name) => state.models[model.id]?.paths?.[name] ?? path.join(DIRS.models, model.id, name);
  const modelPaths = [...model.files.map((f) => where(f.name)), ...Object.values(files)].filter((file) => file && existsSync(file));
  const box = sandboxed(runtime.serverPath, args, {
    readable: [runtime.dir, ENGINE_KEY_FILE, ...modelPaths],
    writable: [socketDir],
    gpu: true,
    cwd: runtime.dir,
  });
  return { ...recipe, ...box, socket };
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
      if (error.fatal || exhausted(current) || ownLauncher(model)) throw error;
      current = smaller(current);
      continue;
    }
    const headroomMiB = await freeVram();
    if (headroomMiB === null || headroomMiB >= HEADROOM_MIN_MIB || exhausted(current) || ownLauncher(model)) {
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
