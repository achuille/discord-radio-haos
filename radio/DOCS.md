# Installer et configurer Discord Radio sur HAOS

**Version 0.2.0 expérimentale.** La connexion authentifiée, le son audible, l’installation et les performances sur votre HAOS restent à valider. Le mode selfbot contrevient aux règles Discord et peut entraîner une suspension du compte. Ne jamais envoyer de token en conversation, dans une issue ou sur GitHub.

## Installation

Dans HA : **Paramètres → Applications → Installer une application → ⋮ → Dépôts**, ajouter `https://github.com/achuille/discord-radio-haos`, puis installer **Discord Radio**. « Applications » peut s’appeler « Modules complémentaires » selon la version. [Procédure officielle HA](https://contributors.home-assistant.io/apps/guides/repository/).

Laisser le **mode protégé** activé. La compilation initiale peut prendre du temps sur une petite machine ; ne pas installer Node ou Docker sur l’hôte HAOS. Vérifier les [résultats CI](https://github.com/achuille/discord-radio-haos/actions) de la version utilisée.

## Configuration native

Tout se règle dans l’onglet **Configuration** de l’application HA. Il n’y a plus de bouton « Ouvrir l’interface web », d’ingress, de panneau latéral ni de commandes Discord. Après modification : **Enregistrer puis redémarrer**. Les options sont lues au démarrage, conformément au [fonctionnement HA](https://contributors.home-assistant.io/apps/guides/options/).

| Option | Effet |
| --- | --- |
| `discord_token` | Token du compte dédié, champ masqué ; jamais dans une URL ou un journal |
| `auth_mode` | `selfbot` uniquement ; pas de token de bot officiel |
| `guild_id` | Identifiant texte du serveur Discord |
| `voice_channel_id` | Identifiant du salon vocal de départ, y compris un salon de création automatique |
| `sources` | Liste de 20 URL publiques maximum ; afficher les **options facultatives** si nécessaire |
| `volume` | De `0` à `1`, défaut `0.6` |
| `playback_enabled` | `true` par défaut ; `false` suspend lecture et connexion vocale, sans arrêter la synchronisation |
| `scan_interval_seconds` | Analyse du cache local, `60` par défaut ; de `10` à `3600` |
| `sync_interval_seconds` | Rafraîchissement des sources, `900` par défaut ; de `60` à `86400` |
| `max_track_seconds` | Garde-fou par piste, `14400` par défaut ; de `30` à `86400` |

Exemple pour les **sources** en mode YAML (conserver vos autres options ; remplacer les exemples par vos propres liens) :

```yaml
sources:
  - "https://drive.google.com/drive/folders/IDENTIFIANT_PUBLIC"
  - "https://example.com/musique.mp3"
volume: 0.6
playback_enabled: true
```

Une liste explicitement vide, `sources: []`, désactive toutes les sources. Omettre entièrement `sources` conserve les sources déjà connues, notamment pendant une migration. Une source retirée devient inéligible à la lecture au redémarrage ; son cache n’est **pas supprimé automatiquement**. Le réajout réutilise les fichiers, mais les anciens caches comptent toujours dans les limites de stockage. Si une purge est nécessaire, arrêter l’application et effectuer une sauvegarde avant toute intervention administrateur sur son stockage privé.

Le compte doit déjà avoir accès au serveur, avec **View Channels**, **Connect**, **Speak** dans les salons concernés. Aucune permission Administrator nécessaire. Utiliser un salon vocal ordinaire, pas une scène. Copier les identifiants depuis Discord après activation de **Paramètres → Avancés → Mode développeur**.

Les champs de connexion peuvent rester vides pour préparer les sources. Aucune connexion vocale n’est tentée tant qu’aucune piste n’est disponible ou que `playback_enabled` est désactivé. Le champ masqué ne protège pas toutes les copies/sauvegardes : sécuriser l’accès administrateur et les sauvegardes HA. Le token n’est pas copié dans `settings.json` ni dans l’état vocal.

## Mise à jour depuis 0.1

1. Sauvegarder l’application avant mise à jour. Ne pas supprimer `/data`.
2. Au premier démarrage, si `sources` n’a pas encore été défini dans la configuration native, l’application reprend les sources et le **volume effectif** de l’ancien `settings.json`. Les identifiants de cache sont conservés.
3. Elle lit ses propres options brutes auprès du Supervisor, ajoute ces sources et ce volume, puis vérifie la relecture. Les autres options, dont les références `!secret`, sont conservées. Aucun accès supplémentaire n’est activé : `/addons/self/...` est autorisé pour chaque application, même sans `hassio_api`. [Documentation officielle](https://contributors.home-assistant.io/apps/supervisor-api/apps/).
4. Si les Journaux annoncent la migration réussie, **rafraîchir l’onglet Configuration** avant de l’éditer. Les sources et le volume y sont désormais enregistrés. Les démarrages suivants ne répètent pas la migration.
5. Si le Supervisor ne répond pas ou refuse la migration, les paramètres effectifs et le cache restent intacts ; un message indique la migration en attente. Une seule tentative bornée est faite par démarrage, pas de boucle de requêtes. Redémarrer pour réessayer, ou définir explicitement les sources et le volume dans Configuration. Une liste native explicite, même vide, est toujours prioritaire.

L’application ne réécrit pas `/data/options.json` pour simuler une migration : ce fichier est produit par HA au démarrage. La migration native réelle reste à confirmer sur une installation HAOS ; ses branches succès, erreur, reprise et liste vide sont testées avec un Supervisor simulé.

## Sources et lecture

- Dossiers **Google Drive publics**, accessibles sans connexion. Le projet ne change aucun partage Google et n’utilise ni OAuth ni rclone.
- URL directe de fichier audio public HTTP(S), HTTPS recommandé. Une page de lecteur, YouTube ou Spotify n’est pas un fichier audio. Aucun contournement de connexion, CAPTCHA ou DRM.
- Téléchargement borné et validation FFprobe avant lecture. Consulter les **Journaux** pour les succès/échecs d’import. Une panne de rafraîchissement conserve les fichiers valides déjà présents.
- Au démarrage puis à chaque intervalle de synchronisation, les fichiers directs sont revalidés. Si le serveur fournit ETag/Last-Modified et répond `304`, ni téléchargement, ni nouvelle validation FFprobe, ni réécriture du cache. Sans validateurs, le fichier est retéléchargé. Drive réutilise ses métadonnées pour les fichiers inchangés.
- Lecture aléatoire par cycles : toutes les pistes disponibles passent avant le cycle suivant, sans répétition immédiate quand plusieurs pistes sont disponibles. Pas de réglage d’ordre de lecture dans cette version.
- Pour suspendre : désactiver `playback_enabled`, enregistrer et redémarrer. Pour reprendre : le réactiver et redémarrer ; la reprise n’est pas au même instant du morceau. Arrêter l’application HA arrête également les imports. Un redémarrage relance une synchronisation immédiate.
- Un déplacement vocal par le serveur (par exemple création d’un salon à votre nom) met à jour la cible au lieu de réimposer le salon de création. La cible effective est conservée pour les reprises, mais un changement de serveur/salon dans Configuration prend la priorité. Si le salon temporaire mémorisé a réellement été supprimé, la reprise repasse une fois par le salon de départ pour en créer un nouveau ; une erreur réseau ou de permission ne déclenche pas ce retour.

## Ressources et surveillance

Un seul FFmpeg et une seule piste à la fois. Le moteur attend une connexion vocale prête avant de décoder ; les erreurs de connexion ne mettent pas les pistes valides en quarantaine. Les journaux signalent les transitions et les erreurs par messages fixes, sans token, URL source ou nom de fichier ; les messages répétitifs sont limités.

Activer **Démarrer au démarrage** dans HA. Le **Chien de garde** du Supervisor peut surveiller l’arrêt du conteneur ; aucun point HTTP `/health` ni port 8080 n’est conservé. Cela ne mesure ni l’audibilité de la radio ni la disponibilité de Discord. Les erreurs fatales du moteur entraînent un arrêt pour permettre la reprise par Supervisor.

Limites : **20 sources, 500 fichiers audio en cache, 2 Gio au total, 256 Mio par fichier**, réserve disque de 256 Mio. Chaque dossier Drive doit avoir moins de 50 entrées ; la pagination non prise en charge est signalée, pas ignorée. Sous-dossiers limités à trois niveaux. Les liens privés, réseaux locaux, symlinks de cache et flux infinis ne sont pas pris en charge.

## Dépannage et validation sur votre installation

- **Pas de connexion :** consulter les Journaux ; vérifier token/mode, identifiants, accès et permissions. Attendre l’import d’une piste. Le trafic Discord sortant et vocal UDP doit être possible.
- **Pas de son :** vérifier `playback_enabled`, le volume, Speak, sourdine serveur et les erreurs d’import.
- **Drive refusé :** ouvrir le lien sans compte Google ; vérifier partage, droits de téléchargement et quotas. Ne pas modifier automatiquement le partage.
- **Cache plein :** retirer une source de la liste arrête sa lecture mais ne purge pas son ancien cache. Ne pas supprimer les données sans sauvegarde.
- **Migration en attente :** redémarrer pour réessayer ; ne pas publier `options.json`, `settings.json` ou les liens privés dans un diagnostic.
- **Interruption :** vérifier Internet, UDP, espace disque et charge HA ; ne pas désactiver le mode protégé ni accorder Administrator.

Avant usage prolongé : tester du son audible, un passage de piste, un déplacement vers un salon créé, une reprise réseau et un redémarrage HAOS ; mesurer CPU/RAM/température sur votre machine. Aucune disponibilité permanente n’est garantie. Si un token fuit, le révoquer/remplacer puis mettre à jour la configuration HA.
