import './helpers/home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEntry } from '../src/custom-models.mjs';
import { cardRepos } from '../src/engines.mjs';
import { profileFromMetadata } from '../src/gguf.mjs';
import { assess } from '../src/planner.mjs';

// Les métadonnées utiles d'Olala-v1.0-mini-7A1B (OVHai, hybride Mamba3 + MoE), lues dans son GGUF.
const meta = {
  'general.architecture': 'olala', 'general.name': 'Olala v1.0 mini',
  'olala.block_count': 36, 'olala.context_length': 100000, 'olala.embedding_length': 1536,
  'olala.attention.head_count': 48, 'olala.attention.head_count_kv': 12, 'olala.attention.key_length': 128, 'olala.attention.value_length': 128,
  'olala.attention.sliding_window': 32768, 'olala.expert_count': 256, 'olala.expert_used_count': 6,
};
const r9700 = { vramGiB: 32, ramGiB: 128, diskFreeGiB: 500, cpu: { physical: 8, model: 'x' }, os: { platform: 'linux' },
  primary: { vendor: 'amd', name: 'AMD Radeon AI PRO R9700', vramMiB: 32 * 1024 } };

test('Olala : contexte plafonné à 32 768, malgré les 100 000 du GGUF', () => {
  const profile = profileFromMetadata({ meta });
  assert.equal(profile.contextLength, 100000);
  assert.equal(profile.maxContext, 32768);
  const entry = buildEntry({ repo: 'OVHaiLLM/Olala-v1.0-mini-7A1B-GGUF', quant: { quant: 'Q8_0', bytes: 6876038592, files: [{ name: 'olala.gguf', bytes: 6876038592 }] }, profile });
  const verdict = assess(entry, r9700);
  assert.notEqual(verdict.fit, 'no');
  assert.equal(verdict.context, 32768);
});

test('une autre architecture garde son contexte', () => {
  const profile = profileFromMetadata({ meta: { ...Object.fromEntries(Object.entries(meta).map(([k, v]) => [k.replace(/^olala/, 'qwen3'), v])), 'general.architecture': 'qwen3' } });
  assert.equal(profile.maxContext, null);
});

test('liens GitHub d’une fiche : le fork, pas llama.cpp lui-même', () => {
  const card = `> **These files need our llama.cpp fork.** Build the
[fork](https://github.com/OVHai-LLM/llama.cpp) as shown below.
A fork of [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp).
\`\`\`sh
git clone https://github.com/OVHai-LLM/llama.cpp.git llama.cpp-olala
\`\`\`
Full guide: [docs](https://github.com/OVHai-LLM/llama.cpp/blob/main/docs/olala-setup.md).
<a href="https://github.com/someone/tool">x</a>`;
  assert.deepEqual(cardRepos(card), ['OVHai-LLM/llama.cpp', 'someone/tool']);
});

test('Olala : niveaux de raisonnement et échantillonnage de sa fiche', async () => {
  const { shapeRequest } = await import('../src/gateway.mjs');
  const entry = buildEntry({ repo: 'OVHaiLLM/Olala-v1.0-mini-7A1B-GGUF', quant: { quant: 'Q8_0', bytes: 1, files: [] }, profile: profileFromMetadata({ meta }) });
  assert.deepEqual([entry.sampling.temperature, entry.sampling.top_p, entry.sampling.top_k], [0.8, 0.9, 40]);
  const effort = (body) => shapeRequest(body, entry).chat_template_kwargs;
  assert.deepEqual(effort({ reasoning_effort: 'high' }), { reasoning_effort: 'high' });
  assert.deepEqual(effort({ reasoning_effort: 'none' }), { reasoning_effort: 'disabled' });
  assert.deepEqual(effort({}), { reasoning_effort: 'medium' });
  // Les autres gardent leurs niveaux (Qwen3.8 : xhigh, enable_thinking).
  const qwen = { ...entry, reasoningLevels: ['low', 'medium', 'xhigh'] };
  assert.equal(shapeRequest({ reasoning_effort: 'high' }, qwen).chat_template_kwargs.reasoning_effort, 'xhigh');
  assert.equal(shapeRequest({ reasoning_effort: 'off' }, qwen).chat_template_kwargs.enable_thinking, false);
});
