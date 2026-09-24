# Commandes slash, skills et prompts

[English](en/commands.md) · **Français** · [← Retour au README](../README.fr.md)

Tapez **`/` au début du message**, ou appuyez sur le bouton **/** à côté des pièces jointes. Le catalogue du projet propose une recherche, les skills et les prompts installés. Sur PC, utilisez les flèches puis **Entrée** ou **Tab** pour compléter ; une seconde validation envoie le message. Sur mobile, touchez une suggestion. **Échap** ferme les suggestions.

La sélection prépare le message et vous laisse ajouter des arguments. Elle ne lance aucune commande à elle seule.

Une commande validée devient un **chip coloré** dans le champ : violet pour un skill, bleu pour une commande et vert pour un prompt. Écrivez vos arguments à côté, ou en dessous sur mobile. **×** retire le chip et conserve les arguments ; **Retour arrière** au début du texte fait la même chose. Sur PC, **Ctrl/Cmd+A**, puis copier ou couper, inclut la commande. Le brouillon est conservé en texte classique et son chip est restauré après rechargement si la commande est toujours disponible. Les images, documents et envois en cours de tour restent compatibles.

Le menu `/` s’ouvre immédiatement avec les raccourcis du Studio. Les skills et prompts sont chargés en arrière-plan, avec un indicateur de chargement et une possibilité de réessayer. Le catalogue est préchargé lorsque le projet est prêt, puis gardé en mémoire pendant 30 secondes par contexte de session. Les longues listes affichent 30 éléments à la fois, chargent la suite au défilement et restent entièrement recherchables. **Actualiser** relit le catalogue depuis le serveur.

## Raccourcis du Studio

| Commande               | Effet                                                                           |
| ---------------------- | ------------------------------------------------------------------------------- |
| `/help`, `/skills`     | Ouvrir le catalogue, ou directement les skills.                                 |
| `/settings`, `/mcp`    | Ouvrir les préférences ou le gestionnaire MCP.                                  |
| `/model [recherche]`   | Ouvrir le sélecteur de modèles et filtrer ses résultats.                        |
| `/effort [niveau]`     | Choisir `off`, `minimal`, `low`, `medium`, `high`, `xhigh` ou `max`.            |
| `/new`                 | Préparer une nouvelle session dans ce projet. Les autres exécutions continuent. |
| `/name [nom]`          | Renommer la session dans le Studio, ou ouvrir la fenêtre de renommage.          |
| `/session`, `/context` | Afficher le panneau de contexte du Studio.                                      |
| `/copy`                | Copier la dernière réponse de l’agent.                                          |
| `/export`              | Télécharger l’export de conversation du Studio.                                 |
| `/resume`              | Rechercher une session dans la barre latérale.                                  |

Les alias `/clear`, `/rename`, `/thinking` et `/usage` sont reconnus. Le modèle et l’effort se changent entre deux tours. Les raccourcis du Studio s’utilisent sans pièces jointes ; seuls les arguments indiqués ci-dessus sont acceptés. L’export et le panneau de contexte sont ceux du Studio, avec leur présentation propre.

## Commandes natives de session

`/compact [consignes]`, `/refine`, `/goal [objectif ou action]` et `/autonomous [status|on|off]` sont transmis au moteur natif installé. Ils suivent sa syntaxe et ses règles. Par exemple :

```text
/goal status
/compact Conserve les décisions d’architecture et les prochaines étapes
/autonomous status
```

Ces commandes s’écrivent sur une seule ligne, sans pièces jointes. Pendant un tour, **Réorienter** et **À la suite** choisissent leur file native ; une commande attend la limite d’exécution prévue par Prime Agent et n’interrompt pas l’outil en cours. Ses résultats apparaissent dans la conversation et dans l’historique. `/compact` et `/refine` peuvent utiliser le modèle ; définir un objectif ou activer l’autonomie peut prolonger le travail conformément aux réglages natifs.

Les commandes propres au terminal et les commandes d’extensions interactives sont visibles dans l’onglet **Terminal**, avec leur limitation. Elles ne sont jamais envoyées silencieusement au modèle. Le Studio n’ouvre pas de terminal pour les exécuter. `/logout` est notamment une commande d’authentification du fournisseur Prime Agent ; pour fermer l’accès au Studio distant, utilisez **Préférences → Se déconnecter**.

## Skills

Dans les onglets **Skills** et **Prompts**, choisissez **Global · Tous les projets** ou **Projet sélectionné**, puis **Ouvrir le dossier**. Le Studio ouvre le dossier natif correspondant : `~/.prime/agent/skills` ou `prompts` pour le global, `.prime/agent/skills` ou `prompts` dans le projet. Un dossier absent est créé à la demande. Depuis un accès distant en contrôle complet, l’ouverture a lieu sur le PC qui héberge le Studio.

Un skill contient des instructions, et éventuellement des scripts ou un module Python. Pour l’invoquer explicitement :

```text
/skill:nom-du-skill Votre demande et vos contraintes
```

Vous pouvez sélectionner plusieurs skills depuis le bouton **/** : chaque sélection ajoute un chip. **×** retire uniquement le skill choisi. Vous pouvez aussi écrire `/skill:premier /skill:second Votre demande` en début de message.

Pour un seul skill, Prime Agent développe le fichier `SKILL.md`. Pour plusieurs skills, le Studio utilise les fichiers du catalogue natif et le même format de bloc, avec leur dossier de référence. Les skills fonctionnent aussi dans les messages envoyés en cours d’exécution, avec des images ou des documents.

Dans vos messages, chaque contenu développé apparaît dans un bloc **Skill · nom**, replié par défaut. Cliquez pour le lire ; votre demande reste visible. **Copier** copie votre texte sans les instructions développées, ou le message complet si aucun texte ne reste. L’historique natif n’est pas modifié.

Le catalogue utilise la découverte native : skills globaux (`~/.prime/agent/skills`, `~/.agents/skills`), skills du projet et de ses ancêtres (`.prime/agent/skills`, `.agents/skills`), chemins configurés, packages installés et skills intégrés à Prime Agent. La priorité des ressources, les exclusions et les skills réservés à une invocation explicite sont respectés. Le chemin source et la description permettent d’identifier chaque skill.

Pour ajouter un skill Markdown au projet, créez `.prime/agent/skills/mon-skill/SKILL.md` :

```markdown
---
name: mon-skill
description: Vérifier les conventions de ce projet.
---

Lisez les conventions du projet puis analysez la demande de l’utilisateur.
```

Les skills Python nécessitent leurs dépendances dans l’environnement Python du moteur. Le catalogue n’installe ni packages ni dépendances. La configuration et les installations restent natives ; le menu n’exécute aucun script d’extension pour découvrir les ressources.

Une session en cours affiche les ressources réellement chargées par son worker. Les nouveaux fichiers sont pris en compte par les nouvelles sessions ; aucune session active n’est rechargée ou arrêtée par le catalogue.

## Prompts réutilisables

Les fichiers Markdown de `~/.prime/agent/prompts`, `.prime/agent/prompts` et des sources natives configurées deviennent des commandes `/nom`. Les arguments sont développés par Prime Agent, y compris les arguments entre guillemets, `$1`, `$2` et `$ARGUMENTS` :

```text
/review "src/fichier avec espaces.js"
```

Le catalogue et les envois sont disponibles sur PC, mobile et dans la PWA après connexion. Leur lecture ne crée aucune session et ne contacte aucun modèle.
