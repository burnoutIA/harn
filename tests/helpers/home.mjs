// À importer en premier dans chaque fichier de test : l'installation (état, modèles, moteurs)
// vit dans un dossier temporaire, et les ports du moteur ne croisent pas ceux d'un Harn lancé.
// Sans ça, un test qui appelle update() réécrirait le vrai data/state.json.
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.HARN_HOME = mkdtempSync(path.join(os.tmpdir(), 'harn-test-'));
process.env.HARN_ENGINE_PORT = String(20_000 + Math.floor(Math.random() * 20_000));
process.env.HARN_STRATA_PORT = String(Number(process.env.HARN_ENGINE_PORT) + 1);
