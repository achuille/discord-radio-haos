# Validation — 26 octobre 2026

## Vérifié localement

- 53 tests automatisés passent sur Linux x64, Node 24.22.1.
- Lecture FFmpeg réelle, fichiers invalides, arrêt, pause/reprise/piste suivante, mélange sans répétition immédiate.
- Encodage Opus natif, conversion PCM vers ressource vocale et création d’une session DAVE hors ligne.
- Reconnexion et interruptions avec doubles de test, jamais un compte Discord réel.
- Ingress : filtrage de l’adresse du Supervisor, CSRF, limites JSON/requêtes, chemins statiques, configuration privée.
- Import : limites, SSRF, DNS par redirection, rafraîchissement atomique, conservation du cache lors d’un échec et suppression locale d’une source.
- Audit npm : aucune vulnérabilité signalée au moment du contrôle. La dépendance transitive tar est explicitement verrouillée à 7.5.22.
- Un vrai dossier Drive public : 11 MP3, 13 615 903 octets, téléchargés sans compte, cookie ni clé API et validés par FFprobe. Test complet de l’importeur avec transport curl de test utilisant le proxy autorisé ; seconde synchronisation : 11 fichiers réutilisés. Aucun contenu personnel n’est inclus dans ce dépôt.

## Limites de cette validation

- Le transport Node HTTP direct n’a pas pu résoudre Drive dans cet environnement (EAI_AGAIN). Les contrôles réseau de production n’ont pas été désactivés pour faire passer le test.
- Interface : syntaxe, structure et API testées ; pas de validation visuelle dans un navigateur réel à ce stade. Le navigateur cloud n’accède pas au serveur local de cette exécution.
- Pas de token Discord utilisé : connexion authentifiée, son audible et reprise vocale réelle restent à tester.
- Pas d’installation HAOS ni de mesure RAM/CPU/température sur le matériel cible.
- Les builds Docker AMD64/ARM64 sont définis dans la CI. Vérifier le résultat du commit utilisé ; cette page n’affirme pas une réussite avant son exécution.

Cette version est expérimentale. Le passage des tests ne garantit ni la disponibilité de Discord/Drive, ni l’absence de suspension d’un compte selfbot.
