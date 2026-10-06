import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tout vit dans le dépôt : runtimes, modèles, état. Déplacer le dossier déplace l'installation.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fromRoot = (...parts) => path.join(ROOT, ...parts);

export const DIRS = {
  runtime: fromRoot('runtime'),
  models: fromRoot('models'),
  data: fromRoot('data'),
  logs: fromRoot('data', 'logs'),
  downloads: fromRoot('runtime', 'downloads'),
  piAgent: fromRoot('data', 'pi-agent'),
  workspace: fromRoot('workspace'),
  public: fromRoot('public'),
};

// Un seul port public : interface, API de contrôle et endpoint OpenAI. Le moteur reste interne.
export const PORTS = {
  app: Number(process.env.HARN_PORT ?? 4747),
  engine: Number(process.env.HARN_ENGINE_PORT ?? 4749),
  strata: Number(process.env.HARN_STRATA_PORT ?? 4750),
};
