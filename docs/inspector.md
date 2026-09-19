# Session, agents et fichiers

[English](en/inspector.md) · **Français** · [← Retour au README](../README.fr.md)

Le bouton de panneau en haut à droite du chat ouvre l’espace de travail. Il reste à côté de la conversation sur PC et occupe la hauteur de l’écran sur mobile. Fermer le panneau ou un aperçu conserve la session et son brouillon.

## Session

Retrouvez le projet, l’état de la session, les exécutions actives et l’export de la conversation. Le suivi distingue la génération d’une réponse, l’exécution d’un outil, la réduction du contexte et l’attente des sous-agents.

Le statut du chat distingue aussi une attente de quota, un fournisseur indisponible et l’utilisation du modèle de secours choisi dans les préférences. Ces indications suivent les événements du moteur ; elles ne modifient ni le modèle sélectionné ni les limites de reprise.

La consommation additionne les données enregistrées par Prime Agent sur la branche actuelle de la conversation : tokens entrants, sortants et en cache. Le coût estimé apparaît uniquement si le moteur le fournit ; il ne correspond pas à la facturation de votre abonnement. Ces totaux concernent l’agent principal, pas l’ensemble de ses délégations.

## Agents

Les réglages des sous-agents sont accessibles dès l’ouverture d’une nouvelle conversation, avant le premier message. Ils dépendent du projet choisi ; aucune session Prime Agent ni aucun agent ne sont créés pour les modifier.

En haut de l’onglet, **Sous-agents du projet** utilise les valeurs communes définies dans les préférences du PC lorsque **Globaux** est sélectionné ; les sélecteurs de modèle et de réflexion sont alors masqués. Choisissez **Ce projet** pour les afficher et personnaliser les prochaines délégations. Le sélecteur de modèle reprend le catalogue, la recherche et les favoris des conversations. Un choix s’enregistre automatiquement pour toutes les sessions du projet ; revenir à **Globaux** supprime l’exception. Les agents déjà créés conservent leurs réglages. Ce bloc est utilisable sur PC et sur mobile avec le contrôle complet.

L’agent principal et ses sous-agents apparaissent dans leur hiérarchie, avec leur modèle, leur **niveau de réflexion**, leur état et le dernier résumé disponible. Le niveau provient de la session active ou des changements enregistrés sur sa branche actuelle, jamais du réglage par défaut du Studio. **Non renseignée** indique une donnée absente d’une ancienne session. Cliquez sur une carte pour lire ses échanges, puis utilisez **Actualiser** pour en récupérer les derniers messages.

Les notes envoyées par `rlm.progress_note(...)` apparaissent sur la carte du sous-agent avec sa dernière activité, lorsque le moteur fournit ces données. L’ancienneté utilise le temps actif mesuré par le moteur : une mise en veille du PC ne rend pas les agents artificiellement inactifs. Pendant l’exécution d’un outil, le Studio ne déduit pas une inactivité de sa durée. Ces notes sont du texte et ne constituent pas un verdict de réussite.

Pendant une exécution lancée par le Studio, la liste se rafraîchit toutes les quelques secondes tant que le panneau est visible. Un agent ayant terminé une première tâche peut travailler à nouveau : son activité actuelle est prioritaire sur son ancien statut « terminé ».

Hors exécution, le Studio affiche les délégations conservées dans le registre natif de Prime Agent. **Historique** signifie que des échanges ont été retrouvés mais que l’état actuel de cet agent n’est pas connu. Certaines anciennes sessions n’ont plus de délégations enregistrées. L’indication d’indisponibilité du suivi ne provoque aucun redémarrage.

Le suivi utilise le protocole de Prime Agent **0.9.5**. Consulter une carte ne reprend pas, n’arrête pas et ne détache pas l’agent. La liste présente au plus 200 sous-agents et chaque aperçu les 150 derniers messages ; les raisonnements internes ne sont pas développés dans cet aperçu.

## Fichiers

- **Modifications** affiche les fichiers modifiés, ajoutés et supprimés du projet Git. Cliquez pour lire les ajouts en vert et suppressions en rouge, ou basculez vers **Contenu**.
- **Parcourir** ouvre les dossiers et leurs fichiers. Le fil de navigation remonte au dossier parent ; **Afficher la suite** charge les entrées suivantes par pages de 100.
- **Ouvrir** lance l’application associée au fichier sur le PC qui héberge le Studio. Depuis la PWA ou un autre appareil, le bouton indique **Ouvrir sur le PC**. Le mode distant en lecture seule garde les aperçus mais ne permet pas de lancer une application sur le PC.

Les fichiers **Markdown** (`.md`, `.markdown`, `.mdown`, `.mkd`) s’affichent avec leurs titres, listes, tableaux, citations et blocs de code. Le JSON est indenté dans l’aperçu, en conservant les valeurs originales. **Aperçu / Source** permet de basculer vers le texte exact du fichier sans le recharger. Les autres fichiers texte conservent leur indentation et les fichiers HTML restent du texte, sans exécution.

Le diff compare le contenu actuel au dernier commit, en incluant les changements indexés et ceux du dossier de travail. Il concerne **tout le projet** : plusieurs sessions ou une modification manuelle peuvent contribuer aux mêmes fichiers. Aucune attribution automatique à un agent n’est faite. Sans Git, le parcours des fichiers reste disponible.

Les liens Markdown vers les documents du projet et les références de fichier écrites en code dans les messages sont cliquables. Ils ouvrent un aperçu avec le même bouton **Ouvrir**, sans changer de session ni perdre le brouillon. Les chemins relatifs, absolus et `file://` sont reconnus, y compris les références à une ligne. Un simple nom de fichier est recherché dans le projet ; si plusieurs fichiers portent ce nom, le Studio vous laisse choisir.

Les aperçus acceptent les textes UTF-8 jusqu’à 512 Kio et les images PNG, JPEG, GIF ou WebP jusqu’à 8 Mio. La mise en forme concerne uniquement l’affichage : elle ne modifie pas les fichiers du projet. Les fichiers supprimés ont un diff mais ne peuvent plus être ouverts. Sous Windows, les scripts et le code s’ouvrent comme texte dans le Bloc-notes ; les exécutables et raccourcis ne sont pas lancés par cette commande. Si un fichier texte n’a pas d’application associée, le Studio utilise le Bloc-notes.

L’accès reste limité aux projets enregistrés et au code d’accès distant habituel. Les dossiers techniques (`.git`, `node_modules`, `.local`, etc.), les données privées du moteur et les liens sortant du projet sont exclus. Le mode distant en lecture seule autorise ces consultations sans autoriser de commandes sur l’agent.
