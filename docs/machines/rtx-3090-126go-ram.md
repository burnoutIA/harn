# NVIDIA GeForce RTX 3090 · 126 Go de RAM

Carnet de cette machine. Les mesures sont réécrites par Harn après chaque banc ; l'analyse
est rédigée par l'IA locale ; les notes en bas s'accumulent au fil de l'usage. Référence
générale : [leviers d'inférence](../leviers-inference.md).

<!-- harn:mesures:début -->
## Mesures (Harn, 06/10/2026 09:33:06)

| Élément | Valeur |
|---|---|
| Carte | NVIDIA GeForce RTX 3090, 24 Go, pilote 617.14, CUDA 13.4 |
| Architecture | Ampere, ~936 Go/s de bande passante |
| Processeur | AMD Ryzen 7 7800X3D 8-Core Processor, 8 cœurs |
| RAM | 126 Go |
| VRAM prise par le reste du système | 1,3 Go |
| Moteur | CUDA 13 |

### Objectif : 100k-150k de contexte, 40 tok/s minimum

| Modèle | Intelligence /100 (banc Harn) | Verdict | Contexte | KV | Débit estimé à 100k | Mesuré ici |
|---|---|---|---|---|---|---|
| Swift Bonsai 2 1-bit · PTQ1_0 | ~70 (estimée) | compatible | 150k | q8_0 | ~85 | — |
| Swift Bonsai 2 2-bit · PQ2_0 | ~74 (estimée) | compatible | 150k | q8_0 | ~70 | — |
| Swift 1.5 Qwen3.8 27B GSQ-RCO · IQ2_XS · MTP | ~86 (estimée) | compatible | 150k | q8_0 | ~84 | — |
| Swift 1.5 Qwen3.8 27B GSQ-RCO · IQ3_XXS · MTP | ~91 (estimée) | compatible | 150k | q8_0 | ~70 | — |
| Swift 1.5 Qwen3.8 27B GSQ-RCO · IQ3_S · MTP | 97 | compatible | 150k | q8_0 | ~60 | 77 tok/s |
| Swift 1.5 Qwen3.8 Flash-Next GSQ-RCO · IQ2_XS · Strata | ~94 (estimée) | compatible | 128k | int8 | ~109 | — |
| Swift 1.5 Qwen3.8 Flash-Next GSQ-RCO · IQ3_XXS · Strata | 100 | compatible | 128k | int8 | ~85 | 90 tok/s |
| Qwen3.6-35B-A3B UD-IQ4_NL · MTP · MoE | 100 | **visé** | 150k | q8_0 | ~129 | 189 tok/s |
| Ornith-1.5-9B Q8_0 · MTP | 98 | compatible | 150k | q8_0 | ~75 | 133 tok/s |

### Banc : Swift 1.5 Qwen3.8 27B GSQ-RCO · IQ3_S · MTP (06/10/2026 00:34:16)

| Levier | Variante | Code | Texte | Contexte long | Score | VRAM libre | Retenu |
|---|---|---|---|---|---|---|---|
| Départ | 150k · KV q8_0 · MTP3 | 94 | 65 | — | 76,6 | 4,4 Go | oui |
| Spéculation MTP | 150k · KV q8_0 · MTP2 | 84 | 65 | — | 73,7 | 4,6 Go |  |
| Spéculation MTP | 150k · KV q8_0 · MTP4 | 97 | 54 | — | 69,2 | 4,3 Go |  |
| Spéculation MTP | 150k · KV q8_0 · MTP5 | 98 | 49 | — | 64,9 | 4,1 Go |  |
| DFlash2 | 150k · KV q8_0 · DFlash2 n5 | 102 | 57 | — | 72,9 | 3,6 Go |  |

Protocole : glouton (température 0), graine 42, sortie fixe de 384 tokens, un échauffement par variante, compteurs du moteur. Charges : code (~3 900 tokens de prompt), texte (prompt court), contexte long (~20 000 tokens, seulement quand le type de KV est comparé). États P relevés pendant la génération : P2.

Usage réel : 88 requêtes, 83 tok/s en moyenne.

### Banc : Qwen3.6-35B-A3B UD-IQ4_NL · MTP · MoE (06/10/2026 02:07:39)

| Levier | Variante | Code | Texte | Contexte long | Score | VRAM libre | Retenu |
|---|---|---|---|---|---|---|---|
| Départ | 150k · KV q8_0 · MTP3 | 206 | 141 | — | 167,1 | 3 Go |  |
| Spéculation MTP | 150k · KV q8_0 · MTP2 | 199 | 167 | — | 181,2 | 3 Go |  |
| Spéculation MTP | 150k · KV q8_0 · MTP4 | 217 | 131 | — | 163,2 | 2,9 Go |  |
| Spéculation MTP | 150k · KV q8_0 · MTP5 | 195 | 119 | — | 148,1 | 2,8 Go |  |
| KV en profondeur | 150k · KV q8_0 · MTP2 | 199 | 169 | 174 | 179,5 | 3 Go |  |
| KV en profondeur | 150k · KV f16 · MTP2 | 200 | 165 | 208 | 189,1 | 1,9 Go | oui |

Protocole : glouton (température 0), graine 42, sortie fixe de 384 tokens, un échauffement par variante, compteurs du moteur. Charges : code (~3 900 tokens de prompt), texte (prompt court), contexte long (~20 000 tokens, seulement quand le type de KV est comparé). États P relevés pendant la génération : P2.

Usage réel : 88 requêtes, 190 tok/s en moyenne.

### Banc : Ornith-1.5-9B Q8_0 · MTP (06/10/2026 02:56:39)

| Levier | Variante | Code | Texte | Contexte long | Score | VRAM libre | Retenu |
|---|---|---|---|---|---|---|---|
| Départ | 150k · KV q8_0 · MTP4 | 151 | 105 | — | 124 | 10,1 Go |  |
| Spéculation MTP | 150k · KV q8_0 · MTP3 | 146 | 105 | — | 121,8 | 10,1 Go |  |
| Spéculation MTP | 150k · KV q8_0 · MTP5 | 150 | 94 | — | 115,4 | 10 Go |  |
| KV en profondeur | 150k · KV q8_0 · MTP4 | 147 | 102 | 142 | 126,7 | 10,1 Go |  |
| KV en profondeur | 150k · KV f16 · MTP4 | 156 | 102 | 158 | 133,1 | 8,4 Go | oui |

Protocole : glouton (température 0), graine 42, sortie fixe de 384 tokens, un échauffement par variante, compteurs du moteur. Charges : code (~3 900 tokens de prompt), texte (prompt court), contexte long (~20 000 tokens, seulement quand le type de KV est comparé). États P relevés pendant la génération : P2.

Usage réel : 26 requêtes, 146 tok/s en moyenne.

### Banc : Swift 1.5 Qwen3.8 Flash-Next GSQ-RCO · IQ3_XXS · Strata (06/10/2026 09:30:40)

| Levier | Variante | Code | Texte | Contexte long | Score | VRAM libre | Retenu |
|---|---|---|---|---|---|---|---|
| Réglages Strata | Réglages de l’installeur | 95 | 80 | — | 86,9 | 0,4 Go |  |
| Strata | pcie-frac 0.35 | 98 | 83 | — | 90,2 | 0,4 Go | oui |

Protocole : glouton (température 0), graine 42, sortie fixe de 384 tokens, un échauffement par variante, compteurs du moteur. Charges : code (~3 900 tokens de prompt), texte (prompt court), contexte long (~20 000 tokens, seulement quand le type de KV est comparé). États P relevés pendant la génération : P2.

Usage réel : 26 requêtes, 113 tok/s en moyenne.
<!-- harn:mesures:fin -->

<!-- harn:analyse:début -->
## Analyse de l'IA locale
La machine tient l'objectif sur les trois critères avec le Qwen3.6-35B-A3B UD-IQ4_NL (100/100 d'intelligence, 150k de contexte, 189 tok/s mesurés, 190 tok/s en usage réel) ; le Swift 1.5 Qwen3.8 27B IQ3_S (97/100, 150k, 77 tok/s) et le Flash-Next IQ3_XXS Strata (100/100, 128k, 90 tok/s) sont compatibles mais moins rapides. Le Flash-Next Strata ne couvre que 128k de contexte, sous la cible de 150k, et sa marge VRAM de 0,4 Go est sous le seuil de 1,5 Go imposé par la référence.

Les mesures confirment la hiérarchie MTP attendue sur Ampere à 936 Go/s : pour le Qwen3.6-35B, MTP2 domine le score global (181,2) avec 199 tok/s en code et 167 en prose, tandis que MTP4 pique le code à 217 tok/s mais chute la prose à 131 ; MTP5 s'effondre (148,1). Pour le Swift 27B, MTP3 est le meilleur compromis (76,6) et MTP5 ne gagne que 4 tok/s en code (98) au prix de 16 tok/s en prose (49). Le KV f16 bat q8_0 en profondeur sur les deux modèles MoE/9B : Qwen3.6-35B passe de 174 à 208 tok/s en contexte long (+19 %), Ornith de 142 à 158 (+11 %), cohérent avec la note de la référence sur la pente de profondeur du noyau FA sur Ampere. DFlash2 n5 sur le Swift 27B donne 102 tok/s en code (meilleur que MTP3 à 94) mais 57 en prose (contre 65), et sa VRAM libre tombe à 3,6 Go. Sur le Flash-Next Strata, `--pcie-frac 0,35` rapporte +3,3 tok/s de score (90,2 contre 86,9) et +3 tok/s en code, +3 en prose.

**Pistes à tester (une variable par test) :**

1. **Flash-Next Strata : contexte 128k → 100k.** Gain attendu : marge VRAM de 0,4 Go à ~1,5-2 Go (libération de ~1,5-2 Go de KV), au prix d'une perte de contexte. Mesure : relancer le banc complet (code, prose, contexte long) à 100k, KV int8, pcie-frac 0,35, et relever la VRAM libre *après* chargement.
2. **Qwen3.6-35B : DFlash2 n5 en remplacement de MTP2.** Gain attendu : +5 à +10 % en code (la référence note 101 contre 93 tok/s pour MTP3 sur 3090), perte probable en prose. Mesure : banc code + prose à 150k, KV q8_0, n-max 5, un seul brouillon, relever `predicted_per_second` et la VRAM libre (coût annoncé ~0,9 Go).
3. **Flash-Next Strata : ajouter `--draft-vocab fr`.** Gain attendu : +15 à +38 % en réponses françaises (référence), sans coût VRAM. Mesure : banc prose en français à 100k, pcie-frac 0,35, comparer le score texte (83 → cible ~95-115).
4. **Qwen3.6-35B : KV q4_0 à 150k (au lieu de q8_0).** Gain attendu : libération de ~2,6 Go de VRAM (référence : 2,95 Go vs 5,6 Go pour 27B à 160k), marge passant de 3 Go à ~5,5 Go. Mesure : banc contexte long (~20k) à 150k, MTP2, comparer le débit en profondeur (174 tok/s attendu en q8_0) et la VRAM libre.
5. **Ornith 9B : MTP2 (non testé).** Gain attendu : la courbe MTP4→MTP3→MTP5 (124→121,8→115,4) suggère un optimum entre 2 et 4 ; MTP2 pourrait donner ~125-128. Mesure : banc code + prose à 150k, KV q8_0, n-max 2, p-min 0, comparer au score MTP4 (124).

**Ce qui pourrait fausser ces mesures sur cette machine :**

- **Marge VRAM du Flash-Next Strata à 0,4 Go** : sous le seuil de 1,5 Go. Le pilote 617.14 (≥ 536.40) renvoie silencieusement le surplus en RAM sans erreur, ce qui rendrait la lecture du prompt 5 à 20 fois plus lente sans trace dans les journaux. Vérifier que la stratégie CUDA est réglée sur « Préférer l'absence de retour » dans le panneau NVIDIA.
- **Échantillon faible** : 26 requêtes en usage réel pour le Flash-Next Strata et l'Ornith 9B, contre 88 pour les deux autres. La moyenne de 113 tok/s (Flash-Next) et 146 tok/s (Ornith) est peu stable.
- **Absence de mesure en contexte long pour le Swift 27B IQ3_S** : le banc ne compare pas le type de KV en profondeur, et le débit estimé à 100k (60 tok/s) n'a pas été confronté à un contexte long réel.
- **Build CUDA 13 / pilote 617.14** : très récent. La référence note que certaines versions débloquent un levier entier (CUDA graphs pour MTP : +18 %). Vérifier que le build utilisé contient bien les CUDA graphs pour le brouillon MTP, et rebâtir les mesures après toute mise à jour.
- **Un seul moteur résident** : les bancs ont été menés en P2 (bon), mais si un jeu, un navigateur GPU-accelerated ou un second moteur tourne en parallèle, la bande passante se partage et fausse tout. Vérifier les PID, pas les ports.

*Rédigé par Swift 1.5 Qwen3.8 Flash-Next GSQ-RCO · IQ3_XXS · Strata le 06/10/2026 09:33:38, à partir des mesures ci-dessus.*
<!-- harn:analyse:fin -->

## Notes au fil de l'usage

Ajouter ici, avec la date, toute observation mesurée sur cette machine (réglage essayé,
débit constaté, problème rencontré). Une note par entrée, la plus récente en haut.

- 2025-07-09 — Qwen3.6-35B-A3B (MoE 256/8, MTP) en UD-IQ4_NL (18,5 Go) : 189,1 tok/s mesurés à 150k avec KV f16 + MTP2 (préfill 2 772 tok/s), score 12/12 au test d'intelligence. L'estimation d'inspect (129 tok/s, KV q8_0) est sous-évaluée : Harn a pu garder le KV en f16 et dépasser largement l'objectif. Vision non installée (`--mmproj` incompatible avec MTP selon le README).
