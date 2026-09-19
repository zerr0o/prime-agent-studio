# Application Windows

[English](en/desktop.md) · **Français** · [← Retour au README](../README.fr.md)

L’application **Prime Agent Studio**, construite avec Tauri 2, ouvre le Studio dans une fenêtre Windows dédiée. Son raccourci lance le serveur discrètement ou réutilise celui déjà ouvert. Aucun lancement manuel du VBS n’est nécessaire.

## Installation et premier lancement

Exécutez l’installateur [Prime-Agent-Studio_3.6.1_x64-setup.exe](https://github.com/zerr0o/prime-agent-studio/releases/download/v3.6.1/Prime-Agent-Studio_3.6.1_x64-setup.exe). L’installation est limitée à votre utilisateur Windows et propose les raccourcis du menu Démarrer et du Bureau. Node.js est inclus. L’installateur installe WebView2 si nécessaire ; une connexion Internet peut être requise pour ce composant.

Les builds incluant la préparation guidée téléchargent **Prime Agent, npm privé, uv et Python** à la demande. Ces composants ne sont pas embarqués dans l’installateur. Aucune installation préalable de Node, npm ou Python, modification du PATH ou commande de terminal n’est nécessaire. Une connexion réseau initiale est requise. **Git Bash reste un prérequis séparé** pour les commandes shell du moteur ; son absence est signalée. Cette fonctionnalité dans les sources ne modifie pas les installateurs déjà publiés.

Au premier lancement, consultez l’état des composants puis choisissez **Installer les composants manquants**, **Choisir une installation existante** ou **Plus tard — ouvrir le Studio**. Le téléchargement nécessite le clic explicite sur le bouton d’installation. « Plus tard » conserve les réglages et l’historique ; les actions du moteur demandent de terminer la préparation. Après validation, configurez un fournisseur dans **Connexions** : la préparation ne connecte aucun compte et n’envoie aucun prompt payant. Si vous utilisiez le dépôt avec le lanceur VBS, choisissez **Reprendre une installation existante** et sélectionnez son dossier, celui qui contient `server.mjs` et `.local`.

La reprise copie les projets, les réglages des sous-agents, les pièces jointes et les accès distants, avec leur PIN. L’installation d’origine est conservée. Si son serveur fonctionne encore, l’application s’y connecte immédiatement et reporte la copie au premier lancement où il sera arrêté. Elle ne coupe aucune exécution. Les sessions Prime Agent restent dans leur emplacement habituel. Après cette reprise, utilisez l’application pour ouvrir le Studio ; l’ancien lanceur conserve sa propre copie des réglages.

Les préférences visuelles et brouillons du navigateur ne sont pas copiés : la fenêtre Tauri dispose de son propre stockage, partagé entre ses ouvertures.

## Préparation, réparation et compatibilité

**Préférences → Système → Composants du Studio → Configurer**, ou **Réglages de l’application** depuis l’icône près de l’horloge, retrouve le même diagnostic. La sélection existante accepte la racine du paquet Prime Agent, `uv.exe` ou `python.exe`. Les variables `PRIME_AGENT_CLI`, `PRIME_GUI_UV` et `PRIME_AGENT_KERNEL_PYTHON` sont prioritaires, suivies de la sélection enregistrée, de l’installation gérée puis des emplacements externes habituels. Un chemin explicite invalide doit être corrigé ; il n’est pas remplacé automatiquement. Un Python externe valide est seulement vérifié, sans installation dans son environnement et sans imposer uv.

Dans les sources actuelles, la politique versionnée dans `lib/desktop-components.mjs` associe le Studio à **Prime Agent 0.9.5**, **npm 10.9.4** et **uv 0.8.22**, avec Python 3.11. Le packaging accepte Windows x64 avec Node 22 ≥ 22.16 ou Node 24 ; le moteur exige ≥ 22.8. Une prochaine version de Studio peut demander un autre moteur précis : le bouton installe alors cette version après accord explicite. Aucun suivi périodique, sélection aveugle de « stable », ni mise à jour des installations externes.

La préparation lit le contrat d’origine dans [l’installateur officiel](https://app.primeintellect.ai/prime-agent/install.sh), sans exécuter ce script. L’archive du moteur et les trois paquets Prime associés sont contrôlés contre l’inventaire `releases/v<version>/SHA256SUMS`. npm provient du [registre officiel versionné](https://registry.npmjs.org/npm/10.9.4), vérifié par son intégrité SHA-512 avant extraction ; il est exécuté avec le Node Studio par `npm-cli.js`. L’archive [uv Windows x64](https://github.com/astral-sh/uv/releases/tag/0.8.22) est vérifiée contre son fichier `.sha256`. Ces références HTTPS de même origine assurent l’intégrité du transfert, pas une signature indépendante. Les hôtes autorisés sont fixes et toute rotation d’origine échoue de façon fermée. Un moteur externe détecté automatiquement n’est pas exécuté : choisissez-le explicitement pour lui accorder votre confiance. Avec Prime Agent 0.9.5, `dist/bundle/cli.js` est un lanceur qui délègue à `dist/bundle/cli-node.js` ; la validation exige le paquet complet (les deux fichiers) et conserve le chemin public `cli.js` dans ses reçus, tandis que l’exécution gérée utilise l’entrée Node directe pour préserver PID et hooks.

Les scripts npm sont désactivés (`--ignore-scripts`). Le postinstall Prime prépare seulement ses outils facultatifs et son propre noyau lorsqu’on le lui demande ; Studio utilise `ensureLocalKernel`. L’installation conserve les ressources et dépendances complètes, vérifie les imports natifs des fournisseurs, modèles, commandes, MCP et Photon avant validation. npm conserve son lockfile pour diagnostiquer les dépendances transitives résolues. uv télécharge son Python géré si nécessaire (`UV_PYTHON_DOWNLOADS=automatic`, `UV_PYTHON_PREFERENCE=only-managed`). Le code existant vérifie les imports Python, le protocole du noyau et les skills essentiels. Les outils optionnels, notamment fd/rg et les intégrations avec comptes, ne sont pas tous installés par cette préparation.

Les composants résident dans `engine/prime-agent/<version-id>`, `engine/uv/<version-id>`, `engine/npm/<version-id>` et `engine/python`, sous le dossier de données. `engine/prepared.json` conserve les composants validés pour une reprise ; `engine/installation.json` sélectionne atomiquement les chemins, versions, provenances et empreintes après validation Python. `engine/selection.json` contient les sélections explicites. Les noyaux restent dans `.local`. Les archives passent par un staging neuf, avec limites de taille et refus des traversées, liens et noms Windows ambigus. Les versions précédentes et les installations externes ne sont jamais supprimées.

La progression expose les étapes réelles et les octets reçus, sans pourcentage global inventé. Une annulation ou une erreur permet de réessayer sans perdre les composants déjà validés. Un verrou empêche deux préparations simultanées et récupère un propriétaire arrêté. Les journaux `engine/logs/components.log` contiennent seulement étapes, codes et octets. Les téléchargements ne démarrent ni à l’ouverture d’une page distante ni à la connexion Windows.

Une préparation terminée redémarre uniquement le serveur dont Studio vérifie la propriété et l’absence d’activité. Si des agents travaillent ou si le serveur appartient à un autre lanceur, l’activation reste différée jusqu’à un redémarrage approprié. Aucun processus Node global n’est arrêté. Les générations du moteur et du noyau restent disponibles pour les processus existants.

## Fenêtre et arrière-plan

- **Fermer la fenêtre** la masque et conserve l’icône près de l’horloge. Les agents, le serveur et les accès mobiles continuent.
- Un clic sur cette icône ou un nouveau lancement du raccourci retrouve la même fenêtre.
- Le menu de l’icône propose **Ouvrir le Studio**, **Réglages de l’application** et **Quitter l’application**. Quitter ferme Tauri, mais laisse le serveur et les agents travailler.
- Dans **Réglages de l’application**, **Démarrer avec Windows** est désactivé par défaut. L’activer lance le Studio en arrière-plan à votre connexion, sans ouvrir sa fenêtre. Une erreur de démarrage affiche la fenêtre pour permettre une nouvelle tentative.
- Les liens externes s’ouvrent dans votre navigateur habituel. Le LAN, Tailscale, HTTPS et la PWA mobile utilisent toujours le même serveur.

Au quotidien, la fenêtre principale affiche d’abord un état de connexion (« Votre espace se prépare »), puis ouvre le Studio : elle réutilise le serveur actif ou le démarre. Les réglages ne s’affichent qu’en cas de configuration nécessaire, d’erreur, ou d’ouverture explicite via `--settings` ou le menu. Avant un démarrage à froid, le lanceur vérifie rapidement le reçu d’installation (versions, provenance, chemins, marqueur Python) sans exécuter de composant ; en cas de changement ou d’échec, utilisez **Vérifier à nouveau** ou **Installer les composants manquants**, qui affichent chaque étape (moteur, Python, shell, uv).

Pour retrouver un serveur arrêté, ouvrez **Réglages de l’application → Ouvrir le Studio**. Ce bouton réutilise une instance existante et n’arrête pas les agents.

Un raccourci Windows peut utiliser l’argument `--settings` pour ouvrir directement les réglages de l’application, y compris lorsqu’elle fonctionne déjà en arrière-plan.

## Données et mises à jour

Les données se trouvent dans `%LOCALAPPDATA%\com.primeagent.studio` :

| Emplacement    | Contenu                                                                         |
| -------------- | ------------------------------------------------------------------------------- |
| `data`         | Projets, pièces jointes, PIN haché, configuration réseau et journaux du serveur |
| `.local`       | Noyaux Python persistants                                                       |
| `versions`     | Copies immuables des fichiers du serveur et de Node.js                          |
| `webview`      | Préférences visuelles et stockage de la fenêtre                                 |
| `desktop.json` | Préférences du lanceur et installation à reprendre                              |

Une mise à jour installe la nouvelle application et prépare une nouvelle copie du serveur. **Préférences → Mise à jour** distingue la version de l’application installée de celle du serveur actif. Les anciennes copies ne sont pas effacées automatiquement afin de préserver les processus encore actifs.

**Passage à la version 3.0.0 :** si l’ancien serveur reste actif après l’installation, le Studio affiche encore sa version et ses fonctions. Attendez la fin des agents, puis utilisez **Préférences → Mise à jour → Redémarrer le serveur** dans l’application Windows pour charger la V3. La [navigation par projets dépliables](navigation.md) et les [connaissances du projet](knowledge.md) deviennent alors disponibles ; les nouvelles exécutions et leurs sous-agents reçoivent les outils de recherche et de lecture de l’historique.

Le correctif **2.8.1** ajoute une réparation ponctuelle au lancement : les dix assistants absents de la release 2.8.0 sont ajoutés à son cache d’origine, même si son serveur fonctionne encore. Les fichiers existants sont conservés. Cette réparation rétablit notamment les messages, la découverte des skills et les fournisseurs sans arrêter les agents.

Dans le Studio, ouvrez **Préférences → Mise à jour → Vérifier les mises à jour**. Si une version stable plus récente est publiée sur GitHub, ses nouveautés et le bouton **Installer et relancer** apparaissent. Le téléchargement affiche sa progression, puis Tauri vérifie la signature avant de lancer l’installation. Aucune installation ne démarre sans ce clic.

L’option **Redémarrer le serveur après l’installation** applique la nouvelle version si le serveur est libre. Si des agents travaillent encore, le serveur reste actif et les réglages s’ouvrent au retour. **Redémarrer le serveur** affiche alors une confirmation : le redémarrage peut interrompre les exécutions et déconnectera temporairement les appareils. Les projets et l’historique enregistré sont conservés. L’activité est vérifiée de nouveau avant l’arrêt ; un serveur lancé par une autre installation n’est pas arrêté.

Ces contrôles restent accessibles dans **Réglages de l’application**, depuis l’icône près de l’horloge, même si l’ancien serveur ne possède pas encore cette catégorie. Depuis un navigateur ou un téléphone, le panneau permet de consulter les versions et les nouveautés. Avec un accès en écriture, vous pouvez confirmer une demande de mise à jour : l’application Windows doit être active et aucun agent ne doit travailler. L’installation et le redémarrage restent exécutés par l’application Windows, qui vérifie à nouveau les conditions. Le pilotage courant du Studio depuis mobile reste disponible pendant le travail des agents.

Les liens web, y compris la connexion Codex, s’ouvrent dans le navigateur habituel. Le dépôt de fichiers utilise directement le compositeur HTML ; aucune passerelle de fichiers supplémentaire n’est nécessaire. Seules les commandes de mise à jour et de redémarrage sont autorisées depuis la fenêtre locale du Studio ; les autres réglages natifs restent réservés au lanceur.

Une erreur réseau, un catalogue absent ou une signature invalide ne sont jamais présentés comme « à jour ». Vous pouvez réessayer ; les détails techniques sont dans `desktop-update-error.log`, dans le dossier de données. Le catalogue devient disponible lors de la première release contenant `latest.json`. La vérification est manuelle, sans interrogation périodique en arrière-plan.

Les mises à jour portent une signature cryptographique Tauri. Les installateurs ne possèdent pas encore de signature Windows Authenticode : celle-ci demande un certificat Windows distinct.

## Construire et vérifier

`npm run test:components` vérifie le résolveur, les téléchargements par serveur local, les empreintes, les archives hostiles, les verrous et le parcours FR/EN dans Edge sans installation réelle. `npm run test:components:download` exige les ressources `.desktop-build` : il lance le Node embarqué dans un dossier temporaire isolé avec un PATH local réduit, télécharge réellement les composants, prépare Python, vérifie `/api/version` et refuse tout téléchargement à la seconde préparation. Il conserve son dossier de diagnostic et ne masque ni ne supprime les outils de l’utilisateur. Il n’utilise aucun compte ni modèle payant. Pour valider les sessions avec un fournisseur simulé, exécutez `scripts/test-commands-native.mjs` avec `PRIME_AGENT_CLI` et `PRIME_AGENT_KERNEL_PYTHON` issus de ce manifeste isolé.

Ces contrôles ne remplacent pas une validation du nouvel assistant dans le binaire Tauri empaqueté, en FR/EN, sur une VM Windows x64 vierge. Cette étape nécessite Rust/MSVC et WebView2. Vérifiez notamment Git Bash absent, annulation par fermeture de l’application, espace disque insuffisant et redémarrage différé pendant une session active.

Sur Windows, installez les outils Rust/MSVC et les prérequis de développement [Tauri 2](https://v2.tauri.app/start/prerequisites/), puis :

```powershell
npm ci
npm run desktop:build
```

L’installateur se trouve dans `src-tauri/target/release/bundle/nsis`. `npm run desktop:dev` prépare les ressources et lance la version de développement. `npm run desktop:icons` régénère les icônes depuis le SVG ; l’image 256 px doit rester en tête du fichier ICO utilisé par Tauri.

La construction vérifie les références des modules, workers et assistants natifs avant de créer l’installateur. `npm run test:desktop-runtime` teste les ressources préparées dans `.desktop-build` avec les vrais workers Prime Agent, un projet et des comptes isolés : skills Python, prompts et fournisseurs.

`npm run test:desktop` vérifie le binaire debug préalablement compilé : ressources extraites par l’exécutable, messages et noyau Python avec un modèle HTTP local simulé, API des fournisseurs et commandes, réutilisation d’un serveur avec un agent simulé actif, démarrage réel du serveur inclus, instance unique et survie du serveur à la fermeture du processus Tauri. Prime Agent et uv doivent être disponibles. Passez le chemin du binaire après `--` pour tester une autre compilation. `npm run test:desktop-ui` vérifie les adaptations de présentation dans Chrome/Edge. Les tests ne lancent aucun appel payant à un modèle.

Pour les tests isolés, `PRIME_STUDIO_DESKTOP_DATA_ROOT` et `PRIME_STUDIO_DESKTOP_PORT` changent respectivement le dossier de données et le port. Ne les définissez pas pour un usage normal. Le VBS reste disponible pour les installations depuis les sources.

`npm run test:desktop-folder-picker` vérifie le vrai sélecteur Windows, son rattachement à la fenêtre Tauri, la sélection et l’annulation. Compilez d’abord avec `node scripts/build-desktop.mjs --debug --no-bundle --config test/fixtures/desktop-picker/tauri.conf.json`, puis définissez `PRIME_STUDIO_TEST_EXE` sur le chemin absolu du binaire obtenu. Le test refuse l’identité de production, utilise des dossiers et un port temporaires et ne ferme que son propre processus.

`npm run test:desktop-updates` et `npm run test:settings-updates` vérifient les deux panneaux en français et anglais. `npm run test:desktop-lifecycle` valide un vrai redémarrage Tauri avec serveur occupé, confirmation, conservation des données et activation de la version installée. `cargo test --manifest-path src-tauri/Cargo.toml --locked` teste le véritable client de mise à jour contre un serveur local : signature valide, fichier altéré, versions égales/antérieures et catalogue invalide. Les tests n’exécutent aucun installateur.

Pour les tests natifs en parallèle de votre application, compilez une identité de test distincte : `$env:TAURI_CONFIG = '{"identifier":"com.primeagent.studio.interaction-test"}'`, puis `cargo build --manifest-path src-tauri/Cargo.toml --locked`. Retirez ensuite la variable (`Remove-Item Env:TAURI_CONFIG`) avant une compilation de distribution. `npm run test:desktop-interactions` teste les liens web et OAuth synthétiques, les pièces jointes, le presse-papiers, l’export et les permissions dans le véritable WebView2. Il ouvre des onglets de test dans le navigateur habituel, sans connexion à un compte.

## Préparer une release avec mise à jour

La clé privée de signature reste hors du dépôt, dans `%USERPROFILE%\.tauri\prime-agent-studio.key` sur le poste de publication. Sauvegardez-la dans un emplacement sûr : les applications installées font confiance à sa clé publique intégrée et une nouvelle clé incompatible empêcherait leurs mises à jour. `desktop:build` utilise cette clé locale ou `TAURI_SIGNING_PRIVATE_KEY` (chemin ou contenu) et `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Sans clé, `npm run desktop:build -- --no-bundle` permet de compiler seulement l’exécutable.

Après la compilation signée, lancez `npm run desktop:manifest -- chemin/notes.md` (notes facultatives). `.local/desktop-release/v<version>` contient les trois fichiers à joindre ensemble à la release stable `v<version>` : l’installateur au nom sans espaces, sa signature `.sig` et `latest.json`. Ne renommez pas l’installateur après cette étape : le catalogue contient son URL exacte.

Le workflow GitHub **Windows desktop release** se lance manuellement avec un tag stable existant, correspondant à la version de `package.json`. Il teste, compile, signe et prépare une **release brouillon** avec ces trois fichiers. Configurez les secrets du dépôt `TAURI_SIGNING_PRIVATE_KEY` et, si la clé est chiffrée, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`. Il refuse de remplacer une release déjà publiée. Les workflows ne signent jamais un installateur téléversé manuellement : ils reconstruisent toujours l'installateur depuis le tag avant de le signer. Le workflow **Rebuild and sign release installer from tag source** (`desktop-sign-local.yml`) applique la même reconstruction sécurisée lorsqu'un brouillon doit être régénéré. Relisez le brouillon, puis publiez-le comme dernière release stable pour rendre la mise à jour disponible. Ne publiez pas ensuite une release stable sans son catalogue et son installateur.
