# Validation — révision 0.2.0, 28 octobre 2026

La version 0.2.0 remplace le panneau web par la configuration native HA. Consulter les [résultats GitHub Actions du commit utilisé](https://github.com/achuille/discord-radio-haos/actions) : une ancienne exécution verte ne valide pas une nouvelle révision.

## Contrôles automatisés de cette révision

- Options bornées, listes de sources absentes/vides, volume et activation de lecture.
- Migration simulée de l’ancien état vers les options propres à l’application Supervisor : succès avec relecture, références `!secret` conservées, erreur, relecture incohérente, reprise au prochain démarrage, idempotence et priorité des choix natifs explicites.
- Conservation des identifiants, paramètres effectifs et fichiers audio ; absence de token dans l’état applicatif ; refus des fichiers de configuration surdimensionnés et symlinks.
- Démarrage réel non configuré sans serveur web ; import sans connexion/FFmpeg quand la lecture est désactivée ; arrêt propre pendant une préparation vocale.
- Adaptateur vocal simulé : déplacements serveur, reprise vers la cible effective, persistance, absence de retour intempestif au salon initial, temporisations et annulation.
- Connexion prête avant création du transcodeur ; pas de décodage pendant l’attente réseau ni d’écriture répétée d’un état inchangé.
- Rafraîchissement conditionnel des fichiers directs, cache réutilisé sur `304`, remplacement atomique des fichiers modifiés et conservation en cas d’erreur. La revalidation reste active au démarrage et périodiquement.
- Tests existants : FFmpeg réel, Opus/DAVE hors ligne, aléatoire, interruption, découverte, SSRF/DNS/redirections et quotas d’import.

Les tests du panneau/serveur/Chromium et les dépendances Playwright ont été retirés **parce que cette interface n’existe plus**, pas pour masquer une panne. Les régressions applicatives utiles sont couvertes par les tests de configuration et du worker.

## Mesure locale limitée

Contrôle du worker non configuré, sans audio ni Discord, sur Linux cloud avec Node **24.22.1** : pendant 10 secondes, **0,00 s de CPU supplémentaire à la résolution des ticks `/proc`**, **41 072 Kio de RSS** (environ 40 Mio), **aucun descripteur socket**, arrêt SIGTERM avec code 0. Ce résultat est une observation d’inactivité en développement, **pas un benchmark HAOS ni une mesure en lecture**. La CI utilise Node 22.

## CI des images

La CI configure deux images locales, **AMD64 et ARM64**, sans publication. Elle vérifie le chargement d’Opus/DAVE, FFmpeg, le démarrage réel sans réseau/token, l’initialisation de l’état privé, l’absence de listener web 8080 et l’arrêt propre. La CI doit être verte sur le commit installé ; ces contrôles ne constituent pas une installation HAOS.

## Éléments historiques, non réexécutés pour cette révision

La version précédente a été testée au commit `49a369cb5c249ea139e8c28307badf618b649dda` ([exécution](https://github.com/achuille/discord-radio-haos/actions/runs/40429170920)). Un dossier Drive public de 11 MP3, 13 615 903 octets, avait été importé anonymement et validé par FFprobe via un transport de test utilisant le proxy autorisé ; le second import réutilisait les 11 fichiers. Aucun lien, fichier ou identifiant personnel n’est conservé dans ce dépôt.

Le transport Node direct vers Drive n’avait pas résolu le service dans cet environnement cloud (`EAI_AGAIN`). Les protections de production n’avaient pas été désactivées ; le réseau HAOS reste à vérifier.

## Limites explicites

- Aucun token Discord utilisé : login réel, son audible et déplacement/reprise vocale réels non validés.
- Pas de HAOS cible : rendu du formulaire natif, migration via Supervisor réel et comportement du watchdog restent à confirmer. Le schéma et l’API s’appuient sur la [documentation HA officielle](https://contributors.home-assistant.io/apps/guides/options/).
- Pas de mesure RAM/CPU/température ou de test prolongé sur matériel cible. Les gains décrits sont des suppressions de travail vérifiées, pas des chiffres de performance mesurés.
- Aucune garantie sur la disponibilité future de Discord/Drive ni sur l’absence de suspension d’un compte selfbot.

Dernier essai local à effectuer après installation : son, volume, passage de piste, création/déplacement vocal, redémarrage de l’application et reprise après coupure réseau. Ne communiquer aucun token dans un rapport de problème.
