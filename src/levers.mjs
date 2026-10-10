// Les leviers dépendent de la carte. Ce qui a payé sur une 3090 (Ampere, 936 Go/s) ne vaut pas
// forcément pour une 5090 (Blackwell, 1,8 To/s, FP4 natif) ou une 4060 Ti (288 Go/s). Ce module
// donne, pour la machine détectée, des points de départ (a priori) et les variantes à mesurer.
// Le banc tranche toujours : un a priori n'est jamais appliqué sans mesure.
//
// Sources (octobre 2026) :
// - MTP Qwen3.8-27B par classe de carte (github.com/sudoingX/qwen38-mtp) : n-max 2 et seuil
//   p-min 0,6-0,75 sur les cartes à faible bande passante ; n-max 3-4 sans seuil sur 5090 ;
//   sur le poste de référence (3090, b11203), MTP5 p-min 0 gagne en code, MTP3 en prose.
// - Builds officiels : 120a-real (tenseurs FP4 Blackwell) compilé seulement avec CUDA ≥ 12.8,
//   donc dans le zip CUDA 13 et pas dans le zip CUDA 12.4 (ggml/src/ggml-cuda/CMakeLists.txt).
// - NVFP4 natif sm_120 depuis b8967 : lecture du prompt +43-68 %, génération inchangée.
// - DFlash2 dans llama.cpp depuis b10658 (--spec-type draft-dflash), brouillon ~1,1 Go ;
//   ~0,9 Gio de VRAM en plus mesuré sur 3090 ; ×2,3 sur RTX PRO 6000, très variable.
// - AMD sous Windows : build HIP officiel (gfx1100/gfx1200) ; Vulkan gagne en génération
//   (~+20 %), HIP en lecture du prompt. Intel Arc : Vulkan devant SYCL en génération.
// - Strata : --draft-vocab fr (réponses françaises +15-38 %), --kv k8v4 (3090, Coder 198k :
//   99 contre 85 tok/s), --pcie-frac propre au lien PCIe et au CPU.

// Bande passante mémoire (Go/s) des cartes courantes : c'est elle qui fixe le débit de
// génération et la profondeur de brouillon rentable.
const BANDWIDTH = [
  [/5090/, 1792], [/5080/, 960], [/5070 Ti/, 896], [/5070/, 672], [/5060/, 448],
  [/4090/, 1008], [/4080/, 717], [/4070 Ti SUPER/, 672], [/4070/, 504], [/4060 Ti/, 288], [/4060/, 272],
  [/3090 Ti/, 1008], [/3090/, 936], [/3080 Ti/, 912], [/3080/, 760], [/3070 Ti/, 608], [/3070|3060 Ti/, 448], [/3060/, 360],
  [/2080 Ti/, 616], [/2080/, 448], [/2070|2060 SUPER/, 448], [/2060/, 336],
  [/RTX PRO 6000/, 1792], [/A6000|RTX 6000 Ada/, 960], [/A100/, 1555], [/H100/, 3350],
  [/7900 XTX/, 960], [/7900 XT/, 800], [/7800 XT/, 624], [/7700 XT/, 432], [/9070/, 640], [/9060 XT/, 320], [/6900|6800/, 512],
  [/B580/, 456], [/A770/, 560], [/A750/, 512],
];

function archOf(gpu) {
  if (!gpu) return 'cpu';
  if (gpu.vendor === 'nvidia') {
    const cc = gpu.computeCapability ?? 0;
    if (cc >= 10) return 'blackwell';
    if (cc >= 9) return 'hopper';
    if (cc >= 8.9) return 'ada';
    if (cc >= 8) return 'ampere';
    if (cc >= 7.5) return 'turing';
    return 'legacy';
  }
  if (gpu.vendor === 'amd') return /RX 9\d{3}|R9700/.test(gpu.name) ? 'rdna4' : /RX 7\d{3}/.test(gpu.name) ? 'rdna3' : 'rdna2';
  if (gpu.vendor === 'intel') return 'intel';
  return 'other';
}

const ARCH_LABEL = {
  blackwell: 'Blackwell', hopper: 'Hopper', ada: 'Ada Lovelace', ampere: 'Ampere', turing: 'Turing', legacy: 'NVIDIA ancienne génération',
  rdna4: 'RDNA 4', rdna3: 'RDNA 3', rdna2: 'RDNA 2', intel: 'Intel Arc', other: 'GPU', cpu: 'Processeur',
};

export function gpuProfile(hardware) {
  const gpu = hardware.primary;
  const arch = archOf(gpu);
  const laptop = /laptop|mobile|max-q/i.test(gpu?.name ?? '');
  let bandwidth = BANDWIDTH.find(([pattern]) => pattern.test(gpu?.name ?? ''))?.[1] ?? null;
  // Un GPU portable a la même puce mais une mémoire nettement plus lente.
  if (bandwidth && laptop) bandwidth = Math.round(bandwidth * 0.6);
  bandwidth ??= { blackwell: 700, hopper: 2000, ada: 450, ampere: 450, turing: 400, rdna4: 600, rdna3: 600, intel: 450 }[arch] ?? 80;
  const bandwidthClass = bandwidth >= 1300 ? 'high' : bandwidth >= 500 ? 'mid' : 'low';
  return {
    arch,
    archLabel: ARCH_LABEL[arch],
    laptop,
    bandwidth,
    bandwidthClass,
    fp4: arch === 'blackwell',
    flashAttentionUncertain: arch === 'turing' || arch === 'legacy',
  };
}

// Les builds à comparer. Blackwell exige le zip CUDA 13 (le seul qui contient 120a-real).
export function backendCandidates(hardware, profile) {
  const gpu = hardware.primary;
  if (gpu?.vendor === 'nvidia') {
    const cuda = Number.parseFloat(gpu.cuda ?? '0');
    if (cuda >= 13.3) return ['cuda13'];
    if (cuda >= 12.4) return ['cuda12'];
    return ['vulkan'];
  }
  if (gpu?.vendor === 'amd' && ['rdna3', 'rdna4'].includes(profile.arch)) return ['vulkan', 'hip'];
  if (gpu && gpu.vramMiB >= 2048) return ['vulkan'];
  return ['cpu'];
}

// llamAmpere (github.com/JakeATX/llamAmpere) : fork de llama.cpp aux noyaux écrits pour les
// RTX 30 (SM86), Linux seulement, à compiler. Mesuré sur la 3090 de référence (ATX IQ4_XS-M,
// 150k) : code 98 → 111-116 tok/s, prose 67 → 63, ~3 Gio de VRAM en moins avec son KV tq5_0/turbo4.
// Proposé au banc, jamais imposé : c'est la mesure qui tranche.
export const isAmpereLinux = (hardware) => hardware?.os?.platform === 'linux' && hardware.primary?.vendor === 'nvidia' && hardware.primary.computeCapability === 8.6;
export const llamAmpereEligible = (hardware) => isAmpereLinux(hardware) && Boolean(hardware.buildTools?.ok);

// Le point de départ du décodage spéculatif MTP, puis ses voisins à mesurer.
export function mtpPlan(profile) {
  if (profile.bandwidthClass === 'low') {
    return { base: { n: 2, pMin: 0.7 }, arms: [{ n: 2, pMin: 0 }, { n: 3, pMin: 0.7 }] };
  }
  if (profile.bandwidthClass === 'high') {
    return { base: { n: 4, pMin: 0 }, arms: [{ n: 3, pMin: 0 }, { n: 5, pMin: 0 }] };
  }
  return { base: { n: 4, pMin: 0 }, arms: [{ n: 3, pMin: 0 }, { n: 5, pMin: 0 }] };
}

// DFlash2 coûte ~2,7 Gio de VRAM plus son brouillon : seulement avec de la marge.
export function dflashEligible(model, profile, headroomMiB) {
  return Boolean(model.dflash) && profile.arch !== 'cpu' && ['ampere', 'ada', 'hopper', 'blackwell'].includes(profile.arch)
    && headroomMiB !== null && headroomMiB >= 1200 + 1536;
}

// Ce qu'on peut dire de la machine sans rien mesurer, en mots simples.
export function hardwareNotes(hardware, profile) {
  const notes = [];
  const gpu = hardware.primary;
  if (profile.arch === 'blackwell') {
    const cuda = Number.parseFloat(gpu.cuda ?? '0');
    notes.push(cuda >= 13.3
      ? { level: 'info', text: 'Carte Blackwell : moteur CUDA 13 avec les cœurs FP4 natifs.' }
      : { level: 'warn', text: 'Carte Blackwell avec un pilote trop ancien pour CUDA 13 : les cœurs FP4 restent inutilisés. Mettez à jour le pilote NVIDIA.' });
  }
  if (profile.flashAttentionUncertain) notes.push({ level: 'info', text: 'Sur cette génération, la Flash Attention est mesurée activée et désactivée.' });
  if (profile.laptop) notes.push({ level: 'warn', text: 'Ordinateur portable : branchez-le sur secteur, la carte graphique ralentit fortement sur batterie.' });
  if (gpu?.vendor === 'amd') notes.push({ level: 'info', text: 'Radeon : Vulkan et HIP (ROCm) sont mesurés tous les deux ; le plus rapide est gardé.' });
  return notes;
}
