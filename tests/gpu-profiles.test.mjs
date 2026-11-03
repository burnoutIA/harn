import assert from 'node:assert/strict';
import test from 'node:test';
import { gpuChangeCheck, inferCard, switchCard } from '../src/gpu-profiles.mjs';

const card = (name) => ({ primary: name ? { name } : null });
const measured = (gpu, context) => ({ tuning: { context, backend: 'cuda12' }, bench: { gpu, winner: { tps: 100 } }, iq: { score: 80 }, usage: 'code' });

test('état d’avant le rangement : la carte se déduit des bancs', () => {
  assert.equal(inferCard({ a: measured('RTX 3090', 1), b: measured('RTX 3090', 2), c: measured('RTX 4060', 3), d: {} }), 'RTX 3090');
  assert.equal(inferCard({}), null);
});

test('nouvelle carte : réglages mis de côté, intelligence gardée', () => {
  const state = { profiles: { m: measured('RTX 3090', 139264), n: { iq: { score: 70 } } } };
  const change = switchCard(state, card('AMD Radeon AI PRO R9700'));
  assert.deepEqual([change.from, change.to, change.archived, change.restored], ['RTX 3090', 'AMD Radeon AI PRO R9700', 1, 0]);
  assert.deepEqual(state.profiles.m, { iq: { score: 80 }, usage: 'code' });
  assert.equal(state.gpuArchive['RTX 3090'].profiles.m.tuning.context, 139264);
  assert.equal(state.gpuKey, 'AMD Radeon AI PRO R9700');
  assert.match(gpuChangeCheck(change).text, /relancez le banc/);
});

test('retour de l’ancienne carte : ses réglages reviennent tels quels', () => {
  const state = { profiles: { m: measured('RTX 3090', 139264) } };
  switchCard(state, card('AMD Radeon AI PRO R9700'));
  state.profiles.m = { ...state.profiles.m, ...measured('AMD Radeon AI PRO R9700', 200000) };
  const change = switchCard(state, card('RTX 3090'));
  assert.equal(change.restored, 1);
  assert.equal(state.profiles.m.tuning.context, 139264);
  assert.equal(state.gpuArchive['AMD Radeon AI PRO R9700'].profiles.m.tuning.context, 200000);
  assert.equal(state.gpuArchive['RTX 3090'], undefined);
});

test('même carte ou carte introuvable : rien ne bouge', () => {
  const state = { profiles: { m: measured('RTX 3090', 1) } };
  assert.equal(switchCard(state, card(null)), null);
  assert.equal(state.profiles.m.tuning.context, 1);
  assert.equal(switchCard(state, card('RTX 3090')), null);
  assert.equal(state.gpuKey, 'RTX 3090');
  assert.equal(state.gpuChange, undefined);
});

test('à remesurer : installés sans banc ici, hors ceux que la carte ne fait pas tourner', async () => {
  const { benchTodo } = await import('../src/gpu-profiles.mjs');
  const state = {
    models: { a: { installedAt: 1 }, b: { installedAt: 1 }, c: { installedAt: 1 }, d: {} },
    profiles: { b: { bench: { winner: { tps: 50 } } } },
    plan: { verdicts: [{ id: 'a', fit: 'full' }, { id: 'b', fit: 'full' }, { id: 'c', fit: 'no' }, { id: 'd', fit: 'full' }] },
  };
  assert.deepEqual(benchTodo(state), { toMeasure: ['a'], unusable: ['c'] });
});

test('moteur qui voit aussi la puce intégrée : la carte retenue lui est désignée', async () => {
  const { deviceArgs } = await import('../src/loading.mjs');
  const hardware = { primary: { name: 'AMD Radeon AI PRO R9700' } };
  const vulkan = [{ id: 'Vulkan0', name: 'AMD Ryzen 7 7800X3D 8-Core Processor (RADV RAPHAEL_MENDOCINO)' }, { id: 'Vulkan1', name: 'AMD Radeon AI PRO R9700 (RADV GFX1201)' }];
  assert.deepEqual(deviceArgs(vulkan, hardware), ['--device', 'Vulkan1']);
  assert.deepEqual(deviceArgs(vulkan, hardware, { draft: true }), ['--device', 'Vulkan1', '--device-draft', 'Vulkan1']);
  assert.deepEqual(deviceArgs([vulkan[1]], hardware), []);
  assert.deepEqual(deviceArgs(null, hardware), []);
  assert.deepEqual(deviceArgs(vulkan, { primary: { name: 'NVIDIA GeForce RTX 3090' } }), []);
});
