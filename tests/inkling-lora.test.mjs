import './helpers/home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEntry, buildLoraEntry, cardFacts, loraModelId } from '../src/custom-models.mjs';
import { llamaArgs } from '../src/engine.mjs';
import { shapeRequest } from '../src/gateway.mjs';
import { profileFromMetadata } from '../src/gguf.mjs';

// Inkling-2-Mini (Mainline_Support d'Unsloth) : 24 couches, les couches 6 à 17 jouées trois fois ;
// attention pleine aux couches 5, 11, 17 et 23, fenêtre glissante ailleurs.
const sliding = Array.from({ length: 24 }, (_, i) => i % 6 !== 5);
const meta = {
  'general.architecture': 'inkling2_loop', 'general.name': 'Inkling-2-Mini', 'general.size_label': '128x1.8B',
  'inkling2_loop.block_count': 24, 'inkling2_loop.context_length': 1048576,
  'inkling2_loop.attention.head_count': Array(24).fill(24), 'inkling2_loop.attention.head_count_kv': Array(24).fill(8),
  'inkling2_loop.attention.key_length': 128, 'inkling2_loop.attention.value_length': 128,
  'inkling2_loop.attention.sliding_window': 1024, 'inkling2_loop.attention.sliding_window_pattern': sliding,
  'inkling2_loop.loop.count': 3, 'inkling2_loop.loop.start': 6, 'inkling2_loop.loop.end': 18,
  'inkling2_loop.expert_count': 128, 'inkling2_loop.expert_used_count': 8,
};

test('couches en boucle : chaque passage a son cache KV', () => {
  // 5 et 23 une fois, 11 et 17 trois fois : 8 applications × 8 têtes × (128 + 128) × 2 octets.
  assert.equal(profileFromMetadata({ meta }).kvBytesPerToken.f16, 8 * 8 * 256 * 2);
});

test('PR exigée par la fiche : gardée, et le modèle lié à ce moteur', () => {
  assert.deepEqual(cardFacts({ requiredPr: 32704 }).requiredPr, [32704]);
  assert.equal(cardFacts({ requiredPr: '32704' }).requiredPr, null);
  assert.deepEqual(cardFacts({ requiredPr: [32218, 'unslothai/llama.cpp#385', 32218] }).requiredPr, [32218, 'unslothai/llama.cpp#385']);
  assert.equal(cardFacts({ requiredPr: [32218, 'n’importe quoi'] }).requiredPr, null);
  const quant = { quant: 'UD-Q8_K_XL', bytes: 22867452896, files: [{ name: 'Mainline_Support/Inkling-2-Mini-UD-Q8_K_XL.gguf_file', bytes: 22867452896 }] };
  const entry = buildEntry({ repo: 'unsloth/Inkling-2-Mini-GGUF', quant, profile: profileFromMetadata({ meta }), engineOnly: 'llama-pr-32704' });
  assert.equal(entry.engineOnly, 'llama-pr-32704');
});

test('Inkling : sans réflexion = reasoning_effort none, pas enable_thinking', () => {
  const entry = { id: 'x', engine: 'llama', reasoning: true, reasoningLevels: ['none', 'low', 'medium', 'high', 'xhigh'] };
  assert.deepEqual(shapeRequest({ reasoning_effort: 'none' }, entry).chat_template_kwargs, { reasoning_effort: 'none' });
});

test('profil LoRA : la base reprise, l’adaptateur passé au moteur', () => {
  const base = { id: 'qwen3-8-27b-gguf-ud-q4-k-m', name: 'Qwen3.8-27B', variant: 'UD-Q4_K_M · MTP', engine: 'llama', reasoning: true, quality: 95,
    files: [{ name: 'Qwen3.8-27B-UD-Q4_K_M.gguf', bytes: 1 }], sampling: { temperature: 1, top_p: 0.95, top_k: 20, min_p: 0 }, reasoningLevels: ['low', 'medium', 'xhigh'] };
  const lora = { name: 'Qwen3.8-27B-pi-lora-F16.gguf', bytes: 318802304, sha256: 'a6' };
  const entry = buildLoraEntry({ base, loraRepo: 'harness-hub/Qwen3.8-27B-pi-adapted-GGUF', lora, reasoning: false, sampling: { temperature: 0.8, top_p: 1, top_k: 0 } });
  assert.equal(entry.id, loraModelId(base.id, 'harness-hub/Qwen3.8-27B-pi-adapted-GGUF'));
  assert.equal(entry.id, 'qwen3-8-27b-gguf-ud-q4-k-m-lora-qwen3-8-27b-pi-adapted');
  assert.deepEqual([entry.loraOf, entry.quality, entry.reasoning, entry.sampling.temperature, entry.sampling.top_p], [base.id, null, false, 0.8, 1]);
  assert.equal(base.quality, 95, 'la base n’est pas touchée');
  const hardware = { cpu: { physical: 8 } };
  const args = llamaArgs(entry, { model: '/m/base.gguf', lora: '/m/pi.gguf' }, { context: 32768, kv: 'f16', batch: 512, ubatch: 512, backend: 'hip' }, hardware);
  assert.equal(args[args.indexOf('--lora') + 1], '/m/pi.gguf');
  assert.ok(args.includes('--reasoning'));
});

test('DSpark : le brouillon du dépôt passe à llama-server avec sa profondeur', () => {
  const profile = profileFromMetadata({ meta });
  const quant = { quant: 'UD-Q4_K_XL', bytes: 17_629_760_736, files: [{ name: 'Mainline_Support/Inkling-2-Mini-UD-Q4_K_XL.gguf_file', bytes: 17_629_760_736 }] };
  const dspark = { name: 'dspark-Inkling-2-Mini-Q8_0.gguf', bytes: 402_278_560 };
  const entry = buildEntry({ repo: 'unsloth/Inkling-2-Mini-GGUF', quant, profile, dspark, card: { requiredPr: [32218, 'unslothai/llama.cpp#385'] } });
  assert.deepEqual(entry.dspark, { repo: 'unsloth/Inkling-2-Mini-GGUF', ...dspark });
  const hardware = { cpu: { physical: 8 } };
  const files = { model: '/m/ink.gguf', dspark: '/m/dspark.gguf' };
  const args = llamaArgs(entry, files, { context: 131072, kv: 'f16', batch: 1024, ubatch: 256, backend: 'hip', spec: { type: 'dspark', n: 3 } }, hardware);
  assert.deepEqual(args.slice(args.indexOf('--spec-type'), args.indexOf('--spec-type') + 8), ['--spec-type', 'draft-dspark', '--spec-draft-model', '/m/dspark.gguf', '--spec-draft-n-max', '3', '-ngld', '999']);
  // Sans le fichier (pas encore téléchargé) : aucune spéculation demandée.
  assert.ok(!llamaArgs(entry, { model: '/m/ink.gguf' }, { context: 131072, kv: 'f16', backend: 'hip', spec: { type: 'dspark', n: 3 } }, hardware).includes('draft-dspark'));
});

test('DSpark : sans la place à 100k, le banc l’essaie avec un cache plus léger', async () => {
  const { dsparkStart } = await import('../src/bench.mjs');
  const { OBJECTIVE } = await import('../src/planner.mjs');
  const model = { dspark: { name: 'dspark.gguf' }, kvBytesPerToken: { f16: 32768, q8_0: 17408, q4_0: 9216 } };
  // 118k en q8_0 avec 3 Gio de marge : en q8_0 il tomberait sous 100k, en q4_0 il tient.
  const tight = dsparkStart(model, { headroomMiB: 3000, tuning: { context: 120832, kv: 'q8_0', fa: 'on' } });
  assert.equal(tight.kv, 'q4_0');
  assert.equal(tight.fa, 'on');
  assert.ok(tight.context >= OBJECTIVE.minContext && tight.context <= 120832);
  // RTX 3090, Inkling UD-Q4_K_M : 1 939 Mio de marge, même en q4_0 le brouillon (~1,8 Gio) ne tient pas.
  assert.equal(dsparkStart(model, { headroomMiB: 1939, tuning: { context: 120832, kv: 'q8_0' } }), null);
  // De la place : même cache, contexte gardé.
  assert.deepEqual(dsparkStart(model, { headroomMiB: 5000, tuning: { context: 120832, kv: 'q8_0' } }), { context: 120832, kv: 'q8_0' });
  // Déjà en q4_0 et rien de libre : pas d'essai.
  assert.equal(dsparkStart(model, { headroomMiB: 100, tuning: { context: 120832, kv: 'q4_0' } }), null);
});
