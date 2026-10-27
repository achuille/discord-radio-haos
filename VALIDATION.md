# Validation — 27 octobre 2026

Code testé : `49a369cb5c249ea139e8c28307badf618b649dda`.
[Exécution GitHub Actions](https://github.com/achuille/discord-radio-haos/actions/runs/40429170920).

## Contrôles réussis

- **53 tests automatisés du moteur**, sur Node 22 en CI et Node 24.22.1 localement.
- **10 tests Chromium**, sur écran ordinateur et mobile : démarrage de la véritable application sans compte configuré, refus des sources invalides/privées, absence de débordement, parcours de la bibliothèque et annulation de dialogue, conservation du curseur de volume pendant l’actualisation, messages de configuration et de permissions. Les états de bibliothèque et de compte sont explicitement simulés ; aucun compte Discord réel n’est utilisé par ces tests.
- Images Docker **AMD64 et ARM64** : construction, chargement Opus/DAVE, FFmpeg et démarrage de l’application sans réseau ni token ; santé locale 200 et API protégée 403.
- Encodage Opus natif, conversion PCM vers ressource vocale et création d’une session DAVE hors ligne.
- Lecture FFmpeg réelle, fichiers invalides, interruption, pause/reprise/piste suivante, mélange sans répétition immédiate.
- Reconnexion et interruptions via doubles de test ; volume appliqué à la ressource active.
- Ingress : filtrage de l’adresse du Supervisor, CSRF, limites JSON/requêtes, chemins statiques et configuration privée.
- Import : limites, SSRF, DNS par redirection, rafraîchissement atomique, conservation du cache lors d’un échec et suppression locale d’une source.
- Audit npm : **aucune vulnérabilité signalée** au contrôle. La dépendance transitive `tar` est verrouillée à 7.5.22.

## Vérification d’un vrai Drive public

Un dossier public de **11 MP3, 13 615 903 octets**, a été téléchargé sans compte, cookie ni clé API et validé par FFprobe. Le test complet de l’importeur utilisait un transport curl de test via le proxy autorisé de l’environnement. La seconde synchronisation a réutilisé les 11 fichiers sans erreur. Aucun contenu, nom de fichier ou identifiant Drive personnel n’est inclus dans ce dépôt.

Le transport HTTP Node direct n’a pas pu résoudre Drive dans cet environnement cloud (`EAI_AGAIN`). Il reste à confirmer sur le réseau HAOS cible. Les protections DNS/SSRF de production n’ont pas été désactivées pour faire passer le test.

## Ce qui n’est pas validé

- Aucun token Discord utilisé : connexion authentifiée, son audible et reprise vocale réelle restent à tester.
- Pas d’installation sur le HAOS physique cible, ni de mesure de RAM/CPU/température en lecture prolongée.
- Les captures des tests navigateur existent dans les artefacts CI ; elles n’ont pas été inspectées manuellement. Les tests ne constituent pas une validation visuelle exhaustive.
- Ni la disponibilité future de Discord/Drive, ni l’absence de suspension d’un compte selfbot ne sont garanties.

Les anciens échecs de CI sont conservés dans l’historique : un import de contrôle CommonJS incorrect a été corrigé ; des téléchargements Ubuntu trop lents ont empêché des tests de démarrer. Le contrôle navigateur utilise désormais l’image officielle Playwright préinstallée. Aucun test fonctionnel n’a été supprimé pour masquer ces échecs.

## Dernier essai sur votre installation

Après configuration locale du compte : vérifier du son audible, le volume, le passage au morceau suivant, puis une reprise après redémarrage de l’application. Ne communiquer aucun token dans un rapport de problème. Garder le mode protégé activé.
