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

const harmonic = (values) => values.length / values.reduce((sum, value) => sum + 1 / value, 0);

export async function measure(endpoint, modelId, { workloads = ['code', 'prose'], maxTokens = 384, onProgress = () => {} } = {}) {
  await complete(endpoint, modelId, [{ role: 'user', content: 'Bonjour' }], 16); // échauffement
  const results = [];
  const pstates = new Set();
  for (const id of workloads) {
    const workload = WORKLOADS[id];
    onProgress(workload.label);
    // L'état P ne compte que si la carte travaille vraiment (au repos elle est en P8, c'est normal).
    const watcher = setInterval(async () => { const gpu = await sampleGpu(); if (gpu && gpu.util >= 50) pstates.add(gpu.pstate); }, 1500);
    const started = Date.now();
    const answer = await complete(endpoint, modelId, workload.messages, maxTokens).finally(() => clearInterval(watcher));
    const t = answer.timings ?? {};
    const generated = t.predicted_n ?? answer.usage?.completion_tokens ?? maxTokens;
    results.push({
      workload: id,
      tps: t.predicted_per_second ?? generated / ((Date.now() - started) / 1000),
      prefillTps: t.prompt_per_second ?? null,
      promptTokens: t.prompt_n ?? answer.usage?.prompt_tokens ?? null,
      acceptance: t.draft_n ? t.draft_n_accepted / t.draft_n : null,
      estimated: !answer.timings,
    });
  }
  return {
    workloads: results,
    tps: +harmonic(results.map((r) => r.tps)).toFixed(1),
    prefillTps: results[0].prefillTps ? +results[0].prefillTps.toFixed(0) : null,
    throttled: [...pstates].some((p) => /P([3-9]|1\d)/.test(p)),
    pstates: [...pstates],
  };
}
