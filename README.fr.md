<p align="center">
  <img src="assets/prime-agent.svg" width="64" alt="Logo Prime Agent Studio">
</p>

<h1 align="center">Prime Agent Studio</h1>

<p align="center">
  <strong>Vos projets. Vos agents. Un seul espace.</strong><br>
  Un espace de travail Windows pour <a href="https://github.com/PrimeIntellect-ai/prime-agent">Prime Agent</a>, dans l’application et le navigateur.
</p>

<p align="center"><a href="README.md" lang="en">English</a> · <strong>Français</strong></p>

<p align="center">
  <a href="https://github.com/zerr0o/prime-agent-studio/releases/latest"><img src="https://img.shields.io/github/v/release/zerr0o/prime-agent-studio?logo=github&amp;label=release" alt="Dernière version"></a>
  <a href="#démarrage-rapide"><img src="https://img.shields.io/badge/platform-Windows-0078D4" alt="Windows x64"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="Licence MIT"></a>
</p>

<a id="sommaire"></a>

<p align="center">
  <a href="https://github.com/zerr0o/prime-agent-studio/releases/latest"><strong>Télécharger pour Windows</strong></a> ·
  <a href="#démarrage-rapide">Démarrage rapide</a> ·
  <a href="#documentation">Documentation</a> ·
  <a href="docs/changelog.md">Nouveautés</a>
</p>

https://github.com/user-attachments/assets/3ac0cccf-c95b-4add-a6fe-64eee66845dd

<p align="center"><em>La présentation complète · 76 secondes · avec son · 9,4 Mo.<br>Filmée avec Studio 4.3.0, des projets fictifs et des exécutions d’agents simulées.</em></p>

## Votre espace, à votre façon

<a id="un-espace-pour-chaque-projet"></a>

Organisez jusqu’à **16 conversations et 16 panneaux d’outils** avec des onglets déplaçables et des divisions. Verrouillez un outil sur son projet ou laissez-le suivre la conversation active. Enregistrez vos dispositions, ou gardez la vue classique.

Chaque conversation conserve son brouillon, ses pièces jointes et sa position de lecture. Fermer un onglet n’arrête pas son agent et ne supprime pas la conversation ; le serveur doit rester actif.

![Conversations modulaires et Roadmap, présentées en vue éclatée dans le film. Projets de démonstration fictifs.](docs/media/prime-agent-studio-workspace.jpg)

## De la demande au travail terminé

- <a id="vos-modèles-à-portée-de-main"></a>**Choisissez vos agents.** Connectez les comptes fournisseurs ou les clés API pris en charge. Réglez les modèles et les niveaux de raisonnement des conversations et des sous-agents, avec des valeurs par défaut propres à chaque projet.
- <a id="pendant-que-lagent-travaille"></a><a id="images-questions-et-pièces-jointes"></a>**Gardez le dialogue.** Suivez les réponses en direct, orientez un agent actif, préparez un message de suivi, répondez à ses questions et joignez des images ou des fichiers.
- <a id="roadmap-du-projet"></a><a id="connaissances-du-projet"></a>**Planifiez et retrouvez.** Partagez une Roadmap avec les agents : plans, tâches imbriquées et backlog. Recherchez les travaux passés, les mémoires natives et les améliorations du harness, avec leurs sources.
- <a id="session-agents-et-fichiers"></a>**Inspectez et livrez.** Suivez les sous-agents et la consommation de tokens. Prévisualisez les fichiers, examinez les diffs Git, gérez les branches, commitez les fichiers sélectionnés et poussez sans quitter Studio.
- <a id="commandes-skills-et-mcp"></a>**Ajoutez vos outils.** Retrouvez commandes, skills et prompts de projet avec `/`. Connectez des serveurs MCP, notamment HTTP, stdio et OAuth.
- **Organisez vos travaux.** Colorez les projets, épinglez et recherchez les conversations, archivez les anciens échanges ou transférez conversations et Roadmaps avec les archives `.pastudio`.

Thèmes sombre, clair et système. Français et anglais. Vos sessions et votre configuration Prime Agent existantes.

## Computer Use

Laissez un agent observer et contrôler le **vrai bureau Windows**, pour une conversation à la fois. Activez explicitement **Autoriser le Computer Use** ; l’option est désactivée par défaut. Computer Use utilise notre moteur natif Windows.

Ce n’est ni un environnement isolé ni une validation clic par clic. Les captures sont envoyées au fournisseur du modèle sélectionné. Utilisez **Arrêter Computer Use** ou **Ctrl+Alt+Shift+F10** pour arrêter les entrées sans interrompre les autres agents. [Guide Computer Use →](docs/computer-use.md)

## Continuez sur vos appareils

<a id="aussi-depuis-votre-téléphone"></a>
<a id="installer-le-studio-comme-une-application"></a>

**Depuis votre téléphone :** ouvrez Studio sur un réseau local de confiance ou une connexion privée Tailscale, ou installez sa PWA. Choisissez la consultation ou le contrôle complet. Le PC hôte doit rester allumé pour exécuter les agents. [Accès mobile](docs/lan.md) · [PWA et notifications](docs/pwa.md)

**Entre PC :** synchronisez, si vous le souhaitez, conversations et Roadmaps dans **votre propre bucket Cloudflare R2**, avec un contenu chiffré avant l’envoi. Retrouvez les travaux déjà envoyés même si le PC source est éteint. Cela ne synchronise pas les dossiers de projet et ne déplace pas les agents actifs entre machines. Réglez cette option dans **Préférences → Synchronisation**.

## Connectez vos outils externes

L’**API publique**, à activer explicitement, relie applications externes et scripts aux projets, conversations, exécutions, événements en direct, Roadmaps et fichiers liés. Utilisez des jetons limités à des projets et assortis d’une expiration ; l’autorisation Computer Use demande une permission explicite distincte. L’administration des jetons reste locale. [Guide API](docs/api.md) · [Contrat OpenAPI](docs/api/openapi-v1.json)

## Démarrage rapide

1. <a id="application-windows"></a><a id="application-windows-et-mises-à-jour"></a>**Installez.** Téléchargez l’[installateur Windows x64](https://github.com/zerr0o/prime-agent-studio/releases/latest), puis ouvrez **Prime Agent Studio**. Node.js est inclus.
2. **Préparez.** Au premier lancement, choisissez **Réparer Studio** pour télécharger le moteur et les composants manquants, ou réutilisez une installation existante. **Git Bash est requis séparément.** La configuration initiale demande Internet.
3. **Lancez un projet.** Connectez un fournisseur de modèles, ajoutez un dossier de projet avec **+**, choisissez un modèle et envoyez votre première demande.

Les agents travaillent sur votre PC. Les appels aux modèles et aux outils peuvent transmettre des données aux services configurés ; des frais fournisseurs peuvent s’appliquer.

Le Studio vérifie les mises à jour au démarrage et toutes les 30 minutes ; **Mise à jour disponible** s’affiche alors à côté de **Préférences**. La réparation prépare les composants ; un redémarrage explicite les active. Les mises à jour utilisent les signatures Tauri ; l’installateur n’a pas encore de signature Windows Authenticode. [Installation, données et mises à jour →](docs/desktop.md)

<details>
<summary><strong>Lancer depuis les sources</strong></summary>

Nécessite **Windows, Node.js 22.13+, uv, Git Bash et Prime Agent installé**. Clonez ce dépôt ou extrayez l’archive des sources, puis lancez :

```powershell
npm ci
npm run setup:runtime
npm run start:silent
```

`setup:runtime` prépare Python et les skills ; il n’installe pas Prime Agent. Studio s’ouvre sur [127.0.0.1:3088](http://127.0.0.1:3088). Utilisez ensuite `Lancer Prime Agent.vbs`. `npm run stop` arrête le serveur et ses agents actifs ; fermer un onglet du navigateur ne le fait pas.

Pour mettre à jour une installation Git, attendez la fin des exécutions :

```powershell
npm run stop
git pull --ff-only
npm ci
npm run setup:runtime
npm run start:silent
```

Pour une installation par archive, remplacez les fichiers de Studio en conservant `.local`, puis répétez la préparation. Les sessions natives Prime Agent restent dans leur propre stockage. [Développement et vérifications →](docs/development.md)

</details>

## Documentation

| Pour commencer | Guides |
| --- | --- |
| **Configurer** | [Application Windows](docs/desktop.md) · [Configuration](docs/configuration.md) · [Fournisseurs](docs/providers.md) |
| **Travailler** | [Projets et conversations](docs/navigation.md) · [Messages vocaux](docs/voice.md) · [Roadmap](docs/roadmap.md) · [Connaissances du projet](docs/knowledge.md) |
| **Utiliser les outils** | [Agents et fichiers](docs/inspector.md) · [Commandes et skills](docs/commands.md) · [MCP](docs/mcp.md) · [Computer Use](docs/computer-use.md) |
| **Connecter** | [Accès mobile](docs/lan.md) · [PWA](docs/pwa.md) · [API publique](docs/api.md) |
| **Contribuer** | [Développement](docs/development.md) · [Traductions](docs/translations.md) · [Changelog](docs/changelog.md) · [Discussions](https://github.com/zerr0o/prime-agent-studio/discussions) |

## Licence et attribution

Développé par **[zerr0o](https://github.com/zerr0o)**. Copyright © 2026 zerr0o. Distribué sous [licence MIT](LICENSE) : utilisation, modification et redistribution, y compris commerciales, en conservant la notice de copyright et le texte de licence. Prime Agent et les dépendances tierces gardent leurs licences respectives.
