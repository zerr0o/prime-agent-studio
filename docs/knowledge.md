# Connaissances du projet

**Français** · [English](en/knowledge.md) · [← Retour au README](../README.fr.md)

Disponible depuis la version 3.0.0, cette vue permet de retrouver les travaux passés d’un projet, ses mémoires de session et les refinements enregistrés par Prime Agent. Les mémoires et refinements globaux sont affichés avec la mention **Global** et restent partagés entre projets.

## Consulter une source

Ouvrez **Connaissances du projet** depuis l’onglet **Session** de l’espace de travail à droite, sous **Copier le chemin**. Le bouton est aussi disponible dans la vue du projet et son menu **⋯**. Recherchez quelques mots d’une décision, d’un problème ou d’une solution, puis filtrez par **Travaux passés**, **Mémoires**, **Prompts**, **Skills**, **Subagents** ou **Refinements**. Ces quatre derniers filtres montrent les entrées natives du harness enregistrées par Prime Agent. **Global** n’affiche que les entrées partagées entre projets. La recherche ignore la casse et les accents ; tous les mots saisis doivent être présents. Il s’agit d’une recherche textuelle, sans appel à un modèle.

Sélectionnez un résultat pour consulter son contenu et sa **Source exacte**. Les dates affichées proviennent des fichiers natifs. Une date absente n’est pas inventée. Les refinements montrent les modifications avant/après lorsqu’elles ont été enregistrées ; une modification non appliquée reste signalée comme telle.

**Ouvrir la conversation** rejoint la session d’origine et son message quand celui-ci est affichable. Les sources des sous-agents terminés restent consultables même si leur session ne figure pas dans la navigation principale. Dans ce cas, le Studio affiche le fichier et la référence native sans proposer de lien de conversation indisponible.

Sur téléphone, le résultat s’ouvre dans le même panneau. **Résultats** revient à la liste. La consultation est aussi disponible à travers un accès distant authentifié en lecture seule.

## Corriger le harness

**Annuler ce refinement** pré-remplit `/refine rollback <id>` dans la conversation qui possède ce refinement. **Corriger** pré-remplit `/refine Corriger <type>:<id> :` pour une mémoire, un prompt, un skill ou un subagent ; décrivez la correction, puis envoyez. Les entrées globales utilisent `--global` dans la conversation courante. Rien n’est exécuté avant l’envoi. Prime Agent applique la commande et enregistre un nouveau refinement ; le Studio n’écrit jamais lui-même dans `harness_state.json`.

## Réutiliser les travaux avec un agent

Les nouvelles exécutions lancées par le Studio disposent de deux outils, `studio_knowledge_search` et `studio_knowledge_read`. Leurs sous-agents en héritent. Par exemple : « Retrouve comment nous avons corrigé ce problème de calibration dans les sessions précédentes, puis vérifie si cette solution convient encore. »

L’agent recherche dans son projet d’exécution et consulte les sources utiles. L’outil ne lui permet pas de choisir un autre projet. Le contenu d’une ancienne conversation reste une référence à vérifier ; il ne remplace pas votre demande actuelle. Les recherches n’ajoutent pas automatiquement tout l’historique au contexte. Une exécution lancée avant l’activation de cette fonction doit se terminer ; les outils seront disponibles lors de la reprise de la session.

### Choisir les mémoires partagées

L’option de conversation **Injecter les mémoires partagées** est désactivée par défaut, y compris pour une ancienne conversation sans choix enregistré. Activez-la avant l’envoi pour réutiliser les mémoires globales. Le choix est conservé pour cette conversation et transmis à ses sous-agents ; il ne devient pas le défaut des nouvelles conversations. Attendez la fin de l’exécution avant de le modifier.

Lorsque l’option est désactivée, le moteur n’injecte pas les mémoires globales ni les résumés de refinements globaux. Les outils `studio_knowledge_search` et `studio_knowledge_read` les excluent aussi, même avec une référence obtenue auparavant. Les mémoires locales et les travaux du projet restent disponibles. La vue **Connaissances du projet**, destinée à votre consultation, continue d’afficher les sources globales.

Ce réglage ne supprime aucun fichier ni les informations déjà échangées dans l’historique. Les instructions globales, skills, définitions de sous-agents et connexions MCP restent indépendants. Il ne limite pas les accès aux fichiers, au réseau ou aux autres agents : ce n’est pas une sandbox. Pour repartir sans les informations déjà reçues, créez une nouvelle conversation avec l’option désactivée.

## Sources et limites

Les fichiers JSONL natifs restent la source de vérité. Le Studio consulte la branche courante de chaque conversation, les sous-agents conservés dans les dossiers d’artefacts natifs, les entrées du `harness_state.json` et les événements natifs `prime-agent.refinement`. L’historique de refinement reste consultable après un changement de branche. Les mémoires et refinements globaux sont partagés entre projets par Prime Agent.

La consultation ne modifie ni mémoires, ni refinements, ni conversations ; seule une commande que vous envoyez modifie le harness. Il n’y a pas de second moteur de mémoire ou de processus d’indexation permanent. Un cache local dérivé, dans `knowledge-index` du dossier de données du Studio, évite de relire les conversations inchangées. Les ajouts en fin de fichier sont lus progressivement. Ce cache peut être supprimé lorsque le Studio est fermé ; il sera reconstruit à la prochaine recherche.

Les extraits et les modifications volumineuses sont limités et signalés. Certaines sources illisibles ou trop grandes peuvent être omises avec un avertissement. Les arguments et résultats d’outils, les images et les réflexions privées ne sont pas indexés. Les réponses et mémoires peuvent contenir des informations sensibles : les accès distants authentifiés disposent des mêmes droits de consultation que pour l’historique.

## Vérifications

`npm run test:knowledge` vérifie l’interface sur des fichiers synthétiques, en français et anglais, sur PC et mobile. `npm run test:navigation` vérifie les projets et conversations imbriqués. `npm test` couvre les sources, les limites, l’isolation des projets, les écritures concurrentes du cache et les accès HTTP.

`npm run test:shared-memories:native` vérifie le contexte envoyé au fournisseur local simulé : conversations simultanées, héritage des sous-agents, changement du choix, reprise et conservation des mémoires locales. Les filtres de compactage et de résumé de branche sont aussi couverts par les tests unitaires. Aucun modèle distant n’est appelé.

`npm run test:knowledge:native` vérifie les appels réels des outils par Prime Agent et un sous-agent avec un fournisseur local simulé, sans requête à un modèle externe. Après `npm run desktop:resources`, `npm run test:knowledge:packaged` vérifie les mêmes ressources copiées hors du dépôt, avec plusieurs lecteurs concurrents.
