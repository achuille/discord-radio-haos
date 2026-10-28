# Discord Radio

Radio Discord et cache local, gérés exclusivement dans l’onglet **Configuration** natif Home Assistant : sources audio publiques, volume, lecture et paramètres de démarrage. Aucun panneau web ni commande Discord.

**Expérimental :** installation HAOS et diffusion réelle encore à valider. Le mode selfbot expose le compte à une suspension ; lire les limites dans le [README du dépôt](../README.md).

[Installation, migration et dépannage](DOCS.md)

Saisir le token seulement dans la configuration HA. Enregistrer puis redémarrer après une modification. Les anciennes sources et le volume sont migrés sans supprimer le cache ; si la migration échoue, l’ancienne configuration reste active.
