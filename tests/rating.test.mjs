import assert from 'node:assert/strict';
import test from 'node:test';
import { globalRating, paramsOf } from '../src/rating.mjs';

const profile = (score, tps, context) => ({ iq: { version: 3, score }, bench: { winner: { tps } }, tuning: { context } });

test('taille lue dans le catalogue, l’étiquette GGUF ou le nom', () => {
  assert.equal(paramsOf({ paramsB: 125 }), 125);
  assert.equal(paramsOf({ profile: { sizeLabel: '35B-A3B' } }), 35);
  assert.equal(paramsOf({ id: 'qwen3-6-35b-a3b-mtp-gguf-ud-iq4-nl' }), 35);
  assert.equal(paramsOf({ id: 'ornith-1-5-9b-gguf-q8-0' }), 9);
  assert.equal(paramsOf({ name: 'Swift 1.5 Qwen3.8' }), null);
});

test('à intelligence égale, le plus gros modèle passe devant', () => {
  const small = globalRating({ paramsB: 4 }, profile(100, 90, 131072)).score;
  const big = globalRating({ paramsB: 122 }, profile(100, 90, 131072)).score;
  assert.ok(big > small + 10);
});

test('pas de note globale sans banc de vitesse', () => {
  assert.equal(globalRating({ paramsB: 27 }, { iq: { version: 3, score: 100 } }), null);
});

test('un MoE de 35B pèse un peu moins qu’un 27B dense', () => {
  const dense = globalRating({ paramsB: 27 }, profile(100, 90, 131072)).parts.taille;
  const moe = globalRating({ paramsB: 35, moe: { experts: 128, used: 8 } }, profile(100, 90, 131072)).parts.taille;
  assert.ok(moe < dense && moe > dense - 0.05);
});
