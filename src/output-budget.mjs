// Combien de sortie donner à un modèle, et combien de place lui garantir avant que pi compacte.
// Pas de chiffre fixe : on part de ce que l'on sait de sa famille (un Qwen3.x officiel réfléchit
// longtemps, un Swift est entraîné à faire court), puis le vrai usage corrige (journal des
// requêtes de la passerelle, hors bancs de Harn) : plus longues réponses, réponses coupées.
// La sortie peut être généreuse (pi la ramène à la place qui reste) ; la place garantie, elle,
// se paie en contexte (compaction plus tôt) : elle suit ce que le modèle produit vraiment.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { DIRS } from './paths.mjs';

// A priori par style de réflexion. long : Qwen conseille jusqu'à ~80k pour les maths et le code
// difficiles. normal : 32k, l'usage courant. court : modèle sans réflexion.
const PRIOR = { long: 81920, normal: 32768, short: 16384 };
const MIN_RUNS = 30;          // en dessous, le journal ne dit pas grand-chose : l'a priori décide
const LIMITS = new Set([8192, 16384, 32768, 65536, 81920]);   // anciennes limites (journal sans « finish »)
const round = (tokens) => Math.ceil(tokens / 1024) * 1024;

export function thinkingStyle(model, iq = null) {
  if (model.thinking) return model.thinking;
  if (!model.reasoning) return 'short';
  // Le test d'intelligence a vu des réponses coupées faute de budget : il pense long.
  if (iq?.verbosity?.label === 'bavard') return 'long';
  const text = `${model.repo ?? ''} ${model.name ?? ''} ${model.profile?.arch ?? ''}`;
  if (/ukisai|swift/i.test(text)) return 'normal';      // réflexion raccourcie à l'entraînement
  if (/qwen3|qwen35/i.test(text)) return 'long';
  return 'normal';
}

// Le vrai usage par modèle : nombre de réponses, 99e centile, plus longue, et coupées à la limite.
export async function outputUsage() {
  const text = await readFile(path.join(DIRS.data, 'requests.jsonl'), 'utf8').catch(() => '');
  const by = new Map();
  for (const line of text.split('\n')) {
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    if (!r?.model || r.error || !(r.generated > 0) || /^harn-/.test(r.client ?? '')) continue;
    const entry = by.get(r.model) ?? { outputs: [], cut: [] };
    entry.outputs.push(r.generated);
    if (r.finish === 'length' || (r.finish == null && LIMITS.has(r.generated))) entry.cut.push(r.generated);
    by.set(r.model, entry);
  }
  const usage = {};
  for (const [model, { outputs, cut }] of by) {
    outputs.sort((a, b) => a - b);
    usage[model] = { runs: outputs.length, p99: outputs[Math.floor(outputs.length * 0.99)], max: outputs.at(-1), cut: cut.length, cutAt: Math.max(0, ...cut) };
  }
  return usage;
}

// maxTokens : ce que le modèle peut produire, au plus les 3/4 du contexte.
// reserve : la place qu'une réponse trouve toujours (pi compacte avant), au plus 1/3 du contexte.
export function outputBudget(model, context, usage = null, iq = null) {
  const style = thinkingStyle(model, iq);
  const prior = PRIOR[style];
  const seen = usage && usage.runs >= MIN_RUNS ? usage : null;
  // Coupé à la limite : on ne sait pas jusqu'où il serait allé, on double.
  const observed = seen ? Math.max(2 * seen.p99, 1.5 * seen.max, seen.cut ? 2 * seen.cutAt : 0) : 0;
  const maxTokens = round(Math.min(Math.max(prior, observed), (context * 3) / 4));
  // Plancher selon le style : un client qui plafonne lui-même ses réponses (4k, 8k) fait paraître
  // court un modèle qui pense long.
  const wanted = seen ? Math.max(2 * seen.p99, seen.cut ? 2 * seen.cutAt : 0, prior / 4) : prior / 2;
  const reserve = round(Math.min(wanted, context / 3, maxTokens));
  return { style, maxTokens, reserve, basis: seen ? `${seen.runs} réponses mesurées` : 'a priori' };
}
