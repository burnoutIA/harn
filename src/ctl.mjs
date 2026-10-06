// Arrêter ou relancer Harn sans rien casser : « npm run stop » et « npm run restart ».
// Avant d'arrêter, on demande au serveur ce qui est en cours (installation, banc, téléchargement,
// réponse en vol…) et on refuse si quelque chose tournerait pour rien ; --force passe outre.
// L'arrêt est propre : le serveur coupe le moteur et enregistre son état avant de quitter.
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { DIRS, PORTS, fromRoot } from './paths.mjs';

const ORIGIN = `http://127.0.0.1:${PORTS.app}`;
const ROOT = fromRoot();
const command = process.argv[2];
const force = process.argv.includes('--force');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function call(pathname, options = {}) {
  try {
    return await fetch(`${ORIGIN}${pathname}`, { ...options, signal: AbortSignal.timeout(3000) });
  } catch {
    return null; // personne n'écoute
  }
}

// Le processus qui tient le port (repli pour une instance trop ancienne ou figée).
function pidOnPort() {
  try {
    if (process.platform === 'win32') {
      const line = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' }).split('\n').find((l) => l.includes(`:${PORTS.app} `) && /LISTENING/.test(l));
      return line ? Number(line.trim().split(/\s+/).at(-1)) : null;
    }
    return Number(execFileSync('lsof', ['-ti', `tcp:${PORTS.app}`, '-sTCP:LISTEN'], { encoding: 'utf8' }).trim().split('\n')[0]) || null;
  } catch {
    return null;
  }
}

// Les sessions pi ouvertes : elles survivent à l'arrêt mais perdent leur modèle le temps du redémarrage.
function piSessions() {
  try {
    const out = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object CommandLine -like '*pi-coding-agent*' | ForEach-Object ProcessId"], { encoding: 'utf8' })
      : execFileSync('pgrep', ['-f', 'pi-coding-agent'], { encoding: 'utf8' });
    return out.split(/\s+/).filter(Boolean).length;
  } catch {
    return 0;
  }
}

async function stop() {
  const res = await call('/api/activity');
  if (!res) { console.log('Harn n’est pas lancé.'); return true; }

  if (res.ok) {
    const { activity } = await res.json();
    if (activity.length) {
      console.log('En cours sur Harn :');
      for (const item of activity) console.log(`  - ${item}`);
      if (!force) {
        console.log('\nRien n’a été arrêté. Attendez la fin, ou relancez avec --force pour couper quand même.');
        return false;
      }
      console.log('\n--force : arrêt quand même.');
    }
    const sessions = piSessions();
    if (sessions) console.log(`${sessions} session(s) pi ouverte(s) : elles restent ouvertes mais n’auront plus de modèle pendant l’arrêt.`);
  }

  console.log('Arrêt de Harn (moteur compris)…');
  const pid = pidOnPort();
  const asked = await call('/api/shutdown', { method: 'POST' });
  if (!asked?.ok && pid) process.kill(pid); // instance sans arrêt propre : on la termine
  for (let i = 0; i < 60; i += 1) {
    if (!(await call('/api/status'))) { console.log('Harn est arrêté.'); return true; }
    await sleep(500);
  }
  console.log(`Harn ne répond plus mais n’a pas quitté au bout de 30 s${pid ? ` (processus ${pid})` : ''}.`);
  return false;
}

async function start({ open }) {
  mkdirSync(DIRS.logs, { recursive: true });
  const log = openSync(path.join(DIRS.logs, 'harn.log'), 'a');
  spawn(process.execPath, ['src/main.mjs', ...(open ? [] : ['--no-open'])], { cwd: ROOT, detached: true, stdio: ['ignore', log, log], windowsHide: true }).unref();
  for (let i = 0; i < 60; i += 1) {
    await sleep(500);
    if ((await call('/api/status'))?.ok) { console.log(`Harn est lancé : ${ORIGIN} (journal : data/logs/harn.log)`); return true; }
  }
  console.log('Harn ne répond pas au bout de 30 s : voir data/logs/harn.log.');
  return false;
}

if (command === 'stop') {
  process.exitCode = (await stop()) ? 0 : 1;
} else if (command === 'restart') {
  const wasRunning = Boolean(await call('/api/status'));
  if (!(await stop())) process.exitCode = 1;
  // Pas de nouvelle fenêtre si Harn tournait déjà (celle qui est ouverte se reconnecte seule), sauf --open.
  else process.exitCode = (await start({ open: !wasRunning || process.argv.includes('--open') })) ? 0 : 1;
} else {
  console.log('Usage : node src/ctl.mjs stop|restart [--force] [--open]');
  process.exitCode = 1;
}
