// Le catalogue fermé : seulement des modèles UkisAI déjà validés sur le poste de référence
// (RTX 3090, voir projets/llama). Chaque entrée porte la recette qui a gagné les bancs, pas un
// réglage générique : MTP p-min 0, KV q8_0, Flash Attention, fit avec marge, vision sur CPU.

const HF = 'https://huggingface.co';

// Les chiffres mesurés viennent de projets/llama (.MEMORY.md, docs/recette-debit-llamacpp.md,
// docs/veille-2026-10-03.md). Ils valent pour une 3090 ; l'app remesure sur la machine réelle.
export const MODELS = [
  {
    id: 'swift-bonsai2-1bit',
    name: 'Swift Bonsai 2',
    variant: '1-bit · PTQ1_0',
    tagline: 'Un 27B ternaire qui tient dans 6 Go. Le meilleur choix pour une petite carte ou sans carte graphique.',
    engine: 'prism',
    kvBytesPerToken: { f16: 65_600, q8_0: 35_000, q4_0: 18_400 },
    repo: 'ukisai/Swift-Bonsai-2-GGUF',
    files: [{ name: 'Swift-Bonsai-2-PTQ1_0.gguf', bytes: 5_947_000_000 }],
    needs: { vramGiB: 0, ramGiB: 8 },
    fullGpuVramGiB: 7.5,
    contextByVram: [[0, 16384], [8, 32768]],
    quality: 70,
    paramsB: 27,
    reasoning: true,
    vision: false,
    sampling: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0, repeat_penalty: 1.0 },
    reasoningLevels: ['low', 'medium', 'xhigh'],
    evidence: null,
  },
  {
    id: 'swift-bonsai2-2bit',
    name: 'Swift Bonsai 2',
    variant: '2-bit · PQ2_0',
    tagline: 'La version 2-bit de Bonsai : plus juste que le 1-bit, toujours très légère.',
    engine: 'prism',
    kvBytesPerToken: { f16: 65_600, q8_0: 35_000, q4_0: 18_400 },
    repo: 'ukisai/Swift-Bonsai-2-GGUF',
    files: [{ name: 'Swift-Bonsai-2-PQ2_0.gguf', bytes: 7_206_000_000 }],
    needs: { vramGiB: 0, ramGiB: 12 },
    fullGpuVramGiB: 9,
    contextByVram: [[0, 16384], [10, 32768], [12, 65536]],
    quality: 74,
    paramsB: 27,
    reasoning: true,
    vision: false,
    sampling: { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0, repeat_penalty: 1.0 },
    reasoningLevels: ['low', 'medium', 'xhigh'],
    evidence: null,
  },
  {
    id: 'swift15-q27-iq2xs-mtp',
    name: 'Swift 1.5 Qwen3.8 27B',
    variant: 'GSQ-RCO · IQ2_XS · MTP',
    tagline: 'Le 27B de référence, compressé pour les cartes de 12 Go. Pense court, code bien.',
    engine: 'llama',
    kvBytesPerToken: { f16: 65_600, q8_0: 35_000, q4_0: 18_400 },
    repo: 'ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF',
    files: [{ name: 'Swift-1.5-Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp.gguf', bytes: 8_770_000_000 }],
    mmproj: { repo: 'ukisai/Swift-1.5-Qwen3.8-27B-GGUF', name: 'mmproj-Swift-1.5-Qwen3.8-27B-F16.gguf', bytes: 930_000_000 },
    dflash: { repo: 'z-lab/Qwen3.8-27B-DFlash2-GGUF', name: 'Qwen3.8-27B-DFlash2-Q4_K_M.gguf', bytes: 1_140_000_000 },
    needs: { vramGiB: 11.5, ramGiB: 16 },
    fullGpuVramGiB: 11.5,
    contextByVram: [[11.5, 32768], [14, 49152]],
    quality: 86,
    paramsB: 27,
    reasoning: true,
    vision: true,
    mtp: true,
    sampling: { temperature: 0.7, top_p: 0.95, top_k: 20, min_p: 0 },
    reasoningLevels: ['low', 'medium', 'xhigh'],
    evidence: null,
  },
  {
    id: 'swift15-q27-iq3xxs-mtp',
    name: 'Swift 1.5 Qwen3.8 27B',
    variant: 'GSQ-RCO · IQ3_XXS · MTP',
    tagline: 'Le 27B taillé pour les cartes de 16 Go : presque la qualité du IQ3_S, avec de la place pour le contexte.',
    engine: 'llama',
    kvBytesPerToken: { f16: 65_600, q8_0: 35_000, q4_0: 18_400 },
    repo: 'ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF',
    files: [{ name: 'Swift-1.5-Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp.gguf', bytes: 10_440_000_000 }],
    mmproj: { repo: 'ukisai/Swift-1.5-Qwen3.8-27B-GGUF', name: 'mmproj-Swift-1.5-Qwen3.8-27B-F16.gguf', bytes: 930_000_000 },
    dflash: { repo: 'z-lab/Qwen3.8-27B-DFlash2-GGUF', name: 'Qwen3.8-27B-DFlash2-Q4_K_M.gguf', bytes: 1_140_000_000 },
    needs: { vramGiB: 15, ramGiB: 16 },
    fullGpuVramGiB: 15,
    contextByVram: [[15, 65536], [20, 131072]],
    quality: 91,
    paramsB: 27,
    reasoning: true,
    vision: true,
    mtp: true,
    sampling: { temperature: 0.7, top_p: 0.95, top_k: 20, min_p: 0 },
    reasoningLevels: ['low', 'medium', 'xhigh'],
    evidence: null,
  },
  {
    id: 'swift15-q27-iq3s-mtp',
    name: 'Swift 1.5 Qwen3.8 27B',
    variant: 'GSQ-RCO · IQ3_S · MTP',
    tagline: 'Le meilleur 27B validé : qualité 95/100, 131k de contexte et la vision sur une carte de 24 Go.',
    engine: 'llama',
    kvBytesPerToken: { f16: 65_600, q8_0: 35_000, q4_0: 18_400 },
    repo: 'ukisai/Swift-1.5-Qwen3.8-27B-GSQ-RCO-GGUF',
    files: [{ name: 'Swift-1.5-Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf', bytes: 12_120_000_000 }],
    mmproj: { repo: 'ukisai/Swift-1.5-Qwen3.8-27B-GGUF', name: 'mmproj-Swift-1.5-Qwen3.8-27B-F16.gguf', bytes: 930_000_000 },
    dflash: { repo: 'z-lab/Qwen3.8-27B-DFlash2-GGUF', name: 'Qwen3.8-27B-DFlash2-Q4_K_M.gguf', bytes: 1_140_000_000 },
    needs: { vramGiB: 19, ramGiB: 16 },
    fullGpuVramGiB: 19,
    contextByVram: [[19, 65536], [22, 131072]],
    quality: 95,
    paramsB: 27,
    reasoning: true,
    vision: true,
    mtp: true,
    sampling: { temperature: 0.7, top_p: 0.95, top_k: 20, min_p: 0 },
    reasoningLevels: ['low', 'medium', 'xhigh'],
    evidence: { gpu: 'RTX 3090', tps4k: 82.4, tps100k: 58.7, note: 'llama.cpp b11203, MTP5 p-min 0, KV q8_0, vision CPU' },
  },
  {
    id: 'swift15-flashnext-iq2xs-strata',
    name: 'Swift 1.5 Qwen3.8 Flash-Next',
    variant: 'GSQ-RCO · IQ2_XS · Strata',
    tagline: 'Le grand MoE de 125B sur un PC de joueur, grâce à Strata. Plus rapide et plus fort que le 27B quand la RAM suit.',
    engine: 'strata',
    strataModel: 'IQ2_XS',
    repo: 'ukisai/Swift-1.5-Qwen3.8-Flash-Next-GSQ-RCO-GGUF',
    files: [
      { name: 'Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS-00001-of-00002.gguf', bytes: 39_790_000_000 },
      { name: 'Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ2_XS-00002-of-00002.gguf', bytes: 28_360_000_000 },
    ],
    needs: { vramGiB: 11.5, ramGiB: 48, nvidiaCc: 7.5 },
    contextByVram: [[11.5, 65536], [20, 131072]],
    quality: 94,
    paramsB: 125,
    sparse: true,
    reasoning: true,
    vision: true,
    sampling: { temperature: 0.7, top_p: 0.95, top_k: 20, min_p: 0 },
    reasoningLevels: ['low', 'medium', 'high'],
    evidence: { gpu: 'RTX 3090', tps4k: 70.7, note: 'Strata 0.1.27, ancien profil' },
  },
  {
    id: 'swift15-flashnext-iq3xxs-strata',
    name: 'Swift 1.5 Qwen3.8 Flash-Next',
    variant: 'GSQ-RCO · IQ3_XXS · Strata',
    tagline: 'Le plus fort du catalogue : MoE 125B en IQ3_XXS, plus de 100 tok/s sur une 3090.',
    engine: 'strata',
    strataModel: 'IQ3_XXS',
    repo: 'ukisai/Swift-1.5-Qwen3.8-Flash-Next-GSQ-RCO-GGUF',
    files: [
      { name: 'Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf', bytes: 39_790_000_000 },
      { name: 'Swift-Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00002-of-00002.gguf', bytes: 36_180_000_000 },
    ],
    needs: { vramGiB: 11.5, ramGiB: 48, nvidiaCc: 7.5 },
    contextByVram: [[15, 65536], [20, 131072]],
    quality: 97,
    paramsB: 125,
    sparse: true,
    reasoning: true,
    vision: true,
    sampling: { temperature: 0.7, top_p: 0.95, top_k: 20, min_p: 0 },
    reasoningLevels: ['low', 'medium', 'high'],
    evidence: { gpu: 'RTX 3090', tps4k: 107.5, tps24k: 117.6, tps100k: 86.2, note: 'Strata 0.1.38, --pcie-frac 0.35, KV int8' },
  },
];

export const modelById = (id) => MODELS.find((model) => model.id === id);
export const downloadUrl = (repo, file) => `${HF}/${repo}/resolve/main/${encodeURIComponent(file)}?download=true`;

// L'empreinte SHA-256 qu'Hugging Face publie pour chaque gros fichier : l'en-tête x-linked-etag
// de /resolve (sans suivre la redirection vers le CDN), sinon l'arbre du dépôt (lfs.oid).
const SHA256 = /^[0-9a-f]{64}$/i;
export async function hfSha256(repo, file) {
  const head = await fetch(downloadUrl(repo, file), { method: 'HEAD', redirect: 'manual', headers: { 'User-Agent': 'harn' } }).catch(() => null);
  const linked = head?.headers.get('x-linked-etag')?.replace(/^W\//, '').replaceAll('"', '') ?? '';
  if (SHA256.test(linked)) return linked.toLowerCase();
  const dir = file.includes('/') ? `/${file.slice(0, file.lastIndexOf('/'))}` : '';
  const tree = await fetch(`${HF}/api/models/${repo}/tree/main${dir}`, { headers: { 'User-Agent': 'harn' } }).then((r) => (r.ok ? r.json() : [])).catch(() => []);
  const oid = tree.find?.((entry) => entry.path === file)?.lfs?.oid ?? '';
  return SHA256.test(oid) ? oid.toLowerCase() : null;
}
export const totalBytes = (model) => model.files.reduce((sum, file) => sum + file.bytes, 0) + (model.mmproj?.bytes ?? 0);

export function contextFor(model, vramGiB) {
  let context = model.contextByVram[0][1];
  for (const [threshold, value] of model.contextByVram) if (vramGiB >= threshold) context = value;
  return context;
}

// Deux modèles au même nom (« Qwen3.8-27B · Q4_K_M ») : on affiche ce qui les distingue, dans
// l'ordre l'auteur du dépôt, puis les particularités (DFlash, vision, MTP) ; un numéro en dernier
// recours. Le premier arrivé garde son nom tel quel quand rien d'autre ne le distingue.
export function distinctionOf(model) {
  const key = (m) => `${m.name} · ${m.variant}`.toLowerCase();
  const twins = MODELS.filter((m) => key(m) === key(model));
  if (twins.length < 2) return null;
  const author = (m) => m.repo?.split('/')[0] ?? '';
  const traits = (m) => [m.dflash && 'DFlash', m.vision && 'vision', m.mtp && !/MTP/i.test(m.variant) && 'MTP'].filter(Boolean);
  const shared = traits(twins[0]).filter((t) => twins.every((m) => traits(m).includes(t)));
  const authorsDiffer = new Set(twins.map(author)).size > 1;
  const label = (m) => [authorsDiffer && author(m), ...traits(m).filter((t) => !shared.includes(t))].filter(Boolean).join(' · ');
  const mine = label(model);
  const same = twins.filter((m) => label(m) === mine);
  const rank = same.indexOf(model) + 1;
  return [mine, rank > 1 && String(rank)].filter(Boolean).join(' · ') || null;
}

export const variantOf = (model) => { const d = distinctionOf(model); return d ? `${model.variant} · ${d}` : model.variant; };
export const displayName = (model) => `${model.name} · ${variantOf(model)}`;
