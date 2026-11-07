# training — la recette « petit modèle de code »

Une routine unique pour spécialiser un petit modèle de langage en code (TypeScript/JS, Python,
Rust, PHP, shell, front), puis l'appliquer à d'autres petits modèles et les comparer.
Le modèle de base n'est qu'un paramètre : rien ici ne dépend d'un modèle précis.

Deux PC :
- **PC d'entraînement** (carte NVIDIA, CUDA) : exécute `recette.sh`.
- **PC de mesure** : bancs, génération de données par un gros modèle professeur, pilotage
  de l'autre PC avec `pc.sh`. On n'y entraîne pas (essai sur carte AMD/ROCm : perte NaN puis
  plantage du pilote graphique).

## Installation (PC d'entraînement)
```bash
cd training
uv venv --python 3.12 .venv
uv pip install --python .venv/bin/python torch --index-url https://download.pytorch.org/whl/cu128
uv pip install --python .venv/bin/python -r requirements.txt
```

## Piloter depuis le PC de mesure
```bash
cp machines.env.exemple machines.env    # adresse ssh du PC d'entraînement
./pc.sh envoyer                          # code + données
ESSAI=1 ./pc.sh lancer <org/modele>      # 3 pas pour valider la chaîne
./pc.sh lancer <org/modele> [nom]        # entraînement complet
./pc.sh etat | ./pc.sh suivre
./pc.sh recuperer                        # modèles entraînés → sorties/
```
Données trop lourdes pour le réseau : `./pc.sh usb-export /media/<clé>` puis, sur l'autre PC,
`rsync -a /media/<clé>/training/data/ data/` (et `sorties/` dans l'autre sens au retour,
`./pc.sh usb-import`). Le modèle de base, lui, est téléchargé directement par le PC
d'entraînement depuis Hugging Face.

Un modèle qui livre son propre code Python (`trust_remote_code`) est refusé tant qu'on ne
l'a pas relu : relancer alors avec `CODE_DISTANT=1`.

## La recette
Leçon des premières mesures : le modèle de base réfléchit trop longtemps (la plupart de ses échecs
au banc sont des réponses coupées), mais **sans réflexion il est bien moins juste**. On lui apprend
donc à raisonner court, pas à ne plus raisonner.

0. **Générations vérifiées** (`generer.py`, sur n'importe quelle machine qui sert le modèle de base
   en API OpenAI, par ex. `PARALLELE=128 banc/servir.sh`) : exercices MBPP+ et leur traduction
   MultiPL-E (Python, TypeScript, JavaScript, PHP, Rust, Bash — jamais les épreuves du banc),
   4 réponses par exercice avec réflexion, chacune exécutée contre les tests dans podman.
   `selection.py` → `data/auto/sft.jsonl` (la réponse juste la plus courte de chaque exercice) et
   `data/auto/dpo.jsonl` (paires : juste et courte ≻ fausse, coupée ou juste mais bien plus longue).
   `reverifier.py` réexécute les tests si l'extraction change.
1. Modèle de base → `modeles/<nom>/`.
2. Mélange (`donnees.py`) → `data/melange.jsonl` : les données vérifiées ci-dessus, des sessions
   d'agent de code avec outils (Nemotron-SFT-OpenCode, catégories code), des corrections de bugs
   résolues dans des dépôts (SWE-smith) et un peu de problèmes/solutions multi-langages (Magicoder).
   Même mélange pour tous les modèles comparés.
3. **SFT** (`sft.py`) → `sorties/<nom>-sft/` : tous les poids, perte sur les réponses de l'assistant
   seulement, 16k tokens, lr 1e-5, AdamW 8 bits, 1 époque, table des tokens gelée (pic mesuré 19 Go
   à 16k). Le bloc de réflexion vide des exemples sans réflexion n'est pas appris. Exemples dont le
   gabarit de conversation n'est pas stable : écartés et comptés.
4. **DPO** (`dpo.py`) → `sorties/<nom>-dpo/` : sur les paires, β 0,1, lr 1e-6. Référence calculée
   d'abord (pas de second modèle en mémoire), puis gradient factorisé, une séquence à la fois.

Modèles, données et sorties ne sont jamais suivis par git (`.gitignore`).

## Banc de code (`banc/`, sur le PC de mesure)
```bash
podman build -t harn-banc-code:1 banc/                 # une fois : Python, Node+tsc, PHP, Rust, Bash
banc/servir.sh <modele.gguf> 4760 &                    # carte choisie par son nom (CARTE=R9700)
python banc/code.py --url http://127.0.0.1:4760 --etiquette <nom>   # --limite 5 pour un essai
```
HumanEval+ (Python) et MultiPL-E (TypeScript, JavaScript, PHP, Rust, Bash), pass@1 glouton,
code exécuté sans réseau dans podman. Une réponse sans bloc de code (vide ou coupée par le
budget) est ratée. Résultats dans `banc/resultats/` (non suivi).

**Savoir vite si une méthode marche.** Le banc complet prend ~75 min. `banc/rapide.txt` garde les
394 épreuves sur 959 dont le résultat a changé d'un modèle à l'autre (les autres sont toujours
justes ou toujours fausses : elles ne départagent rien) → ~30 min. La liste est figée : sert à
comparer des méthodes, pas à annoncer un score. Pendant l'entraînement, `dpo.py --sauver-tous 50`
écrit des points de contrôle, que le PC de mesure évalue pendant que l'autre continue :
```bash
./pc.sh recuperer <nom>
LLAMA_CPP=<clone de llama.cpp> banc/evaluer.sh sorties/<nom>/pas-50 <nom>-pas50 banc/resultats/<base>.json
```
`evaluer.sh` convertit (GGUF Q4_K_M), sert, passe le banc rapide (`COMPLET=1` : complet) et compare
à la référence avec `banc/comparer.py` : épreuves gagnées / perdues par langage et probabilité que
l'écart soit du hasard (test du signe). Point de contrôle moins bon que la base → on coupe le run.

## À faire
- Données générées par le professeur pour le front (HTML/CSS/SCSS/Svelte/Twig), gardées
  seulement si elles passent une vérification automatique.
- Export GGUF des modèles entraînés.
- RLVR (GRPO) : récompense = tests réussis, avec bonus de concision, si SFT + DPO laissent de la marge.
