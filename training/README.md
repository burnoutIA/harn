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

## La recette (`recette.sh`)
1. Modèle de base → `modeles/<nom>/`.
2. Données (`donnees.py`) → `data/melange.jsonl` : ~28 000 exemples, ~40 M tokens (~4 h sur une 3090) — problèmes/solutions
   multi-langages (Magicoder OSS-Instruct), sessions d'agent de code avec outils
   (Nemotron-SFT-OpenCode, catégories code), corrections de bugs résolues dans des dépôts
   (SWE-smith). Même mélange pour tous les modèles comparés.
3. Entraînement (`sft.py`) → `sorties/<nom>-sft/` : tous les poids, perte sur les réponses de
   l'assistant seulement, 16k tokens, lr 1e-5, AdamW 8 bits, 1 époque, table des tokens gelée (pic mesuré 19 Go à 16k). Exemples dont le gabarit
   de conversation n'est pas stable : écartés et comptés.

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

## À faire
- Données générées par le professeur pour le front (HTML/CSS/SCSS/Svelte/Twig), gardées
  seulement si elles passent une vérification automatique.
- Export GGUF des modèles entraînés.
