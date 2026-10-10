import path from 'node:path';
import { appendFile, mkdir as makeDir, readFile } from 'node:fs/promises';
import { displayName, downloadUrl, hfSha256 } from './catalog.mjs';
import { download, hashFile } from './download.mjs';
import { adoptLocalCopy, findLocalCopies } from './local-files.mjs';
import { DIRS } from './paths.mjs';
import { assess } from './planner.mjs';
import { installStrata } from './runtimes.mjs';
import { getState, update } from './state.mjs';

// Fichiers d'un modèle : copies locales reprises, téléchargements vérifiés, journal d'installation.
// Chaque installation a son journal complet (data/logs/install-<modèle>.log) : c'est lui qu'on
// montre, et qu'on donne à pi, quand quelque chose échoue.
export const installLogPath = (id) => path.join(DIRS.logs, `install-${id}.log`);
export async function installModelFiles(model, { ggufDir: forcedDir = null } = {}) {
  const dir = path.join(DIRS.models, model.id);
  const logFile = installLogPath(model.id);
  await makeDir(DIRS.logs, { recursive: true });
  const log = (text) => appendFile(logFile, String(text).endsWith('\n') ? String(text) : `${text}\n`).catch(() => {});
  await log(`\n# ${new Date().toISOString()} · installation de ${displayName(model)}`);
  const note = (detail) => { log(detail); update((s) => { s.models[model.id].detail = detail; }); };
  update((s) => { s.models[model.id] = { ...(s.models[model.id] ?? {}), installing: true, error: null, detail: 'Recherche de fichiers déjà présents' }; });
  const files = model.files.map((file) => ({ repo: model.repo, ...file }));
  if (model.mmproj) files.push(model.mmproj);
  const paths = {};
  try {
    // Avant de télécharger : le fichier est peut-être déjà sur la machine (même nom, même taille).
    const local = await findLocalCopies(model.engine === 'strata' ? model.files : files);
    if (model.engine === 'strata') {
      const context = assess(model, getState().hardware).context;
      const shards = model.files.map((file) => local[file.name]).filter(Boolean);
      const ggufDir = forcedDir ?? (shards.length === model.files.length && new Set(shards.map((p) => path.dirname(p))).size === 1 ? path.dirname(shards[0]) : null);
      note(ggufDir ? `Fichiers déjà présents dans ${ggufDir} : réutilisés, pas de téléchargement` : 'Installation de Strata et téléchargement du modèle');
      await installStrata(model, context, (line) => { log(line); update((s) => { s.models[model.id].log = String(line).slice(-400); }); }, { ggufDir });
    } else {
      for (const file of files) {
        // Une copie trouvée sur le disque n'a que le bon nom et la bonne taille : son empreinte
        // doit aussi correspondre, sinon on télécharge l'original.
        if (local[file.name]) {
          note(`${file.name} trouvé dans ${local[file.name]} : vérification de l’empreinte`);
          const actual = (await hashFile(local[file.name])).digest('hex');
          if (actual !== await expectedSha(file)) {
            note(`${file.name} (${local[file.name]}) ne correspond pas à l’original : ignoré`);
            delete local[file.name];
          }
        }
        if (local[file.name]) {
          const used = await adoptLocalCopy(local[file.name], path.join(dir, file.name));
          if (used !== path.join(dir, file.name)) paths[file.name] = used;
          note(`${file.name} déjà présent (${local[file.name]}) : réutilisé`);
        } else {
          note(`Téléchargement de ${file.name}`);
          await downloadFile(model, file);
        }
      }
    }
  } catch (error) {
    await log(`ÉCHEC : ${error.message}`);
    throw new Error(`${error.message}${await lastLines(logFile)}`);
  }
  await log('Fichiers prêts.');
  update((s) => { s.models[model.id] = { installedAt: new Date().toISOString(), installing: false, files: files.map((file) => file.name), paths }; });
}
// Les dernières lignes utiles d'un journal : ce qu'un humain lira en premier.
async function lastLines(file, count = 3) {
  const { readFile: read } = await import('node:fs/promises');
  const text = await read(file, 'utf8').catch(() => '');
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  const useful = lines.filter((l) => /error|erreur|échec|failed|not found|introuvable|impossible|denied|refus|traceback|exception|n'est pas reconnu/i.test(l));
  const pick = (useful.length ? useful : lines).slice(-count);
  return pick.length ? ` — ${pick.join(' · ').slice(0, 400)}` : '';
}
// L'empreinte d'un fichier de modèle : celle notée à l'ajout depuis Hugging Face, sinon celle que
// Hugging Face publie. Sans empreinte, pas de téléchargement : un GGUF est lu par le parseur
// du moteur, qui a déjà eu des failles exploitables par un fichier piégé.
async function expectedSha(file) {
  const sha = file.sha256 ?? await hfSha256(file.repo, file.name);
  if (!sha) throw new Error(`Hugging Face ne publie pas d’empreinte SHA-256 pour ${file.name} (${file.repo}) : fichier non vérifiable, téléchargement refusé.`);
  return sha;
}
export async function downloadFile(model, file) {
  return download({
    id: `model:${model.id}:${file.name}`,
    label: file.name,
    url: downloadUrl(file.repo, file.name),
    dest: path.join(DIRS.models, model.id, file.name),
    expectedBytes: file.bytes,
    sha256: await expectedSha(file),
  });
}
