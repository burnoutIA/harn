// Mise à jour de Harn depuis GitHub : au démarrage puis toutes les 6 h, on compare la version
// installée au dernier commit de main (la version publiée) ; un bouton applique la nouvelle version et
// relance Harn. Ce qui appartient à la machine (data, models, runtime, workspace) n'est jamais
// touché : seul le code change.
//
// Deux installations possibles : un clone git (git pull --ff-only, refusé s'il y a des
// modifications locales ou des commits non publiés) ou un dossier dézippé (on télécharge
// l'archive du commit et on recopie le code ; le commit installé est noté dans data/).
import { execFile, spawn } from 'node:child_process';
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { download } from './download.mjs';
import { DIRS, ROOT } from './paths.mjs';
import { github as githubApi } from './github.mjs';
import { extract } from './runtimes.mjs';
import { getState, update } from './state.mjs';

const run = promisify(execFile);
const REPO = 'xavier-egoneau/harn';
// main : la version publiée. develop porte le travail en cours et n'est jamais proposé.
const BRANCH = 'main';
const VERSION_FILE = path.join(DIRS.data, 'app-version.json');
const KEEP = new Set(['data', 'models', 'runtime', 'workspace', 'node_modules', '.git']);
const EVERY_MS = 6 * 60 * 60 * 1000;

// Toujours frais : on vérifie une mise à jour au plus toutes les six heures.
const github = (pathname) => githubApi(`/repos/${REPO}${pathname}`, { ttl: 0, timeout: 15_000 });

const git = (...args) => run('git', args, { cwd: ROOT, windowsHide: true, timeout: 120_000 }).then((r) => r.stdout.trim());
const isClone = () => stat(path.join(ROOT, '.git')).then(() => git('--version').then(() => true, () => false), () => false);

// La version installée : le commit du clone, ou celui noté à la dernière mise à jour par archive.
async function installed() {
  if (await isClone()) {
    const sha = await git('rev-parse', 'HEAD').catch(() => null);
    const dirty = Boolean(await git('status', '--porcelain', '--untracked-files=no').catch(() => ''));
    return { mode: 'git', sha, dirty };
  }
  const saved = JSON.parse(await readFile(VERSION_FILE, 'utf8').catch(() => '{}'));
  return { mode: 'zip', sha: saved.sha ?? null, dirty: false };
}

export async function checkForUpdate() {
  try {
    const branch = BRANCH;
    const head = await github(`/commits/${branch}`);
    const local = await installed();
    const remote = { sha: head.sha, date: head.commit.committer.date, message: head.commit.message.split('\n')[0] };
    let status = 'unknown';
    let behindBy = null;
    let changes = [];
    if (local.sha === remote.sha) status = 'current';
    else if (local.sha) {
      // ahead / diverged : un poste de développement en avance sur GitHub, rien à proposer.
      const diff = await github(`/compare/${local.sha}...${remote.sha}`).catch(() => null);
      // Commit inconnu de GitHub : sur un clone, des commits pas encore publiés (poste de dev).
      status = !diff ? (local.mode === 'git' ? 'diverged' : 'available') : diff.status === 'behind' || diff.status === 'identical' ? 'current' : diff.status === 'ahead' ? 'available' : 'diverged';
      behindBy = diff?.ahead_by ?? null;
      changes = (diff?.commits ?? []).slice(-8).reverse().map((c) => c.commit.message.split('\n')[0]);
    } else status = 'available'; // dossier dézippé sans version notée : on ne sait pas, on propose
    update((s) => { s.appUpdate = { ...s.appUpdate, checkedAt: new Date().toISOString(), branch, mode: local.mode, dirty: local.dirty, local: local.sha, remote, status, behindBy, changes, error: null }; });
  } catch (error) {
    update((s) => { s.appUpdate = { ...s.appUpdate, checkedAt: new Date().toISOString(), error: error.message }; });
  }
  return getState().appUpdate;
}

export function watchForUpdates() {
  update((s) => { if (s.appUpdate) Object.assign(s.appUpdate, { applying: false, restarting: false }); });
  setTimeout(() => checkForUpdate(), 5_000);
  setInterval(() => checkForUpdate(), EVERY_MS).unref();
}

// Applique la dernière version puis relance Harn. `busy` : ce qu'un redémarrage interromprait.
export async function applyUpdate(busy = []) {
  if (busy.length) throw new Error(`Attendez la fin : ${busy.join(', ')}`);
  const info = getState().appUpdate;
  if (!info?.remote?.sha || !['available', 'unknown'].includes(info.status)) throw new Error('Aucune mise à jour à appliquer');
  update((s) => { s.appUpdate.applying = true; s.appUpdate.error = null; });
  try {
    const local = await installed();
    if (local.mode === 'git') {
      if (local.dirty) throw new Error('Des fichiers de Harn ont été modifiés à la main : mise à jour par git impossible sans les perdre');
      await git('pull', '--ff-only', 'origin', info.branch);
    } else {
      await fromArchive(info.remote.sha);
    }
    update((s) => { s.appUpdate = { ...s.appUpdate, applying: false, restarting: true, local: info.remote.sha, status: 'current' }; });
    restart();
  } catch (error) {
    update((s) => { s.appUpdate.applying = false; s.appUpdate.error = error.message; });
    throw error;
  }
}

async function fromArchive(sha) {
  const zip = await download({ id: 'app:update', label: `Harn ${sha.slice(0, 7)}`, url: `https://codeload.github.com/${REPO}/zip/${sha}`, dest: path.join(DIRS.downloads, `harn-${sha.slice(0, 7)}.zip`) });
  const staging = path.join(DIRS.downloads, `harn-${sha.slice(0, 7)}`);
  await rm(staging, { recursive: true, force: true });
  await extract(zip, staging);
  // L'archive range tout dans « harn-<commit> » : c'est ce dossier qu'on recopie.
  const [top] = await readdir(staging);
  const source = path.join(staging, top);
  if (!(await stat(path.join(source, 'src', 'main.mjs')).catch(() => null))) throw new Error('Archive de mise à jour inattendue (src/main.mjs absent)');
  for (const entry of await readdir(source)) {
    if (KEEP.has(entry)) continue;
    await cp(path.join(source, entry), path.join(ROOT, entry), { recursive: true, force: true });
  }
  await mkdir(DIRS.data, { recursive: true });
  await writeFile(VERSION_FILE, JSON.stringify({ sha, at: new Date().toISOString() }, null, 2));
  await rm(staging, { recursive: true, force: true });
  await rm(zip, { force: true });
  update((s) => { delete s.downloads['app:update']; });
}

// La relance passe par ctl.mjs, détaché : il arrête ce serveur proprement puis en lance un neuf
// (la fenêtre ouverte se reconnecte seule).
function restart() {
  spawn(process.execPath, ['src/ctl.mjs', 'restart', '--force'], { cwd: ROOT, detached: true, stdio: 'ignore', windowsHide: true }).unref();
}
