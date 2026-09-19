# Développement et fonctionnement

[English](en/development.md) · **Français** · [← Retour au README](../README.fr.md)

## Installation et développement

Prérequis : **Node.js 22.8 ou ultérieur** et **Prime Agent 0.9.2** installé. Configurez un fournisseur avant le premier message, dans Prime Agent ou dans le panneau local **Fournisseurs**. Cette version du Studio et son adaptateur de sous-agents sont validés avec **0.9.2**. Le GUI réutilise les comptes existants sans redemander leurs clés.

```powershell
npm ci
npm run setup:runtime
npm start
```

Il n’y a pas d’étape de compilation. Les bibliothèques Markdown sont servies localement depuis `node_modules`, sans CDN. `npm start` garde le serveur dans votre terminal ; utilisez le lanceur VBS pour un démarrage entièrement silencieux.

Dans **Un projet à explorer.**, **Choisir un dossier** ouvre le sélecteur Windows et remplit le chemin, sans ajouter le projet avant validation. Le helper PowerShell reste masqué ; PowerShell 7 fournit le sélecteur moderne lorsqu’il est installé, avec repli sur Windows PowerShell. Ce sélecteur est réservé au Studio local sur Windows. `npm run test:folders` vérifie la sélection, l’annulation, les erreurs et les réponses tardives. Pour ce test et `scripts/test-commands-ui.mjs`, `PRIME_STUDIO_TEST_BROWSER=chrome` permet d’utiliser Chrome à la place d’Edge.

Sous Windows, le moteur Python est provisionné sous `.local/kernel-venv/` pour conserver le contournement du chemin POSIX `bin/python` de Prime Agent. Le Studio prépare le runtime, ses bibliothèques et les skills Python activées, dès le premier message ou avec `npm run setup:runtime`. La première installation nécessite Internet. `scripts/native-skill-resources.mjs` partage la découverte native avec le catalogue des commandes : filtres, priorité des projets, packages configurés et intégrations MCP désactivées sont respectés.

`lib/kernel-skills.mjs` lit les `pyproject.toml` avec un analyseur TOML et résout les dépendances locales entre packages frères, y compris les helpers sans `SKILL.md`. Le runtime et tous les packages locaux sont fournis par leurs chemins dans une seule résolution `uv pip install --python …`. Leurs homonymes sur PyPI ne remplacent donc pas les sources locales. Les packages sont installés normalement, sans ajout à `sys.path` ni lien éditable vers les sources d’une session active.

`lib/kernel.mjs` conserve un marqueur de format 2 par empreinte du runtime, des sources Python, des `pyproject.toml` et des imports attendus. Chaque réutilisation vérifie réellement les imports, le protocole du runtime et, lorsque la skill est activée, le caractère appelable de `agent_message.send`. Le verrou `kernel-setup.lock` sérialise les préparations entre processus. Une installation ancienne ou endommagée produit automatiquement une nouvelle génération ; l’environnement précédent reste intact. Aucun marqueur prêt n’est publié après un échec d’installation ou de validation.

`runtime/kernel-loader.mjs` adapte uniquement le point d’entrée du bootstrap dans les processus lancés par le Studio. Le parent, chaque enfant et chaque kernel repris transmettent ainsi leur liste native de skills à la même préparation. Le superviseur partagé ne fige plus le Python du premier projet pour tous ses workers. Le hook prend en charge le module natif et son bundle, et refuse explicitement une signature incompatible ; aucun fichier installé de Prime Agent n’est modifié.

Un `PRIME_AGENT_KERNEL_PYTHON` explicitement fourni reste prioritaire et n’est jamais modifié automatiquement. Le Studio vérifie sa compatibilité : une dépendance essentielle ou `agent_message.send` manquante bloque le lancement avec le chemin du Python et l’erreur d’import ; une skill optionnelle indisponible produit un avertissement explicite. La [documentation native](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/skills.md#python-backed-skills) décrit pourquoi Prime Agent n’installe rien automatiquement dans ce Python externe.

Pour réparer ou préparer un projet particulier, utilisez `npm run setup:runtime -- "C:\chemin du projet"`. La commande sans argument utilise le dossier courant. Arrêtez et relancez le Studio pour charger un nouvel adaptateur et redémarrer les kernels déjà ouverts ; les historiques sont conservés. Les anciennes générations peuvent être conservées tant que leurs kernels sont utilisés.

`test/kernel.test.mjs` couvre l’installation, la migration, les imports à chaque réutilisation, les changements de sources/dépendances, les erreurs suivies d’une nouvelle tentative, la concurrence, les chemins Windows avec espaces, le Python externe et la découverte native. `test:subagents:native` comprend aussi `scripts/test-kernel-messaging-native.mjs` : fournisseur simulé sur localhost, vrais kernels, messages explicites dans les deux sens vérifiés dans les historiques **et** les contextes des modèles, puis reprise du même parent après arrêt du moteur. Une notification de fin d’enfant ne satisfait pas ce test.

## Sessions longues et synchronisation

`runtime/transport-loader.mjs` adapte en mémoire le transport OpenAI Codex du moteur lancé par le Studio. Les [connexions WebSocket OpenAI sont limitées à 60 minutes](https://developers.openai.com/api/docs/guides/websocket-mode). Une connexion inactive de plus de 50 minutes est renouvelée avant la requête suivante ; le cache de réponse précédent est abandonné et le moteur renvoie le contexte complet. Une requête occupée n’est jamais coupée par cet adaptateur. Les reprises restent celles de Prime Agent : le Studio ne rejoue pas lui-même les messages ou les outils. Une erreur suivie d’une reprise native réussie ne laisse plus l’exécution en échec. D’autres coupures réseau restent possibles. `test/transport.test.mjs` exerce les deux modules réellement installés avec une horloge accélérée, sans remplacer un essai réel d’une heure.

L’ordre des projets et les marqueurs de lecture partagés sont conservés dans `workspace.json`, sans modifier les historiques natifs. Les accusés de lecture désignent un identifiant de réponse précis, progressent uniquement sur la branche courante et sont autorisés aux appareils authentifiés en consultation. Les révisions de lecture et la fraîcheur des historiques sont traitées séparément pour supporter les réponses HTTP retardées. `npm run test:activity` vérifie deux navigateurs à stockages indépendants ; `npm run test:stability` couvre les cartes, les files protégées et l’ordre persistant sur PC/mobile. `node scripts/fixtures/session-stability.mjs` lance leur aperçu synthétique isolé.

## Processus Windows silencieux

La gestion des fournisseurs utilise `lib/provider-service.mjs` et un processus masqué `scripts/provider-auth-worker.mjs`. `lib/provider-auth.mjs` charge le catalogue et les flux OAuth natifs sans extension de projet. Les clés passent par stdin ; seules les informations d’affichage et les étapes de connexion reviennent au navigateur. Les écritures utilisent `FileAuthStorageBackend` et `AuthStorage`, avec une révision du fournisseur vérifiée sous verrou. La fermeture d’un parcours n’arrête que son processus de connexion. Les routes `/api/providers` et leurs sous-routes ne figurent pas dans la liste d’accès de la passerelle distante.

`npm run test:providers` vérifie l’ajout et le retrait de clés dans un stockage natif temporaire, l’actualisation des modèles, le parcours OAuth simulé, la conservation du brouillon et le refus des routes sur mobile et PC distant. `test/providers.test.mjs` couvre les verrous, conflits, clés invalides, commandes de secrets non exécutées, annulations et délais OAuth. Aucun compte personnel n’est connecté ou déconnecté par ces tests.

Le serveur appelle directement le fichier JavaScript du CLI avec Node, sans passer par un lanceur `.cmd` ni une console PowerShell.

Le Studio démarre son propre superviseur Prime Agent en arrière-plan, sur une adresse de communication privée. Il ne réutilise pas le superviseur d’un terminal externe. Les demandes partagent ce moteur, mais chacune garde son client : **Arrêter** demande au client concerné de fermer proprement sa session et ses sous-agents. L’arrêt forcé de son processus reste un recours si le client ne répond plus.

Le correctif local `runtime/windows-hidden.cjs` applique `windowsHide` aux sous-processus Node du CLI. Le module `runtime/python/sitecustomize.py` applique `CREATE_NO_WINDOW` et `SW_HIDE` aux sous-processus du moteur Python, y compris leurs appels PowerShell. Ces réglages sont transmis uniquement à l’arbre de processus lancé par le GUI. L’installation globale de Prime Agent n’est pas modifiée.

Le correctif `runtime/windows-session-leases.cjs` permet à Prime Agent 0.9.1 de reconnaître une collision de dossiers sous Windows lors de la récupération d’un verrou de session. Prime Agent conserve ses vérifications du PID et de sa date de démarrage : le correctif ne supprime pas les verrous de sessions encore actives.

Le chargeur local `runtime/headless-loader.mjs` active l’attente native de fin des sous-agents avant que le client JSON ferme sa session. La réponse du parent ne coupe donc pas les tâches qu’il vient de déléguer. Le changement s’applique en mémoire, uniquement au mode d’exécution utilisé par le Studio ; les fichiers installés de Prime Agent restent intacts. Si une mise à jour du CLI change ce point d’intégration, le Studio affiche une erreur explicite plutôt que d’appliquer une transformation incertaine.

La fermeture d’un onglet ne tue pas l’agent. Le bouton **Arrêter**, lui, ferme l’exécution et ses descendants. Une fermeture ou un redémarrage du serveur interrompt les exécutions en cours ; les messages déjà enregistrés restent consultables et la conversation peut être reprise.

## Développement des préférences sans interruption

L’application native et son installateur se construisent avec `npm run desktop:build` : voir [le guide Windows](desktop.md). Les tests natifs utilisent un dossier temporaire et un port dédié. L’interface ne possède aucun accès générique au shell Tauri ; les commandes du lanceur vérifient leur origine locale, et les liens externes s’ouvrent dans le navigateur.

Le Studio sert directement les fichiers du dépôt. Pour travailler pendant des sessions actives, utilisez un worktree séparé : modifier le checkout servi pourrait changer l’interface de ces sessions. `node scripts/preview-preferences.mjs --serve` lance un aperçu avec dossiers temporaires, moteur simulé et écoute exclusivement loopback ; les adresses affichées sont de démonstration. Ce script ne lance aucun agent et ne modifie aucun compte ou accès réel.

`lib/remote-network.mjs` gère séparément les passerelles et leur cycle de vie. Les modifications réseau et du PIN utilisent la même file d’écriture et une révision de configuration. Une nouvelle écoute doit réussir avant l’enregistrement et le remplacement de l’ancienne ; un échec annule les écoutes préparées. La fermeture d’une passerelle détruit ses connexions proxy, sans appeler l’annulation des agents. La passerelle distante ne relaie aucune route de configuration réseau ou système.

`lib/tailscale-https.mjs` prépare et vérifie Tailscale Serve avec `execFile`, sans shell ni fenêtre Windows. La passerelle loopback doit écouter avant toute modification Serve. L’annulation restaure uniquement la redirection préparée si elle appartient encore au Studio ; les services tiers et Funnel ne sont jamais remplacés. Les liens d’autorisation sont limités aux pages Serve/DNS HTTPS de `login.tailscale.com`. Désactiver HTTPS ferme la passerelle locale et conserve la redirection privée pour la prochaine activation.

`npm run test:https` vérifie l’autorisation, la nouvelle tentative, l’état d’attente, le PIN, le QR et les options HTTPS sur PC/mobile. `test/https-settings.test.mjs` vérifie les conflits, l’annulation et la continuité des agents. Ces tests et l’aperçu utilisent un émulateur Tailscale : aucune commande réelle de configuration n’est exécutée.

`npm run test:settings` vérifie la navigation, le focus, les changements réseau, le QR, les langues et les largeurs 390/320 px. `test/remote-network.test.mjs` vérifie la conservation du PIN, les échecs, les révisions concurrentes, les permissions et les agents toujours actifs. Les tests utilisent uniquement des données temporaires et des ports loopback. Définissez `PRIME_STUDIO_TEST_BROWSER=chrome` pour Chrome à la place d’Edge dans les tests d’interface concernés.

## Vérifications

```powershell
npm run check
npm test
npm run test:ui
npm run test:i18n
npm run test:mobile
npm run test:layout
npm run test:attachments
npm run test:inspector
npm run test:reasoning
npm run test:remote-access
npm run test:subagents:native
npm run test:pwa
```

## Traductions de l’interface

`public/translations.js` contient la liste des langues et une table unique : une ligne par identifiant, avec toutes ses traductions. `public/i18n-core.js` fournit les paramètres, pluriels natifs `Intl`, la sélection de langue et le repli français, utilisables aussi par le serveur. `public/i18n.js` applique le choix du navigateur et actualise uniquement les textes et attributs liés à une traduction. Les champs de formulaire et les contenus des conversations ne sont pas remplacés lors du changement.

`npm run check` inclut la vérification des langues, des paramètres, des pluriels et des références du code et du HTML. `test/i18n.test.mjs` teste aussi volontairement une traduction absente pour vérifier le repli réel. `npm run test:i18n` teste le changement dans un vrai navigateur, la synchronisation entre onglets, les brouillons de connexion fournisseur et MCP, une réponse en cours sans annulation, les pièces jointes, la connexion mobile et la PWA hors ligne. Les autres tests graphiques déclarent explicitement leur langue française.

Pour ajouter un texte ou une langue, suivez [le guide de traduction](translations.md). Les textes du serveur restent dans la langue de référence dans les données natives ; le navigateur traduit uniquement les libellés et diagnostics appartenant au Studio. Aucun service de traduction externe n’est utilisé.

La documentation dispose également de deux versions. `npm run check:docs`, inclus dans `npm run check`, vérifie le registre des paires, les liens, les ancres et les empreintes de relecture. Après une modification, relisez les deux langues puis utilisez `npm run docs:sync -- identifiant` ; [le guide des traductions](translations.md#maintenir-la-documentation-bilingue) décrit cette procédure. Ce contrôle n’évalue pas automatiquement la qualité linguistique.

Les tests automatiques utilisent des données temporaires et un faux moteur, sans consommation de modèle. Les tests Windows vérifient également les paramètres natifs de création des processus, le lancement VBS, la réutilisation du serveur et l’arrêt des descendants. Les tests de navigateur utilisent Microsoft Edge installé localement et produisent des captures dans `test-results/`. Le packaging guidé (`lib/desktop-components.mjs`, `test/desktop-components.test.mjs`) est épinglé sur Prime Agent 0.9.5 avec npm 10.9.4 et uv 0.8.22 ; les tests unitaires tournent sous Node sans téléchargement de production.

`test:subagents:native` utilise le vrai moteur et Python avec un fournisseur HTTP local simulé, sans compte ni appel payant. Il vérifie les arguments par défaut et explicites, le prompt existant, les niveaux en direct et dans l’historique, puis un changement par projet pendant que les premiers sous-agents travaillent encore.

Le chargeur `runtime/subagent-loader.mjs` est ajouté uniquement à l’environnement des processus du Studio. Son hook reconnaît les méthodes du moteur 0.9.2, dans les modules ou le bundle, et refuse une structure inconnue. Les arguments omis sont complétés avant la validation native ; l’instruction est ajoutée à la liste des compléments système et reconstruite avant les nouveaux tours. Les instantanés des enfants incluent leur `thinkingLevel` effectif. Aucun fichier de l’installation Prime Agent n’est modifié. Après une mise à jour de ce chargeur, il faut un redémarrage du Studio ; attendre la fin des sessions actives.

`test:reasoning` vérifie les trois modes d’affichage, le Markdown nettoyé, le suivi des deux dernières lignes à chaque delta et à la rotation, les valeurs du panneau Agents et la configuration globale/par projet. L’ancien booléen de préférence migre vers Masqué ou Détaillé ; une nouvelle installation utilise Aperçu.

Test réel facultatif avec le compte Luna déjà configuré (**consomme des appels au modèle**) :

```powershell
node scripts/smoke-luna.mjs
```

Il utilise `openai-codex/gpt-5.6-luna` et des sessions isolées dans `.local/smoke-sessions`. Il vérifie un appel de l’outil Python vers PowerShell avec le correctif silencieux chargé.

Le scénario réel de délégation, reprise avec outil et interruption se lance explicitement avec `node scripts/smoke-worker-recovery.mjs --run-luna`. Il utilise uniquement Luna et conserve ses sessions et rapports dans `.local/recovery-smoke-workspace/`.

## Panneau Session, Agents et Fichiers

`lib/session-inspector.mjs` reconstruit les délégations depuis les liens du registre natif, sans en créer ni en réparer. Pour une exécution active, `get_state` et `get_rlm_children` enrichissent l’historique ; le client vérifie le propriétaire, le projet et l’en-tête de session avant toute lecture. Aucun `attach`, `detach` ou arrêt n’est émis. Les instantanés sont partagés pendant deux secondes et le navigateur suspend le rafraîchissement quand le panneau est masqué.

`lib/project-files.mjs` limite les chemins aux projets enregistrés, vérifie les cibles réelles des liens et masque les dossiers techniques et privés. Git est exécuté sans shell ni fenêtre, avec limites de temps et de volume, sans verrouillage facultatif, diff externe ou textconv. Les routes `GET /api/inspector*` et `GET /api/project-files*` utilisent les protections d’origine et l’authentification existantes, y compris pour les téléchargements.

Les références de documents passent par `GET /api/project-files/resolve` et la même vérification du projet. `public/file-links.js` relie les liens Markdown et les chemins en code au visualiseur, sans navigation du navigateur. L’ouverture native utilise exclusivement `POST /api/project-files/open`, autorisé aux accès distants en contrôle complet. `lib/open-file.mjs` et le helper Windows transmettent le chemin comme donnée à `ShellExecuteW` avec une fenêtre visible pour l’application, depuis un helper PowerShell masqué. Les scripts sont envoyés au Bloc-notes et les exécutables refusés.

`npm run test:inspector` couvre une hiérarchie imbriquée, l’activité d’un agent réutilisé, les fichiers et diffs, le téléchargement exact, le mode distant en lecture seule, le clavier, les thèmes et les formats 1440, 390 et 320 pixels. Il vérifie que les fichiers natifs, l’index Git et le brouillon restent intacts. `npm run test:commands:native` vérifie aussi la lecture du nouvel instantané auprès du vrai moteur 0.9.2 pendant un outil Python, sans appel à un fournisseur payant.

## Messages pendant une exécution

Pendant une exécution, le champ permet **Réorienter** (après les outils de l’étape courante) ou **À la suite** (après la réponse courante). Les messages en attente peuvent être modifiés, réordonnés, retirés ou déplacés entre ces deux modes. Le carré d’arrêt reste une commande distincte. Une confirmation d’envoi signifie que le moteur a accepté le message ; sa transmission apparaît ensuite dans la conversation.

`lib/live-session-client.mjs` utilise les commandes du daemon existant, sans créer ni relancer de session. Les routes `/api/live/sessions/:id` restent protégées par l’authentification et les permissions de l’accès mobile habituel.

Les vérifications ciblées sont `node scripts/test-live-messages-ui.mjs` et `node scripts/test-live-integration.mjs`. Le test `node scripts/smoke-live-messages.mjs --run-native` utilise le Prime Agent installé avec un véritable outil Python et un fournisseur simulé sur localhost, sans appel à un compte de modèle.

## Pièces jointes

`lib/images.mjs` valide les images PNG/JPEG/GIF/WebP. Au lancement, le Studio utilise les arguments natifs `@chemin` du CLI avec les images conservées dans `.studio-images/` ; les commandes RPC `steer` et `follow_up` reçoivent directement les blocs `ImageContent`. Les deux chemins enregistrent les pixels dans les messages natifs. Les éditions de file omettent volontairement le champ `images`, ce qui conserve les images attachées selon le contrat natif de Prime Agent 0.9.1.

`lib/files.mjs` conserve les autres fichiers sous des identifiants aléatoires dans `.local/attachments/`. Les noms d’origine sont des métadonnées ; leurs octets ne sont pas interprétés comme du texte. Le message contient un bloc `prime_studio_files` listant les chemins locaux accessibles aux outils. L’historique affiche des liens de téléchargement authentifiés via `GET /api/files/:id`. L’édition d’un message en attente conserve ses références de fichiers.

Le navigateur propose deux sélecteurs, le dépôt dans la conversation et le collage des objets `File` du presse-papiers. Un chemin copié sous forme de simple texte n’est pas importé automatiquement. Les brouillons de pièces jointes utilisent IndexedDB et sont retirés après acceptation seulement. Le serveur annonce cette capacité dans le bootstrap pour éviter un envoi silencieusement ignoré par un ancien serveur encore en cours d’exécution.

```powershell
npm run test:attachments
node scripts/smoke-live-messages.mjs --run-native --attachments
```

Le premier scénario vérifie les sélecteurs réels, le collage, le dépôt, les brouillons, les téléchargements, les deux modes d’envoi et la disposition mobile/PC via la passerelle authentifiée. Le second utilise le vrai moteur, un outil Python et un fournisseur simulé local : il vérifie les pixels reçus, la lecture des fichiers et leur conservation après édition de la file, sans consommer de compte modèle ni toucher aux sessions utilisateur.

## PWA et HTTPS privé

`public/manifest.webmanifest` décrit l’application autonome et ses icônes. `public/pwa.js` propose le dialogue natif d’installation ou une aide adaptée au navigateur, sur la page de connexion et dans le menu. Le service worker `/service-worker.js` conserve uniquement une liste fixe d’icônes, le manifeste, une feuille de style, les ressources de traduction et l’écran de reconnexion. Les API, les flux SSE, les soumissions et les fichiers utilisateur sont exclus. Les pages authentifiées ne sont jamais enregistrées dans Cache Storage.

`lib/pwa.mjs` définit les seules ressources publiques nécessaires à l’installation et valide l’origine HTTPS Tailscale. `lib/lan.mjs` accepte cette origine uniquement sur la passerelle loopback dédiée, conserve les contrôles Host/Origin et émet un cookie Secure. Les en-têtes de proxy ne définissent pas l’origine de confiance. `scripts/enable-pwa.mjs` préserve la configuration existante et pointe Tailscale Serve vers cette passerelle, jamais directement vers l’API locale.

`npm run test:pwa` utilise un profil Edge temporaire pour vérifier les critères d’installation via CDP, le service worker, l’absence de données privées dans le cache, le retour hors ligne, la conservation des brouillons et les instructions iPhone. Le dialogue d’installation est simulé pour ne pas installer réellement une application sur le PC pendant les tests. Les tests HTTP dans `test/pwa.test.mjs` couvrent l’authentification HTTPS, les ressources publiques, les origines et les conflits de configuration Serve.

`public/viewport.js` ajuste la hauteur du chat au viewport visible, y compris lorsque le clavier réduit seulement celui-ci. Le zoom tactile reste libre. Les marges système sont réservées autour de l’interface ; le pied de page secondaire est masqué sur mobile. `npm run test:layout` vérifie une longue conversation en portrait, paysage et avec des géométries simulées de clavier et de barre système. Ces simulations ne remplacent pas un test sur un téléphone physique.

Le test PWA couvre aussi une arrivée depuis un autre site suivie d’un rechargement avec le service worker actif. Ce relais conserve le mode de navigation mais peut transmettre `Sec-Fetch-Dest: empty`. La passerelle accepte ce cas uniquement pour les ouvertures GET de `/` et `/index.html`, tout en conservant les vérifications Host/Origin, l’authentification et les protections des API.

## Projets, déconnexion et MCP

`npm run test:workspace` vérifie les menus de projet et de session sur écran tactile, leur stabilité lors du redimensionnement, le retrait confirmé avec conservation des fichiers, les formulaires MCP et la déconnexion d’un navigateur pendant une exécution simulée. Les captures PC/mobile sont conservées dans `test-results/`.

Sous Windows, `lib/open-directory.mjs` utilise un assistant PowerShell masqué et une demande ShellExecute explicitement visible pour l’Explorateur. Une fenêtre existante du même dossier est réutilisée, y compris si un ancien lancement l’avait masquée. La notification de succès attend la confirmation d’une fenêtre visible et non minimisée ; les processus des agents conservent leur lancement silencieux. Le chemin est transmis comme donnée, sans construction de commande PowerShell.

`npm run test:explorer` est un test Windows facultatif qui ouvre réellement un dossier temporaire dans l’Explorateur depuis un processus masqué, vérifie sa visibilité, reproduit une fenêtre invisible et vérifie sa restauration sans doublon. Il ferme uniquement la fenêtre du dossier temporaire créé par le scénario. Ce test de bureau est séparé de `npm test`, qui ne doit pas ouvrir de dossiers pendant ses vérifications ordinaires.

`lib/mcp-config.mjs` valide le format natif, masque les secrets renvoyés au navigateur et écrit uniquement `mcpServers` avec `FileSettingsStorage.withLock`. Les valeurs par défaut des modèles utilisent le même verrou. Chaque modification MCP vérifie la révision de la configuration pour refuser un écrasement depuis un écran périmé. `lib/prime-native.mjs` charge les modules de l’installation Prime Agent résolue par le Studio ; une installation incompatible produit une erreur explicite.

`lib/mcp-service.mjs` possède uniquement ses processus de découverte et d’autorisation. `scripts/mcp-probe-worker.mjs` et `scripts/mcp-probe.py` utilisent le stockage OAuth et le client Python `rlm.mcp` natifs. `scripts/mcp-oauth-worker.mjs` utilise le fournisseur OAuth natif avec saisie de l’URL complète depuis un autre appareil. Les délais, annulations et arrêts sont limités aux processus du gestionnaire. Aucun arrêt de daemon ni rechargement d’une session utilisateur n’est déclenché.

`test/mcp.test.mjs` couvre les écritures concurrentes avec les réglages de modèles, les secrets, les conflits, les serveurs réservés, une connexion stdio et une connexion HTTP avec le véritable client Python, ainsi qu’un parcours OAuth HTTPS complet avec PKCE et retour mobile. Ces tests utilisent uniquement des serveurs, fichiers et certificats temporaires ; ils n’utilisent aucun compte de fournisseur. Ils nécessitent Prime Agent installé et, pour les connexions, `npm run setup:runtime`.

Les routes MCP sont `/api/mcp` (GET/POST/PATCH/DELETE), `/api/mcp/test`, `/api/mcp/login`, `/api/mcp/disconnect`, `/api/mcp/login/complete` (POST), et `/api/mcp/login/:id` (GET/DELETE). La passerelle les refuse en lecture seule. `POST /lan/logout` révoque le cookie courant et ses connexions de proxy, y compris SSE, sans arrêter les exécutions. `DELETE /api/projects` retire les métadonnées de projet ; un marqueur persistant empêche leur réimportation immédiate depuis les sessions natives.

## Organisation du code

`public/composer.js` conserve la commande sélectionnée séparément des arguments dans le textarea. `composerText()` sérialise le tout pour les brouillons et les deux chemins d’envoi ; `setComposerText()` synchronise l’édition et le chip. Les événements de collage des pièces jointes restent attachés au même textarea. Les raccourcis immédiats sont partagés entre interface et serveur dans `public/command-definitions.js`.

Le navigateur précharge le catalogue, mutualise les requêtes, conserve un cache par contexte pendant 30 secondes et invalide les réponses tardives lors d’un changement de session. La validation serveur reste native. Le menu propose les raccourcis sans attendre le réseau et le catalogue détaillé affiche des lots de 30 résultats. `scripts/test-command-chips.mjs`, inclus dans `npm run test:commands`, retient volontairement la réponse HTTP pour vérifier l’ouverture immédiate et utilise 801 skills pour tester pagination et recherche, puis les brouillons, le presse-papiers, les pièces jointes et les envois pendant un tour sur PC et mobile.

`lib/commands.mjs` expose le catalogue et valide les envois slash avant leur admission. `scripts/command-catalog-worker.mjs` utilise le gestionnaire de packages et les lecteurs de skills/prompts de l’installation native, dans un processus masqué et borné. Il ignore les packages absents et ne charge pas les extensions JavaScript. Pour une exécution active, `get_commands` fournit les ressources réellement chargées, après vérification de l’identité du worker.

Les commandes natives de session passent par `prompt` avec `streamingBehavior` et `queueIfBusy` : `steer` et `follow_up` seuls ne déclenchent pas leur analyse native. Les skills et prompts conservent ces chemins d’envoi ordinaires et sont développés par le moteur. Les résultats natifs `custom` avec `display: true` sont projetés comme messages de contexte. Le remplacement d’un message ordinaire par une commande en attente est refusé, car leur type d’action native est différent.

`npm run test:commands` vérifie les parcours PC/mobile via une passerelle authentifiée, le catalogue, la complétion clavier, les raccourcis, les contenus non fiables et la disposition du composeur. `npm run test:commands:native` utilise un véritable worker Prime Agent, son outil Python et un fournisseur factice local, dans des dossiers temporaires. Il vérifie les expansions de skills, les arguments de prompts, les commandes en cours de tour, leur historique et l’absence d’interruption des outils. Aucun compte ou daemon utilisateur n’est utilisé.

`server.mjs` expose l’API locale et les flux SSE. `lib/store.mjs` lit les sessions natives et conserve les préférences. `lib/agent.mjs` gère le CLI, les modèles, les événements et l’arrêt. `public/` contient l’interface. `runtime/` isole les correctifs de sous-processus. `scripts/` contient les lanceurs et outils de vérification.

Les principales routes sont `GET /api/bootstrap`, `GET /api/overview`, `GET /api/history?id=…`, les routes locales `/api/model-config` et `/api/model-defaults`, `POST /api/projects`, `PATCH /api/projects`, `PATCH /api/sessions`, `POST /api/runs`, `GET /api/runs/:id/events` et `POST /api/runs/:id/stop`. Les flux SSE acceptent `Last-Event-ID` pour reprendre les événements après une déconnexion.

## Régénérer les captures du README

```powershell
node scripts/capture-readme.mjs
```

Cette commande régénère les illustrations **en français et en anglais** depuis le HTML, le JavaScript et les styles actuels du dépôt. Elle utilise le Chromium installé pour Playwright, sans fenêtre visible. `PRIME_STUDIO_BROWSER` permet de choisir un autre canal déjà installé, par exemple `chrome` ou `msedge`.

Les scénarios sont séparés en trois groupes dans `scripts/readme-captures/` :

| Groupe      | Vues couvertes                                                                                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------- |
| `core`      | Conversations, projets, import, Roadmap, messages en cours, questions, pièces jointes, modèles et sous-agents. |
| `tools`     | Fournisseurs, MCP, commandes, fichiers, connaissances et contexte de session.                                  |
| `platforms` | Conversation mobile, accès distant, notifications, préparation Windows et mises à jour.                        |

Chaque groupe démarre un serveur temporaire sur l’adresse de boucle locale, avec des dossiers et des données fictives isolés. Aucun agent natif, compte fournisseur, serveur MCP réel ou session utilisateur n’est utilisé. Les services du moteur, du bureau et du réseau peuvent être simulés pour afficher les états documentés : **ces captures illustrent l’interface, elles ne valident pas une connexion réelle ni une installation Windows**.

Les captures ne comportent aucun bandeau ajouté. La mention des données fictives figure dans le README, hors des images. Les vues utilisent les dimensions adaptées à leur contenu : bureau, dialogue cadré et téléphone. Les deux langues possèdent leurs propres captures et contenus de démonstration.

Toutes les captures demandées sont produites avant le remplacement des fichiers dans `docs/screenshots/` et `docs/screenshots/en/`. Le rapport `test-results/readme-captures.json` conserve les scénarios, dimensions et empreintes des images. Les serveurs, navigateurs et dossiers temporaires sont fermés après exécution, y compris en cas d’échec.

Pour ne régénérer qu’une langue ou un groupe, ou préparer une revue sans remplacer les illustrations publiées :

```powershell
node scripts/capture-readme.mjs --lang en
node scripts/capture-readme.mjs --group core
node scripts/capture-readme.mjs --output .local/readme-preview
```

`--docs-en` reste un alias de `--lang en`. Les scripts de tests spécialisés et `scripts/capture-roadmap.mjs` restent disponibles pour leurs scénarios propres ; ils ne sont pas nécessaires pour reconstruire les illustrations du README.
