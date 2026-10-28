# Discord Radio · Home Assistant OS

Radio Discord hébergée sur HAOS, gérée **uniquement dans l’onglet Configuration natif de l’application**. Plusieurs dossiers Google Drive publics ou URL audio directes, cache local et lecture aléatoire : aucun PC, navigateur ni interface web séparée à laisser ouvert. Aucune commande Discord n’est ajoutée.

> **Version 0.2.0 expérimentale.** Les contrôles automatisés ne remplacent pas une installation HAOS ni une écoute Discord réelle. Le mode compte utilisateur automatisé (*selfbot*) contrevient aux règles Discord et expose le compte à une suspension, même s’il est dédié. [Règle officielle](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots).

## Installation

1. Ajouter `https://github.com/achuille/discord-radio-haos` au magasin d’applications HA et installer **Discord Radio**.
2. Dans **Configuration**, saisir le token (champ masqué), les identifiants du serveur et du salon vocal, puis les **sources** publiques. Si nécessaire, afficher les options facultatives.
3. **Enregistrer puis redémarrer** l’application pour appliquer les changements. Consulter les **Journaux** pour l’import et la connexion.
4. Activer **Démarrer au démarrage** et, si souhaité, le **Chien de garde** du Supervisor. Vérifier le son dans Discord.

Mise à jour depuis 0.1 : les anciennes sources et le volume effectif sont migrés vers la configuration native, avec conservation du cache. En cas d’échec, ils restent utilisés et la migration est retentée au prochain démarrage. Rafraîchir la page Configuration après la migration. [Détails et limites](radio/DOCS.md#mise-à-jour-depuis-01).

[Guide détaillé](radio/DOCS.md) · [Validation](VALIDATION.md) · [Résultats CI](https://github.com/achuille/discord-radio-haos/actions)

## Fonctionnement et ressources

- Aucun serveur HTTP, ingress, panneau web, port publié ou navigateur Playwright.
- Un morceau et un FFmpeg à la fois ; la connexion vocale est prête **avant** le lancement du décodage. Opus natif et DAVE.
- Les déplacements vers un salon vocal créé par le serveur sont suivis ; le salon de création n’est pas réimposé à chaque morceau. La cible est conservée pour la reprise ; changer les identifiants de Configuration réinitialise ce choix.
- Synchronisations espacées ; les URL directes utilisent les validateurs HTTP lorsque disponibles pour éviter téléchargement et FFprobe inutiles.
- État et cache privés dans `/data`. Pas de token Discord dans les journaux ni dans les fichiers d’état applicatifs.
- Aucun accès à l’API Core HA, au socket Docker, aux périphériques audio ou au réseau de l’hôte. La migration utilise uniquement les options de **cette application** via l’accès Supervisor déjà accordé, sans activer `hassio_api`.
- Node.js 22, architectures `amd64` et `aarch64`. Pas de promesse de diffusion ininterrompue ni de mesures de performance sur votre matériel.

Ne diffusez que des contenus dont vous détenez les droits. La licence MIT couvre le code, pas les enregistrements. Aucun fichier musical, lien Drive personnel ou secret n’est inclus.

## Développement

Depuis `radio/` : `npm ci`, puis `npm test`. L’image se construit avec `docker build -t discord-radio:test .`. La première installation compile sur HAOS ; elle nécessite Internet et du stockage libre. Aucun Node/Docker à installer sur l’hôte HAOS, aucune image précompilée annoncée.

La CI teste le moteur, les migrations/configurations et les images AMD64/ARM64, sans publier d’image. Les tests navigateur ont été supprimés **avec** l’interface web. La CI vérifie un démarrage hors réseau sans token, l’absence de listener web et un arrêt propre ; ce n’est pas un test sur HAOS réel.

Références : [options natives HA](https://contributors.home-assistant.io/apps/guides/options/), [schéma HA](https://contributors.home-assistant.io/apps/reference/configuration/), [API des options propres à l’application](https://contributors.home-assistant.io/apps/supervisor-api/apps/).
