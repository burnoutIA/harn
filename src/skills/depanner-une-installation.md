---
name: depanner-une-installation
description: Comprendre pourquoi l'installation d'un modèle a échoué dans Harn et la relancer correctement. À utiliser quand Harn ou l'utilisateur signale une installation interrompue, une erreur de moteur, Strata ou llama.cpp qui ne démarre pas.
---

# Dépanner une installation Harn

Tu as les outils MCP de Harn : `read_install_log`, `retry_install`, `harn_status`, ainsi que
`bash`, `read` et la recherche web ketch. Tu tournes sur un autre modèle que celui en panne.

## Procédure

1. **Lire avant d'agir.** Appelle `read_install_log` avec l'identifiant du modèle. Repère la
   première vraie erreur, pas la dernière ligne : un échec en cascade commence souvent plus haut.

2. **Classer la cause**, puis l'expliquer en une phrase simple à l'utilisateur :
   - réseau ou téléchargement interrompu → une relance reprend là où elle s'était arrêtée ;
   - disque plein → dire combien il faut libérer, ne rien supprimer toi-même ;
   - fichiers déjà présents ailleurs sur la machine → les réutiliser (`gguf_dir`) ;
   - Python, dépendance ou pilote manquant → donner la marche à suivre (lien officiel) ;
   - mémoire (RAM ou carte graphique) insuffisante → dire que ce modèle ne tient pas ici ;
   - erreur inconnue → cherche le message exact avec ketch (`search`) avant de conclure.

3. **Proposer une action précise** et demander l'accord : « Je relance en réutilisant les
   fichiers de D:\… ? ». N'appelle `retry_install` qu'après un oui, avec `user_confirmed: true`.
   L'outil attend la fin (plusieurs minutes) : c'est normal.

4. **Rendre compte** : ce qui s'était passé, ce que tu as fait, le résultat (`harn_status`).

## Règles

- Ne modifie pas les fichiers de Harn ni ceux des moteurs à la main. Passe par les outils.
- Ne supprime jamais de fichiers de modèle : ils font des dizaines de gigaoctets.
- Si tu ne trouves pas la cause, dis-le franchement et donne le chemin du journal
  (`data/logs/install-<modèle>.log`) pour demander de l'aide ailleurs.
