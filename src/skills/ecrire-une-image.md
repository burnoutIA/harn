---
name: ecrire-une-image
description: Écrire la consigne (prompt) d'une image pour generate_image à partir d'une demande courte ou vague : la traduire en anglais, l'enrichir (sujet, cadrage, lumière, style), choisir le format, retoucher une image, utiliser un LoRA. À utiliser avant chaque appel à generate_image, et quand la personne demande de refaire, varier ou améliorer une image.
---

# Écrire une image

La personne écrit vite et court (« un chat dans l'espace », « une photo de moi à la plage »).
Ton travail : deviner ce qu'elle veut et le décrire au modèle d'images comme le ferait un bon
photographe ou illustrateur. Les modèles de Harn (FLUX, Qwen-Image, Z-Image, Krea, ERNIE…)
lisent la consigne avec un vrai modèle de langue : ils comprennent des phrases, pas des listes de
mots-clés.

## La consigne

- **En anglais**, toujours. Traduis l'idée, pas mot à mot. Garde tels quels les noms propres et le
  texte à écrire dans l'image.
- **Des phrases descriptives**, 40 à 120 mots, le plus important d'abord. Pas de listes de tags,
  pas de « masterpiece, best quality, 8k, ultra detailed » : ces formules ne servent à rien sur
  ces modèles et diluent le reste.
- **Ce qui est voulu, pas ce qui ne l'est pas.** « an empty beach » plutôt que « no people ». Les
  modèles distillés (Turbo, klein, schnell) ignorent le champ `negative`.
- **Ne contredis jamais la demande.** Tu complètes ce qu'elle laisse ouvert ; ce qu'elle précise
  (couleur, nombre, style, ambiance) passe tel quel.

## Compléter une demande vague

Pour chaque point que la demande laisse ouvert, choisis ce qui sert le mieux l'intention :

1. **Sujet** : qui ou quoi, son allure, ce qu'il fait, son expression.
2. **Lieu et moment** : décor, saison, heure du jour, météo.
3. **Cadrage** : plan large, plan moyen, portrait serré ; angle (à hauteur d'œil, plongée,
   contre-plongée) ; pour une photo, l'objectif (« 35mm », « 85mm portrait lens », « shallow
   depth of field »).
4. **Lumière** : « soft morning light », « golden hour », « overcast », « neon at night »,
   « studio softbox ». C'est ce qui fait le plus la différence.
5. **Style** : photo, illustration, aquarelle, peinture à l'huile, 3D, anime, pixel art… Sans
   indication, une photo réaliste pour une scène réelle, une illustration pour l'imaginaire.
6. **Ambiance et couleurs** : chaleureuse, mélancolique, palette pastel, contrastée…
7. **Détails** : matières, textures, un ou deux objets qui racontent la scène.

Exemple. Demande : « un chat dans l'espace ». Consigne :

> A fluffy orange tabby cat floating weightlessly inside a small spacecraft, wearing a tiny
> white astronaut suit with its helmet off, paws reaching toward a drifting food pellet. Through
> the round window behind it, Earth glows blue against black space. Soft cabin light from the
> left, warm and cosy. Playful, detailed digital illustration, rich colours.

Ne demande des précisions que si un choix change tout et ne se devine pas (le texte exact à
écrire, la personne à représenter). Sinon, fais l'image, puis dis en une phrase les choix que tu
as faits pour qu'elle puisse corriger (« je l'ai faite en illustration, plutôt une photo ? »).

## Format

Choisis `width` et `height` selon le sujet, multiples de 32, autour d'un million de pixels :
carré 1024 × 1024 ; portrait 832 × 1216 ; paysage 1216 × 832 ; panorama 1344 × 768 ; affiche
ou fond d'écran de téléphone 768 × 1344. Plus grand : plus lent, pas forcément mieux.

## Selon le modèle

- **Qwen-Image** : le meilleur pour le texte dans l'image (panneau, affiche, logo) : mets le texte
  exact entre guillemets, « a sign that reads "OPEN" ». Suit fidèlement les consignes longues.
- **FLUX.2 klein, Z-Image Turbo, ERNIE Turbo** : rapides ; même consigne en phrases. Pour
  itérer vite sur une idée avant de lancer un modèle plus lent.
- **FLUX.1, Chroma, Krea** : très bons en photo réaliste ; décris l'appareil, l'objectif, la
  lumière.
- Un modèle qui ne sait pas retoucher ne prend pas d'image de référence (la liste des modèles le
  dit).

## Retoucher une image

Passe l'image dans `references` et décris **seulement le changement**, puis ce qui doit rester :
« Replace the red car with a vintage green bicycle. Keep everything else exactly the same: the
street, the lighting, the framing. » Pas besoin de redécrire toute la scène.

## Avec un LoRA

Suis la note de la personne sur ce LoRA (dans la liste de tes LoRA). Pour un visage : nomme la
personne comme la note l'indique, décris la scène, la tenue, la lumière, mais **pas le visage**
(barbe, yeux, cheveux, âge) : c'est le LoRA qui l'apporte, le décrire le remplace par un visage
quelconque. Le mot déclencheur, s'il y en a un, va au début de la consigne.

## Refaire, varier

- « Encore » ou « une autre » : même consigne, sans `seed`, pour une nouvelle image.
- « La même mais… » : même `seed` (rendu par generate_image) et la consigne d'avant, avec le seul
  changement demandé : le reste de l'image bouge peu.
- Si tu vois l'image (modèle qui sait voir), vérifie qu'elle correspond à la demande avant de la
  présenter ; une main ou un texte raté se refait.

## Limites

Pas d'image sexuelle impliquant un mineur, jamais. Pas d'image intime, humiliante ou trompeuse
d'une personne réelle reconnaissable sans son accord.
