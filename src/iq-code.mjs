// Exécuter le code écrit par un modèle pendant le banc d'intelligence : dans une bulle bubblewrap
// (voir sandbox.mjs : système en lecture seule, dossier personnel invisible, aucun réseau), avec
// une limite de temps. Le code du modèle est suivi des tests de l'épreuve, qui affichent en
// dernière ligne « RESULTAT-<jeton> <réussis>/<total> ». Le jeton est tiré à chaque exécution
// (« @@JETON@@ » dans les tests) : le code du modèle ne peut pas afficher un faux résultat.
import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { promisify } from 'node:util';
import { sandboxAvailable, sandboxed } from './sandbox.mjs';

const run = promisify(execFile);
const TIMEOUT_MS = 20_000;

// Le dernier bloc de code de la réponse (```python, ```js…), ou toute la réponse sans bloc.
export function codeBlock(text) {
  const blocks = [...String(text ?? '').matchAll(/```[\w+-]*[ \t]*\n([\s\S]*?)```/g)].map((m) => m[1]);
  return blocks.length ? blocks.at(-1) : String(text ?? '');
}

// Où trouver chaque langage, vu de l'intérieur de la bulle. null : absent de cette machine.
const toolchains = {};
async function toolchain(lang) {
  if (lang in toolchains) return toolchains[lang];
  let found = null;
  try {
    if (lang === 'python') {
      await run('python3', ['--version'], { timeout: 5000 });
      found = { command: 'python3', args: ['-I', '-'], readable: [] };
    } else if (lang === 'node') {
      // Node peut vivre hors de /usr (~/.local/node) : on montre son dossier à la bulle.
      found = { command: process.execPath, args: ['-'], readable: [path.dirname(path.dirname(process.execPath))] };
    } else if (lang === 'rust') {
      // rustc de rustup est un relais qui cherche ~/.rustup : on prend le vrai, dans sa racine.
      const { stdout } = await run('rustc', ['--print', 'sysroot'], { timeout: 10_000 });
      const sysroot = stdout.trim();
      found = { command: '/bin/sh', args: ['-c', `cat > /tmp/m.rs && ${sysroot}/bin/rustc --edition 2021 -O -o /tmp/m /tmp/m.rs 2>&1 && /tmp/m`], readable: [sysroot] };
    }
  } catch {
    found = null;
  }
  return (toolchains[lang] = found);
}

// Le langage peut-il tourner ici ? Sinon l'épreuve est écartée (ni réussie ni ratée).
export async function canRun(lang) {
  return Boolean((await sandboxAvailable()) && (await toolchain(lang)));
}

// { passed, total, output } ; passed 0 si le code ne compile pas, plante ou dépasse le temps.
export async function runTests(lang, code, tests, total) {
  const chain = await toolchain(lang);
  const token = randomBytes(8).toString('hex');
  const source = `${code}\n${tests.replaceAll('@@JETON@@', token)}`;
  const { command, args } = sandboxed(chain.command, chain.args, { readable: chain.readable });
  const output = await new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let text = '';
    const keep = (chunk) => { if (text.length < 20_000) text += chunk; };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);
    const timer = setTimeout(() => { text += '\n[temps dépassé]'; child.kill('SIGKILL'); }, TIMEOUT_MS);
    child.on('close', () => { clearTimeout(timer); resolve(text); });
    child.on('error', (error) => { clearTimeout(timer); resolve(String(error.message)); });
    child.stdin.on('error', () => {});
    child.stdin.end(source);
  });
  const match = [...output.matchAll(new RegExp(`RESULTAT-${token} (\\d+)/(\\d+)`, 'g'))].at(-1);
  const passed = match && Number(match[2]) === total ? Math.min(total, Number(match[1])) : 0;
  return { passed, total, output: output.slice(-400) };
}
