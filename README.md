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

### Avant d'installer, sous Linux

Une seule chose que Harn ne peut pas faire seul, parce qu'elle demande votre mot de passe :
si vous avez une NVIDIA d'au moins 12 Go (RTX série 20 ou plus récente), les grands MoE
Flash-Next passent par Strata, dont l'installeur a besoin de Python 3.10+ avec venv.
Ubuntu et Debian le livrent sans venv :

```sh
sudo apt install python3-venv
```

Fedora et Arch l'ont déjà. Sinon `Harn-install.sh` le propose, et l'application le rappelle
dans ses vérifications et sur la carte des modèles Strata.

Avec une RTX 30 (3060 à 3090 Ti), Harn peut aussi mesurer
[llamAmpere](https://github.com/JakeATX/llamAmpere), un llama.cpp aux noyaux écrits pour ces
cartes : sur une 3090, +15 à 20 % en code et en contexte long, un peu moins vite en prose
française, ~3 Go de VRAM en moins. Pas de binaire publié : Harn le compile une fois (10 à 20 min,
version figée), à condition d'avoir les outils :

```sh
sudo apt install nvidia-cuda-toolkit cmake build-essential
```

Le banc le met face au moteur officiel et garde le plus rapide.

Pour les agents (voir « Agents »), `tmux` est conseillé :

```sh
sudo apt install tmux
```

Avec lui, un agent tourne sans fenêtre, survit à la fermeture de son terminal, et « Ouvrir »
rouvre le même au lieu d'en lancer un second. Sans lui, chaque « Ouvrir » lance un nouveau pi dans
une nouvelle fenêtre, et Harn ne sait pas dire si un agent est en marche.

Pour copier du texte depuis pi (sélection à la souris, commande `/copy`), il lui faut l'outil de
presse-papiers du bureau : `sudo apt install wl-clipboard` sous Wayland, `xclip` sous X11. Sans
lui rien n'est copié ; l'application le signale dans ses vérifications.

Harn interroge GitHub (versions des moteurs, recherche d'un moteur pour une architecture
nouvelle, mises à jour). Sans compte, GitHub limite à 60 requêtes par heure ; un jeton sans
aucune permission (github.com → Settings → Developer settings → Fine-grained token, accès
« Public repositories ») en donne 5 000. Le mettre dans `data/github.token`, ou dans la variable
`GITHUB_TOKEN`.

Quand un modèle demande un moteur que llama.cpp ne publie pas encore (une PR non fusionnée),
Harn le propose et attend votre accord : c'est du code que personne n'a relu. Sous Linux, ce
moteur est compilé puis lancé dans une bulle [bubblewrap](https://github.com/containers/bubblewrap)
(`sudo apt install bubblewrap`) : sans réseau, sans accès à vos fichiers, il ne voit que ses
sources, le modèle qu'il sert et la carte graphique. Sans bubblewrap, la demande d'accord le dit.

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

### Ajouter un modèle depuis Hugging Face

Vue Modèles : coller l'adresse d'un dépôt GGUF. pi l'analyse pour la carte, propose la meilleure
quantification, puis Harn la télécharge, la règle, la mesure et teste son intelligence.

Un fichier déjà sur la machine (même nom, même taille : dossier `models/`, LM Studio, cache
Hugging Face, Documents, Téléchargements) est repris tel quel, sans téléchargement. C'est aussi
la façon d'installer un dépôt à accès restreint (`gated`), que Harn ne peut pas télécharger faute
de jeton Hugging Face : copier le fichier dans `models/`, puis donner l'adresse du dépôt. Harn
lit alors l'architecture dans le fichier local.

Un Flash-Next (architecture `qwen4exp`) ajouté ainsi va sur Strata et non sur llama.cpp, dès que
Strata est déjà sur la machine (un Flash-Next du catalogue l'apporte, avec sa tête MTP). Strata
prépare un « pack » à côté des fichiers, sans les réécrire. Mesuré sur une RTX 3090 avec
l'Uncensored d'OrcaRouter en IQ4_XS (97 Go) : 69 tok/s à 131k sous Strata, contre 34 sous
llama.cpp, qui laisse les experts au processeur. Pas de vision par cette voie pour l'instant.
Sans Strata, le modèle s'installe sous llama.cpp, avec sa tête MTP à part si le dépôt en livre une.

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

## Agents

Vue Agents : un agent par personne. Chacun a sa fiche, son dossier pi et son dossier de travail
dans `data/agents/<id>/` (hors dépôt), sans rien de commun avec les autres ni avec le pi de test.

```text
data/agents/<id>/agent.json                   la fiche : nom, modèle, cases, bot Telegram
data/agents/<id>/MEMORY.md                    sa mémoire
data/agents/<id>/workspace/                   son dossier de travail
data/agents/<id>/workspace/files/             les fichiers qu'on lui envoie
data/agents/<id>/pi-agent/APPEND_SYSTEM.md    ses consignes
data/agents/<id>/pi-agent/sessions/           ses conversations
```

- **Créer** : le champ « Prénom de la personne » en haut de la vue, puis « Créer un agent ».
- **Cases** : shell, outils de Harn, recherche web, mémoire, images, lancer avec Harn. Un nouvel agent n'a
  ni shell ni outils de Harn : on coche ce dont il a besoin.
- **Mémoire** : l'agent note lui-même ce qu'il juge durable et le relit au début de chaque
  conversation (6 000 caractères au plus, modifiables dans la fiche).
- **Telegram** : un bot par agent. Le jeton vient de @BotFather, l'identifiant de la personne de
  @userinfobot ; seule cette personne est écoutée. Ses messages vont à l'agent, la réponse finale
  lui revient, `/new` ouvre une nouvelle conversation. Photos et fichiers (20 Mo au plus, limite
  de Telegram) sont rangés dans `workspace/files/` ; une image est aussi montrée au modèle quand
  il sait voir. Cocher « Lancer avec Harn » pour que le bot réponde sans ouvrir de fenêtre.
- **La carte graphique** : avant d'injecter un message reçu, l'agent la demande. Libre, il la
  prend. Occupée par quelqu'un d'autre, la demande s'affiche dans la fenêtre de Harn.

Sous Linux avec tmux :

- Chaque agent tourne dans sa session, sur un serveur tmux propre à Harn : vos sessions tmux ne
  sont pas touchées. Pour s'y rattacher à la main : `tmux -L harn ls`, puis
  `tmux -L harn attach -t harn-<id>`.
- La fiche affiche « en marche » quand le pi de l'agent tourne.
- « Ouvrir » rouvre le terminal de l'agent. Si son modèle, ses outils, ses consignes ou son bot ont
  changé depuis son démarrage, son pi est relancé et reprend sa conversation.
- « Tout voir » (dès que deux agents sont en marche) : tous dans une seule fenêtre, un panneau
  chacun. La souris choisit le panneau ; un agent qui démarre la rejoint ; la fermer n'arrête
  personne.
- Supprimer un agent arrête son pi et efface tout son dossier.

## Images

Un agent dont la case « Images » est cochée a un outil `generate_image` : il génère une image à
partir d'une description, ou retouche une image de son dossier de travail. Aucune interface à
part : Harn fait tourner [stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)
en coulisses, comme llama.cpp pour le texte, et l'installe avec le premier modèle d'images.

Vue Modèles, section Images :

| Modèle | À télécharger | Sur une RTX 3090 (1024 × 1024) |
|---|---|---|
| FLUX.2 klein 4B (Apache-2.0) | 8,9 Go | ~15 s |
| Qwen-Image 2.1 Uncensored (licence Qwen Research, non commercial) | 18,2 Go | ~85 s |

- La carte graphique ne tient pas les deux : le temps d'une image, le modèle de texte est
  déchargé, puis rechargé. Une requête qui arrive entre-temps attend, elle n'est pas refusée.
- L'image est rangée dans `images/` du dossier de travail de l'agent, montrée au modèle quand il
  sait voir, et envoyée dans le chat Telegram de la personne si l'agent a un bot.
- Les images à retoucher ne sont lues que dans le dossier de travail de l'agent (les fichiers
  reçus par Telegram sont dans `files/`).
- Moteur : build CUDA 12 sous Windows avec une NVIDIA, Vulkan ailleurs (aucun build CUDA n'est
  publié pour Linux), CPU sans carte graphique.

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
- **Intégrité** : chaque GGUF téléchargé est vérifié contre l'empreinte SHA-256 publiée par
  Hugging Face, les binaires contre le digest des releases GitHub quand il existe. Un fichier déjà
  sur la machine est repris sans vérification : c'est le vôtre. Strata est figé sur un commit
  (`STRATA_COMMIT` dans `src/runtimes.mjs`).
- **Mémoire de pi** (Linux) : pi et tout ce qu'il lance (son shell, ses scripts) tournent avec un
  quart de la RAM au plus, sans échange. Un script qui s'emballe est tué par le noyau au lieu de
  figer la machine ; le bureau affiche alors qu'une application a été arrêtée faute de mémoire.
- `node src/main.mjs --no-open --no-setup` pour développer sans lancer l'installation.
- `npm run check` pour les tests.
- `npm run power-test` : 30 min de créneaux repos / pleine charge pour savoir si l'alimentation
  tient les pics de la carte graphique, avec relevé de puissance toutes les 20 ms
  (`data/logs/power-*.csv`). Après une coupure, le relancer : il dit ce qui s'est passé.

### Lancer, relancer, arrêter

- `Harn-start.cmd` (double-clic) : lance Harn, ou le relance s'il tourne déjà, et ouvre la fenêtre.
  `Harn-install.cmd` reste le premier lancement : il installe Node.js s'il manque.
- `Harn-stop.cmd` (double-clic) : ferme Harn. Si quelque chose est en cours, il l'affiche et
  demande s'il faut arrêter quand même.
- Sous Linux : `./Harn-install.sh`, `./Harn-start.sh` et `./Harn-stop.sh` font la même chose.
  L'installeur pose Node.js dans `~/.local/node` (sans sudo) s'il manque, et ajoute au menu des
  applications les lanceurs « Harn », « Harn - arrêter » et « Harn - installer » (le gestionnaire
  de fichiers de GNOME ouvre les `.sh` dans l'éditeur au lieu de les lancer).
  `./Harn-install.sh --lanceurs` ne fait que (re)créer ces lanceurs.
  Moteur : builds `ubuntu` de llama.cpp (CUDA 12.8 ou 13, avec leurs bibliothèques CUDA, sans
  toolkit à installer), `linux-cuda` de Prism, build Linux de ketch. Strata (Flash-Next) s'installe
  par son `setup.sh` (voir « Avant d'installer, sous Linux »).
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
src/pi.mjs         installation, configuration et lancement de pi (terminal, tmux, vue d'ensemble)
src/agents.mjs     les agents : fiche, dossier, lancement, demande de la carte
src/images.mjs     génération d'images : moteur, modèles, partage de la carte avec le texte
src/pi-extensions/ extensions pi fournies par Harn : ctx-optimizer, telegram-follow, agent-memory, image-gen
src/harn-mcp.mjs   les outils de Harn donnés à pi (analyser, installer, mesurer, tester)
src/skills/        les marches à suivre de pi : installer un modèle, dépanner une installation
public/            interface
```
