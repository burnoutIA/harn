import './helpers/home.mjs';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { DIRS, fromRoot } from '../src/paths.mjs';
import { installExtensions } from '../src/pi.mjs';

const shipped = readdirSync(fromRoot('src', 'pi-extensions'), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);

test('une extension que Harn ne fournit plus est retirée ; celles de l’utilisateur restent', async () => {
  const piDir = path.join(DIRS.data, 'pi-test');
  const ext = path.join(piDir, 'extensions');
  mkdirSync(path.join(ext, 'ancienne'), { recursive: true });
  mkdirSync(path.join(ext, 'perso'), { recursive: true });
  writeFileSync(path.join(ext, 'ancienne', 'index.ts'), '');
  writeFileSync(path.join(ext, 'perso', 'index.ts'), '');
  writeFileSync(path.join(ext, '.harn-extensions.json'), JSON.stringify([...shipped, 'ancienne']));
  await installExtensions(piDir);
  assert.ok(!existsSync(path.join(ext, 'ancienne')));
  assert.ok(existsSync(path.join(ext, 'perso')));
  for (const name of shipped) assert.ok(existsSync(path.join(ext, name)), name);
});
