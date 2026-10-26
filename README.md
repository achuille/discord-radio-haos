# Discord Radio · Home Assistant OS

Une radio hébergée sur Home Assistant OS, avec une interface intégrée pour gérer plusieurs dossiers Google Drive publics ou URL audio directes. Les morceaux sont mis en cache sur HAOS : aucun PC ni navigateur à laisser allumé.

> **Prototype expérimental.** La compatibilité complète, l'installation HAOS et la diffusion vocale réelle restent à valider. Le mode compte utilisateur automatisé (*selfbot*) contrevient aux règles Discord et expose le compte à une suspension, même s'il est dédié ou jetable. [Règle officielle](https://support.discord.com/hc/en-us/articles/115002192352-Automated-User-Accounts-Self-Bots).

[Dépôt GitHub](https://github.com/achuille/discord-radio-haos) · [Résultats CI](https://github.com/achuille/discord-radio-haos/actions)

## Installation en bref

1. Ajouter `https://github.com/achuille/discord-radio-haos` au magasin d'applications HA et installer **Discord Radio**.
2. Saisir le token **uniquement dans la configuration HA**, puis les identifiants du serveur et du salon vocal.
3. Ouvrir l'interface dans Home Assistant et y ajouter les sources publiques.
4. Activer **Démarrer au démarrage** et **Chien de garde**, puis vérifier la lecture dans Discord.

[Guide détaillé, sécurité et dépannage →](radio/DOCS.md)

## Conception

- Interface Home Assistant via ingress, sans port publié sur l'hôte.
- Sources et cache audio conservés dans `/data`, jamais dans GitHub.
- Un morceau et un processus FFmpeg à la fois ; Opus natif et prise en charge DAVE.
- Aucun accès à l'API HA, au socket Docker, aux périphériques audio ou au réseau de l'hôte.
- Démarrage automatique et reprises prévues pour un usage prolongé, sans garantie de diffusion ininterrompue.
- Node.js 22, architectures HA `amd64` et `aarch64`. Les performances et la compatibilité ARM64 restent à vérifier sur matériel.

Ne diffusez que des contenus pour lesquels vous avez les droits nécessaires. La licence MIT couvre le code, pas les enregistrements audio. Aucun fichier musical, identifiant Drive personnel ou secret n'est inclus.

## Développement

Depuis `radio/` : `npm ci`, puis `npm test`. Utiliser une version de Node compatible avec `package.json`. Construire l'image depuis le même dossier : `docker build -t discord-radio:test .`. Conserver `package-lock.json` dans le dépôt.

La première installation compile l'image sur HAOS : elle nécessite Internet, du stockage libre et une charge temporaire supérieure à la lecture. Aucune image précompilée n'est annoncée. La base officielle `node:22-bookworm-slim` reçoit les mises à jour de sa branche ; les dépendances npm sont verrouillées séparément. Sans S6, `init: true` laisse Supervisor fournir l'init.

### Avant une mise en service 24/7

- Construire et tester l'image sur AMD64 et ARM64 ; vérifier FFmpeg, Opus et DAVE.
- Valider une véritable source Drive publique, une URL audio directe et la gestion des liens invalides.
- Tester sur HAOS l'interface ingress, ses restrictions d'accès et la persistance de `/data`.
- Tester une vraie lecture Discord, une perte réseau, un redémarrage HAOS et un fichier corrompu.
- Mesurer CPU/RAM/température en lecture prolongée et vérifier l'absence de secrets dans les journaux.

Sources : [schéma HA](https://contributors.home-assistant.io/apps/reference/configuration/), [ingress HA](https://contributors.home-assistant.io/apps/guides/ingress/), [bibliothèque voice](https://discord.js.org/docs/packages/voice/stable).

La CI est configurée pour tester le code et construire AMD64/ARM64, sans publier d’image. Sa présence ne signifie pas qu’une exécution a déjà réussi ; consulter les résultats du commit utilisé.
