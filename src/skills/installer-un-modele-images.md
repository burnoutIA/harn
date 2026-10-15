---
name: installer-un-modele-images
description: Installer un modèle de génération ou de retouche d'images (FLUX, Qwen-Image, Z-Image, Chroma, Krea, ERNIE-Image, Stable Diffusion…) avec les outils Harn, depuis la liste de Harn, ses propositions ou une adresse Hugging Face. À utiliser quand l'utilisateur veut générer des images sans modèle installé, ou demande d'ajouter, choisir ou essayer un modèle d'images.
---

# Installer un modèle d'images avec Harn

Harn fait tourner les modèles d'images avec stable-diffusion.cpp, à côté du modèle de texte. Tu as
ses outils MCP : `list_image_models`, `inspect_image_repo`, `install_image_model`. Tu choisis,
Harn exécute : il prend la version qui tient sur la carte et va chercher le décodeur et le
lecteur de consigne de la famille.

## Procédure

1. **Regarder ce qu'il y a.** Appelle `list_image_models` : les modèles de la liste (installés ou
   non) et les propositions du jour, déjà filtrées pour cette machine.

2. **Choisir.** Selon ce que veut l'utilisateur :
   - Retoucher des images (changer un objet, un texte, un style) : un modèle avec `can_edit`.
   - Du texte lisible dans l'image : Qwen-Image.
   - La vitesse : les versions distillées (Turbo, klein, schnell : 4 à 8 étapes).
   - Ce qui tient : `fits_this_machine` vrai ; sinon ce sera très lent ou impossible.
   - La licence : signale celles qui interdisent l'usage commercial.
   Une adresse Hugging Face donnée par l'utilisateur : `inspect_image_repo` d'abord. Un `problem`
   non vide dit pourquoi le dépôt ne s'installe pas : rends-le tel quel et propose une
   alternative de la liste.

3. **Demander la confirmation.** En quelques lignes : le modèle, sa famille, la taille à
   télécharger, s'il sait retoucher, la licence. Demande « Je lance le téléchargement ? ».
   N'appelle `install_image_model` qu'après un oui explicite. Harn affiche ensuite la demande dans
   sa fenêtre : préviens l'utilisateur qu'il doit cliquer sur Accepter, rien ne démarre avant.

4. **Installer.** `install_image_model` avec `model_id` (modèle de la liste) ou `url` (et `file`
   pour une autre variante que celle conseillée). L'outil bloque le temps du téléchargement
   (plusieurs minutes pour 10 à 30 Go) : c'est normal.

5. **Rendre compte.** Donne l'identifiant installé. Si tu as l'outil `generate_image`, propose un
   premier essai avec ce modèle (`model`). Sinon, dis à l'utilisateur de cocher la case « Images »
   de l'agent dans Harn.

## Limites à dire franchement

- Harn n'installe que des modèles d'images en GGUF, d'une famille qu'il reconnaît. Pas de
  safetensors seuls, pas de dépôt à accès restreint (Harn n'a pas de jeton Hugging Face).
- Supprimer un modèle d'images se fait dans la fenêtre de Harn, pas avec tes outils.
- Un outil de Harn qui échoue : rends son message et arrête-toi là ; ne télécharge rien toi-même.
