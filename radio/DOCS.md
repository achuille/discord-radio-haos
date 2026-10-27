# Installer Discord Radio sur Home Assistant OS

**Version expérimentale.** L'installation sur HAOS et la diffusion Discord réelles doivent encore être validées. Les limites du mode selfbot sont indiquées dans le [README](../README.md). Aucun token ne doit être envoyé en conversation, dans une issue ou sur GitHub.

## 1. Installer l'application

URL du dépôt : `https://github.com/achuille/discord-radio-haos`. Vérifier les [résultats CI du commit utilisé](https://github.com/achuille/discord-radio-haos/actions) avant installation ; un dépôt publié ne vaut pas validation sur HAOS.

Dans HA : **Paramètres → Applications → Installer une application → ⋮ → Dépôts**, ajouter cette URL, puis installer **Discord Radio**. Selon la version, « Applications » peut s'appeler « Modules complémentaires ». [Procédure officielle HA](https://contributors.home-assistant.io/apps/guides/repository/).

La compilation initiale peut prendre du temps sur une petite machine. Ne pas installer Node ou Docker sur l'hôte HAOS et laisser le **mode protégé** activé.

## 2. Configurer la connexion Discord

Le compte dédié doit déjà avoir accès au serveur et au salon vocal. Il lui faut seulement les permissions **View Channels**, **Connect** et **Speak** dans ce salon : aucune permission Administrator n'est nécessaire. Utiliser un vocal ordinaire, pas une scène, et laisser une place libre si le nombre de participants est limité. [Permissions Discord](https://docs.discord.com/developers/topics/permissions).

Dans Discord : **Paramètres → Avancés → Mode développeur**. Clic droit sur le serveur → **Copier l'identifiant du serveur** ; clic droit sur le salon → **Copier l'identifiant du salon**. Utiliser ces identifiants, pas les noms.

Dans l'onglet **Configuration** de l'application HA :

| Option | Usage |
| --- | --- |
| `discord_token` | Token du compte dédié ; champ masqué |
| `auth_mode` | `selfbot` — seul mode de cette version |
| `guild_id` | Identifiant du serveur, conservé comme texte |
| `voice_channel_id` | Identifiant du salon vocal, conservé comme texte |
| `volume` | `0.6` par défaut, entre `0` et `1` |
| `scan_interval_seconds` | Scan de la bibliothèque locale : `60` par défaut |
| `max_track_seconds` | Garde-fou de durée par morceau : `14400` par défaut |

Les trois champs de connexion peuvent rester vides pour ouvrir le panneau et préparer les sources ; la connexion Discord nécessite ensuite les trois valeurs. Saisir le token uniquement ici. Il n'est pas demandé dans le panneau web et ne doit pas être mis dans une URL. Le champ masqué protège l'affichage, pas toutes les copies ou sauvegardes : protéger aussi le compte administrateur et les sauvegardes HA. L'application lit les options dans `/data/options.json` ; après modification, enregistrer puis redémarrer. [Options HA](https://contributors.home-assistant.io/apps/guides/options/).

Le mode bot officiel n'est pas implémenté dans cette version. Ne pas saisir un token de bot officiel dans ce mode.

## 3. Ajouter les sources audio

Démarrer l'application, puis **Ouvrir l'interface web**. Le panneau passe par la session Home Assistant ; il n'ouvre aucun port public supplémentaire. Il peut être affiché dans la barre latérale. [Ingress HA](https://contributors.home-assistant.io/apps/guides/ingress/).

Ajouter les sources dans le panneau :

- **Google Drive :** lien d'un dossier public, accessible sans connexion. Un lien de dossier privé ne devient pas public parce qu'il est ajouté ici. Le projet ne change aucun partage Google.
- **URL audio directe :** adresse HTTPS d'un fichier audio ; une page de lecteur web, YouTube ou Spotify n'est pas une URL audio directe. Aucun contournement de connexion ou de DRM n'est prévu.

Plusieurs sources peuvent être enregistrées. Les paramètres des sources restent dans `/data/settings.json` et les fichiers téléchargés dans `/data/audio`. Aucun OAuth Google ni rclone n'est requis pour ces sources publiques. Les téléchargements et leur validation sont effectués avant lecture ; consulter l'état d'import dans l'interface avant d'attendre du son. Une source publique peut néanmoins refuser ou limiter les téléchargements : quotas, fichier supprimé, page de confirmation ou restriction du propriétaire doivent être signalés, jamais présentés comme une réussite.

Un dossier public réel de 11 MP3 (13,6 Mo) a été importé anonymement et ses fichiers validés par FFprobe. Le test complet a utilisé un transport de test via le proxy autorisé de l’environnement ; le transport Node direct reste à valider sur HAOS. Cette vérification ne garantit pas tous les liens Drive. Ne pas copier les liens personnels dans le dépôt ou dans les captures publiques. Surveiller l'espace disque : le cache est local à HAOS.

## 4. Laisser tourner

Activer **Démarrer au démarrage** et **Chien de garde**, rejoindre le salon et vérifier le son. Le processus utilise une seule piste à la fois. Le point `/health` du port interne 8080 sert au Supervisor ; le port n'est pas publié sur l'hôte.

L'accès sortant à Discord, dont le trafic vocal UDP avec réponses, est nécessaire. Une coupure Internet ou une panne Discord peut interrompre la radio ; aucune solution ne garantit littéralement une diffusion sans interruption pour toujours. Avant usage prolongé, vérifier une reprise après perte réseau puis après redémarrage HAOS, et mesurer la charge sur le matériel réel.

## Dépannage

- **Pas de connexion Discord :** vérifier le mode/token correspondant, les identifiants, l'accès au serveur, les permissions du salon et le réseau. Ne pas publier le token dans les journaux de diagnostic.
- **Connecté sans son :** vérifier volume, permission Speak, mise en sourdine côté serveur et présence d'au moins un fichier importé valide.
- **Import Drive impossible :** ouvrir le lien en navigation privée, sans connexion Google ; vérifier les droits de téléchargement et les quotas. Ne pas modifier automatiquement le partage.
- **URL refusée :** utiliser un véritable fichier HTTPS public, pas une page HTML ni une ressource locale ou privée du réseau.
- **Interruptions :** vérifier réseau/UDP, stockage libre et charge HA ; ne pas accorder Administrator ni désactiver le mode protégé pour tenter de corriger.
- **Arrêter :** arrêter l'application dans HA ; désactiver son démarrage automatique si elle ne doit pas revenir après redémarrage.

Ne partager que des journaux relus et expurgés. Si un token fuit, le révoquer ou remplacer selon le type de compte, puis actualiser la configuration HA.

## Commandes et limites

- Lecture aléatoire par cycles : toutes les pistes disponibles passent avant le cycle suivant, sans répétition immédiate s’il y en a plusieurs.
- Pause arrête le morceau ; Reprendre sélectionne le prochain morceau aléatoire. Le volume change pendant la lecture.
- Synchronisation automatique toutes les 15 minutes et bouton de synchronisation manuelle. Les URL audio directes sont retéléchargées et validées ; Drive réutilise les fichiers inchangés selon ses métadonnées.
- Retirer une source arrête son import et supprime seulement son cache local, jamais le dossier Drive ou le fichier distant.
- Maximum 20 sources, 500 pistes en cache, 2 Gio de cache et 256 Mio par fichier. Une réserve disque de 256 Mio est conservée.
- Chaque dossier Drive doit contenir moins de 50 entrées ; au-delà, un message signale la pagination au lieu de prétendre avoir tout importé. Sous-dossiers limités à trois niveaux.
- Les pages de confirmation de téléchargement, connexions, CAPTCHA, liens privés, adresses réseau locales et flux audio infinis ne sont pas pris en charge.
- L’adaptateur vocal réessaie les erreurs réseau avec temporisation puis attend cinq minutes après une série échouée. Une erreur de token, de droits ou une vérification demandée par Discord exige une intervention, pas un contournement automatique.
