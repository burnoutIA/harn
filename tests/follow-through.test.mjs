import assert from 'node:assert/strict';
import test from 'node:test';

const load = async () => import(`../src/pi-extensions/follow-through/index.ts?${Math.random()}`);
const assistant = (text, tool = false) => ({ role: 'assistant', content: [{ type: 'text', text }, ...(tool ? [{ type: 'toolCall', name: 'bash' }] : [])] });

function fakePi() {
  const handlers = {};
  return { on: (event, handler) => { handlers[event] = handler; }, emit: (event, payload = {}) => handlers[event]?.(payload) };
}
const settle = (pi, last) => pi.emit('agent_before_settle', { outcome: 'completed', context: { canContinue: true, llmMessages: [{ role: 'user', content: 'go' }, last] } });

test('une annonce finale est reconnue, un résumé non', async () => {
  const { announcesWork } = await load();
  // Le cas mesuré : Swift 27B s'est arrêté là, à 26 tests sur 36.
  assert.ok(announcesWork('Plusieurs bugs à corriger. Je les analyse et je corrige :\n\n1. **csvlite** : séparateur non sauté.\n2. **dates** : Pâques faux.'));
  assert.ok(announcesWork('Les tests échouent encore. Je vais reprendre durees.py.'));
  assert.ok(announcesWork("Let me fix the parser first."));
  assert.ok(!announcesWork('Suite complète : **36 tests passés**, 0 échec.\n\nRésumé des implémentations (tests inchangés) :\n\n- `cache.py` — CacheLRU.\n- `dates.py` — Pâques.'));
  assert.ok(!announcesWork('Voici la capitale : Paris.'));
  assert.ok(!announcesWork(''));
});

test('relance seulement un agent qui a travaillé, deux fois au plus par tour', async () => {
  const pi = fakePi();
  (await load()).default(pi);
  const annonce = assistant('Je corrige les deux derniers modules :\n- texte\n- dates');
  // Une discussion sans outil n'est jamais relancée.
  pi.emit('agent_start');
  assert.equal(settle(pi, annonce), undefined);
  pi.emit('tool_execution_end');
  const first = settle(pi, annonce);
  assert.equal(first.continue, true);
  assert.equal(first.entries[0].type, 'custom_message');
  assert.equal(settle(pi, annonce).continue, true);
  assert.equal(settle(pi, annonce), undefined);
  // Un nouveau tour repart de zéro ; un message qui appelle un outil ou un tour interrompu ne compte pas.
  pi.emit('agent_start');
  pi.emit('tool_execution_end');
  assert.equal(settle(pi, assistant('Je corrige :', true)), undefined);
  assert.equal(pi.emit('agent_before_settle', { outcome: 'aborted', context: { canContinue: true, llmMessages: [annonce] } }), undefined);
  assert.equal(settle(pi, assistant('Tout passe : 36 passed.')), undefined);
});
