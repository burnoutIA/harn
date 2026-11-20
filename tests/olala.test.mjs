import './helpers/home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEntry, cardFacts } from '../src/custom-models.mjs';
import { cardRepos, readableCard } from '../src/engines.mjs';
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

// Ce que pi lit sur la fiche d'Olala et passe à install_model.
const card = { maxContext: 32768, reasoningLevels: ['disabled', 'low', 'medium', 'high'], notes: ['BF16 recommandé sur GPU'] };
const quant = { quant: 'Q8_0', bytes: 6876038592, files: [{ name: 'olala.gguf', bytes: 6876038592 }] };

test('limite de contexte lue sur la fiche : 32 768, malgré les 100 000 du GGUF', () => {
  const profile = profileFromMetadata({ meta });
  assert.equal(profile.contextLength, 100000);
  const entry = buildEntry({ repo: 'OVHaiLLM/Olala-v1.0-mini-7A1B-GGUF', quant, profile, card });
  assert.equal(entry.profile.maxContext, 32768);
  assert.deepEqual(entry.cardNotes, ['BF16 recommandé sur GPU']);
  const verdict = assess(entry, r9700);
  assert.notEqual(verdict.fit, 'no');
  assert.equal(verdict.context, 32768);
});

test('sans fiche lue : le contexte de la machine, les niveaux par défaut', () => {
  const entry = buildEntry({ repo: 'OVHaiLLM/Olala-v1.0-mini-7A1B-GGUF', quant, profile: profileFromMetadata({ meta }) });
  assert.equal(entry.profile.maxContext, undefined);
  assert.ok(assess(entry, r9700).context > 32768);
  assert.deepEqual(entry.reasoningLevels, ['low', 'medium', 'xhigh']);
});

test('faits de fiche : valeurs hors bornes et niveaux inconnus écartés', () => {
  assert.deepEqual(cardFacts({ maxContext: 12, reasoningLevels: ['turbo', 'low'], notes: [] }), { maxContext: null, reasoningLevels: ['low'], notes: null });
  assert.equal(cardFacts({ maxContext: '32768' }).maxContext, null, 'un entier, pas une chaîne');
  assert.equal(cardFacts(null), null);
});

test('fiche lisible : sans images en data: URI ni balisage', () => {
  const raw = '<div align="center"><img src="data:image/svg+xml,%3Csvg%20xmlns%3D" alt=""/><a href="https://x">AI Endpoints</a></div>\n\n> These files need our llama.cpp fork.<br/>-c at most 32,768';
  const text = readableCard(raw);
  assert.ok(!text.includes('data:') && !text.includes('<'));
  assert.match(text, /AI Endpoints/);
  assert.match(text, /needs? our llama\.cpp fork/);
  assert.match(text, /at most 32,768/);
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
  const entry = buildEntry({ repo: 'OVHaiLLM/Olala-v1.0-mini-7A1B-GGUF', quant: { quant: 'Q8_0', bytes: 1, files: [] }, profile: profileFromMetadata({ meta }), card, sampling: { temperature: 0.8, top_p: 0.9, top_k: 40 } });
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

test('moteurs ajoutés : registre à part, survivent au redémarrage, orphelins isolés', async () => {
  const { migrate } = await import('../src/migrations.mjs');
  const fork = { id: 'fork-ovhai-llm-llama-cpp', label: 'llama.cpp OVHai-LLM', repo: 'OVHai-LLM/llama.cpp', ref: 'abc', onlyArchs: ['olala'], isolated: true };
  const migrated = migrate({ version: 5, engines: { [fork.id]: fork, 'qwen3-8-27b': { status: 'ready' } }, profiles: {} });
  assert.deepEqual(Object.keys(migrated.addedEngines), [fork.id]);
  assert.deepEqual(Object.keys(migrated.engines), ['qwen3-8-27b'], 'les modèles chargés restent où ils sont');

  const { engineSheet, dropUnusedEngines } = await import('../src/engines.mjs');
  const { update } = await import('../src/state.mjs');
  // Un fork compilé dont la fiche a disparu : isolé, jamais proposé.
  const orphan = engineSheet(fork.id);
  assert.equal(orphan.isolated, true);
  assert.equal(orphan.eligible({}), false);
  assert.equal(engineSheet('llama-pr-test').isolated, true, 'même hors du format des identifiants : isolé');
  // Le ménage : le fork encore réglé sur un modèle installé reste, Strata n'est jamais touché.
  update((s) => {
    s.models = { olala: { installedAt: 'x' } };
    s.profiles = { olala: { tuning: { fork: fork.id } } };
    s.runtimes = { [`${fork.id}-hip`]: { kind: fork.id }, 'strata-x': { kind: 'strata' }, 'fork-autre-hip': { kind: 'fork-autre' } };
  });
  const { dropped } = await dropUnusedEngines();
  assert.deepEqual(dropped, ['fork-autre']);
  const { getState } = await import('../src/state.mjs');
  assert.deepEqual(Object.keys(getState().runtimes).sort(), [`${fork.id}-hip`, 'strata-x']);
});
