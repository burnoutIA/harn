// Le catalogue fermé : seulement des modèles déjà validés sur le poste de référence
// (RTX 3090, voir projets/llama) : les UkisAI, puis quelques autres passés au banc Harn. Chaque entrée porte la recette qui a gagné les bancs, pas un
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
    // Go d'experts (« arena_gb » de setup.py de Strata) : décide si le mode faible RAM suffit.
    arenaGB: 35.5,
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
    arenaGB: 42.9,
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

  {
    id: 'flashnext-coder-iq1m-strata',
    name: 'Qwen3.8 Flash-Next Coder',
    variant: 'GSQ-RCO · IQ1_M · Strata',
    tagline: 'Le grand MoE réduit au code par ISTA-DASLab (la moitié des experts) : tient avec 32 Go de RAM. Plus faible hors du code.',
    engine: 'strata',
    strataFamily: 'coder',
    strataModel: 'IQ1_M',
    arenaGB: 23.4,
    repo: 'ISTA-DASLab/Qwen3.8-Flash-Next-GSQ-RCO-Coder-GGUF',
    files: [
      { name: 'IQ1_M/Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00001-of-00002.gguf', bytes: 29_608_446_496, sha256: 'e11083ba855e7666b48ea3f2db6a9c3a20c18751a012cc24f948de91b7087fad' },
      { name: 'IQ1_M/Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00002-of-00002.gguf', bytes: 28_800_138_432, sha256: '316b46f3a2dbd68c900f43136ab9449f9dcc3725dfd8c794847c204bc161e113' },
    ],
    needs: { vramGiB: 11.5, ramGiB: 32, nvidiaCc: 7.5 },
    contextByVram: [[11.5, 65536], [20, 131072]],
    // 91 % du score SWE-bench Verified du modèle complet (chiffre des auteurs) ; en dessous ailleurs.
    quality: 88,
    paramsB: 65,
    sparse: true,
    reasoning: true,
    vision: true,
    sampling: { temperature: 0.7, top_p: 0.95, top_k: 20, min_p: 0 },
    reasoningLevels: ['low', 'medium', 'high'],
    evidence: { gpu: 'RTX 5070', tps4k: 55, note: 'README Strata (moteur 0.1.26, 64 Go de RAM), pas encore mesuré par Harn' },
  },

  // ── Hors UkisAI, validés sur le poste de référence (banc Harn v3, RTX 3090) ──
  {
    id: 'qwen3-8-27b-gguf-ud-q4-k-m',
    name: 'Qwen3.8-27B',
    variant: 'UD-Q4_K_M · MTP',
    tagline: 'Le 27B officiel de Qwen, quantifié par Unsloth. La référence sans retouche, vision comprise.',
    engine: 'llama',
    repo: 'unsloth/Qwen3.8-27B-GGUF',
    files: [{ name: 'Qwen3.8-27B-UD-Q4_K_M.gguf', bytes: 16_464_440_224, sha256: '322e194ff79741c7baa497c240f677f54b201b0efab44ca8e50f122b39123482' }],
    mmproj: { repo: 'unsloth/Qwen3.8-27B-GGUF', name: 'mmproj-F16.gguf', bytes: 927_607_488, sha256: 'cbb841a9ee0636b2ec172f5bb8df2ea8dfeb01e90fe7c6126581d662a0b4e43e' },
    kvBytesPerToken: { f16: 69_632, q8_0: 36_992, q4_0: 19_584 },
    needs: { vramGiB: 0, ramGiB: 16 },
    fullGpuVramGiB: 19.1,
    contextByVram: [[0, 32768]],
    quality: 95,
    paramsB: 27,
    reasoning: true,
    vision: true,
    mtp: true,
    moe: null,
    sampling: { temperature: 1, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0, repeat_penalty: 1 },
    reasoningLevels: ['low', 'medium', 'xhigh'],
    evidence: { gpu: 'RTX 3090', tps128k: 70.7, note: 'banc Harn : 128k · KV q8_0 · MTP3, intelligence 100' },
  },
  {
    // Le même 27B, servi par HyperQwen (vLLM 0.31 patché par syv-ai pour les cartes de 24 Go) :
    // W4A16 AutoRound, KV int8 lu par pthfa, et l'anticipation retenue au banc : DFlash2 quand la
    // carte est libre, sinon MTP avec un vocabulaire de brouillon recompté en français
    // (src/assets/hyperqwen-draft-vocab-fr.json : +24 % sur des réponses françaises).
    id: 'qwen3-8-27b-hyperqwen',
    name: 'Qwen3.8-27B',
    variant: 'W4A16 · HyperQwen',
    tagline: 'Le 27B officiel servi par HyperQwen (vLLM patché pour la 3090) : 131k de contexte, une centaine de tok/s en français.',
    engine: 'hyperqwen',
    repo: 'dbirks/Qwen3.8-27B-W4A16-AutoRound',
    // Pas de fichier unique : les poids (19,5 Go) et l'environnement Python de vLLM (~20 Go),
    // installés par installHyperQwen. Ce total sert au contrôle de place sur le disque.
    files: [{ name: 'Qwen3.8-27B-W4A16-AutoRound', bytes: 42_000_000_000 }],
    needs: { vramGiB: 23, ramGiB: 32, nvidiaCc: 8.6 },
    contextByVram: [[23, 131072]],
    quality: 95,
    paramsB: 27,
    reasoning: true,
    // La vision désactive pthfa, qui fait la vitesse en contexte long : servi sans.
    vision: false,
    moe: null,
    sampling: { temperature: 1, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 0 },
    reasoningLevels: ['low', 'medium', 'xhigh'],
    evidence: { gpu: 'RTX 3090', tps4k: 99.4, tps128k: 68.4, note: 'HyperQwen ce9615c, MTP CTX=long 131k, KV int8 pthfa, brouillon FR' },
  },
  {
    // La pile gagnante du Fast Gemma Challenge (gemma-slayer, installGemmaChallenge), servie telle
    // quelle pour comparer la carte à l'A10G du challenge. Taillée pour sa métrique : 5 couches
    // retirées, lm_head réduit à 12k tokens choisis sur des prompts anglais, fenêtre glissante 188.
    // En génération libre le français déraille (mots inventés, boucles) : un banc, pas un assistant.
    id: 'gemma-4-e4b-challenge',
    name: 'Gemma 4 E4B',
    variant: 'Fast Gemma Challenge · vLLM',
    tagline: 'La pile gagnante du Fast Gemma Challenge (511 tok/s vérifiés sur A10G), servie telle quelle : ~700 tok/s sur une 3090, 4k de contexte, qualité dégradée.',
    engine: 'gemma-challenge',
    challengeStack: 'submission',
    repo: 'google/gemma-4-E4B-it',
    // Les poids réduits (8,5 Go), le brouillon (0,2 Go) et l'environnement Python de vLLM (~11 Go),
    // plus le bake d'origine le temps de la réduction : le total sert au contrôle de place.
    files: [{ name: 'osoi5-12k', bytes: 29_000_000_000 }],
    needs: { vramGiB: 23, ramGiB: 16, nvidiaCc: 8.6 },
    contextByVram: [[23, 4096]],
    quality: 25,
    paramsB: 8,
    reasoning: false,
    // La soumission garde les encodeurs image et audio chargés, mais rien n'est mesuré ici avec eux.
    vision: false,
    moe: null,
    // Le challenge impose le décodage glouton ; le serveur le prend par défaut.
    sampling: { temperature: 0, top_p: 1, top_k: 0, min_p: 0 },
    evidence: { gpu: 'RTX 3090', tps4k: 702, note: 'banc du challenge (128 prompts publics, 512 tokens, une requête à la fois) : 693 / 708 / 706 tok/s, PPL 2,3932 (A10G : ~507, PPL 2,3930)' },
  },
  {
    // Le meilleur du challenge sans sa casse : la boucle MTP K=7 en un seul graphe CUDA, le split-KV
    // en vérification et l'échauffement de la soumission gemma-slayer, sur le checkpoint QAT W4A16
    // officiel complet (42 couches, vocabulaire entier) et le brouillon de Google, à 131k.
    // 3090, réponses en français : 283 tok/s en glouton, 235 en échantillonnage (vLLM seul : 266 et
    // 211), PPL 2,005 contre 2,032 pour vLLM seul. Outils, vision et flux vérifiés.
    id: 'gemma-4-e4b-qat-vllm',
    name: 'Gemma 4 E4B',
    variant: 'QAT W4A16 · MTP · vLLM',
    tagline: 'Le petit Gemma 4 officiel avec les accélérations sans perte du Fast Gemma Challenge : 131k de contexte, ~280 tok/s en français.',
    engine: 'gemma-challenge',
    challengeStack: 'qat',
    repo: 'google/gemma-4-E4B-it-qat-w4a16-ct',
    // Les poids (11,5 Go), le brouillon (0,2 Go) et l'environnement Python de vLLM (~11 Go), partagé
    // avec la fiche du challenge : le total sert au contrôle de place sur le disque.
    files: [{ name: 'qat-w4a16', bytes: 23_000_000_000 }],
    needs: { vramGiB: 23, ramGiB: 16, nvidiaCc: 8.6 },
    contextByVram: [[23, 131072]],
    // Banc d'intelligence Harn sur la 3090 : 85 (Qwen3.8-27B : 100).
    quality: 85,
    paramsB: 8,
    reasoning: false,
    vision: true,
    moe: null,
    // Le generation_config.json de Google, que le serveur applique.
    sampling: { temperature: 1, top_p: 0.95, top_k: 64, min_p: 0 },
    evidence: { gpu: 'RTX 3090', tps4k: 298, tps128k: 129, note: 'banc Harn 298 tok/s (code 436, texte 227), 252 à 34k ; 129 tok/s après 92k de prompt (lu à 3 284 tok/s) ; intelligence 85' },
  },
  {
    id: 'qwen3-6-35b-a3b-mtp-gguf-ud-iq4-nl',
    name: 'Qwen3.6-35B-A3B',
    variant: 'UD-IQ4_NL · MTP · MoE',
    tagline: 'Le MoE 35B de Qwen (3B actifs) : moins fin que les 27B, mais près de 190 tok/s sur une 3090.',
    engine: 'llama',
    repo: 'unsloth/Qwen3.6-35B-A3B-MTP-GGUF',
    files: [{ name: 'Qwen3.6-35B-A3B-UD-IQ4_NL.gguf', bytes: 18_536_192_288 }],
    kvBytesPerToken: { f16: 22_528, q8_0: 11_968, q4_0: 6_336 },
    needs: { vramGiB: 0, ramGiB: 17 },
    fullGpuVramGiB: 21.1,
    contextByVram: [[0, 32768]],
    quality: 76,
    paramsB: 35,
    reasoning: true,
    vision: false,
    mtp: true,
    moe: { experts: 256, used: 8 },
    sampling: { temperature: 1, top_p: 0.95, top_k: 20, min_p: 0, presence_penalty: 1.5, repeat_penalty: 1 },
    reasoningLevels: ['low', 'medium', 'xhigh'],
    evidence: { gpu: 'RTX 3090', tps150k: 189.1, note: 'banc Harn : 150k · KV f16 · MTP2, intelligence 76' },
  },
  {
    id: 'ornith-1-5-9b-gguf-q8-0',
    name: 'Ornith-1.5-9B',
    variant: 'Q8_0 · MTP',
    tagline: 'Un 9B étonnamment juste pour sa taille : rapide, léger, 150k de contexte sur une carte de 16 Go.',
    engine: 'llama',
    repo: 'ornith-ai/Ornith-1.5-9B-GGUF',
    files: [{ name: 'Ornith-1.5-9B-Q8_0.gguf', bytes: 9_786_060_384 }],
    kvBytesPerToken: { f16: 36_864, q8_0: 19_584, q4_0: 10_368 },
    needs: { vramGiB: 0, ramGiB: 13 },
    fullGpuVramGiB: 12.9,
    contextByVram: [[0, 32768]],
    quality: 87,
    paramsB: 9,
    reasoning: true,
    vision: false,
    mtp: true,
    moe: null,
    sampling: { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0 },
    reasoningLevels: ['low', 'medium', 'xhigh'],
    evidence: { gpu: 'RTX 3090', tps150k: 133.1, note: 'banc Harn : 150k · KV f16 · MTP4, intelligence 87' },
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
// Strata, HyperQwen et la pile du Gemma Challenge se lancent par leurs propres scripts, avec leurs
// propres réglages : ni recette llama-server, ni repli sur moins de contexte au chargement.
export const ownLauncher = (model) => ['strata', 'hyperqwen', 'gemma-challenge'].includes(model.engine);
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
