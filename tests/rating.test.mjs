import './helpers/home.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { IQ_VERSION } from '../src/iq-test.mjs';
import { globalRating, paramsOf } from '../src/rating.mjs';

const profile = (score, tps, context) => ({ iq: { version: IQ_VERSION, score }, bench: { winner: { tps } }, tuning: { context } });

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
  assert.equal(globalRating({ paramsB: 27 }, { iq: { version: IQ_VERSION, score: 100 } }), null);
});

test('un MoE de 35B pèse un peu moins qu’un 27B dense', () => {
  const dense = globalRating({ paramsB: 27 }, profile(100, 90, 131072)).parts.taille;
  const moe = globalRating({ paramsB: 35, moe: { experts: 128, used: 8 } }, profile(100, 90, 131072)).parts.taille;
  assert.ok(moe < dense && moe > dense - 0.05);
});

test('vitesse : à intelligence égale, le modèle qui répond en moins de temps passe devant', () => {
  const p = (tps, replyTokens) => ({ ...profile(100, tps, 131072), iq: { version: IQ_VERSION, score: 100, verbosity: { replyTokens } } });
  const fastButVerbose = globalRating({ paramsB: 27 }, p(130, 2000));
  const slowButConcise = globalRating({ paramsB: 27 }, p(65, 500));
  assert.equal(fastButVerbose.replySeconds, 15.4);
  assert.ok(slowButConcise.score > fastButVerbose.score);
  // Sans mesure des tokens, l'ancienne échelle en tok/s : 20 tok/s → 0, 160 tok/s → 1.
  assert.equal(globalRating({ paramsB: 27 }, profile(100, 20, 131072)).parts.vitesse, 0);
  assert.equal(globalRating({ paramsB: 27 }, profile(100, 160, 131072)).parts.vitesse, 1);
});
