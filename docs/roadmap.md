# Roadmap du projet

**Français** · [English](en/roadmap.md) · [← Retour au README](../README.fr.md)

La Roadmap rassemble les travaux prévus, les checklists et les conversations qui les traitent. Elle appartient au projet sélectionné. Le PC, le téléphone et les agents du Studio consultent le même document ; ouvrir ce panneau ne lance aucun agent ni appel de modèle.

## Organiser le travail

À l’intérieur d’un plan contenant des sous-tâches, **Tout replier / Tout déplier** agit sur tous les niveaux de tâches de ce plan. Le plan reste ouvert ; en mode replié, seules ses tâches principales et leurs compteurs restent visibles. Les autres plans et les descriptions conservent leur état.

Ouvrez **Roadmap** depuis le projet ou l’onglet **Session** du panneau de droite. **Projet** présente la vision facultative, les jalons et leurs plans. **Session** retrouve les plans liés à la conversation actuelle. **Backlog** conserve les idées, les tâches non engagées et les notes.

Sur PC, le bouton **Agrandir la roadmap** en haut du panneau ouvre une vue sur tout l’espace de travail. **Réduire la roadmap** ou Échap revient au panneau latéral. Les jalons, plans et tâches parentes se replient en cliquant sur leur titre ; le compteur en bout de ligne reste visible et suit les tâches cochées. Les descriptions sont masquées par défaut : **Afficher la description** les ouvre, **Masquer la description** les replie. Ces choix de lecture sont conservés pendant les actualisations et les changements de taille du panneau, sans modifier les données du projet.

Une Roadmap absente reste vide jusqu’à son initialisation explicite. Ajoutez un plan, puis ses tâches et notes. Les checklists acceptent trois niveaux. Les menus permettent de modifier, regrouper, déplacer ou supprimer explicitement les éléments. Des poignées de glisser-déposer réorganisent les jalons, les tâches et le backlog ; les menus gardent les actions disponibles au clavier et sur téléphone.

Le compteur mesure les tâches terminales cochées, une fois chacune. Un groupe reflète ses enfants et sa case applique le même état à tous. Changer le statut d’un plan ne coche pas ses tâches. Les plans abandonnés restent consultables et sortent du compteur du projet ; les plans en pause y restent. Le backlog est compté séparément.

Le menu d’un plan propose **Archiver**. Les plans archivés quittent les vues **Projet** et **Session**, les listes de jalons et les compteurs. Ils restent visibles dans l’onglet **Archivés** avec son compteur, en lecture seule, avec **Restaurer** (ou **Désarchiver**) et **Supprimer**. L’archivage demande la révision courante comme les autres modifications et ne supprime aucune donnée (un plan existant sans indicateur reste visible). Les agents ne voient pas les plans archivés et toute modification d’un agent sur un plan archivé est refusée.

Sur téléphone, le panneau utilise la hauteur de l’écran. L’accès distant en lecture seule permet de consulter et de suivre les liens, sans modifier la Roadmap ni lancer un travail.

Chaque plan avec des tâches affiche aussi son pourcentage. Les cases terminées sont vertes ; les groupes partiellement terminés gardent leur couleur. **Reste à faire uniquement** masque les tâches cochées sans changer la progression réelle. Les parents et les notes restent accessibles ; désactivez le filtre pour retrouver toutes les tâches.

## Confier une tâche et retrouver son résultat

L’action **Travailler dessus** prépare un message à partir des éléments choisis. L’envoi reste explicite et utilise les conversations et la file du Studio. Le lien conservé permet de retrouver la conversation ; il ne la relance pas. Les références natives de sous-agents peuvent ouvrir leur historique via la conversation parente, y compris après leur arrêt.

Dans la fenêtre de confirmation, **Instructions complémentaires (optionnel)** permet d’ajouter jusqu’à 4 000 caractères de précisions. Elles accompagnent le message envoyé sans modifier les tâches de la roadmap.

Un agent peut déclarer les éléments sur lesquels il travaille. Le lien d’activité indique son identité exacte et mène à sa conversation. Il disparaît à la fin de sa boucle de travail, à l’arrêt de son exécution ou à la perte du propriétaire. Une continuation ne récupère pas automatiquement l’ancien indicateur. Ce signal exprime une déclaration de travail ; il ne prouve pas qu’une tâche est terminée.

Les notes et le journal court d’un plan donnent le contexte du résultat sans recopier la conversation. **Connaissances du projet** conserve sa fonction de recherche dans les travaux passés, mémoires et refinements natifs. [Guide des connaissances](knowledge.md).

## Outils disponibles pour les agents

Les nouvelles exécutions du Studio et leurs sous-agents reçoivent six outils via l’extension native de Prime Agent 0.9.6. Aucun fork du moteur n’est nécessaire.

| Outil               | Rôle                                                                                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `roadmap_read`      | Lire une vue synthétique, un plan ou le backlog, avec les références stables et la révision courante. Les grandes listes sont paginées et les extraits tronqués sont signalés. |
| `roadmap_plan`      | Initialiser explicitement la Roadmap, créer ou modifier un plan, gérer ses tâches et son journal, ou lier sa conversation.                                                     |
| `roadmap_check`     | Cocher ou rouvrir une ou plusieurs tâches d’un même plan dans une seule écriture.                                                                                              |
| `roadmap_backlog`   | Ajouter, modifier, déplacer, cocher, supprimer ou convertir des éléments et notes numérotés.                                                                                   |
| `roadmap_milestone` | Modifier la vision et les jalons qui regroupent les plans.                                                                                                                     |
| `roadmap_work`      | Déclarer une activité temporaire sur des éléments existants, ou l’effacer avec une liste vide.                                                                                 |

Le projet et l’identité de l’agent viennent du contexte natif, jamais des arguments du modèle. Le serveur vérifie la conversation active et la filiation des enfants dans les données natives. Les outils rejoignent le même service d’écriture que l’interface par un canal local privé. Un plan créé par un agent est lié par défaut à sa conversation racine ; les autres liens qu’il ajoute sont limités à sa propre conversation ou à sa racine.

Les éditions exigent la révision lue. Après un conflit, l’agent doit relire et réconcilier son changement ; la modification n’est pas rejouée automatiquement. Les outils ne démarrent pas de goals, ne lancent pas d’autres agents et ne cochent rien à partir d’un statut ou d’un événement de fin. Les plans et todos internes du moteur ne sont pas importés automatiquement.

## Stockage, conflits et limites

Le document de référence est `.prime/studio/roadmap.json` dans le projet. Les écritures sont atomiques et sérialisées avec une révision attendue ; deux modifications concurrentes ne remplacent pas silencieusement le travail de l’autre. Un conflit conserve la saisie de l’éditeur pour permettre une reprise après actualisation. Les brouillons ne sont pas publiés tant que l’édition n’a pas réussi.

L’export Markdown sert à lire ou partager une copie. Modifier cet export ne modifie pas la Roadmap. L’édition simultanée du JSON dans un outil externe n’est pas prise en charge. Un document invalide reste intact et produit une erreur distincte d’une Roadmap vide. Les mémoires, refinements et historiques natifs ne sont pas réécrits.

Le fichier est limité à 4 Mio. L’activité reste en mémoire et disparaît au redémarrage du serveur ; elle n’est jamais enregistrée comme une preuve de présence dans le document. Les accès en lecture seule sont également vérifiés côté serveur.

## Vérifications

`node --test test/roadmap*.test.mjs` couvre le stockage, les conflits, les accès HTTP, l’identité des agents et les liens vers les conversations. `node scripts/test-roadmap-native.mjs` vérifie les six outils dans de vrais processus Prime Agent parent et enfant avec un fournisseur déterministe local, sans requête à un modèle externe.

`node scripts/test-roadmap-native-packaged.mjs` refait cette preuve depuis une copie isolée des ressources de bureau, avec un Node copié lancé hors du dépôt. Il ne modifie pas l’application installée ni les sessions utilisées par l’utilisateur.
