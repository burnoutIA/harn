---
name: installer-un-modele
description: Installer, régler et évaluer un nouveau modèle d'IA locale depuis une adresse Hugging Face (GGUF), avec les outils Harn. À utiliser quand l'utilisateur veut essayer, ajouter, télécharger ou tester un modèle (« installe ce modèle », un lien huggingface.co, un modèle dont on parle).
---

# Installer un modèle avec Harn

Harn est le serveur d'IA locale de cette machine. Tu as ses outils MCP : `inspect_model_repo`,
`install_model`, `harn_status`, `test_intelligence`. Tu fais le jugement, Harn exécute.

## L'objectif à servir

- Contexte entre 100k et 150k tokens.
- Le modèle le plus intelligent possible.
- La vitesse la plus haute possible : sous 40 tok/s, c'est lent.
- Ne jamais sacrifier la marge mémoire de la carte graphique.

## Procédure

1. **Analyser.** Appelle `inspect_model_repo` avec l'adresse. Lis : architecture, MoE ou dense,
   présence MTP, licence, accès restreint, fichiers vision, indications du README, et le verdict
   de chaque quantification sur cette machine.

2. **Choisir la quantification.**
   - Garde celles dont `verdict.fit` vaut `full` et `meetsObjective` vaut `true`.
   - Parmi elles, prends la plus grosse : plus de bits = plus de qualité, tant que l'objectif
     tient. Préfère les quantifications « UD » ou imatrix à taille égale.
   - Si aucune n'atteint l'objectif, prends celle qui tient au moins 100k et va le plus vite,
     et dis clairement ce qui manque.
   - Évite les quantifications 1 et 2 bits quand une 3 ou 4 bits tient.
   - `partial` veut dire qu'une partie tournera sur le processeur : beaucoup plus lent. Ne le
     propose que si rien d'autre ne tient, en le disant.

3. **Choisir les réglages.**
   - Échantillonnage : reprends les valeurs recommandées par l'auteur pour le mode raisonnement
     ou code (`temperature`, `top_p`, `top_k`, `min_p`, `presence_penalty`). Sans indication,
     n'en passe pas : Harn met des valeurs sûres.
   - Vision : n'ajoute un `mmproj` que si l'auteur ne dit pas qu'il est incompatible avec MTP.
     Si les deux sont incompatibles, garde MTP (la vitesse) et signale-le.

4. **Demander la confirmation.** Présente en quelques lignes : le modèle, la quantification,
   la taille à télécharger, le contexte et la vitesse estimés, la licence, ce que tu laisses de
   côté (vision…). Demande « Je lance le téléchargement ? ». N'appelle `install_model` qu'après
   un oui explicite. Harn affiche ensuite la demande dans sa fenêtre (dépôt, taille, licence) :
   préviens l'utilisateur qu'il doit cliquer sur Accepter, rien ne démarre avant.

5. **Installer.** Appelle `install_model`. L'outil bloque plusieurs minutes (téléchargement,
   banc, banc d'intelligence, analyse) : c'est normal. Pendant ce temps, la carte graphique
   appartient au modèle mesuré. À la fin, Harn recharge le modèle précédent (celui sur lequel tu
   tournes).

6. **Rendre compte.** Donne la vitesse mesurée, le réglage retenu, le contexte, la note du banc
   d'intelligence et son détail (palier atteint en outils, code, raisonnement, long contexte, honnêteté ; réflexion), et compare au modèle actuel (`harn_status`). Recommande de l'adopter ou non
   selon l'objectif. L'utilisateur l'active d'un clic dans Harn (vue Modèles).

## Limites à dire franchement

- Harn ne sert que des fichiers GGUF. Un dépôt sans GGUF ne s'installe pas ici.
- Un dépôt à accès restreint (`gated`) demande d'accepter la licence sur Hugging Face et un jeton :
  Harn ne le gère pas encore.
- Une architecture trop récente peut ne pas se charger avec le moteur installé : l'erreur du banc
  le dira. Signale-le plutôt que de réessayer.
- Le banc d'intelligence (test adaptatif par paliers : plancher, difficile, limite, en cinq domaines)
  donne une note sur 100 commune à tous les modèles. 100 est rare : il faut réussir les paliers
  limite. Ce n'est pas un benchmark public, mais il départage bien.
  Signale aussi le marqueur de réflexion : un modèle « bavard » répond plus lentement à l'usage.
