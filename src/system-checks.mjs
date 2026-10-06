import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { gpuProfile, hardwareNotes } from './levers.mjs';

const run = promisify(execFile);
const quiet = (command, args) => run(command, args, { windowsHide: true, timeout: 10_000 }).then((r) => r.stdout).catch(() => '');

const SCHEMES = {
  '381b4222-f694-41f0-9685-ff5bb260df2e': 'Utilisation normale',
  '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c': 'Performances élevées',
  'e9a42b02-d5df-448d-aa00-03f14749eb61': 'Performances optimales',
  'a1841308-3541-4fab-bc81-f71556f20b4a': 'Économie d’énergie',
};
const HIGH_PERFORMANCE = '8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c';

// Les réglages Windows qui coûtent du débit sans laisser de trace. Chaque conseil dit quoi
// faire ; seuls ceux qu'on peut appliquer sans droits administrateur ont un bouton.
export async function systemChecks(hardware, { vramBaselineMiB = null } = {}) {
  const checks = [];
  const profile = gpuProfile(hardware);
  for (const note of hardwareNotes(hardware, profile)) checks.push({ id: `hw-${checks.length}`, title: note.text.split(' : ')[0].split('.')[0], ...note });
  if (process.platform !== 'win32') return checks;

  const scheme = (await quiet('powercfg', ['/getactivescheme'])).match(/[0-9a-f-]{36}/i)?.[0]?.toLowerCase();
  // Seulement les plans connus pour brider : un plan personnalisé (constructeur, outil de
  // tuning) est déjà un choix de l'utilisateur.
  if (['381b4222-f694-41f0-9685-ff5bb260df2e', 'a1841308-3541-4fab-bc81-f71556f20b4a'].includes(scheme)) {
    checks.push({
      id: 'power-plan',
      level: 'warn',
      title: 'Le mode d’alimentation bride le processeur',
      text: `Windows est en « ${SCHEMES[scheme]} ». Sous une charge longue, le processeur ralentit.`,
      action: { id: 'power-plan', label: 'Passer en performances élevées' },
    });
  }

  const battery = await quiet('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-CimInstance Win32_Battery | Select-Object -First 1).BatteryStatus']);
  if (battery.trim() === '1') checks.push({ id: 'battery', level: 'warn', title: 'Sur batterie', text: 'La carte graphique tourne au ralenti. Branchez le secteur.' });

  if (hardware.primary?.vendor === 'nvidia') {
    // Débordement silencieux : depuis le pilote 536.40, Windows envoie le surplus de VRAM en
    // RAM au lieu d'échouer, et le débit est divisé par 5 à 20 sans aucun message.
    checks.push({
      id: 'sysmem-fallback',
      level: 'info',
      title: 'Empêcher le débordement silencieux en RAM',
      text: 'Un modèle trop gros échoue alors franchement au lieu de ramer en silence.',
      how: 'Panneau de configuration NVIDIA → Gérer les paramètres 3D → « CUDA – Stratégie de retour à la mémoire système » → « Préférer l’absence de retour ».',
    });
    checks.push({
      id: 'power-management',
      level: 'info',
      title: 'Garder la carte à pleine vitesse',
      text: 'Évite que la carte se mette en économie d’énergie entre deux tokens.',
      how: 'Panneau de configuration NVIDIA → Gérer les paramètres 3D → « Mode de gestion de l’alimentation » → « Privilégier les performances maximales ».',
    });
    // Ce que les autres applications occupent avant qu'on charge quoi que ce soit.
    const used = vramBaselineMiB ?? (hardware.primary.vramMiB - hardware.primary.freeMiB);
    if (used > 2500) {
      checks.push({
        id: 'vram-busy',
        level: 'warn',
        title: `${(used / 1024).toFixed(1).replace('.', ',')} Go de mémoire graphique déjà pris`,
        text: 'Un jeu, une autre IA ou un navigateur occupe la carte. Le modèle aura moins de contexte et ira moins vite.',
      });
    }
  }
  if (!hardware.gitBash) checks.push({ id: 'git-bash', level: 'warn', title: 'Git pour Windows manquant', text: 'pi agent en a besoin pour exécuter des commandes.', how: 'Installer Git pour Windows depuis git-scm.com.' });
  return checks;
}

export async function applyCheck(id) {
  if (id === 'power-plan') {
    await run('powercfg', ['/setactive', HIGH_PERFORMANCE], { windowsHide: true });
    return 'Mode performances élevées activé';
  }
  throw new Error('Action inconnue');
}
