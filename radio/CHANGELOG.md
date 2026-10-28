# 0.2.0

## Configuration native Home Assistant

- Suppression du panneau web, de l’ingress, du serveur HTTP et des dépendances/tests navigateur. Aucune nouvelle commande Discord.
- Sources multiples, volume, activation de lecture et intervalles se règlent dans **Configuration** ; enregistrer puis redémarrer. Afficher les options facultatives pour les sources si nécessaire.
- Migration des anciennes sources et du volume effectif vers les options propres à l’application, sans permission supplémentaire, token affiché ni perte de cache. En cas d’échec, conservation de l’ancien état et nouvelle tentative au prochain démarrage.
- `sources: []` désactive toutes les sources ; les caches retirés sont conservés et comptent encore dans les quotas. Rafraîchir Configuration après la migration.
- Journaux de connexion/import et erreurs expurgés. Le watchdog ne dépend plus d’un port web.

## Vocal et ressources

- Suit les déplacements vers les salons créés par le serveur sans renvoyer le compte au salon de création. Cible conservée pour la reprise ; un changement explicite de Configuration reste prioritaire.
- Attente de connexion avant FFmpeg, récupération vocale avec temporisation et arrêt annulable.
- Revalidation HTTP conditionnelle des fichiers directs : pas de téléchargement, FFprobe ou réécriture sur réponse 304. Les origines sans validateurs sont toujours rafraîchies.
- Suppression des écritures répétées d’état inchangé et des lectures de métadonnées réservées à l’ancienne interface.

Installation HAOS, migration via Supervisor réel et écoute Discord restent à valider sur l’appareil cible. Aucun test n’utilise de token réel.
