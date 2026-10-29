import './helpers/home.mjs';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { profileFromMetadata, readGgufFile } from '../src/gguf.mjs';

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const str = (s) => Buffer.concat([u64(Buffer.byteLength(s)), Buffer.from(s)]);
const STRING = 8;
const ARRAY = 9;
const U32 = 4;

// Un GGUF minimal : en-tête, quelques clés, puis des « poids » que la lecture ne doit pas toucher.
function gguf(entries, payloadBytes = 0) {
  const body = entries.map(([key, type, value]) => Buffer.concat([str(key), u32(type), value]));
  return Buffer.concat([Buffer.from('GGUF'), u32(3), u64(0), u64(entries.length), ...body, Buffer.alloc(payloadBytes)]);
}

test('l’en-tête d’un GGUF se lit dans le fichier local, sans charger les poids', async () => {
  const file = path.join(process.env.HARN_HOME, 'local.gguf');
  // Un vocabulaire de 300 000 mots pousse l'en-tête au-delà de la première lecture (4 Mo).
  const words = Buffer.concat(Array.from({ length: 300_000 }, (_, i) => str(`mot-numero-${i}`)));
  await writeFile(file, gguf([
    ['general.architecture', STRING, str('qwen35')],
    ['general.name', STRING, str('Essai 27B')],
    ['tokenizer.ggml.tokens', ARRAY, Buffer.concat([u32(STRING), u64(300_000), words])],
    ['qwen35.block_count', U32, u32(64)],
    ['qwen35.attention.head_count_kv', U32, u32(8)],
    ['qwen35.nextn_predict_layers', U32, u32(1)],
  ], 1024));
  const profile = profileFromMetadata(await readGgufFile(file));
  assert.equal(profile.arch, 'qwen35');
  assert.equal(profile.name, 'Essai 27B');
  assert.equal(profile.layers, 64);
  assert.equal(profile.mtp, true);
});

test('un fichier qui n’est pas un GGUF est refusé', async () => {
  const file = path.join(process.env.HARN_HOME, 'faux.gguf');
  await writeFile(file, Buffer.from('pas un modèle du tout'));
  await assert.rejects(readGgufFile(file), /n’est pas un GGUF/);
});

test('fenêtre glissante : seules les couches d’attention pleine comptent dans le cache par token', async () => {
  const file = path.join(process.env.HARN_HOME, 'gemma.gguf');
  const BOOL = 7;
  const u8 = (n) => Buffer.from([n]);
  const pattern = [true, true, true, true, true, false];
  await writeFile(file, gguf([
    ['general.architecture', STRING, str('gemma4')],
    ['gemma4.block_count', U32, u32(6)],
    ['gemma4.attention.head_count_kv', ARRAY, Buffer.concat([u32(U32), u64(6), ...[8, 8, 8, 8, 8, 1].map(u32)])],
    ['gemma4.attention.key_length', U32, u32(512)],
    ['gemma4.attention.value_length', U32, u32(512)],
    ['gemma4.attention.sliding_window', U32, u32(1024)],
    ['gemma4.attention.sliding_window_pattern', ARRAY, Buffer.concat([u32(BOOL), u64(6), ...pattern.map((b) => u8(b ? 1 : 0))])],
  ]));
  const profile = profileFromMetadata(await readGgufFile(file));
  // Une couche pleine, une tête KV : (512 + 512) × 2 octets.
  assert.equal(profile.kvBytesPerToken.f16, 2048);
});
