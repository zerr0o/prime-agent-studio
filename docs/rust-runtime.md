# Moteur Rust expérimental

[English](en/rust-runtime.md)

Studio conserve son moteur JavaScript Prime Agent par défaut. Définissez `PRIME_STUDIO_RUST_CLI` avec le chemin absolu d'un exécutable officiel Prime Agent 0.10 pour activer Rust. Cette option de développement n'est pas activée par l'installateur de bureau.

Pointez `PRIME_AGENT_CLI` vers les métadonnées JavaScript du paquet npm officiel, `legacy/prime-agent/dist/bundle/cli.js`, ou vers son dossier imbriqué `legacy/prime-agent`. Le dossier `dist` principal contient des wrappers, pas ces métadonnées. Installez les dépendances imbriquées avec `npm install --ignore-scripts`. Ce paquet est requis au démarrage ; seuls les modèles annoncés par l'exécutable natif entrent au catalogue. Les métadonnées JavaScript enrichissent les identifiants correspondants sans ajouter de fournisseurs réservés à JavaScript.

Utilisez des dossiers dédiés pour `PRIME_AGENT_CODING_AGENT_DIR` et `PRIME_AGENT_SESSION_DIR`. Rust démarre un daemon privé sans rejoindre un daemon utilisateur existant. Le hello du protocole v7, l'identité du superviseur, la propriété du client et l'identité session/projet sont vérifiés. Une mutation incertaine n'est pas répétée automatiquement. Ne faites pas écrire deux moteurs dans le même dossier de sessions.

Cette proposition contient uniquement le moteur natif et l'adaptateur du client de session. Le pont Python Studio et la reprise automatique après redémarrage sont des propositions dépendantes distinctes. Sans le pont, désactivez **Autoriser les questions** pour les exécutions natives ; sinon l'exécution est refusée explicitement avant la création de session. Le prompt natif indique que les fonctions Studio Questions, Connaissances et Roadmap sont indisponibles.

| Fonction | Comportement natif et limite |
| --- | --- |
| Tours et annulation | Création, attachement, prompt, événements, libération du worker propriétaire et annulation avant nettoyage. La fin headless attend la quiescence RLM ; l'échec des vérifications autonomes ou l'épuisement de leurs limites échoue l'exécution. |
| Questions, Connaissances et Roadmap | Aucun assistant Studio dans le moteur de base. Le pont examiné séparément les fournit via un adaptateur par tour. Les outils natifs restent disponibles. |
| Reprise après redémarrage | Aucun journal ni continuation automatique dans le moteur de base. La reprise explicite exige l'identité native exacte ; la reprise automatique est une proposition distincte. |
| Computer Use et politique des sous-agents | Computer Use et les choix Studio de modèle/réflexion des sous-agents sont explicitement refusés. Les sous-agents natifs existent sans le hook JavaScript. |
| Fournisseurs Meta et Muse-Code | Le fournisseur Meta JavaScript est refusé. L'extension OAuth Muse-Code n'est pas chargée ; seuls les fournisseurs natifs sont proposés. Aucune parité fournisseur n'est revendiquée. |
| Images et fichiers | Les prompts natifs acceptent les images. La couche HTTP enregistre les pièces jointes ordinaires et les décrit dans le prompt ; l'entrée directe `files` du moteur est refusée. Les images du projet restent liées à leur chemin d'origine et ne sont pas archivées. La provenance du routage d'images natif reste à valider. |
| Préférences | La création reçoit le modèle et la réflexion sélectionnés. La réflexion en direct exige `session_scoped_preferences` avant l'envoi de `set_thinking_level`, sinon elle est refusée pour protéger les valeurs globales. Aucun changement de modèle en direct dans cet adaptateur. |
| Extensions Studio 4.4 | Les budgets d'exécution/projet, le contexte de code indexé activé et les relances de quota autorisées sont refusés avant la création native. Les hooks JavaScript de budget, contexte, métriques et quota ne fonctionnent pas sous Rust. Aucune parité des métriques ou de la jauge de contexte Studio n'est revendiquée. |
| Autres hooks JavaScript | Les hooks contexte, image, RPC/headless, noyau, transport et flux daemon ne sont pas chargés. Le daemon natif, la quiescence et l'instruction d'affichage d'images remplacent certains chemins seulement ; ce n'est pas une parité des extensions. |

Exécutez `node --test test/rust-*.test.mjs test/live-session-client.test.mjs` pour les tests isolés. `node scripts/rust-native-canary.mjs CHEMIN_ABSOLU_DU_BINAIRE` utilise un dossier temporaire et `--offline` pour vérifier le hello, la création, l'attachement, l'état et la libération sans inférence. Ce test ne prouve ni l'accès fournisseur, ni Windows, ni la parité. N'utilisez pas de données ou d'identifiants de production.

L'ancien essai Windows de réouverture à froid a échoué pendant que le worker précédent conservait son verrou. Le moteur amont a depuis ajouté le support des verrous Windows, mais ce candidat n'a pas de preuve fraîche de réouverture Windows ou de fournisseur réel. Cette proposition reste un brouillon jusqu'à ces vérifications et à l'accord du mainteneur sur l'interface des extensions.
