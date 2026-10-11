import './helpers/home.mjs';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { forget, readMemory, remember } from '../src/pi-extensions/agent-memory/store.ts';

const file = path.join(process.env.HARN_HOME, 'MEMORY.md');
const day = new Date('2026-10-11T08:00:00Z');

test('un fait par ligne, daté, sans doublon', () => {
  assert.equal(readMemory(file), '');
  assert.deepEqual(remember(file, 200, '  Aime le thé,\n pas le café. ', day), { ok: true, message: 'Remembered.' });
  assert.equal(readFileSync(file, 'utf8'), '- 2026-10-11 : Aime le thé, pas le café.\n');
  assert.equal(remember(file, 200, 'aime le thé, pas le café.', day).message, 'Already in memory.');
  assert.ok(remember(file, 200, 'Apprend le piano', day).ok);
  assert.equal(readMemory(file).split('\n').length, 2);
});

test('mémoire pleine ou fait trop long : refusé, rien n’est écrit', () => {
  const before = readFileSync(file, 'utf8');
  assert.match(remember(file, 80, 'Travaille sur un potager en permaculture', day).message, /Memory is full/);
  assert.match(remember(file, 9999, 'x'.repeat(301), day).message, /Too long/);
  assert.equal(remember(file, 200, '   ', day).ok, false);
  assert.equal(readFileSync(file, 'utf8'), before);
});

test('oublier retire une seule ligne, désignée sans ambiguïté', () => {
  assert.match(forget(file, '2026-10-11').message, /2 entries contain this text/);
  assert.equal(forget(file, 'violon').ok, false);
  assert.equal(forget(file, '').ok, false);
  assert.match(forget(file, 'PIANO').message, /^Forgotten: - 2026-10-11 : Apprend le piano$/);
  assert.equal(readFileSync(file, 'utf8'), '- 2026-10-11 : Aime le thé, pas le café.\n');
  // Ce que la personne a écrit à la main depuis Harn se retire aussi.
  writeFileSync(file, 'Prénom : Éloïse\n- 2026-10-11 : Aime le thé\n');
  assert.ok(forget(file, 'prénom').ok);
  assert.equal(readFileSync(file, 'utf8'), '- 2026-10-11 : Aime le thé\n');
});
