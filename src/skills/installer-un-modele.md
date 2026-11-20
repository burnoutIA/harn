---
name: installer-un-modele
description: Installer, régler et évaluer un nouveau modèle d'IA locale depuis une adresse Hugging Face (GGUF), avec les outils Harn. À utiliser quand l'utilisateur veut essayer, ajouter, télécharger ou tester un modèle (« installe ce modèle », un lien huggingface.co, un modèle dont on parle).
---

# Installer un modèle avec Harn

Harn est le serveur d'IA locale de cette machine. Il sait télécharger, régler, mesurer et
compiler un moteur. Il ne sait pas **lire** : la fiche d'un modèle dit souvent ce que le fichier
ne dit pas (moteur à utiliser, vraie limite de contexte, réglages, pièges selon le matériel).
C'est ton travail. Sans toi, Harn installe à l'aveugle avec des valeurs par défaut.

Tes outils : `read_model_card`, `inspect_model_repo`, `install_model`, `read_install_log`,
`harn_status`, `test_intelligence`, et la recherche web ketch (`search` pour chercher, `scrape` pour lire une page, `code` pour du code open source).

## L'objectif à servir

- Contexte entre 100k et 150k tokens.
- Le modèle le plus intelligent possible.
- La vitesse la plus haute possible : sous 40 tok/s, c'est lent.
- Ne jamais sacrifier la marge mémoire de la carte graphique.

## 1. Enquêter avant de choisir

Appelle `read_model_card` et `inspect_model_repo`. Lis la fiche **en entière**, celle du modèle
de base aussi, puis note ce qui compte pour cette machine :

- **Le moteur.** Une architecture récente peut exiger un fork de llama.cpp (« needs our llama.cpp
  fork », « not supported upstream yet »). `read_model_card` liste les dépôts GitHub cités ;
  `llamaCppFork: true` en signale un. Harn le trouve et propose de le compiler : ce que tu dois
  comprendre, c'est **pour quel matériel** l'auteur l'a écrit (CUDA, Metal, CPU, ROCm), et le dire.
- **La limite réelle de contexte.** Le GGUF annonce parfois plus que ce que le modèle tient
  (« -c at most 32,768 », fenêtre glissante, contexte d'entraînement). Si la fiche donne une
  limite plus basse, elle devient `max_context`.
- **Les réglages.** Échantillonnage recommandé (température, top_p, top_k, min_p, pénalités) pour
  le raisonnement ou le code ; les niveaux de raisonnement du gabarit (`reasoning_effort` : par
  exemple disabled / low / medium / high) deviennent `reasoning_levels`.
- **Les mises en garde.** Quantification déconseillée sur GPU (« use bf16 on GPUs », NaN avec
  certaines quantifications), vision incompatible avec MTP, gabarit à corriger… Chacune devient une
  phrase de `notes`, et pèse sur ton choix.
- **Le vrai nom.** Si le nom donné par `inspect_model_repo` ressemble à un essai d'entraînement
  (« CODE_FINAL Step220… »), prends celui de la fiche pour `name`.
- **Ce que l'auteur a mesuré.** Ses benchmarks et ses vitesses, avec le matériel : ils te
  serviront à juger le résultat à l'étape 5.

Si la fiche est muette sur un point qui compte (moteur, limite de contexte), cherche avec ketch
la page du fork, son README, une discussion sur le modèle. Cite ce que tu as trouvé.

## 2. Choisir la quantification

- Respecte d'abord les mises en garde de la fiche pour ce matériel : si elle recommande BF16 sur
  GPU et que BF16 tient, prends BF16, même si une quantification plus petite a un meilleur verdict.
- Sinon, parmi les quantifications dont `verdict.fit` vaut `full` et `meetsObjective` vaut `true`,
  prends la plus grosse. Préfère « UD » ou imatrix à taille égale.
- Aucune n'atteint l'objectif : celle qui tient au moins 100k et va le plus vite, en disant ce qui
  manque. Avec une limite de contexte plus basse sur la fiche, l'objectif de 100k est hors d'atteinte :
  dis-le, et juge sur l'intelligence et la vitesse.
- Évite 1 et 2 bits quand une 3 ou 4 bits tient. `partial` (une partie sur le processeur) seulement
  si rien d'autre ne tient, en le disant.
- Vision : un `mmproj` seulement si l'auteur ne le dit pas incompatible avec MTP. Si les deux le sont,
  garde MTP et signale-le.

## 3. Demander la confirmation

En quelques lignes : le modèle, la quantification et pourquoi, la taille, le contexte et la vitesse
estimés, la licence, **le moteur** (officiel ou fork, et pour quel matériel), **ce que tu as tiré de
la fiche** (limite de contexte, réglages, mises en garde), ce que tu laisses de côté. Demande
« Je lance ? ». N'appelle `install_model` qu'après un oui explicite.

Préviens que Harn affichera une demande dans sa fenêtre, et une seconde s'il faut compiler un
moteur (code non relu, compilé et lancé isolé). Rien ne démarre avant que l'utilisateur accepte.

## 4. Installer

Appelle `install_model` avec tout ce que tu as tiré de la fiche : `sampling`, `name`,
`max_context`, `reasoning_levels`, `notes`. L'outil bloque de longues minutes (compilation éventuelle
du moteur, 10 à 20 min, puis téléchargement, banc, test d'intelligence) : c'est normal.

Lis le résultat tel qu'il est : `status: "installed"` veut dire que c'est réussi, avec `model_id`.
Un échec commence par « ÉCHEC ». Ne conclus jamais à un échec sur un résultat `installed`. Pour un
échec, appelle `read_install_log` avec l'identifiant exact (`model_id`, ou celui que l'erreur liste),
jamais un identifiant deviné, puis passe au skill `depanner-une-installation`.

## 5. Juger le résultat, ne pas seulement le recopier

Donne la vitesse, le contexte retenu, la note d'intelligence et son détail par domaine, le marqueur
de réflexion, et compare au modèle actif (`harn_status`). Puis **critique** :

- Le résultat colle-t-il à ce que l'auteur annonce, pour un matériel comparable ? Un écart net
  demande une explication.
- Le test s'est-il fait dans les conditions de la fiche ? Le banc d'intelligence tourne à
  température 0 pour tous les modèles (comparaison équitable) ; un modèle qui réfléchit peut boucler
  en glouton. Des réponses coupées (« bavard », réponses tronquées) ou un domaine à 0 sont des signaux.
- Une mise en garde de la fiche s'applique-t-elle à ce qui a été installé (quantification sur GPU,
  limite de contexte) ?

Sépare clairement ce qui est **mesuré** de ce que tu **supposes**. Si un doute peut changer la
recommandation, propose un essai précis (une autre quantification, un nouveau test) et ce qu'il
coûte, au lieu de conclure. Recommande ensuite d'adopter le modèle ou non ; l'utilisateur l'active
d'un clic dans Harn (vue Modèles).

Le carnet de la machine (`docs/machines/…`) : n'y écris que des faits mesurés, datés, sans en tirer
de conclusion que la mesure ne permet pas.

## Limites à dire franchement

- Un modèle d'images (FLUX, Qwen-Image, Z-Image…) ne passe pas par ici : skill
  `installer-un-modele-images`.
- Harn ne sert que des fichiers GGUF.
- Un dépôt à accès restreint (`gated`) ne se télécharge pas (pas de jeton Hugging Face), sauf si
  son fichier est déjà sur la machine (`alreadyOnDisk`) : `install_model` le reprend.
- Un Flash-Next (`engine: strata`) est servi par Strata, sans vision par cette voie.
- N'écris pas de script pour lire ou analyser toi-même un fichier de modèle : ils font des dizaines
  de gigaoctets, et un script maladroit remplit la mémoire de la machine. La fiche et les outils
  suffisent. Ne compile pas de moteur toi-même : Harn le fait, isolé, après accord.
- Le banc d'intelligence (paliers plancher, difficile, limite, expert, en cinq domaines) donne une
  note commune à tous les modèles : 100 pour tous les paliers limite réussis, jusqu'à 125. Ce n'est
  pas un benchmark public, mais il départage bien.
