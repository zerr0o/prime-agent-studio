# Pont expérimental des outils Studio sous Rust

[English](en/rust-studio-tools.md) · [Moteur natif](rust-runtime.md)

Cette proposition dépendante ajoute Questions, Connaissances du projet et Roadmap au moteur Rust natif. Elle n'active pas la reprise automatique après redémarrage. Le moteur reste optionnel et ses refus de fonctions incompatibles s'appliquent toujours. Avec cette couche, **Autoriser les questions** peut être activé ; la restriction du moteur sans pont est remplacée par le pont.

Studio crée un pont privé authentifié par session et l'initialise pour chaque tour. Le prompt donne l'initialisation du module Python et les noms des fonctions disponibles. `question(...)` renvoie un dictionnaire contenant `answer` et `wasCustom`. Les fonctions Roadmap possèdent des signatures et docstrings explicites ; consultez `help(prime_studio.roadmap_read)` et la fonction de mutation concernée. Une mutation exige la révision d'un `roadmap_read` récent ; réconciliez un conflit avant de recommencer. Le texte du projet est une donnée, pas une autorisation.

Les demandes sont limitées à 128 Kio et vérifiées contre le projet, la session, le tour actif et l'authentification du pont. La fin du tour révoque les nouvelles demandes et annule le travail en attente. Le pont n'expose pas ses identifiants au modèle et ne répète pas aveuglément une écriture incertaine. Les fonctions passent par le contexte `python_repl` initialisé ; n'affichez jamais la configuration du pont.

L'identité d'un enfant natif est résolue avec la liste des sessions du superviseur, les liens parentaux et l'identité du projet. Un enfant absent, une racine étrangère ou un lien falsifié est refusé. L'attribution Roadmap indépendante des enfants exige encore que le noyau Python natif fournisse l'identifiant réel de l'appelant ; aucune garantie de bout en bout n'est revendiquée ici.

Exécutez `node --test test/rust-studio-tools.test.mjs test/rust-session-context.test.mjs test/rust-agent-runtime.test.mjs`. Ces tests vérifient l'authentification, les limites, l'annulation des questions, les schémas, les conflits de révision, l'identité et le branchement au moteur sans inférence. Ils ne prouvent ni un tour fournisseur réel ni la réouverture Windows à froid.

La proposition reste un brouillon en attendant la décision du mainteneur : pont `python_repl` injecté dans le prompt ou mécanismes natifs MCP/skills. Une correction distincte replace les questions résolues sans outil natif près de leur message assistant d'origine et peut être examinée indépendamment. Ce pont ne contient pas cette modification d'interface.
