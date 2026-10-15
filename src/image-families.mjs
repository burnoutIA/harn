// Les familles de modèles d'images que stable-diffusion.cpp sait faire tourner, et ce qu'il faut à
// chacune en plus de ses poids : un décodeur (vae) et le ou les modèles qui lisent la consigne.
// Un dépôt Hugging Face ne livre en général que les poids de diffusion : Harn reconnaît la famille
// (tag base_model, nom du dépôt ou du fichier) et va chercher le reste. Recettes et réglages : la
// documentation de stable-diffusion.cpp (docs/<famille>.md) et les fiches des modèles.

// Les fichiers d'accompagnement. Les lecteurs de consigne existent en deux tailles : la grande
// (Q8_0) quand la carte a de la marge, la petite (Q4_K_M) sinon. Aucun dépôt à accès restreint.
const BIG_CARD_GIB = 12;
const llm = (repo, big, small) => ({ repo, big, small });
const ENCODERS = {
  qwen3_4b: llm('unsloth/Qwen3-4B-GGUF', 'Qwen3-4B-Q8_0.gguf', 'Qwen3-4B-Q4_K_M.gguf'),
  qwen3_4b_2507: llm('unsloth/Qwen3-4B-Instruct-2507-GGUF', 'Qwen3-4B-Instruct-2507-Q8_0.gguf', 'Qwen3-4B-Instruct-2507-Q4_K_M.gguf'),
  qwen3_8b: llm('unsloth/Qwen3-8B-GGUF', 'Qwen3-8B-Q8_0.gguf', 'Qwen3-8B-Q4_K_M.gguf'),
  qwen3vl_4b: llm('Qwen/Qwen3-VL-4B-Instruct-GGUF', 'Qwen3VL-4B-Instruct-Q8_0.gguf', 'Qwen3VL-4B-Instruct-Q4_K_M.gguf'),
  qwen3vl_8b: llm('Qwen/Qwen3-VL-8B-Instruct-GGUF', 'Qwen3VL-8B-Instruct-Q8_0.gguf', 'Qwen3VL-8B-Instruct-Q4_K_M.gguf'),
  qwen25vl_7b: llm('mradermacher/Qwen2.5-VL-7B-Instruct-GGUF', 'Qwen2.5-VL-7B-Instruct.Q8_0.gguf', 'Qwen2.5-VL-7B-Instruct.Q4_K_M.gguf'),
  mistral_24b: llm('unsloth/Mistral-Small-3.2-24B-Instruct-2506-GGUF', 'Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf', 'Mistral-Small-3.2-24B-Instruct-2506-Q4_K_M.gguf'),
  ministral_3b: llm('unsloth/Ministral-3-3B-Instruct-2512-GGUF', 'Ministral-3-3B-Instruct-2512-Q8_0.gguf', 'Ministral-3-3B-Instruct-2512-Q4_K_M.gguf'),
};
const VISION = {
  qwen3vl_4b: { repo: 'Qwen/Qwen3-VL-4B-Instruct-GGUF', name: 'mmproj-Qwen3VL-4B-Instruct-F16.gguf' },
  qwen3vl_8b: { repo: 'Qwen/Qwen3-VL-8B-Instruct-GGUF', name: 'mmproj-Qwen3VL-8B-Instruct-F16.gguf' },
  qwen25vl_7b: { repo: 'mradermacher/Qwen2.5-VL-7B-Instruct-GGUF', name: 'Qwen2.5-VL-7B-Instruct.mmproj-f16.gguf' },
};
const VAE = {
  flux1: { repo: 'Comfy-Org/z_image_turbo', name: 'split_files/vae/ae.safetensors' },
  flux2: { repo: 'Comfy-Org/flux2-klein-4B', name: 'split_files/vae/flux2-vae.safetensors' },
  qwenImage: { repo: 'Comfy-Org/Qwen-Image_ComfyUI', name: 'split_files/vae/qwen_image_vae.safetensors' },
  qwenImage21: { repo: 'Comfy-Org/Qwen-Image-2.1', name: 'vae/qwen_image_2.1_vae_bf16.safetensors' },
  wan21: { repo: 'Comfy-Org/Wan_2.1_ComfyUI_repackaged', name: 'split_files/vae/wan_2.1_vae.safetensors' },
};
const CLIP_L = { repo: 'comfyanonymous/flux_text_encoders', name: 'clip_l.safetensors' };
const T5XXL = { repo: 'comfyanonymous/flux_text_encoders', name: 't5xxl_fp16.safetensors' };

// arch : le réseau de diffusion. Un LoRA entraîné sur une famille sert à toutes celles de même
// arch (Qwen-Image 2.1 et sa version Turbo, FLUX.1 dev et schnell…).
// match : sur le texte réuni (tags base_model, nom du dépôt, chemin du fichier), en minuscules,
// « _ » et espaces changés en « - ». L'ordre compte : le plus précis d'abord.
// edit : sait retoucher une image donnée en référence (-r).
// args : les réglages d'échantillonnage recommandés (étapes, CFG, planificateur).
export const IMAGE_FAMILIES = [
  {
    id: 'qwen-image-2.1-turbo', arch: 'qwen-image-2.1', name: 'Qwen-Image 2.1 Turbo', match: /qwen-image-2[.-]?1.*turbo/,
    tagline: 'Qwen-Image 2.1 distillé : huit étapes, texte lisible dans l’image, retouche.',
    vae: VAE.qwenImage21, llm: ENCODERS.qwen3vl_8b, vision: VISION.qwen3vl_8b, edit: true,
    args: ['--sigmas', 'qwen-image-2.1-turbo', '--steps', '8', '--cfg-scale', '1.0', '--sampling-method', 'euler'],
  },
  {
    id: 'qwen-image-2.1', arch: 'qwen-image-2.1', name: 'Qwen-Image 2.1', match: /qwen-image-2[.-]?1/,
    tagline: 'Fidèle à la consigne, écrit du texte lisible dans l’image, retouche. Lent : trente étapes.',
    vae: VAE.qwenImage21, llm: ENCODERS.qwen3vl_8b, vision: VISION.qwen3vl_8b, edit: true,
    args: ['--cfg-scale', '4.0', '--sampling-method', 'euler', '--steps', '30'],
  },
  {
    id: 'qwen-image-edit-2511', arch: 'qwen-image', name: 'Qwen-Image Edit 2511', match: /qwen-image-edit-2511/,
    tagline: 'Spécialiste de la retouche : change un objet, un texte, un style dans une image donnée.',
    vae: VAE.qwenImage, llm: ENCODERS.qwen25vl_7b, vision: VISION.qwen25vl_7b, edit: true,
    args: ['--cfg-scale', '2.5', '--sampling-method', 'euler', '--flow-shift', '3', '--steps', '30', '--model-args', 'qwen_image_zero_cond_t=true'],
  },
  {
    id: 'qwen-image-edit', arch: 'qwen-image', name: 'Qwen-Image Edit', match: /qwen-image-edit/,
    tagline: 'Spécialiste de la retouche : change un objet, un texte, un style dans une image donnée.',
    vae: VAE.qwenImage, llm: ENCODERS.qwen25vl_7b, vision: VISION.qwen25vl_7b, edit: true,
    args: ['--cfg-scale', '2.5', '--sampling-method', 'euler', '--flow-shift', '3', '--steps', '30'],
  },
  {
    id: 'qwen-image', arch: 'qwen-image', name: 'Qwen-Image', match: /qwen-image(?!-layered)/,
    tagline: 'Le premier Qwen-Image : texte lisible dans l’image, scènes chargées. Lent et gros.',
    vae: VAE.qwenImage, llm: ENCODERS.qwen25vl_7b, edit: false,
    args: ['--cfg-scale', '2.5', '--sampling-method', 'euler', '--flow-shift', '3', '--steps', '30'],
  },
  {
    id: 'flux3-klein-base', arch: 'flux3-klein', name: 'FLUX.3 klein base', match: /flux[.-]?3.*klein.*base/,
    tagline: 'FLUX.3 non distillé : plus souple, vingt étapes.',
    vae: VAE.flux2, llm: ENCODERS.qwen3vl_4b, edit: true,
    args: ['--cfg-scale', '3.5', '--steps', '20', '--sampling-method', 'euler'],
  },
  {
    id: 'flux3-klein', arch: 'flux3-klein', name: 'FLUX.3 klein', match: /flux[.-]?3.*klein/,
    tagline: 'Le dernier FLUX, compact : photos, illustrations, retouche d’une image.',
    vae: VAE.flux2, llm: ENCODERS.qwen3vl_4b, edit: true,
    args: ['--cfg-scale', '1.0', '--steps', '16', '--sampling-method', 'euler'],
  },
  {
    id: 'flux2-klein-base-9b', arch: 'flux2-klein-9b', name: 'FLUX.2 klein base 9B', match: /flux[.-]?2-klein-base-9b/,
    tagline: 'FLUX.2 klein 9B non distillé : plus souple, vingt étapes.',
    vae: VAE.flux2, llm: ENCODERS.qwen3_8b, edit: true,
    args: ['--cfg-scale', '4.0', '--steps', '20'],
  },
  {
    id: 'flux2-klein-9b', arch: 'flux2-klein-9b', name: 'FLUX.2 klein 9B', match: /flux[.-]?2-klein-9b/,
    tagline: 'Rapide (quatre étapes) et plus fin que le 4B. Photos, illustrations, retouche.',
    vae: VAE.flux2, llm: ENCODERS.qwen3_8b, edit: true,
    args: ['--cfg-scale', '1.0', '--steps', '4'],
  },
  {
    id: 'flux2-klein-base-4b', arch: 'flux2-klein-4b', name: 'FLUX.2 klein base 4B', match: /flux[.-]?2-klein-base(-4b)?/,
    tagline: 'FLUX.2 klein 4B non distillé : plus souple, vingt étapes.',
    vae: VAE.flux2, llm: ENCODERS.qwen3_4b, edit: true,
    args: ['--cfg-scale', '4.0', '--steps', '20'],
  },
  {
    id: 'flux2-klein-4b', arch: 'flux2-klein-4b', name: 'FLUX.2 klein 4B', match: /flux[.-]?2-klein/,
    tagline: 'Le plus rapide : quatre étapes. Photos, illustrations, retouche d’une image.',
    vae: VAE.flux2, llm: ENCODERS.qwen3_4b, edit: true,
    args: ['--cfg-scale', '1.0', '--steps', '4'],
  },
  {
    id: 'flux2-dev', arch: 'flux2-dev', name: 'FLUX.2 dev', match: /flux[.-]?2-dev/,
    tagline: 'Le grand FLUX.2 : très fin, très lourd (lecteur de consigne de 24B).',
    vae: VAE.flux2, llm: ENCODERS.mistral_24b, edit: true,
    args: ['--cfg-scale', '1.0', '--sampling-method', 'euler', '--steps', '28'],
  },
  {
    id: 'flux1-kontext', arch: 'flux1', name: 'FLUX.1 Kontext', match: /flux[.-]?1-kontext/,
    tagline: 'FLUX.1 pour la retouche : modifie une image donnée selon la consigne.',
    vae: VAE.flux1, clipL: CLIP_L, t5xxl: T5XXL, edit: true,
    args: ['--cfg-scale', '1.0', '--sampling-method', 'euler', '--steps', '28'],
  },
  {
    id: 'flux1-schnell', arch: 'flux1', name: 'FLUX.1 schnell', match: /flux[.-]?1-schnell/,
    tagline: 'FLUX.1 distillé : quatre étapes, licence libre.',
    vae: VAE.flux1, clipL: CLIP_L, t5xxl: T5XXL, edit: false,
    args: ['--cfg-scale', '1.0', '--sampling-method', 'euler', '--steps', '4'],
  },
  {
    id: 'flux1-dev', arch: 'flux1', name: 'FLUX.1 dev', match: /flux[.-]?1-(dev|krea)/,
    tagline: 'Le FLUX.1 de référence et ses dérivés : photos réalistes, vingt étapes.',
    vae: VAE.flux1, clipL: CLIP_L, t5xxl: T5XXL, edit: false,
    args: ['--cfg-scale', '1.0', '--sampling-method', 'euler', '--steps', '20'],
  },
  {
    id: 'chroma', arch: 'chroma', name: 'Chroma', match: /(^|[^k])chroma(?!1?-radiance)/,
    tagline: 'Dérivé libre de FLUX.1 schnell, sans filtre : vingt-six étapes.',
    vae: VAE.flux1, t5xxl: T5XXL, edit: false,
    args: ['--cfg-scale', '4.0', '--sampling-method', 'euler', '--steps', '26', '--model-args', 'chroma_use_dit_mask=false'],
  },
  {
    id: 'z-image-turbo', arch: 'z-image', name: 'Z-Image Turbo', match: /z-image-turbo/,
    tagline: 'Petit et rapide (huit étapes), photoréaliste, tient sur une petite carte.',
    vae: VAE.flux1, llm: ENCODERS.qwen3_4b_2507, edit: false,
    args: ['--cfg-scale', '1.0', '--steps', '8'],
  },
  {
    id: 'z-image', arch: 'z-image', name: 'Z-Image', match: /z-image(?!-l2p)/,
    tagline: 'Z-Image non distillé : plus souple, plus lent (trente étapes).',
    vae: VAE.flux1, llm: ENCODERS.qwen3_4b_2507, edit: false,
    args: ['--cfg-scale', '4.0', '--steps', '30'],
  },
  {
    id: 'krea2-turbo', arch: 'krea2', name: 'Krea 2 Turbo', match: /krea-?2.*turbo/,
    tagline: 'Krea 2 distillé : esthétique soignée, huit étapes.',
    vae: VAE.wan21, llm: ENCODERS.qwen3vl_4b, edit: false,
    args: ['--cfg-scale', '1.0', '--steps', '8'],
  },
  {
    id: 'krea2', arch: 'krea2', name: 'Krea 2', match: /krea-?2/,
    tagline: 'Krea 2 : esthétique soignée, photos et illustrations.',
    vae: VAE.wan21, llm: ENCODERS.qwen3vl_4b, edit: false,
    args: [],
  },
  {
    id: 'ernie-image-turbo', arch: 'ernie-image', name: 'ERNIE-Image Turbo', match: /ernie-image-turbo/,
    tagline: 'ERNIE-Image distillé : huit étapes, léger.',
    vae: VAE.flux2, llm: ENCODERS.ministral_3b, edit: false,
    args: ['--cfg-scale', '1.0', '--steps', '8'],
  },
  {
    id: 'ernie-image', arch: 'ernie-image', name: 'ERNIE-Image', match: /ernie-image/,
    tagline: 'ERNIE-Image : fidèle à la consigne, trente étapes.',
    vae: VAE.flux2, llm: ENCODERS.ministral_3b, edit: false,
    args: ['--cfg-scale', '4.0', '--steps', '30'],
  },
];

export const familyById = (id) => IMAGE_FAMILIES.find((family) => family.id === id) ?? null;

// Les noms des réseaux, pour les messages.
export const ARCH_NAMES = {
  'qwen-image-2.1': 'Qwen-Image 2.1', 'qwen-image': 'Qwen-Image (2512, Edit)', 'flux3-klein': 'FLUX.3 klein',
  'flux2-klein-9b': 'FLUX.2 klein 9B', 'flux2-klein-4b': 'FLUX.2 klein 4B', 'flux2-dev': 'FLUX.2 dev', flux1: 'FLUX.1',
  chroma: 'Chroma', 'z-image': 'Z-Image', krea2: 'Krea 2', 'ernie-image': 'ERNIE-Image', sdxl: 'SDXL', sd1: 'Stable Diffusion 1.5', sd3: 'Stable Diffusion 3',
};

// Où trouver des LoRA pour un réseau : Hugging Face les range comme adaptateurs de leur modèle
// de base (tag base_model:adapter:…), Civitai par recherche.
const LORA_BASES = {
  'qwen-image-2.1': ['Qwen/Qwen-Image-2.1'],
  'qwen-image': ['Qwen/Qwen-Image', 'Qwen/Qwen-Image-2512', 'Qwen/Qwen-Image-Edit-2509'],
  'flux2-klein-4b': ['black-forest-labs/FLUX.2-klein-4B', 'black-forest-labs/FLUX.2-klein-base-4B'],
  'flux2-klein-9b': ['black-forest-labs/FLUX.2-klein-9B', 'black-forest-labs/FLUX.2-klein-base-9B'],
  'flux2-dev': ['black-forest-labs/FLUX.2-dev'],
  'flux3-klein': ['black-forest-labs/flux-3-image-klein'],
  flux1: ['black-forest-labs/FLUX.1-dev'],
  chroma: ['lodestones/Chroma', 'lodestones/Chroma1-HD'],
  'z-image': ['Tongyi-MAI/Z-Image-Turbo', 'Tongyi-MAI/Z-Image'],
  krea2: ['krea/Krea-2-Raw', 'krea/Krea-2-Turbo'],
  'ernie-image': ['baidu/ERNIE-Image', 'baidu/ERNIE-Image-Turbo'],
};
export function loraSources(arch) {
  const name = ARCH_NAMES[arch] ?? arch;
  return [
    ...(LORA_BASES[arch] ?? []).map((base) => ({ label: `Hugging Face · ${base.split('/')[1]}`, url: `https://huggingface.co/models?other=${encodeURIComponent(`base_model:adapter:${base}`)}&sort=likes` })),
    { label: 'Civitai', url: `https://civitai.com/search/models?modelType=LORA&query=${encodeURIComponent(name.replace(/\s*\(.*\)/, ''))}` },
  ];
}

// Le réseau visé par un LoRA, d'après ce que l'outil d'entraînement a écrit dans le fichier
// (ai-toolkit, kohya : ss_base_model_version, modelspec.architecture, base_model). null : inconnu.
const LORA_ARCHS = [
  [/qwen-?image-?2(\.?1)?(?!\d)/, 'qwen-image-2.1'],
  [/qwen-?image/, 'qwen-image'],
  [/flux-?\.?3/, 'flux3-klein'],
  [/flux-?\.?2.*9b|klein-?9b/, 'flux2-klein-9b'],
  [/flux-?\.?2.*klein|klein/, 'flux2-klein-4b'],
  [/flux-?\.?2/, 'flux2-dev'],
  [/chroma/, 'chroma'],
  [/flux|kontext/, 'flux1'],
  [/z-?image/, 'z-image'],
  [/krea-?2/, 'krea2'],
  [/ernie/, 'ernie-image'],
  [/sdxl|stable-diffusion-xl/, 'sdxl'],
  [/sd-?3|stable-diffusion-3/, 'sd3'],
  [/sd-?v?1|stable-diffusion-v1/, 'sd1'],
];
export function loraArchOf(metadata = {}) {
  const text = normalize(['ss_base_model_version', 'modelspec.architecture', 'ss_base_model', 'base_model', 'ss_sd_model_name']
    .map((key) => metadata[key] ?? '').join(' '));
  return LORA_ARCHS.find(([pattern]) => pattern.test(text))?.[1] ?? null;
}

const normalize = (text) => String(text).toLowerCase().replace(/[_\s]+/g, '-');

// La famille d'un fichier de poids : son chemin et le nom du dépôt d'abord (un dépôt peut livrer
// turbo et base côte à côte, et un dérivé garde rarement le nom exact de son modèle de départ),
// les tags base_model ensuite.
export function familyOf({ repo = '', file = '', baseModels = [] }) {
  const find = (text) => IMAGE_FAMILIES.find((family) => family.match.test(normalize(text))) ?? null;
  return find(`${file} ${repo}`) ?? find(baseModels.join(' '));
}

// Un dépôt de lecteur de consigne, de décodeur ou de LoRA porte souvent le nom du modèle d'images
// qu'il accompagne : ce n'est pas un modèle d'images.
export const notImageModel = (repo) => /text[-_]?encoder|(^|[-_/])(vae|lora|loras|clip|controlnet|mmproj)([-_]|$)/i.test(repo);

// Ce qui n'est pas un poids de diffusion dans un dépôt : décodeurs, lecteurs de consigne, LoRA,
// projecteurs vision, fichiers fragmentés (que sd.cpp ne sait pas réunir).
const NOT_DIFFUSION = /(^|\/)(text[-_]?encoders?|vae|loras?|clip|model[-_]patches)\/|mmproj|text[-_]?encoder|(^|[\/_-])(vae|lora|t5|umt5|clip[-_]?[lg])[-_.]|(^|[\/_-])(qwen3[-_]?(vl)?[-_]?\d|qwen2\.5|mistral|ministral)|-\d{5}-of-\d{5}\.gguf$/i;
const QUANT = /(?:^|[-_.])((?:UD-)?(?:IQ\d_[A-Z]+|Q\d_K(?:_[A-Z]+)?|Q\d_\d|Q\d_K|BF16|F16|F32))(?=\.gguf$)/i;
const FULL = /^(BF16|F16|F32)$/i;

// Les poids de diffusion d'un dépôt, regroupés par variante (même nom à la quantification près).
export function diffusionVariants(files) {
  const groups = new Map();
  for (const file of files) {
    if (!/\.gguf$/i.test(file.name) || NOT_DIFFUSION.test(file.name)) continue;
    const quant = (file.name.match(QUANT)?.[1] ?? 'GGUF').toUpperCase();
    const stem = file.name.replace(QUANT, '').replace(/\.gguf$/i, '').replace(/[-_.]+$/, '');
    const group = groups.get(stem) ?? { stem, quants: [] };
    group.quants.push({ quant, ...file });
    groups.set(stem, group);
  }
  // Les fichiers à la racine d'abord, puis les noms les plus courts : la variante principale.
  return [...groups.values()]
    .map((group) => ({ ...group, quants: group.quants.sort((a, b) => a.bytes - b.bytes) }))
    .sort((a, b) => a.stem.split('/').length - b.stem.split('/').length || a.stem.length - b.stem.length);
}

const GIB = 1024 ** 3;
// Ce qui s'ajoute aux poids sur la carte pendant le débruitage d'une image de 1024 × 1024
// (activations, avec Flash Attention et le décodage par tuiles).
const ACTIVATIONS_GIB = 2;
const MARGIN_GIB = 2;

// Les fichiers d'accompagnement pour cette carte, avec leur rôle (le drapeau de sd-cli).
export function companionsFor(family, vramGiB) {
  const out = [{ role: 'vae', ...family.vae }];
  if (family.llm) out.push({ role: 'llm', repo: family.llm.repo, name: vramGiB >= BIG_CARD_GIB ? family.llm.big : family.llm.small });
  if (family.vision) out.push({ role: 'vision', ...family.vision });
  if (family.clipL) out.push({ role: 'clip_l', ...family.clipL });
  if (family.t5xxl) out.push({ role: 't5xxl', ...family.t5xxl });
  return out.map((file) => ({ ...file, shared: true }));
}

// Chaque partie ne monte sur la carte que le temps de servir (--offload-to-cpu) : il faut que la
// plus grosse y tienne, et que toutes tiennent ensemble en mémoire vive.
export function memoryNeeds(diffusionBytes, companionBytes) {
  const biggestCompanion = Math.max(0, ...companionBytes);
  return {
    vramGiB: +Math.max(diffusionBytes / GIB + ACTIVATIONS_GIB, biggestCompanion / GIB + 1).toFixed(1),
    ramGiB: +((diffusionBytes + companionBytes.reduce((sum, b) => sum + b, 0)) / GIB + 4).toFixed(1),
  };
}

// La meilleure quantification qui tient sur la carte : la plus grosse, sans aller au-delà de Q8
// (BF16 et F16 doublent le téléchargement pour une différence invisible) sauf s'il n'y a qu'elles.
export function bestQuant(variant, vramGiB) {
  const quantized = variant.quants.filter((q) => !FULL.test(q.quant));
  const pool = quantized.length ? quantized : variant.quants;
  const fitting = pool.filter((q) => q.bytes / GIB + ACTIVATIONS_GIB + MARGIN_GIB <= vramGiB);
  return fitting.at(-1) ?? null;
}
