# Configuration et données locales

[English](en/configuration.md) · **Français** · [← Retour au README](../README.fr.md)

## Préférences et portée des réglages

Le panneau **Préférences** regroupe les réglages en sept catégories : **Apparence**, **Modèles et agents**, **Outils**, **Accès distant**, **Notifications**, **Système** et **Mise à jour**. La navigation reste accessible sur les petits écrans et au clavier. Fermer un gestionnaire ouvert depuis les préférences ramène à sa catégorie.

Une indication sous chaque titre rappelle la portée sans ajouter de contrôles : l’apparence et la saisie concernent ce navigateur et cette adresse ; les comptes, MCP et modèles par défaut concernent Prime Agent sur ce PC. Les défauts des sous-agents du Studio peuvent être remplacés pour un projet. Le modèle choisi pour une conversation reste distinct du modèle par défaut.

**Outils** donne accès aux MCP et aux catalogues Skills/Prompts, avec leurs dossiers globaux et du projet sélectionné. **Accès distant**, réservé au PC, active le LAN et Tailscale sans interrompre les agents et propose les liens et QR codes : voir [le guide mobile](lan.md). **Système** affiche les versions, la disponibilité du moteur et le nombre d’agents en cours ; le diagnostic copiable exclut les clés et conversations. L’ouverture des journaux est réservée au PC.

La carte **Tailscale HTTPS** configure aussi l’adresse privée nécessaire à [l’installation PWA](pwa.md), avec un lien d’autorisation Tailscale si nécessaire et une nouvelle tentative depuis le panneau. Elle conserve le PIN et les autres accès.

## Langue de l’interface

**Préférences → Apparence → Langue** propose **Automatique**, **Français** et **English**, sur PC et mobile. Le mode automatique utilise les langues du navigateur, avec le français comme repli. Le choix est conservé dans `prime-studio.language` pour ce navigateur et cette adresse d’accès. Les onglets de la même adresse se synchronisent ; les autres appareils gardent leur propre choix.

Changer de langue ne recharge pas la page, n’envoie aucun message et n’arrête aucun agent. Les formulaires ouverts, brouillons, pièces jointes, choix de modèle et de réflexion sont conservés. Les conversations, raisonnements, fichiers, noms de modèles et identifiants des commandes gardent leur contenu original. Les descriptions de ressources externes et les diagnostics provenant directement d’un fournisseur restent dans leur langue d’origine lorsqu’ils n’ont pas de traduction dans le Studio.

Un cookie de préférence `prime_studio_language`, distinct du cookie d’authentification, permet au serveur de présenter la connexion mobile dans la bonne langue avant le chargement du JavaScript. La table de traduction et le moteur de traduction font partie des ressources publiques de la PWA ; aucune conversation ni pièce jointe n’est ajoutée à son cache.

La [documentation des traductions](translations.md) décrit la table unique, le repli et les contrôles automatiques.

## Configurer les modèles

### Questions interactives et images dans la conversation

La case **Autoriser les questions**, près du niveau de réflexion, autorise l’outil de questions pour cette conversation. Elle est cochée par défaut et se change entre deux exécutions. **Préférences → Modèles et agents → Autoriser les questions par défaut** définit la valeur initiale, commune aux appareils connectés à ce PC. Les choix déjà enregistrés dans les conversations restent prioritaires. L’agent propose des choix avec une courte description, repliée par défaut et consultable via **Afficher la description**. Vous pouvez sélectionner une option, écrire une autre réponse ou passer. Le Studio utilise le protocole interactif natif de Prime Agent et enregistre le résultat dans son historique d’outils. Répondre sur le téléphone clôt également la demande sur le PC. Recharger la page retrouve les demandes tant que l’exécution et le serveur sont actifs ; un arrêt du moteur les annule.

L’agent peut afficher un fichier PNG, JPEG, GIF ou WebP du projet avec `![Aperçu](captures/resultat.png)`. Le Studio lit le fichier original, sans créer de copie, et un clic agrandit l’image. Une image déplacée ou supprimée affiche un état indisponible. Une modification du fichier change donc l’aperçu à son prochain chargement. Les images restent soumises aux accès du projet, y compris sur mobile ; cette fonction n’expose pas les fichiers extérieurs au projet. Les pièces jointes envoyées par l’utilisateur conservent leur fonctionnement habituel.

### Notifications Windows

Dans l’application Windows, **Préférences → Notifications** propose deux interrupteurs indépendants, activés initialement : **Question de l’agent** et **Fin de tour de l’agent**. Une erreur de l’agent suit le réglage de fin de tour ; les arrêts manuels restent silencieux. Les préférences sont enregistrées sur ce PC dans `desktop.json`.

Le Studio n’affiche aucune notification si l’une de ses fenêtres a le focus, y compris les réglages de l’application. Les événements silencieux ne sont pas réaffichés lorsque vous passez à une autre application. Le suivi natif continue quand la fenêtre est masquée ; quitter complètement l’application l’arrête. Il ne rejoue pas les événements historiques au démarrage. Les réglages Windows et le mode **Ne pas déranger** restent applicables.

Ces notifications nécessitent le nouveau build Windows installé. Le navigateur et la PWA ne déclenchent pas de notification Windows sur le PC hôte. La version de développement peut utiliser l’identité PowerShell pour les notifications, selon [la documentation Tauri](https://v2.tauri.app/plugin/notification/).

### Modèle et niveau de réflexion

Les sélecteurs de modèle et de réflexion près du champ de message sont propres à chaque conversation. Le Studio retrouve ses choix à la réouverture, y compris depuis un autre appareil. Les nouvelles conversations partent des valeurs par défaut de Prime Agent ; les changements d’une conversation ne modifient pas ces valeurs globales.

Vous pouvez changer le niveau de réflexion pendant que l’agent travaille. Le moteur applique le niveau compatible aux prochains appels du modèle, sans interrompre l’appel ou l’outil déjà en cours. Un message confirme la prise en compte ; en cas d’échec, le sélecteur revient à sa valeur précédente. Le modèle se choisit entre deux exécutions.

Ouvrez **Préférences → Modèles et agents → Configurer** sur le PC. La première zone choisit le modèle par défaut de l’agent principal avec le sélecteur des conversations, sa recherche intégrée et ses favoris partagés. Cliquez sur **Enregistrer** pour appliquer votre choix. Cette zone écrit uniquement les champs natifs `defaultProvider` et `defaultModel` dans `~/.prime/agent/settings.json`, comme Prime Agent 0.9.1. Le choix est appliqué au sélecteur du Studio et aux prochains lancements. **Choix automatique de Prime Agent** supprime ces deux champs. **Nouvelle session**, **Ctrl+N** et l’ouverture d’une conversation vide utilisent ce modèle par défaut, même si un autre modèle a été choisi dans la conversation précédente. Les conversations existantes retrouvent le modèle de leur historique.

La zone **Sous-agents**, vérifiée avec Prime Agent **0.9.6**, définit le modèle et le niveau de réflexion par défaut pour tous les projets. Le bouton de modèle ouvre le même sélecteur que les conversations : catalogue identique, recherche intégrée par nom, fournisseur ou identifiant, et favoris partagés. Les niveaux proposés dépendent du modèle sélectionné. **Défaut du moteur** utilise le modèle natif par défaut, ou le modèle parent si aucun n’est défini. **Niveau parent** conserve l’héritage du niveau de réflexion.

Pour un projet précis, ouvrez une conversation puis l’onglet **Agents** du panneau de droite. Les réglages sont disponibles avant le premier message, dès qu’un projet est sélectionné ; ils sont enregistrés pour ce projet sans créer de session Prime Agent ni lancer d’agent. Dans le bloc compact **Sous-agents du projet**, le mode **Globaux** masque les sélecteurs et utilise les valeurs communes. Sélectionnez **Ce projet** pour afficher le modèle et le niveau de réflexion et créer une exception pour ce projet. Chaque modification est enregistrée immédiatement. Revenir à **Globaux** supprime l’exception et masque à nouveau les sélecteurs. Ce réglage est aussi disponible depuis le téléphone avec le contrôle complet ; les accès en lecture seule peuvent seulement le consulter. Les réglages globaux restent réservés au PC.

Le Studio ajoute une instruction dynamique au prompt système sans remplacer `SYSTEM.md`, `APPEND_SYSTEM.md`, les instructions du projet ou les skills. Il fournit également les valeurs manquantes aux appels `rlm.spawn(…, name="…")` : ce choix est donc appliqué par le moteur. Un argument explicite `model` ou `thinking` reste prioritaire. Si le défaut Studio est vide, le défaut natif s’applique avant le modèle parent. Prime Agent vérifie l’authentification du modèle et la compatibilité du niveau ; si vous héritez du modèle parent tout en fixant un niveau, celui-ci doit être accepté par ce modèle.

Les réglages sont enregistrés dans `.local/subagent-defaults.json`, séparément des fichiers natifs. Les nouvelles délégations et les prochains tours de l’agent utilisent les valeurs actualisées, y compris dans une session déjà chargée par le Studio. Les sous-agents existants gardent leur modèle et leur niveau. Une modification concurrente depuis un autre onglet demande de recharger les réglages avant d’enregistrer. Les sessions lancées indépendamment du Studio conservent le comportement de Prime Agent.

Le même écran ajoute, modifie ou supprime aussi des définitions personnalisées dans `~/.prime/agent/models.json`, puis actualise le sélecteur. Les champs avancés déjà présents sont conservés. Pour un nouveau fournisseur, indiquez le **nom** d’une variable d’environnement, jamais sa valeur secrète. Le serveur n’accepte que les quatre protocoles documentés par Prime Agent et bloque les URL contenant des identifiants, paramètres ou fragments. HTTPS est obligatoire hors service loopback local. Une adresse associée à une identification existante ne peut pas être remplacée depuis le formulaire, afin d’éviter l’envoi accidentel d’une clé vers un autre serveur.

Avant une écriture, le Studio conserve une copie `models.json.prime-studio.bak` ou `settings.json.prime-studio.bak` dans le même dossier. Le configurateur et ses routes d’écriture sont réservés à `127.0.0.1`. Ils ne traversent pas la passerelle LAN. Les modèles déjà configurés restent disponibles dans le sélecteur du téléphone.

### Modèles avancés et budgets autonomes (Prime Agent 0.9.6)

La carte **Modèles avancés**, dans le même écran **Configurer**, expose les nouveaux réglages natifs de Prime Agent 0.9.6 sans changer vos valeurs actuelles. Tant que les champs restent vides, le comportement natif est préservé : aucun modèle de secours ni mode autonome n’est activé automatiquement, et les modèles par défaut restent inchangés.

Le **modèle de résumés et d’affinage** (`auxiliaryModel`) sert à l’affinage et aux résumés de compaction et de branche. Le moteur utilise le modèle de session si ce choix est absent, inutilisable ou trop petit pour un résumé de branche. Ce routage natif ne constitue pas une garantie de coût mesurée dans Studio.

Le **modèle pour les images** (`imageModel`) traite les tours avec images quand le modèle de session accepte seulement le texte. Il doit prendre en charge les images. Le laisser vide conserve le refus explicite du moteur pour les tours incompatibles. Il ne remplace pas le modèle de décision de Bureau expert et n’active pas un agent distinct d’analyse de captures.

Le **modèle de secours** (`providerBackupModel`) reste désactivé par défaut : les demandes ne changent pas de modèle en silence. Lorsqu’il est défini et authentifié, il intervient en cas de quota ou de panne. Les sélecteurs partagent le catalogue authentifié (`/api/models`, modèles indisponibles exclus) ; un choix vide supprime le champ et rétablit le comportement natif.

Le **niveau de service par défaut** (`defaultServiceTier`) s’applique aux nouvelles sessions. **Standard** rétablit le défaut du moteur ; **Flex**, **Priority** et **Auto** dépendent du fournisseur et peuvent modifier le coût ou le délai. Enregistrer un défaut ne change ni ne redémarre une session active.

Les quatre **budgets autonomes par défaut** (`autonomous.maxContinuations`, `maxTurns`, `maxTokens`, `timeoutMs`) acceptent un entier positif ou `Illimité`. Un champ vide supprime ce budget et rétablit le défaut natif (3 relances, 12 tours, 80 000 jetons, 30 minutes). Ces limites sont prêtes sans activer le mode autonome ; les options explicites de lancement restent prioritaires à chaque exécution.

Le **sous-agent natif par défaut** (`subagentDefaultModel`) est un champ natif distinct, affiché sous ce nom pour ne pas le confondre avec les réglages Studio. L’enregistrement de ce champ ne modifie pas les préférences Studio dans `.local/subagent-defaults.json`. La priorité reste : choix explicite `model`/`thinking` > réglages Studio (globaux ou du projet) > défaut natif > modèle parent. Vider ce champ supprime le défaut natif ; les arguments explicites et les préférences Studio restent prioritaires.

Les écritures passent par le verrou natif `FileSettingsStorage`, fusionnent les champs inconnus sans les effacer, valident strictement chaque valeur et conservent une sauvegarde `settings.json.prime-studio.bak`. Une modification concurrente depuis un autre onglet renvoie un conflit 409 : rechargez les réglages avant d’enregistrer. Les routes `GET`/`POST /api/engine-settings` sont réservées au PC (`127.0.0.1`) et absentes de la passerelle LAN : depuis un accès distant ou en lecture seule, l’interface reste consultable mais désactivée, sans mutation possible.

## Données et configuration

Le [panneau Fournisseurs](providers.md), disponible uniquement depuis l’adresse locale du PC, gère les identifiants natifs de `auth.json`. Il propose les parcours par compte, les clés API et la déconnexion avec confirmation. Les secrets enregistrés ne sont pas renvoyés au navigateur ; les réglages externes et les identifiants MCP sont conservés.

Le [gestionnaire MCP](mcp.md), distinct du configurateur de modèles, est également disponible à distance en contrôle complet. Il modifie le champ natif `mcpServers` de `settings.json` et confie les identifiants OAuth au stockage `auth.json` de Prime Agent. Les écritures des valeurs par défaut des modèles et des MCP utilisent le même verrou natif pour préserver les changements simultanés.

| Emplacement                                                | Contenu                                                                                                                                                       |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `~/.prime/agent/sessions/`                                 | Conversations natives de Prime Agent                                                                                                                          |
| `~/.prime/agent/settings.json`, `models.json`, `auth.json` | Configuration du moteur ; le configurateur peut écrire `models.json` et les valeurs par défaut de `settings.json`, sans transmettre les secrets à l’interface |
| `.local/workspace.json`                                    | Projets, titres, épingles et archives du GUI                                                                                                                  |
| `.local/subagent-defaults.json`                            | Modèle et réflexion des sous-agents : valeurs globales et exceptions par projet                                                                               |
| `.local/kernel-venv/`                                      | Environnements Python par configuration de skills, avec marqueurs de validation ; les générations précédentes restent disponibles                             |
| `.local/kernel-ready.json`                                 | Chemin du dernier Python entièrement préparé et vérifié par le Studio                                                                                         |
| `.local/attachments/`                                      | Fichiers joints originaux et métadonnées de téléchargement ; à conserver pour pouvoir les relire depuis les sessions                                          |
| `~/.prime/agent/sessions/.studio-images/`                  | Images transmises au CLI, également enregistrées dans les messages natifs                                                                                     |
| IndexedDB du navigateur                                    | Pièces jointes des brouillons, séparées par session ou nouveau projet                                                                                         |
| Stockage local du navigateur                               | Brouillons, thème et préférences de saisie                                                                                                                    |
| Cache Storage du navigateur                                | Icônes et écran de reconnexion de la PWA ; aucune conversation ni pièce jointe envoyée                                                                        |
| `.local/lan-access.json`                                   | Code d’accès haché et passerelles LAN, Tailscale et HTTPS PWA                                                                                                 |
| `.local/logs/server.log`                                   | Journal du serveur lancé en arrière-plan                                                                                                                      |
| `.local/logs/launcher.log`                                 | Diagnostics du lanceur                                                                                                                                        |

| Variable d’environnement       | Rôle                                                                                                          |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `PORT`                         | Port HTTP, `3088` par défaut                                                                                  |
| `PRIME_AGENT_CLI`              | Chemin du `cli.js` ou du dossier npm de Prime Agent                                                           |
| `PRIME_AGENT_CODING_AGENT_DIR` | Dossier de configuration de Prime Agent                                                                       |
| `PRIME_AGENT_SESSION_DIR`      | Dossier des sessions à lire et à créer                                                                        |
| `PRIME_AGENT_GUI_DATA_DIR`     | Dossier des métadonnées GUI, `.local` par défaut                                                              |
| `PRIME_AGENT_GUI_NODE`         | Exécutable Node utilisé par le lanceur VBS                                                                    |
| `PRIME_AGENT_KERNEL_PYTHON`    | Python externe déjà préparé : runtime, bibliothèques et skills Python ; vérifié sans installation automatique |
| `PRIME_GUI_UV`                 | Chemin de l’exécutable `uv` utilisé pour préparer les environnements du Studio                                |

### Python et skills

Sans Python externe configuré, le Studio prépare sous Windows le runtime et les skills Python activées pour le projet. La découverte suit les réglages de Prime Agent, y compris les chemins supplémentaires et les skills désactivées. Les parents et leurs sous-agents utilisent cette préparation, y compris après reprise.

Pour réparer une ancienne installation où `agent_message` manque, lancez sur le PC :

```powershell
npm run setup:runtime
npm stop
npm run start:silent
```

Il n’est pas nécessaire de supprimer l’ancien venv. La préparation vérifie les imports et crée automatiquement un environnement complet si nécessaire. Pour un autre projet : `npm run setup:runtime -- "C:\chemin du projet"`. Un kernel déjà ouvert garde son environnement jusqu’à son redémarrage ; l’arrêt du Studio termine aussi ses exécutions en cours, mais conserve les conversations.

Si `PRIME_AGENT_KERNEL_PYTHON` est défini, vous gérez les packages de ce Python. Le Studio n’y installe rien et indique précisément les imports manquants. Le runtime et la messagerie activée sont obligatoires ; une autre skill indisponible est signalée comme optionnelle. Un message de préparation réussie n’est émis pour un environnement géré qu’après vérification complète.

Le serveur de commande écoute uniquement sur `127.0.0.1`. L’accès mobile facultatif passe par une passerelle authentifiée qui autorise les commandes selon son mode. Les origines externes et les noms d’hôte inconnus sont refusés ; seuls les fichiers de l’interface et les routes autorisées sont servis. Ne l’exposez pas via un proxy public : c’est une application personnelle locale.
