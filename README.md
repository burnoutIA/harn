# Harn

Une IA locale qui tourne bien, sans rien régler. Double-cliquer sur `Harn-install.cmd` :
l'application analyse la machine, installe le bon moteur et le meilleur modèle validé,
le règle et le mesure, puis installe **pi agent** déjà branché dessus.

## Ce qui se passe au premier démarrage

| Étape | Détail |
|---|---|
| Analyse | Carte graphique (VRAM, version CUDA du pilote, génération), RAM, cœurs, disque, Git Bash |
| Moteur | Dernier build llama.cpp officiel (CUDA 13, CUDA 12.4, Vulkan ou CPU selon le pilote) ; fork Prism pour Bonsai |
| Modèle | Le meilleur modèle UkisAI qui tient entièrement sur la carte, téléchargement reprenable |
| pi agent | `@earendil-works/pi-coding-agent` dans `runtime/pi`, configuré dans `data/pi-agent` |
| Chargement | Contexte réduit tant que la VRAM libre reste sous 1,5 Gio |
| Réglage | Banc code + texte sur 2 ou 3 variantes ; la plus rapide reste chargée |

Les trois longues attentes (moteur, poids, pi) se font en parallèle.

## Choix du modèle

| Machine | Premier modèle | Proposé ensuite |
|---|---|---|
| Moins de 8 Go de VRAM, ou sans carte graphique | Swift Bonsai 2 1-bit (Prism) | — |
| 9 à 11 Go | Swift Bonsai 2 2-bit | — |
| 12 Go | Swift 1.5 Qwen3.8 27B GSQ-RCO IQ2_XS-mtp | Flash-Next Strata IQ2_XS si 48 Go de RAM |
| 16 Go | 27B GSQ-RCO IQ3_XXS-mtp | Flash-Next Strata IQ3_XXS si 60 Go de RAM |
| 20 Go et plus | 27B GSQ-RCO IQ3_S-mtp, 131k | Flash-Next Strata IQ3_XXS si 60 Go de RAM |

Flash-Next (68 à 76 Go) n'est jamais téléchargé d'office : il est proposé une fois que la
machine a déjà une IA qui marche, et il s'installe pendant que le premier modèle continue de servir.

## Les réglages : des a priori par carte, puis la mesure

Ce qui paie sur une 3090 ne paie pas forcément ailleurs. `src/levers.mjs` classe la carte
(architecture, bande passante mémoire) et en tire des points de départ. Le banc les remet
ensuite en cause, une variable à la fois, sur la machine réelle.

| Levier | A priori | Ce que le banc compare |
|---|---|---|
| Spéculation MTP | n-max 2 et p-min 0,7 sous 500 Go/s ; n-max 4 sans seuil au-delà | les voisins (n ± 1, avec ou sans seuil) |
| DFlash2 | seulement sur NVIDIA Ampere ou plus récente, avec plus de 4,5 Gio libres | brouillon z-lab Q4_K_M (1,1 Go) contre le meilleur MTP |
| Type de KV | q8_0 | f16 avec plus de 4 Gio libres, jugé sur une charge de ~20k tokens |
| Flash Attention | activée | désactivée sur Turing et plus ancien |
| Backend | CUDA 13 si le pilote le permet (seul build avec les cœurs FP4 de Blackwell) | Radeon RDNA 3/4 : Vulkan contre HIP |
| Strata | réglages de l'installeur | `--draft-vocab fr`, `--kv k8v4`, `--pcie-frac 0.35` |

Règles qui valent partout :

- **Marge VRAM ≥ 1,5 Gio** (`--fit on --fit-target 1024`, contrôle après chargement). Sans
  elle, le préfill retombe sur la mémoire hôte, sans erreur. Une variante qui l'entame est
  écartée, même si elle va plus vite.
- **Vision sur CPU** (`--no-mmproj-offload`) : environ 0,9 Gio rendu au contexte.
- **Raisonnement `medium` par défaut**, car `xhigh` vide les réponses sur les runs longs.
- **Débit lu dans les compteurs du moteur** (`/slots`, `timings`).
- **Fenêtre annoncée à pi = la vraie fenêtre**, plafond de sortie indépendant.
- **Un seul moteur sur la carte**, avec reprise des orphelins par PID.

Réglages Windows signalés dans l'interface : mode d'alimentation (corrigeable en un clic),
batterie, VRAM déjà occupée, « CUDA – Stratégie de retour à la mémoire système » et
« Mode de gestion de l'alimentation » NVIDIA (à régler dans le panneau NVIDIA).

Pas encore intégré : **NVFP4 sur Blackwell**. UkisAI publie `Swift-1.5-Qwen3.8-27b-NVFP4`
(safetensors ModelOpt), convertible en GGUF avec `convert_hf_to_gguf.py --fp8-as-q8`. Le
noyau sm_120 natif (b8967+) accélère la lecture du prompt de 43 à 68 %, la génération ne
change pas. Il reste à valider la qualité, la présence de la tête MTP et la taille réelle.

## Documentation pour l'IA locale

- [docs/leviers-inference.md](docs/leviers-inference.md) : la référence des leviers par carte, avec ses sources.
- `docs/machines/<carte>-<ram>.md` : le carnet de chaque machine. Harn y réécrit les mesures
  après chaque banc, l'IA locale y rédige son analyse (objectif, leviers, pistes à tester),
  et pi agent est invité, par son `AGENTS.md`, à y ajouter des notes datées.

## Utilisation

- Interface : <http://127.0.0.1:4747>
- API OpenAI : `http://127.0.0.1:4747/v1`. Si le champ `model` désigne un autre modèle installé,
  celui-ci est chargé.

## Sécurité de l'inférence

- **Clés API** (Machine → Brancher une application, ou `npm run keys -- create "Portable — Copilot"`,
  `list`, `revoke <id>`). Tant qu'aucune clé n'existe, `/v1` répond sans clé, à cette machine
  seulement. La première clé ferme la porte, en local aussi. Seule l'empreinte SHA-256 est gardée
  (`data/api-keys.json`). pi agent, le banc et l'analyse utilisent la clé interne de Harn
  (`data/harn.key`), qui ne compte pas comme une clé créée et n'ouvre jamais le réseau.
- **Clé dans l'URL** pour les clients qui ne laissent pas saisir de clé (Copilot) :
  `http://127.0.0.1:4747/k/<clé>/v1`. L'adresse peut finir dans les journaux du client.
- **Réseau local** : un port à part (`4748`, `HARN_LAN_PORT`) qui ne sert que `/v1`, avec une clé
  toujours exigée. L'interface et l'API de contrôle restent sur la boucle locale.
- **Moteur** : llama-server reçoit une clé neuve à chaque lancement de Harn (`--api-key-file`).
  Sans elle, n'importe quelle page web ouverte dans le navigateur pouvait l'interroger et lire
  `/slots`.
- **Navigateur** : Harn ne répond qu'aux noms `127.0.0.1`, `localhost` (parade au DNS rebinding),
  et refuse un POST sur `/v1` qui n'est pas du JSON (seule forme qu'une page web envoie sans
  permission).
- **Ce que pi demande** (installer depuis Hugging Face, relancer une installation) s'affiche dans
  la fenêtre de Harn et n'est lancé qu'après un clic sur Accepter.
- **Intégrité** : chaque GGUF est vérifié contre l'empreinte SHA-256 publiée par Hugging Face
  (copies locales réutilisées comprises), les binaires contre le digest des releases GitHub quand
  il existe. Strata est figé sur un commit (`STRATA_COMMIT` dans `src/runtimes.mjs`).
- `node src/main.mjs --no-open --no-setup` pour développer sans lancer l'installation.
- `npm run check` pour les tests.

### Lancer, relancer, arrêter

- `Harn-start.cmd` (double-clic) : lance Harn, ou le relance s'il tourne déjà, et ouvre la fenêtre.
  `Harn-install.cmd` reste le premier lancement : il installe Node.js s'il manque.
- `Harn-stop.cmd` (double-clic) : ferme Harn. Si quelque chose est en cours, il l'affiche et
  demande s'il faut arrêter quand même.
- `npm run restart` : lance Harn, ou le relance s'il tourne déjà.
- `npm run stop` : arrête Harn, moteur compris.

Avant d'arrêter, les deux commandes demandent à Harn ce qui est en cours : première installation,
ajout ou installation d'un modèle, réglage, banc de vitesse, test d'intelligence, téléchargement,
analyse de la machine, chargement d'un modèle, réponse en cours de génération. Si quelque chose
tourne, elles l'affichent et n'arrêtent rien. Ajoutez `--force` pour couper quand même
(`npm run restart -- --force`). Les sessions pi ouvertes sont signalées : elles restent ouvertes,
mais n'ont plus de modèle le temps du redémarrage.

L'arrêt est propre : Harn coupe le moteur et enregistre son état avant de quitter. Après un
`restart`, Harn tourne en arrière-plan, sans fenêtre de console, et écrit dans
`data/logs/harn.log`. La fenêtre de l'interface déjà ouverte se reconnecte seule ; s'il n'y en
avait pas, une nouvelle s'ouvre.

## Organisation

```text
src/hardware.mjs   détection matériel et relevé GPU en direct
src/catalog.mjs    modèles validés et leurs besoins
src/planner.mjs    choix du backend, du premier modèle et de l'amélioration
src/levers.mjs     profil de la carte (architecture, bande passante) et a priori des leviers
src/system-checks.mjs  réglages Windows et conseils
src/runtimes.mjs   installation llama.cpp (officiel / Prism) et Strata
src/engine.mjs     recette llama-server et cycle de vie du moteur
src/tuner.mjs      banc de démarrage
src/setup.mjs      parcours du premier démarrage, installation, activation
src/gateway.mjs    endpoint /v1, bascule de modèle, mesure des requêtes
src/metrics.mjs    direct : GPU, débit, historique
src/pi.mjs         installation, configuration et lancement de pi
public/            interface
```
