import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Tout vit dans le dépôt : runtimes, modèles, état. Déplacer le dossier déplace l'installation.
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const fromRoot = (...parts) => path.join(ROOT, ...parts);

// HARN_HOME : l'installation (état, modèles, moteurs) ailleurs que dans le dépôt. Les tests s'en
// servent pour ne jamais toucher à la vraie installation ; le code et l'interface restent ici.
export const HOME = process.env.HARN_HOME ? path.resolve(process.env.HARN_HOME) : ROOT;
const fromHome = (...parts) => path.join(HOME, ...parts);

export const DIRS = {
  runtime: fromHome('runtime'),
  models: fromHome('models'),
  data: fromHome('data'),
  logs: fromHome('data', 'logs'),
  downloads: fromHome('runtime', 'downloads'),
  piAgent: fromHome('data', 'pi-agent'),
  agents: fromHome('data', 'agents'),
  workspace: fromHome('workspace'),
  public: fromRoot('public'),
};

// Un seul port local : interface, API de contrôle et endpoint OpenAI. Le moteur reste interne.
// lan : l'endpoint OpenAI seul, ouvert au réseau local à la demande (clé exigée).
export const PORTS = {
  app: Number(process.env.HARN_PORT ?? 4747),
  lan: Number(process.env.HARN_LAN_PORT ?? 4748),
  engine: Number(process.env.HARN_ENGINE_PORT ?? 4749),
  strata: Number(process.env.HARN_STRATA_PORT ?? 4750),
};
