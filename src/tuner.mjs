import { engineHeaders } from './engine.mjs';
import { sampleGpu } from './hardware.mjs';

// La mesure d'une variante déjà chargée. Règles du poste de référence :
// - plusieurs charges et leur moyenne harmonique : l'optimum MTP n'est pas le même en code et
//   en prose, et le type de KV ne se départage qu'en profondeur (pente f16 deux fois plus
//   faible que q8_0 sur le build officiel) ;
// - les compteurs du moteur (timings), jamais le comptage des événements SSE ;
// - une passe d'échauffement, glouton, graine fixe, longueur de sortie fixe ;
// - l'état P relevé pendant la génération : en P3 la mesure est fausse.

export const HEADROOM_MIN_MIB = 1536;

function codeBlocks(count) {
  const blocks = [];
  for (let i = 0; i < count; i += 1) {
    blocks.push(`export interface Order${i} { id: string; customer: string; items: Array<{ sku: string; qty: number; price: number }>; status: 'new' | 'paid' | 'shipped'; createdAt: Date }
export function total${i}(order: Order${i}): number {
  return order.items.reduce((sum, item) => sum + item.qty * item.price, 0);
}
export function isLate${i}(order: Order${i}, now: Date): boolean {
  const days = (now.getTime() - order.createdAt.getTime()) / 86_400_000;
  return order.status !== 'shipped' && days > ${3 + (i % 5)};
}`);
  }
  return blocks.join('\n\n');
}

const ASK_CODE = 'Écris un module complet qui regroupe ces commandes par client, calcule les totaux, détecte les retards et exporte un rapport JSON, avec tests unitaires.';

export const WORKLOADS = {
  code: {
    label: 'Code',
    messages: [
      { role: 'system', content: 'Tu es un développeur TypeScript senior. Réponds uniquement avec du code.' },
      { role: 'user', content: `${codeBlocks(24)}\n\n${ASK_CODE}` },
    ],
  },
  prose: {
    label: 'Texte',
    messages: [{ role: 'user', content: 'Explique en détail, pour un public non technique, comment une IA locale génère du texte mot après mot, ce qui la rend rapide ou lente sur un ordinateur, et comment choisir un modèle. Fais un texte long et structuré.' }],
  },
  // ~32k tokens lus puis une réponse courte : la charge d'un agent dont la conversation grossit.
  // C'est là que certains modèles s'effondrent (Xing4 : 99 tok/s à vide, 48 à 55k).
  depth: {
    label: 'Profondeur',
    maxTokens: 128,
    messages: [
      { role: 'system', content: 'Tu es un développeur TypeScript senior. Réponds uniquement avec du code.' },
      { role: 'user', content: `${codeBlocks(208)}\n\n${ASK_CODE}` },
    ],
  },
  // ~20k tokens de contexte : là où la pente de l'attention sur le KV se voit.
  deep: {
    label: 'Contexte long',
    messages: [
      { role: 'system', content: 'Tu es un développeur TypeScript senior. Réponds uniquement avec du code.' },
      { role: 'user', content: `${codeBlocks(120)}\n\n${ASK_CODE}` },
    ],
  },
};

async function complete(endpoint, model, messages, maxTokens) {
  const response = await fetch(`${endpoint}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...engineHeaders() },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature: 0,
      seed: 42,
      ignore_eos: true,
      chat_template_kwargs: { enable_thinking: false },
    }),
  });
  if (!response.ok) throw new Error(`Banc : HTTP ${response.status} ${await response.text().catch(() => '')}`.slice(0, 300));
  return response.json();
}

// Moyenne harmonique pondérée : le temps total pour produire chaque charge selon son poids.
export function weightedHarmonic(results, weights = {}) {
  const w = (r) => weights[r.workload] ?? 1;
  return results.reduce((sum, r) => sum + w(r), 0) / results.reduce((sum, r) => sum + w(r) / r.tps, 0);
}

// Ce que l'utilisateur fait surtout : la moyenne du banc pèse code et texte en conséquence. La
// profondeur compte toujours (la charge d'un agent dont la conversation grossit).
export const USAGE_WEIGHTS = {
  code: { code: 0.7, prose: 0.3, depth: 0.5, deep: 0.5 },
  balanced: { code: 0.5, prose: 0.5, depth: 0.5, deep: 0.5 },
  prose: { code: 0.3, prose: 0.7, depth: 0.5, deep: 0.5 },
};

// Le bruit d'une mesure : la carte varie de quelques pour cent d'une session à l'autre (MTP2 et
// MTP3 ont échangé leur place entre deux bancs, à 2 % près). En dessous, on garde ce qu'on a.
export const NOISE = 0.03;
export function isBetter(candidate, current) {
  if (!candidate.ok || candidate.error) return false;
  if (!current || current.error) return true;
  const margin = Math.max(NOISE, candidate.spread ?? 0, current.spread ?? 0);
  return candidate.tps > current.tps * (1 + margin);
}

// runs : chaque charge mesurée plusieurs fois, la moyenne gardée et l'écart noté (la profondeur,
// longue à lire, une seule fois).
export async function measure(endpoint, modelId, { workloads = ['code', 'prose'], maxTokens = 384, runs = 2, weights = {}, onProgress = () => {} } = {}) {
  await complete(endpoint, modelId, [{ role: 'user', content: 'Bonjour' }], 16); // échauffement
  const results = [];
  const pstates = new Set();
  for (const id of workloads) {
    const workload = WORKLOADS[id];
    onProgress(workload.label);
    // L'état P ne compte que si la carte travaille vraiment (au repos elle est en P8, c'est normal).
    const watcher = setInterval(async () => { const gpu = await sampleGpu(); if (gpu && gpu.util >= 50) pstates.add(gpu.pstate); }, 1500);
    const samples = [];
    try {
      for (let run = 0; run < (id === 'depth' ? 1 : runs); run += 1) {
        const started = Date.now();
        const answer = await complete(endpoint, modelId, workload.messages, workload.maxTokens ?? maxTokens);
        const t = answer.timings ?? {};
        const generated = t.predicted_n ?? answer.usage?.completion_tokens ?? workload.maxTokens ?? maxTokens;
        samples.push({
          tps: t.predicted_per_second ?? generated / ((Date.now() - started) / 1000),
          // La lecture du prompt se juge au premier passage : ensuite le cache de prompt la court-circuite.
          prefillTps: t.prompt_per_second ?? null,
          promptTokens: t.prompt_n ?? answer.usage?.prompt_tokens ?? null,
          acceptance: t.draft_n ? t.draft_n_accepted / t.draft_n : null,
          estimated: !answer.timings,
        });
      }
    } finally { clearInterval(watcher); }
    const tps = samples.reduce((sum, s) => sum + s.tps, 0) / samples.length;
    results.push({
      ...samples[0],
      workload: id,
      tps,
      spread: samples.length > 1 ? (Math.max(...samples.map((s) => s.tps)) - Math.min(...samples.map((s) => s.tps))) / tps : 0,
    });
  }
  return {
    workloads: results,
    tps: +weightedHarmonic(results, weights).toFixed(1),
    spread: Math.max(...results.map((r) => r.spread)),
    prefillTps: results[0].prefillTps ? +results[0].prefillTps.toFixed(0) : null,
    throttled: [...pstates].some((p) => /P([3-9]|1\d)/.test(p)),
    pstates: [...pstates],
  };
}
