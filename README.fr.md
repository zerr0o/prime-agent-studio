<p align="center">
  <img src="assets/prime-agent.svg" width="80" alt="Logo Prime Agent Studio">
</p>

<h1 align="center">Prime Agent Studio</h1>

<p align="center"><a href="README.md" lang="en">English</a> · <strong>Français</strong></p>

<p align="center">
  <a href="https://github.com/zerr0o/prime-agent-studio/releases/latest"><img src="https://img.shields.io/github/v/release/zerr0o/prime-agent-studio?logo=github&amp;label=release" alt="Dernière release GitHub"></a>
  <a href="https://github.com/zerr0o/prime-agent-studio/stargazers"><img src="https://img.shields.io/github/stars/zerr0o/prime-agent-studio?logo=github&amp;label=stars" alt="Étoiles GitHub"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="Licence MIT"></a>
  <a href="#démarrage-rapide"><img src="https://img.shields.io/badge/Node.js-%3E%3D22.8-339933?logo=nodedotjs&amp;logoColor=white" alt="Node.js 22.8 ou ultérieur"></a>
  <a href="#démarrage-rapide"><img src="https://img.shields.io/badge/platform-Windows-0078D4" alt="Plateforme Windows"></a>
</p>

<p align="center">
  <strong>Pilotez vos agents. Gardez le fil de vos projets.</strong><br>
  Votre espace de travail pour Prime Agent, sur Windows et sur mobile.
</p>

<p align="center">
  <a href="https://github.com/zerr0o/prime-agent-studio/releases/latest"><strong>Télécharger pour Windows</strong></a> ·
  <a href="#démarrage-rapide">Démarrage rapide</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="docs/changelog.md">Nouveautés</a>
</p>

![Prime Agent Studio : projets, conversations et sous-agents réunis dans une interface sombre.](docs/screenshots/desktop-conversation.png)

_Interface réelle, données de démonstration. Les contenus et mesures affichés sont fictifs._

**Prime Agent Studio** réunit conversations, sous-agents, outils et suivi de projet dans une interface locale. Lancez plusieurs tâches, suivez leur progression et intervenez au bon moment, sans jongler entre les terminaux. Retrouvez le même Studio depuis votre téléphone.

## Un seul espace pour avancer

|                                  | Ce que vous gagnez                                                                                                             |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Des conversations organisées** | Ordre stable, épingles, recherche et déplacement par glisser-déposer ou menu. Vos échanges ne remontent plus à chaque message. |
| **Un suivi concret**             | Roadmap partagée avec les agents : plans, tâches imbriquées, backlog et liens vers les conversations.                          |
| **Le contrôle en direct**        | Réorientez une tâche, préparez le message suivant et répondez aux questions de l’agent sans arrêter son travail.               |
| **Vos modèles et vos outils**    | Fournisseurs, favoris, réflexion, sous-agents, skills et connexions MCP dans la même interface.                                |
| **Images et documents**          | Joignez vos fichiers par sélection, glisser-déposer ou collage ; consultez les images du projet dans les réponses.             |
| **Le contexte à portée de main** | Historique, mémoires natives, refinements, fichiers, contexte courant et quota Codex lorsqu’ils sont disponibles.              |
| **La continuité entre PC**       | Exportez conversations et Roadmap en `.pastudio`, puis importez-les dans un autre projet sans effacer les échanges locaux.     |

### La Roadmap, à côté du travail

Passez d’une idée à un plan, confiez-le à un agent et retrouvez la conversation associée. Agrandissez le panneau, repliez les tâches et gardez une vue claire de ce qu’il reste à faire.

![Roadmap agrandie : plans, tâches imbriquées et progression dans un projet fictif.](docs/screenshots/roadmap-expanded.png)

[Découvrir la Roadmap →](docs/roadmap.md)

### Reprenez sur un autre PC

Le menu du projet propose **Exporter / Importer `.pastudio`**. L’archive conserve les historiques natifs, les sous-agents et la Roadmap — **pas les fichiers du projet ni les réglages fournisseurs**. Choisissez le dossier de destination : les conversations existantes restent intactes et les doublons d’archive sont détectés.

Les conversations importées sont marquées lues. Leur modèle est conservé s’il est utilisable ; sinon, le modèle par défaut du PC prend le relais. L’export/import s’effectue depuis le Studio ouvert sur chaque PC, pas depuis un navigateur distant.

[Transfert, limites et précautions de confidentialité →](docs/navigation.md)

## Sur PC. Sur téléphone. Sans perdre le fil.

- **Windows** : une fenêtre dédiée, un écran de connexion au lancement et une présence discrète près de l’horloge. Fermer la fenêtre laisse les agents travailler.
- **Mobile** : accédez au Studio par Wi-Fi ou Tailscale, avec un code d’accès. Installez la PWA en HTTPS et activez les notifications de questions et de fins de tour par appareil.
- **Mises à jour** : consultez les notes de version et installez depuis le panneau dédié. Le pilotage des mises à jour depuis mobile nécessite l’application Windows active, un accès autorisé en écriture et aucun agent en cours.

Le PC doit rester allumé. Sur iPhone, les notifications nécessitent iOS 16.4 ou ultérieur, la PWA installée sur l’écran d’accueil et votre autorisation. L’accès distant est conçu pour vos réseaux privés, **pas pour une exposition directe sur Internet**.

[Accès distant](docs/lan.md) · [PWA et notifications](docs/pwa.md) · [Application Windows](docs/desktop.md)

## Démarrage rapide

### Application Windows — recommandé

1. [Téléchargez le dernier installateur Windows x64](https://github.com/zerr0o/prime-agent-studio/releases/latest), puis ouvrez **Prime Agent Studio**.
2. Si nécessaire, cliquez sur **Installer les composants manquants**. Node.js est inclus ; Prime Agent 0.9.4, uv et Python se préparent à la demande. Git Bash reste nécessaire pour les commandes shell.
3. Connectez votre fournisseur, ajoutez le dossier d’un projet et lancez votre première conversation.

Au quotidien, le Studio privilégie l’ouverture de la fenêtre principale. Le diagnostic complet reste accessible dans les réglages, avec l’étape en cours affichée.

**Version actuelle : 3.6.1.** Les mises à jour utilisent une signature vérifiée par Tauri ; l’installateur n’a pas encore de signature Windows Authenticode. Après une mise à jour, redémarrez le serveur depuis les préférences une fois les agents terminés. [Guide complet →](docs/desktop.md)

### Depuis les sources

Avec Windows, Node.js ≥ 22.8, uv et Prime Agent installés, depuis le dépôt cloné :

```powershell
npm ci
npm run setup:runtime
npm run start:silent
```

Ouvrez [127.0.0.1:3088](http://127.0.0.1:3088). Configurez un fournisseur avant le premier message. [Installation et développement →](docs/development.md)

## Documentation

[Projets, conversations et archives](docs/navigation.md) · [Modèles et configuration](docs/configuration.md) · [Fournisseurs](docs/providers.md) · [MCP](docs/mcp.md) · [Commandes et skills](docs/commands.md) · [Agents et fichiers](docs/inspector.md) · [Connaissances](docs/knowledge.md) · [Langues](docs/translations.md)

## Licence

Développé par **[zerr0o](https://github.com/zerr0o)**, sous [licence MIT](LICENSE). Copyright © 2026 zerr0o. Prime Agent et les dépendances tierces conservent leurs licences respectives.
