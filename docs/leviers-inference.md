# Leviers d'inférence locale : ce qui compte, selon la carte

Ce document sert de référence à l'IA locale qui tourne dans Harn, et à quiconque règle une
machine. Il dit quels leviers comptent, pour quelle carte, et d'où vient chaque affirmation.
Il complète le fichier propre à la machine (`docs/machines/<machine>.md`), qui contient les
mesures réelles. **Quand ce document et une mesure locale se contredisent, la mesure gagne.**

Dernière mise à jour : 6 octobre 2026.

## 1. L'objectif

| Critère | Cible | Pourquoi |
|---|---|---|
| Contexte | 100k minimum, 150k maximum | un agent de code (pi) lit des fichiers, des sorties d'outils et un long historique |
| Intelligence | le modèle le plus fort que la machine porte | un modèle rapide et mauvais ne sert à rien |
| Vitesse | la plus haute possible, **40 tok/s minimum** à 100k de profondeur | en dessous, l'attente devient pénible |

Arbitrage, dans cet ordre :

1. Parmi les modèles qui tiennent 100k ET 40 tok/s, prendre le plus intelligent.
2. Si aucun ne tient les deux, prendre celui qui tient 100k et va le plus vite.
3. Ne jamais sacrifier la marge VRAM (section 3) pour gagner du contexte ou de la vitesse.

## 2. Le catalogue et son ordre

Seuls des modèles UkisAI validés (Swift : raisonnement plus court, même qualité).

| Modèle | Moteur | Taille | Qualité | Où il brille |
|---|---|---|---|---|
| Swift 1.5 Qwen3.8 Flash-Next GSQ-RCO IQ3_XXS | Strata | 76 Go (RAM + SSD) | 97 | carte NVIDIA ≥ 12 Go **et** ≥ 48 Go de RAM |
| Swift 1.5 Qwen3.8 Flash-Next GSQ-RCO IQ2_XS | Strata | 68 Go | 94 | idem, carte ou RAM plus justes |
| Swift 1.5 Qwen3.8 27B GSQ-RCO IQ3_S-mtp | llama.cpp | 12,1 Go | 95 | 24 Go de VRAM |
| Swift 1.5 Qwen3.8 27B GSQ-RCO IQ3_XXS-mtp | llama.cpp | 10,4 Go | 91 | 16-20 Go |
| Swift 1.5 Qwen3.8 27B GSQ-RCO IQ2_XS-mtp | llama.cpp | 8,8 Go | 86 | 16 Go si le contexte prime |
| Swift Bonsai 2 PQ2_0 / PTQ1_0 | fork Prism de llama.cpp | 7,2 / 5,9 Go | 74 / 70 | < 12 Go de VRAM, ou sans carte |

**Strata + Flash-Next donne de beaux résultats même sur une carte de 12 ou 16 Go**, à
condition d'avoir la RAM à côté : Strata garde les experts du MoE en RAM et met en VRAM ceux
qui servent le plus. Plus de VRAM = plus d'experts en cache = plus vite. Sur une petite carte
avec peu de RAM, la bonne réponse est souvent d'ajouter de la RAM, pas de changer de carte.

## 3. Les règles qui valent sur toutes les cartes

### Marge VRAM : au moins 1,5 Gio libre

Le levier le plus fort mesuré (×21 en lecture de prompt sur RTX 3090). Sous Windows
(pilote ≥ 536.40), quand la VRAM déborde, le pilote envoie le surplus en RAM **sans erreur** :
lecture du prompt 5 à 20 fois plus lente, GPU à 20 % d'utilisation, rien dans les journaux.

- Vérifier la VRAM libre **après** chargement, pas avant.
- Pour retrouver la marge, céder dans cet ordre : contexte jusqu'à 100k, puis KV q4_0, puis
  seulement sous 100k.
- Réglage NVIDIA à connaître : Panneau de configuration NVIDIA → Gérer les paramètres 3D →
  « CUDA – Stratégie de retour à la mémoire système » → « Préférer l'absence de retour ».
  Un modèle trop gros échoue alors franchement. *(Intégration dans Harn à étudier.)*

### Mesurer avec les compteurs du moteur

- llama.cpp : `timings` en fin de réponse (`predicted_per_second`, `prompt_per_second`,
  `draft_n`, `draft_n_accepted`) et `/slots` → `next_token[0].n_decoded` pendant la génération.
- Ne jamais compter les événements SSE : le décodage spéculatif livre plusieurs tokens par
  événement (35 tok/s affichés pour 86 réels sur 3090).
- Une variable à la fois. Glouton, graine fixe, longueur de sortie fixe, échauffement.
- Plusieurs charges : code, prose, contexte long (~20k). L'optimum MTP n'est pas le même en
  code et en prose ; le type de KV ne se départage qu'en profondeur.
- Relever l'état P pendant la génération : en P3 la mesure est fausse (pilote en économie).

### Un seul moteur sur la carte

Deux moteurs résidents se partagent la bande passante et faussent tout. Vérifier les **PID**,
pas les ports. Fermer jeux et applications 3D avant une mesure qui compte.

### Le contexte coûte en génération, pas en lecture

Avec le cache de préfixe, une conversation qui grandit par la fin ne relit que ses nouveaux
tokens. Mais chaque token généré relit tout le KV : un historique encombré coûte un
pourcentage de vitesse à chaque token. Une session neuve par tâche : 56,7 → 70 tok/s sur 3090.

### Raisonnement : `medium` par défaut

Qwen3.8 accepte `low`, `medium`, `xhigh` (défaut). `xhigh` peut épuiser le budget de sortie
en pleine réflexion et rendre une réponse vide (`finish_reason: length`, `content` vide).
Sans raisonnement, la justesse tombe (2/5 contre 5/5). Entre `low` et `medium`, aucune
hiérarchie mesurable sur des protocoles courts.

### Côté client

- Annoncer la vraie fenêtre de contexte : la réduire étrangle les réponses près du seuil de
  compaction (le résidu vaut ~8 % de la fenêtre annoncée).
- Le plafond de sortie ne doit pas dépendre de la fenêtre.
- Le client met le catalogue en cache : après un changement de modèle, relancer la session cliente.

## 4. Leviers par architecture

| Architecture | Cartes | Ce qui change |
|---|---|---|
| **Blackwell** (sm_120) | RTX 50, RTX PRO 6000 | Cœurs FP4 natifs. Le build officiel **CUDA 13** est le seul à les contenir (`120a-real`, CUDA ≥ 12.8) ; le zip CUDA 12.4 ne les a pas. NVFP4 natif depuis b8967 : lecture du prompt +43 à +68 %, génération inchangée. MTP rentable plus profond (n-max 3-4 sans seuil). |
| **Ada** (sm_89) | RTX 40 | FP8 matériel, pas de FP4 : NVFP4 n'apporte qu'un peu de bande passante. Comportement MTP proche d'Ampere ; cartes 4060/4060 Ti à faible bande passante (272-288 Go/s). |
| **Ampere** (sm_86) | RTX 30 | Poste de référence (3090). MTP5 p-min 0 pour le code, MTP3 pour la prose. DFlash2 bon sur ce poste. Sur le build officiel, KV f16 a une pente de profondeur deux fois plus faible que q8_0 (le noyau FA convertit le KV quantifié en f16). |
| **Turing** (sm_75) | RTX 20 | Code compilé en PTX (`75-virtual`) : premier lancement plus long (compilation JIT). Flash Attention à mesurer activée et désactivée. Strata supporté depuis 0.1.27. |
| **RDNA 3/4** | RX 7000, RX 9000 | Sous Windows : Vulkan ou build HIP officiel (gfx1100/gfx1200). Vulkan ~+20 % en génération, HIP meilleur en lecture du prompt. Mesurer les deux. |
| **Intel Arc** | B580, A770 | Vulkan devant SYCL en génération. |
| **Processeur seul** | — | Threads = cœurs physiques (pas les threads logiques ; sur Intel hybride, les cœurs P). Débit limité par la bande passante RAM (double canal sature vers 5 threads). |

## 5. Les leviers un par un

### Décodage spéculatif MTP (`--spec-type draft-mtp`)

La tête MTP est déjà dans les GGUF `-mtp`. Le gain dépend de la bande passante de la carte.

| Classe de carte | Point de départ | Source |
|---|---|---|
| < 500 Go/s (4060, 4060 Ti, 3060, portables) | n-max 2, `p-min` 0,6-0,75 | sudoingX/qwen38-mtp |
| 500-1300 Go/s (3090, 4090, 5070, 5080) | n-max 3-5, `p-min` 0 | poste de référence, sudoingX |
| > 1300 Go/s (5090) | n-max 3-4, `p-min` 0 ; 74 → 130-170 tok/s | sudoingX |

- `p-min 0,8` bride : +31 % à 4k et +8,6 % à 100k en le retirant (3090).
- Trop profond s'effondre (n-max 8) : on paie des vérifications inutiles.
- Le taux d'acceptation seul trompe : regarder le débit.
- `--spec-draft-sampling probabilistic` : +16 % à 100k à T=0,7, −9 % à 4k. Pas en défaut.
- Mesurer à `--parallel 1` : l'avantage disparaît vers parallel=4.

### DFlash2 (`--spec-type draft-dflash`)

Dans llama.cpp depuis b10658. Brouillon séparé (`z-lab/Qwen3.8-27B-DFlash2-GGUF`, Q4_K_M
1,1 Go). Coût mesuré sur RTX 3090 (b11430) : ~0,9 Gio de VRAM (2,7 Gio annoncés sur RTX PRO 6000).
Sur cette 3090 : meilleur en code (101 contre 93 tok/s pour MTP3), moins bon en prose (57 contre 64). Résultats très variables : ×2,3 sur RTX PRO 6000
(n-max 5 optimal), bon sur la 3090 de référence, perdant chez d'autres (−45 % sur 3090 avec
un autre modèle MoE). Ne combiner ni avec MTP ni avec un second brouillon n-gramme. À
n'essayer qu'avec de la marge VRAM. Compatibilité vision à revérifier sur chaque build.

### Type de KV (`--cache-type-k/-v`)

- Toujours K et V **du même type** (sinon l'attention repasse sur le CPU sans
  `GGML_CUDA_FA_ALL_QUANTS`).
- Coût mesuré sur Qwen3.8-27B (16 couches d'attention pleine sur 64), 160k tokens :
  f16 10,5 Go, q8_0 5,6 Go, q4_0 2,95 Go.
- Le noyau compte plus que la taille : q4_0 est plus lent que q8_0 en profondeur sur le build
  officiel. Le K quantifié coûte plus en qualité que le V.
- TurboQuant (turbo3/turbo4) : refusé dans llama.cpp principal, seulement dans des forks.

### Flash Attention (`-fa on`)

Nécessaire au KV quantifié. Activée par défaut ; à vérifier sur Turing et plus ancien.

### Vision (`--mmproj`, `--no-mmproj-offload`)

Projecteur sur CPU : ~0,9 Gio de VRAM rendus au contexte, génération identique ; seule
l'ingestion de l'image ralentit. À préférer quand la marge VRAM est juste.

### Placement (`--fit on --fit-target 1024`, `-ngl auto`)

`--fit` ajuste ce qui n'est pas fixé pour tenir en mémoire. Forcer toutes les couches
(`-ngl all`) ne rapporte rien. Le contexte, lui, est fixé : c'est la vérification de marge
qui le corrige.

### Quantification des poids

- Choisir selon la vitesse du **noyau**, pas la taille. Sous ~13 Go, rétrécir ne rapporte
  plus rien en vitesse : sur 3090, IQ3_S n'a pas battu IQ4_XS malgré un fichier plus petit
  (le noyau de déquantification annule le gain de bande passante), et IQ2 n'a pas de raison
  mesurée d'aller plus vite. Les petites quantifications servent à faire **tenir** le
  modèle et son contexte, pas à accélérer.
- `output.weight` (lm_head) est relu à chaque token et à chaque brouillon.
- NVFP4 (Blackwell) : UkisAI publie `Swift-1.5-Qwen3.8-27b-NVFP4` en safetensors ModelOpt,
  convertible avec `convert_hf_to_gguf.py --fp8-as-q8`. **Non validé** : qualité, présence de
  la tête MTP et taille réelle à vérifier.

### Builds

Mettre à jour llama.cpp rapporte peu par build (+1 à +5 %), mais certaines versions
débloquent un levier entier (CUDA graphs pour le brouillon MTP : +18 % ; NVFP4 natif).
Rebâtir les mesures après chaque mise à jour.

### Strata (Flash-Next)

| Option | Effet mesuré |
|---|---|
| `--draft-vocab fr` | réponses françaises +15 à 38 % (acceptation 0,51 → 0,60) |
| `--kv k8v4` | 3090, Coder 198k : 99 contre 85 tok/s, mêmes aiguilles |
| `--pcie-frac` | dépend du lien PCIe et du CPU. 0,35 a battu la valeur calibrée (0,00) sur 3090 |
| `--calibrate` | mesure ses réglages sur le PC (5-10 min) ; à confronter à nos propres bancs |
| `--coupled-draft` | −6 à −13 % en code à T=0,7 : non |
| version 0.1.38+ | +7 à +10 % en génération face à 0.1.27 ; ~2 Gio de VRAM en plus |

Pendant le démarrage, Strata charge 35-55 Go en RAM : le PC peut ralentir 1 à 3 minutes.

## 6. Réglages Windows

| Réglage | Effet | Où |
|---|---|---|
| Stratégie de retour à la mémoire système (CUDA) | évite le débordement silencieux en RAM | Panneau NVIDIA → Paramètres 3D |
| Mode de gestion de l'alimentation | évite la retombée en P3 entre deux tokens | Panneau NVIDIA → Paramètres 3D |
| Mode d'alimentation Windows | « Utilisation normale » bride le CPU sous charge longue | `powercfg` |
| Batterie | la carte d'un portable ralentit fortement sur batterie | secteur |
| Bureau sur la même carte | ~1 Go de VRAM pris par Windows | — |

## Sources

- Mesures du poste de référence : RTX 3090, Ryzen 7 7800X3D, 128 Go (projet Llama Control,
  `.MEMORY.md`, `docs/recette-debit-llamacpp.md`, `docs/veille-2026-10-03.md`).
- [sudoingX/qwen38-mtp](https://github.com/sudoingX/qwen38-mtp) — MTP par classe de carte.
- [FP4 in llama.cpp: NVFP4 vs MXFP4](https://insiderllm.com/guides/fp4-inference-llamacpp-nvfp4-mxfp4/)
- [Qwen3.6-27B NVFP4 sur llama.cpp](https://boredconsultant.com/2026/07/18/45-tok-s-on-a-Laptop-Getting-Qwen3-6-27B-s-NVFP4-Quants-Running-on-llama-cpp/) — coût KV par type.
- `ggml/src/ggml-cuda/CMakeLists.txt` de llama.cpp — architectures des builds officiels.
- [DFlash2 Qwen3.8 sur llama.cpp](https://github.com/lukaLLM/DFlash2_Qwen3.8_3.6_27B_LlamaCPP)
- [Spéculatif perdant sur 3090 (MoE)](https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/discussions/14)
- [Sysmem Fallback](https://runaihome.com/blog/shared-gpu-memory-slow-local-ai-sysmem-fallback-fix-2026/), [NVIDIA](https://nvidia.custhelp.com/app/answers/detail/a_id/5490/~/system-memory-fallback-for-stable-diffusion)
- [RX 9070 XT : Vulkan contre ROCm](https://localaimaster.com/blog/rx-9070-xt-local-ai)
- [Intel Arc : SYCL contre Vulkan](https://github.com/ggml-org/llama.cpp/issues/26010)
- [TurboQuant, état d'août 2026](https://sotaaz.com/post/turboquant-status-2026-en)
- [Strata, détails](https://github.com/Niko1221/Strata/blob/main/docs/DETAILS.md)
