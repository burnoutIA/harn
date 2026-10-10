// L'alimentation tient-elle les pics de la carte graphique ? « npm run power-test ».
//
// Les pics qui font couper une alimentation durent de quelques microsecondes à quelques
// millisecondes : aucun logiciel ne les voit. On reproduit donc ce qui les déclenche, des passages
// brusques du repos à la pleine charge, répétés, et on regarde si la machine tient. Pour une IA
// locale, la charge la plus dure est la lecture d'un long prompt (tous les cœurs de calcul de la
// carte) ; la génération, limitée par la mémoire, tire moins.
//
// Pendant le test, nvidia-smi relève power.draw.instant toutes les 20 ms : une borne basse des
// vrais pics, utile pour comparer deux réglages. Une coupure tue le script : un témoin dans
// data/ le signale au lancement suivant, avec ce que le journal système en dit.
//
// Options : --minutes N (30 par défaut), --force (lancer même si Harn travaille).
// Pour mesurer ce que coûte un bridage, lancer le test une fois normalement, une fois après
// « sudo nvidia-smi -lgc 210,1800 », et comparer les deux résumés (« sudo nvidia-smi -rgc » annule).
import { execFileSync, spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { internalKey } from '../src/api-keys.mjs';
import { DIRS, PORTS } from '../src/paths.mjs';

const ORIGIN = `http://127.0.0.1:${PORTS.app}`;
const MARKER = path.join(DIRS.data, 'power-test.json');
const arg = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : fallback;
};
const minutes = Number(arg('--minutes', 30));
const force = process.argv.includes('--force');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);

// ── Le test précédent s'est-il fini par une coupure ? ────────
async function previousRun() {
  const marker = JSON.parse(await readFile(MARKER, 'utf8').catch(() => 'null'));
  if (!marker) return;
  console.log(`Le test du ${new Date(marker.startedAt).toLocaleString('fr-FR')} ne s’est pas terminé normalement.`);
  try {
    const boots = execFileSync('journalctl', ['--list-boots', '--no-pager', '-o', 'json'], { encoding: 'utf8' });
    const firsts = JSON.parse(boots).map((boot) => boot.first_entry / 1000);
    if (firsts.some((first) => first > marker.startedAt)) {
      console.log('  La machine a redémarré depuis : coupure probable de l’alimentation.');
      console.log('  « journalctl -b -1 -n 20 » : un journal qui s’arrête net, sans les lignes d’arrêt, le confirme.');
    } else {
      console.log('  Pas de redémarrage depuis : le test a seulement été interrompu.');
    }
  } catch {}
  const csv = (await readFile(marker.csv, 'utf8').catch(() => '')).trim().split('\n');
  const peak = Math.max(0, ...csv.map((line) => Number(line.split(',')[1]) || 0));
  if (peak) console.log(`  Pic relevé avant l’arrêt : ${peak.toFixed(0)} W (${marker.csv}).`);
  console.log('');
  await rm(MARKER, { force: true });
}

// ── Harn ─────────────────────────────────────────────────────
async function activeModel() {
  const state = JSON.parse(await readFile(path.join(DIRS.data, 'state.json'), 'utf8'));
  if (state.active?.status !== 'ready') throw new Error('Aucun modèle chargé dans Harn : lancez Harn et attendez qu’il soit prêt.');
  return state.active.modelId;
}

async function activity() {
  const response = await fetch(`${ORIGIN}/api/activity`, { signal: AbortSignal.timeout(3000) }).catch(() => null);
  if (!response) throw new Error(`Harn ne répond pas sur ${ORIGIN}.`);
  return (await response.json()).activity ?? [];
}

let key = null;
async function complete(model, content, maxTokens) {
  const response = await fetch(`${ORIGIN}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'harn-power-test', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content }],
      max_tokens: maxTokens,
      temperature: 0,
      ignore_eos: true,
      cache_prompt: false, // chaque créneau relit tout son prompt : c'est la charge voulue
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text()).slice(0, 200)}`);
  return (await response.json()).timings ?? {};
}

// Un long prompt différent à chaque fois (le début change), d'environ `tokens` tokens.
const LINES = [
  'function update(state, event) { return { ...state, [event.key]: event.value }; }',
  'La mesure fait foi : un réglage sans banc n’est qu’une hypothèse sur cette machine.',
  'for (const item of items) if (item.ready && !item.sent) queue.push(transform(item));',
  'Le contexte long coûte de la mémoire graphique ; la marge évite le repli silencieux.',
];
function longPrompt(tokens) {
  const nonce = Math.random().toString(36).slice(2);
  const lines = [`Référence ${nonce}. Résume en une phrase le texte suivant.`];
  for (let i = 0; lines.join('\n').length < tokens * 3.6; i += 1) lines.push(`${i} ${nonce.slice(0, 4)} ${LINES[i % LINES.length]}`);
  return lines.join('\n');
}

// ── Relevé de puissance ──────────────────────────────────────
function startSampler(csvPath) {
  const out = createWriteStream(csvPath);
  out.write('time,power_w,sm_mhz,temp_c,util\n');
  const stats = { samples: 0, max: 0, over400: 0, over450: 0, maxClock: 0, maxTemp: 0, loaded: [] };
  const child = spawn('nvidia-smi', [
    '--query-gpu=timestamp,power.draw.instant,clocks.sm,temperature.gpu,utilization.gpu',
    '--format=csv,noheader,nounits', '-i', '0', '-lms', '20',
  ]);
  let buffer = '';
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const [time, power, clock, temp, util] = line.split(',').map((cell) => cell.trim());
      const watts = Number(power);
      if (!Number.isFinite(watts)) continue;
      out.write(`${time},${watts},${clock},${temp},${util}\n`);
      stats.samples += 1;
      stats.max = Math.max(stats.max, watts);
      if (watts > 400) stats.over400 += 1;
      if (watts > 450) stats.over450 += 1;
      stats.maxClock = Math.max(stats.maxClock, Number(clock) || 0);
      stats.maxTemp = Math.max(stats.maxTemp, Number(temp) || 0);
      if (Number(util) >= 80) stats.loaded.push(watts);
      cycleMax = Math.max(cycleMax, watts);
    }
  });
  child.on('error', () => console.log('nvidia-smi introuvable : pas de relevé de puissance, le test de tenue continue.'));
  return { stats, stop: () => { child.kill(); out.end(); } };
}
let cycleMax = 0;

const percentile = (values, p) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
};

// ── Le test ──────────────────────────────────────────────────
await previousRun();
const model = await activeModel();
const busy = await activity();
if (busy.length && !force) {
  console.log('Harn travaille (le test fausserait sa mesure, et inversement) :');
  for (const item of busy) console.log(`  - ${item}`);
  console.log('\nAttendez la fin, ou relancez avec --force.');
  process.exit(1);
}
key = await internalKey();

await mkdir(DIRS.logs, { recursive: true });
const csvPath = path.join(DIRS.logs, `power-${stamp()}.csv`);
const startedAt = Date.now();
await writeFile(MARKER, JSON.stringify({ startedAt, csv: csvPath, minutes }));
const sampler = startSampler(csvPath);

console.log(`Test de tenue de l’alimentation : ${minutes} min de créneaux repos / pleine charge sur ${model}.`);
console.log(`Relevé de puissance : ${csvPath}`);
console.log('Si la machine se coupe, relancez le test après le redémarrage : il dira ce qui s’est passé.\n');

let stopped = false;
process.on('SIGINT', () => { stopped = true; console.log('\nArrêt demandé : fin du créneau en cours puis résumé.'); });

// Débit de génération de référence, carte chaude (pour comparer avec un bridage).
await complete(model, 'Bonjour', 8);
const decode = await complete(model, 'Écris une longue explication du fonctionnement d’un compilateur.', 384);
console.log(`Génération : ${decode.predicted_per_second?.toFixed(1) ?? '?'} tok/s\n`);

const prefills = [];
let cycles = 0;
const deadline = startedAt + minutes * 60_000;
while (!stopped && Date.now() < deadline) {
  cycles += 1;
  cycleMax = 0;
  // Prompts de 4k à 24k tokens, un sur trois suivi d'un peu de génération ; puis 1 à 5 s de repos.
  const tokens = 4096 + Math.floor(Math.random() * 20_480);
  const timings = await complete(model, longPrompt(tokens), cycles % 3 === 0 ? 128 : 1).catch((error) => {
    console.log(`  créneau ${cycles} : ${error.message}`);
    return {};
  });
  if (timings.prompt_per_second) prefills.push(timings.prompt_per_second);
  const left = Math.max(0, Math.round((deadline - Date.now()) / 60_000));
  console.log(`créneau ${String(cycles).padStart(3)} · ${String(timings.prompt_n ?? '?').padStart(5)} tokens lus à ${timings.prompt_per_second?.toFixed(0) ?? '?'} tok/s · pic ${cycleMax.toFixed(0)} W · reste ${left} min`);
  await sleep(1000 + Math.random() * 4000);
}

sampler.stop();
await rm(MARKER, { force: true });
const { stats } = sampler;
const duration = (Date.now() - startedAt) / 60_000;
const average = (values) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);
console.log(`
── Résumé ───────────────────────────────────────────
Durée            ${duration.toFixed(1)} min, ${cycles} créneaux repos → pleine charge, sans coupure
Puissance carte  pic ${stats.max.toFixed(0)} W · 99e centile en charge ${percentile(stats.loaded, 0.99)?.toFixed(0) ?? '?'} W · moyenne en charge ${average(stats.loaded)?.toFixed(0) ?? '?'} W
Au-dessus de     400 W : ${stats.over400} relevés · 450 W : ${stats.over450} relevés (sur ${stats.samples}, un toutes les 20 ms)
Fréquence max    ${stats.maxClock} MHz · température max ${stats.maxTemp} °C
Débit            génération ${decode.predicted_per_second?.toFixed(1) ?? '?'} tok/s · lecture du prompt ${average(prefills)?.toFixed(0) ?? '?'} tok/s en moyenne

${duration >= 25
    ? 'L’alimentation a tenu toute la durée : pour cet usage, les pics ne vous concernent pas.'
    : 'Moins de 25 min : trop court pour conclure, relancez-le sans --minutes.'}
Les pics réels dépassent ces relevés (nvidia-smi ne voit pas la microseconde) : ils servent à
comparer deux réglages, pas à dimensionner une alimentation.`);
