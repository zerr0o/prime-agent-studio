# Historique des versions

[English](en/changelog.md) · **Français** · [← Retour au README](../README.fr.md)

Les changements par version. Retrouvez les installateurs et les archives du code source dans les [releases GitHub](https://github.com/zerr0o/prime-agent-studio/releases).

## 4.4.7

- **Computer Use à la demande** : les tâches de bureau utilisent des sous-agents natifs ordinaires, tandis que l’agent principal garde son modèle et son niveau de réflexion. Une autorisation seule ne démarre aucun pilote ; un seul agent précis détient le bureau à la fois.
- **Moteur Windows natif uniquement** : suppression de CUA et de ses exécutables embarqués. Les anciennes préférences de moteur reviennent au natif sans démarrer de contrôle ; le modèle et le niveau de réflexion sont conservés.
- **Bordure orange d’activité** : une bordure sans focus ni interception des clics suit la détention du bureau sur chaque écran. L’exclusion des captures Windows est vérifiée avant affichage ; la bordure se ferme à l’arrêt du worker et reste cachée si la protection est indisponible.
- **16 conversations ouvertes** : limite augmentée sans partage du verrou exclusif du bureau.
- **Réglages Outils** : le modèle Computer Use et le niveau de réflexion retrouvent deux lignes distinctes sur ordinateur et mobile.

## 4.4.7-beta.2

- **Computer Use natif uniquement** : suppression de CUA, de son sélecteur, de ses exécutables et de sa préparation dans les builds. Les anciennes préférences reviennent au moteur natif sans démarrer de contrôle. Les réglages de modèle et de réflexion sont conservés.
- **Bordure d’activité** : une bordure orange discrète suit la détention du bureau sur tous les écrans. Sans focus ni interception des clics, elle reste exclue des captures par Windows et se ferme avec le worker. Si la protection est refusée, elle reste cachée.

## 4.4.7-beta.1

- **Délégation à la demande** : l’agent principal garde son modèle et son niveau de réflexion. Les tâches de bureau utilisent des sous-agents natifs ordinaires avec le modèle et l’effort Computer Use configurés. Activer l’autorisation ne crée aucun enfant ni pilote de bureau. Un enfant inactif peut être réutilisé ou remplacé par un nouveau pour une autre tâche.
- **Bureau exclusif** : plusieurs conversations peuvent être autorisées, mais un seul agent précis détient le bureau. Les frères ne partagent pas son verrou. La fin, l’arrêt ou la libération de l’enfant rend le bureau disponible et invalide les anciennes captures. Un bureau occupé est refusé sans prise de contrôle ni rejeu automatique.
- **Accès vérifié** : le modèle de l’enfant vient de sa session native et sa capacité image du catalogue, jamais des indications de l’appel d’outil. La révocation des autorisations et la création du pilote restent protégées contre les requêtes concurrentes. Les erreurs d’outils exposent au modèle des détails de diagnostic bornés.
- **Périmètre** : cette évolution porte sur la délégation. Elle ne prétend pas résoudre tous les problèmes de fenêtres temporaires, d’actions partielles ou de rétention des captures. La validation sur le vrai bureau reste distincte des tests automatisés avec bureau factice.

## 4.4.6

- **GPT-6.1 Terra** : ajouté aux catalogues API OpenAI et Codex avec des métadonnées et niveaux de raisonnement vérifiés. L’accès Codex dépend toujours du compte ; le modèle par défaut ne change pas.
- **Fichiers** : vues Modifications et Historique simplifiées. Le message de commit et **Proposer un message** restent visibles dans Modifications. L’historique affiche les commits à côté de leurs fichiers, avec tags, chargement automatique en bas de liste et couleurs de statut GitHub Desktop. Un clic sur un fichier ouvre son diff dans la visionneuse.
- **Worktrees** : compteur dans l’onglet, sélection arrondie, badge **Actuel**, chemin et état des modifications sur des lignes distinctes. Ouvrir un worktree change uniquement le contexte Fichiers, pas la conversation.
- **Interface stable** : les rafraîchissements ne font plus apparaître de message de chargement et conservent les cases cochées. Branche, état et Fetch/Pull/Push partagent une barre compacte. Les skills actives ne compriment plus le champ de saisie principal.
- **Sécurité Git** : les commits ne prennent que les fichiers sélectionnés et préservent les autres fichiers indexés. Les noms sont traités littéralement et l’accès en consultation continue de bloquer les opérations Git d’écriture.

## 4.4.6-beta.2

- **Saisie avec une skill active** : correction d’un conflit de priorité CSS qui réduisait le champ principal à quelques pixels et faisait apparaître une barre de défilement. La saisie conserve maintenant sa largeur avec ou sans skill, sur ordinateur, portable et mobile.

## 4.4.6-beta.1

- **Fichiers** : quatre vues distinctes — **Modifications**, **Historique**, **Worktrees** et **Parcourir**. Les panneaux larges affichent le diff à côté de la liste ; les panneaux étroits proposent une ouverture agrandie.
- **Historique Git** : commits paginés, tags visibles, fichiers du commit et diff avec son premier parent, y compris pour le premier commit du dépôt. La recherche et le filtre des tags portent sur les commits chargés ; **Afficher la suite** étend la liste.
- **Worktrees** : liste des worktrees du dépôt et sélection des worktrees gérés par Studio pour le panneau Fichiers, sans changer la conversation. Les worktrees externes restent visibles sans autoriser un contexte de fichier non enregistré.
- **Commits** : le bouton existant **Proposer un message** est conservé, y compris dans les worktrees gérés. Un commit ne prend que les fichiers sélectionnés et laisse les autres fichiers déjà indexés en place. Les noms contenant des caractères de pathspec Git sont traités littéralement. Aucun commit ni push automatique.
- **Consultation** : historique et diffs restent accessibles en lecture seule ; les actions Git d’écriture restent interdites. Les lectures de l’historique n’exécutent ni hooks ni outils de diff externes.

## 4.4.5

- **Ports réservés sous Windows** : si le port local est indisponible, Studio choisit un autre port et le mémorise. Le port peut aussi être changé dans **Préférences → Système** ou depuis le lanceur en cas d’échec. Le changement confirme l’arrêt du serveur puis relance proprement l’application, avec une confirmation supplémentaire si des agents travaillent. La variable `PRIME_STUDIO_DESKTOP_PORT` reste prioritaire.
- **Démarrage et conversations** : un index local léger évite de relire tous les historiques à chaque lancement. Seuls les fichiers modifiés sont analysés à nouveau, et ouvrir une conversation ne charge que son historique. La première construction de l’index peut encore prendre du temps. La liste s’affiche sans attendre le moteur ou les modèles ; les requêtes bloquées sont retentées automatiquement et les étapes lentes sont journalisées sans contenu de conversation.
- **Aperçus hors projet** : l’option **Aperçus des fichiers hors projet**, dans **Préférences → Apparence**, est activée par défaut. Les liens vers des fichiers locaux hors du projet ouvrent un aperçu en lecture seule avec leur chemin complet. La désactivation est appliquée côté serveur. Les dossiers protégés, les chemins réseau et l’accès distant en consultation restent exclus ; aucun droit supplémentaire de modification ou d’exécution n’est accordé.
- **Préférences** : correction d’une erreur de traduction dans l’état du démarrage automatique sous Windows.
- **Sécurité** : mise à jour de DOMPurify vers la version 3.4.17.

> Un changement de port change l’origine Web : le layout et les brouillons enregistrés pour l’ancienne adresse peuvent ne plus être visibles. Les projets et conversations sont conservés.

## 4.4.4

- **Coloration du code** : l’aperçu des fichiers et les blocs de code des conversations sont colorés comme dans VS Code (thèmes sombre et clair), avec des numéros de ligne. highlight.js est servi par le Studio lui-même et chargé seulement quand un code s’affiche ; les très gros fichiers restent en texte simple. L’option **Coloration du code dans les conversations**, dans Préférences → Apparence, la désactive dans les conversations.
- **Ouvrir avec l’application de Windows** : **Ouvrir** utilise l’application par défaut de Windows pour les documents, les pages web et le code (le navigateur pour un fichier `.html`, votre éditeur pour un `.ts` ou un `.json`). Les scripts que Windows exécuterait (`.js`, `.ps1`, `.bat`, `.py`…) s’ouvrent toujours dans le Bloc-notes, et les programmes restent refusés.
- **Exécuter un script** : le nouveau bouton **Exécuter** lance le script, après confirmation, dans une console visible ouverte dans son dossier, qui reste ouverte à la fin. Il est disponible sur le PC et en accès distant en contrôle complet, jamais en consultation.
- **Liens de fichiers fiables** : dans les messages, seules les références vers un fichier existant deviennent des liens. Les noms seuls et les fins de chemin sont cherchés dans les fichiers du projet, en respectant `.gitignore`, et les plages de lignes (`app.js:62-63`) sont comprises. Un lien vers un fichier absent apparaît barré ; les numéros de version et les noms de branche restent du texte simple. Les agents reçoivent aussi une consigne pour écrire les chemins depuis le dossier du projet.

## 4.4.3

- **Envoi des messages fiable** : dès l’envoi, le champ de saisie se grise et se verrouille avec « Envoi du message… », puis se vide quand le message apparaît dans la conversation. Un texte modifié pendant l’attente ne peut plus rester dans le champ après avoir été envoyé. En cas d’échec, le texte redevient modifiable. Même comportement pendant une exécution (Réorienter, À la suite).
- **Configuration avant le premier message** : tant qu’aucun fournisseur n’est connecté ou qu’il manque le modèle de l’agent principal ou des sous-agents, une nouvelle conversation affiche trois étapes à la place des suggestions, et l’envoi attend la fin de la configuration. Sans connexion, le modèle par défaut du moteur échouait (erreur 401). S’il ne manque que le modèle des sous-agents, **Utiliser le même** suffit.
- **Modèles simplifiés** : le bloc « Modèles avancés » et toute la gestion des quotas (relais après quota, plafonds, budgets autonomes) sont retirés. L’usage Codex reste affiché. Si d’anciennes valeurs existent, une carte « Anciens réglages détectés » les supprime en un clic ; un ancien modèle de secours bloque les exécutions jusqu’à cette réinitialisation.
- **Installation des composants plus claire** : l’accueil indique s’il s’agit d’une première configuration ou d’une réparation. Pendant l’installation, une liste d’étapes affiche l’étape en cours, son temps écoulé, la taille téléchargée et une explication pour les étapes longues. Lors d’une première installation, le Studio s’ouvre tout seul à la fin.
- **Démarrage plus robuste** : l’application ne dépend plus de la façon dont Node lit les chemins Windows longs (`\\?\C:\…`), et le build refuse un Node incompatible. Une erreur de démarrage affiche une explication simple, avec les détails techniques repliés.
- **Interface** : « Préférences du Studio » depuis la zone de notification ne bloque plus la fenêtre. L’historique des sous-agents regroupe les appels d’outils entre deux messages et s’ouvre sur le dernier message. Le bouton « … » de la barre du haut est retiré : le menu reste sur chaque conversation de la liste (clic droit ou « … »). Les icônes à points restent visibles sur les écrans à très forte densité, et « Actualiser » est aligné avec la recherche dans la fenêtre Fournisseurs.

## 4.4.3-beta.1

- **Menu « Préférences du Studio » corrigé** : depuis l’icône de la zone de notification, les Préférences s’ouvrent de nouveau au premier plan, sur l’onglet Mise à jour. Avant, une fenêtre invisible pouvait bloquer tous les clics.
- **Installation des composants plus claire** : l’accueil indique s’il s’agit d’une première configuration ou d’une réparation, et décrit le rôle de chaque composant. Pendant l’installation, une liste d’étapes affiche l’étape en cours, son temps écoulé, la taille téléchargée et une explication pour les étapes longues (dépendances npm, Python). En cas d’échec, l’étape concernée est signalée avec Réessayer et Ouvrir les journaux. Lors d’une première installation, le Studio s’ouvre tout seul à la fin.
- **Démarrage plus robuste** : l’application ne dépend plus de la façon dont Node lit les chemins Windows longs (`\\?\C:\…`), et le build refuse un Node incompatible. Une erreur de démarrage affiche une explication simple, avec les détails techniques repliés.
- **Historique des sous-agents plus lisible** : dans le panneau Agents, les appels d’outils entre deux messages sont regroupés dans un bloc « Activité de l’agent » repliable, comme dans la conversation principale, et la fenêtre s’ouvre sur le dernier message.

## 4.4.2

- **Questions dans le bon ordre** : les questions répondues ou ignorées restent désormais auprès du message assistant qui les précédait, au lieu de rester en bas après l’arrivée de nouveaux messages. Cela couvre aussi les groupes de questions et l’historique fenêtré, y compris lorsque la vue de conversation est recréée. Les questions en attente restent près du compositeur ; celles déjà liées à un outil conservent leur position. Contribution de [@evgyur](https://github.com/evgyur) dans la [#12](https://github.com/zerr0o/prime-agent-studio/pull/12).

## 4.4.1

- **Réglages des sous-agents simplifiés** : les sélecteurs de rôles Explorer / Implémenter / Réviser sont supprimés. Choisissez le modèle et le niveau de réflexion par défaut globalement ou par projet ; les choix explicites au lancement d’un sous-agent restent prioritaires.
- **Compatibilité des conversations existantes** : les anciens réglages par rôle n’influencent plus le choix du modèle. Les arguments `role` hérités sont ignorés pour permettre aux anciennes conversations de continuer sans erreur liée au sélecteur supprimé.
- **Autres contrôles inchangés** : le modèle de suggestion Git, les budgets et le repli sur quota restent disponibles. Le correctif d’installation de Prime Agent 0.9.8 et le Contexte (Bêta) sur activation explicite de la 4.4.0 sont conservés.

## 4.4.0

- **Installation de Prime Agent corrigée** : le moteur reste fixé à 0.9.8. Studio utilise une source et des empreintes inscrites dans le build, sans analyser le script d’installation distant qui évolue indépendamment. Les archives restent vérifiées avant activation. Corrige le blocage `source_contract_changed` signalé dans l’issue #10.
- **Diagnostic de réparation** : un échec affiche le chemin de `components.log`, en français et en anglais (PR #11).
- **Contexte (Beta)** : le nouveau contexte de projet est désactivé par défaut et nécessite une activation explicite. Son onglet porte la mention Beta. Il propose un index local de code et des outils de recherche, de symboles et de carte du projet ; aucun service d’embeddings distant n’est utilisé.
- **Routage et budgets** : rôles de sous-agents, modèles auxiliaires, repli sur quota et budgets configurables. Le choix des modèles utilise le sélecteur partagé ; les actions de quota affichent le nom du modèle concerné.
- **Performance** : les exécutions arrêtées sont exclues du calcul du taux de réussite. Cette version stable reprend aussi les mesures de consommation et la jauge de contexte de la 4.4.0-beta.2.

## 4.4.0-beta.2

- **Onglet Performance** : un nouvel onglet outil de l’espace modulaire montre votre consommation pour ce projet ou tous les projets, sur aujourd’hui, 7, 30 ou 90 jours : coût estimé, tokens, taux de cache, runs, durée médiane et latence du premier token, un graphique par jour, un classement de vos modèles sur votre propre travail (taux de réussite, coût par run réussi, latence, erreurs) et un tableau par projet. Il suit le projet actif ou reste verrouillé sur un projet ; en disposition classique et sur mobile, il s’ouvre depuis l’onglet Session. Il se met à jour à l’affichage, après chaque run ou avec Actualiser, jamais sur un minuteur.
- **Jauge de contexte** : une ligne discrète « Contexte x % · Cache y % » sous chaque zone de saisie (éditeur principal, onglets modulaires, mobile), mise à jour sur les événements du run. Au repos, elle montre la dernière requête. Orange à 80 %, rouge à 95 %.
- **Consommation plus claire dans le panneau Session** : entrée hors cache, sortie, lecture et écriture du cache, taux de cache, et totaux qui incluent les sous-agents sans double comptage. Le chiffre de l’agent principal n’inclut plus une partie de la consommation des sous-agents, et son détail reste ouvert pendant les actualisations du panneau.
- **Mesures d’utilisation** : le Studio enregistre des métadonnées sans contenu pour chaque requête, sous-agents compris (tokens, cache, coût estimé, statuts, durées), les conserve 90 jours dans le dossier de données et reprend les sessions existantes en arrière-plan. Aucun prompt, réponse ni contenu d’outil n’est enregistré.

## 4.3.8-beta.3

- **Copier l’identifiant d’une conversation** : le menu d’une conversation propose **Copier l’identifiant de la conversation**. Il copie l’identifiant enregistré, utile avec l’API publique ou pour le support. Contribution de [@evgyur](https://github.com/evgyur) dans la [#8](https://github.com/zerr0o/prime-agent-studio/pull/8).

## 4.3.8-beta.2

- **La fenêtre se rouvre là où vous l’avez laissée** : la fenêtre principale garde sa position, sa taille et son état agrandi d’un démarrage à l’autre. Une fenêtre plus grande que son écran est réduite pour y tenir, et une fenêtre restée sur un écran débranché revient sur l’écran principal.

## 4.3.8-beta.1

- **Agents en attente visibles dans le panneau Session** : dans « Agents en cours », un agent qui attend votre réponse affiche le point ambre de question utilisé dans la barre latérale et les onglets, à la place de l’indicateur de chargement. L’indicateur revient une fois la réponse envoyée. Contribution de [@evgyur](https://github.com/evgyur) dans la [#7](https://github.com/zerr0o/prime-agent-studio/pull/7).

## 4.3.7

- **Messages vocaux** : un microphone dans le compositeur enregistre un message et le transcrit, puis envoie le texte ou l’ajoute au brouillon (**Envoyer après la transcription**). Activez-le dans Préférences › Outils › Messages vocaux, avec **Groq** (la clé Groq des Fournisseurs, ou `GROQ_API_KEY`) ou un serveur **Whisper local** comme whisper.cpp ; ce réglage est propre à chaque PC. Après une erreur temporaire, **Réessayer** renvoie le même enregistrement. Contribution de [@evgyur](https://github.com/evgyur) dans la [#6](https://github.com/zerr0o/prime-agent-studio/pull/6).
- **Plusieurs questions à la fois** : l’agent peut poser de 1 à 6 questions en un seul appel. Parcourez-les sur une seule ligne, ← Question 2/3 →, répondez à chacune par une option ou votre propre texte, ou passez-la : une question passée affiche une coche et « Question passée », et un second clic annule. Envoyez ensuite toutes les réponses ensemble. Une réponse libre est toujours possible, y compris pour une question unique. L’API publique accepte `{ values: [...] }` pour plusieurs questions ; une question unique garde son format.
- **La barre latérale ne remplace plus une conversation ouverte** : en espace modulaire, choisir une conversation, un run ou un projet l’ouvre dans un nouvel onglet juste à droite de la conversation active, ou sélectionne son onglet existant. À huit conversations ouvertes, le Studio demande de fermer un onglet au lieu d’en remplacer un.
- **Fenêtres étroites et mobile** : c’est toujours l’éditeur visible qui envoie. L’éditeur d’un onglet masqué ne peut plus envoyer un texte périmé.
- **Dans chaque onglet** : les onglets secondaires affichent le bouton Derniers messages au-dessus de leur zone de saisie, et n’ajoutent plus de barre « question(s) en attente » redondante.
- **Mises à jour** : l’option beta n’indique plus qu’il n’y a aucune vérification automatique.

## 4.3.6-beta.2

- **Messages vocaux** : un microphone dans le compositeur enregistre un message, le transcrit et envoie le texte. Activez-le dans Préférences › Outils › Messages vocaux, avec **Groq** (la clé Groq des Fournisseurs, ou `GROQ_API_KEY`) ou un serveur **Whisper local** comme whisper.cpp. Ce réglage est propre à chaque PC. Contribution de [@evgyur](https://github.com/evgyur) dans la [#6](https://github.com/zerr0o/prime-agent-studio/pull/6).
- **Envoyer ou garder en brouillon** : désactivez **Envoyer après la transcription** pour ajouter le texte transcrit au brouillon sans l’envoyer, et le compléter d’abord.
- **Dictée fiable** : après une erreur temporaire (limite de débit, délai dépassé, service indisponible), **Réessayer** renvoie le même enregistrement. Si la conversation d’origine n’existe plus, **Copier le texte** conserve la transcription. Le microphone utilise toujours l’éditeur visible, y compris sur mobile.

## 4.3.6-beta.1

- **Plusieurs questions à la fois** : l’agent peut poser de 1 à 6 questions en un seul appel. Parcourez-les sur une seule ligne, ← Question 2/3 →, répondez à chacune par une option ou votre propre texte, passez celles que vous voulez, puis envoyez toutes les réponses ensemble. Une réponse libre est toujours possible, y compris pour une question unique. L’API publique accepte `{ values: [...] }` pour plusieurs questions ; une question unique garde son format.
- **La barre latérale ne remplace plus une conversation ouverte** : en espace modulaire, choisir une conversation, un run ou un projet l’ouvre dans un nouvel onglet juste à droite de la conversation active, ou sélectionne son onglet existant. À huit conversations ouvertes, le Studio demande de fermer un onglet au lieu d’en remplacer un.
- **Fenêtres étroites et mobile** : c’est toujours l’éditeur visible qui envoie. L’éditeur d’un onglet masqué ne peut plus envoyer un texte périmé.
- **Derniers messages dans chaque onglet** : les onglets secondaires affichent le même bouton Derniers messages, centré au-dessus de leur zone de saisie.

## 4.3.5

- **Ordre des Roadmaps synchronisé** : déplacer un plan, un jalon ou un élément de backlog se propage maintenant aux autres PC. Auparavant, chaque PC gardait son propre ordre lors d’une fusion : deux PC pouvaient rester différents indéfiniment tout en affichant « synchronisé ». L’ordre de la Roadmap modifiée le plus récemment l’emporte ; en cas d’égalité, tous les PC choisissent le même. Au premier cycle après la mise à jour, chaque Roadmap distante est fusionnée de nouveau une fois pour résorber les écarts existants.

## 4.3.4

- **Modèles Muse Code selon votre abonnement** : le sélecteur n’affiche plus que les modèles réellement servis par votre offre. Muse Wonder Full n’apparaît donc plus sur les offres qui ne l’incluent pas, au lieu d’échouer avec « model not found ». La liste est lue chez Meta en lecture seule ; si elle est indisponible, tous les modèles restent affichés.
- **Muse Wonder Contributor** : nouvelle variante Muse Code (`muse-wonder-1.0-contributor`), servie dans le mode Contributor par défaut des abonnements. Elle donne plus d’usage en échange de l’utilisation des contenus pour l’entraînement.

## 4.3.3

- **Synchronisation depuis l’API publique** : `GET /api/v1/sync` lit l’état ; `POST /api/v1/projects/{projectId}/sync` synchronise immédiatement via R2 une conversation (même jamais vue sur ce PC) ou lance un cycle complet. Nouvelle permission `sync:write`, décochée par défaut. Une application peut ainsi reprendre sur un PC une conversation terminée sur un autre sans attendre le cycle de cinq minutes.
- **Envoi fiable en fin de tour** : la synchronisation d’une conversation attend la fin d’un cycle en cours au lieu d’être sautée.
- **Muse Wonder** : nouveau modèle Meta (`muse-wonder-1.0`, préversion) avec une clé API ou l’abonnement Muse Code ; **Muse Wonder Full** avec l’abonnement Muse Code (offres Power Usage et Maximum Usage).

## 4.3.2

- **Mise à jour disponible** : l’application Windows vérifie les mises à jour 10 secondes après le démarrage, puis toutes les 30 minutes, sur le canal choisi (stable ou bêta). Si une version existe, le bouton **Mise à jour disponible** apparaît à côté de **Préférences** et ouvre **Préférences → Mises à jour**. Rien n’est téléchargé ni installé sans votre clic ; les erreurs de cette vérification restent silencieuses.
- **Nouvelle conversation toujours possible** : les conversations fermées restaient mémorisées et, au-delà de 24, bloquaient la création même avec peu d’onglets ouverts. Le Studio libère maintenant la plus ancienne conversation fermée sans brouillon, pièce jointe ni agent en cours. L’historique reste disponible depuis la barre latérale.
- **README** : nouvelle page d’accueil FR/EN avec le film de présentation complet ; guides des fournisseurs, de la configuration et de la navigation corrigés pour l’accès distant en contrôle complet.

## 4.3.1

- **Computer Use dans l’API publique** : `GET /api/v1/computer-use` lit l’état ; `POST` active ou désactive l’autorisation pour une session ou un run. La nouvelle permission `computer:write` est décochée par défaut et n’est pas ajoutée aux anciens jetons. Chaque écriture exige la révision lue, sans reprise du contrôleur d’une autre cible ni capture ou saisie implicite. Documentation FR/EN et OpenAPI à jour.
- **Ouvrir un dossier hors projet** : le menu **Ouvrir le dossier** accepte tout dossier existant accessible au PC, sans l’enregistrer comme projet. Les chemins absolus, relatifs et `file://` sont pris en charge ; un fichier ouvre son dossier parent. Les aperçus et téléchargements gardent leurs limites d’accès.
- **Menu des liens dans un aperçu** : les liens d’un document ouvert dans un dialogue peuvent aussi ouvrir leur dossier ; le menu reste cliquable et le retour du focus au clavier est préservé.

## 4.3.0

- **Espace modulaire stable** : disposez jusqu’à huit conversations et seize panneaux outils. Chaque conversation conserve son éditeur, ses brouillons, pièces jointes et position de lecture. Les dispositions classique et mobile restent disponibles.
- **Outils indépendants et verrouillables** : Roadmap, Session, Agents, Fichiers et Préférences suivent la conversation active ou restent attachés à leur cible. Une cible absente reste indisponible ; les droits restent à jour. Les dispositions nommées ne conservent que les types de panneaux et leur géométrie.
- **Clignotement Computer Use corrigé** : changer de conversation n’efface plus le propriétaire du bureau, la dernière action ni le raccourci d’arrêt dans les panneaux Session, même verrouillés. Ces informations conservées n’accordent aucun droit de contrôle à la nouvelle conversation ; les réponses tardives et les erreurs restent gérées.
- **Historique et navigation plus fluides** : l’historique paginé et virtualisé conserve toutes les données enregistrées. Les nouvelles conversations ouvrent des onglets distincts ; le chargement Roadmap, les dialogues Préférences et les liens/images au premier clic sont corrigés.
- **Onglets et saisie affinés** : noms d’outils courts, cadenas intégrés, déplacement par glisser-déposer, commandes slash par panneau et expansion des skills dans le texte.
- **Autres améliorations depuis 4.2.0** : API publique v1 facultative et documentation interactive, provenance des tâches Roadmap terminées, finition mobile et mises à jour de sécurité des dépendances.
- **Limites** : les fenêtres natives flottantes ne sont pas incluses. La recherche du navigateur porte sur les messages montés ; un très grand message déplié peut rester coûteux. Les défauts existants de navigation après reconnexion et de retour du focus depuis Skills restent suivis séparément.

## 4.3.0-beta.10

- **Libellés sobres** : les onglets outils et le menu Ajouter un onglet affichent uniquement Roadmap, Session, Agents, Fichiers ou Préférences. Le projet et la conversation restent indiqués dans le contenu.
- **Cadenas intégré** : le verrou se trouve dans la surface de l’onglet, avec son propre bouton accessible. Son fonctionnement ne change pas.
- **Menu allégé** : le sous-menu Déplacer vers est supprimé. Le déplacement par glisser-déposer est conservé.

## 4.3.0-beta.9

- **Onglets outils indépendants** : ouvrez plusieurs panneaux Roadmap, Session, Agents, Fichiers et Préférences, jusqu’à seize panneaux outils aux côtés de huit conversations. Chaque panneau garde sa sélection, ses formulaires et ses dialogues.
- **Verrouillage de cible** : fixez un outil à sa conversation et son projet, ou laissez-le suivre la conversation active. Les verrous survivent au rechargement ; données et droits restent actualisés. Une cible absente demeure indisponible, sans remplacement silencieux par une autre conversation.
- **Agencements simplifiés** : ajoutez et déplacez les onglets depuis leur menu. Le dialogue Agencement conserve l’activation de l’espace modulable, les agencements nommés et la réinitialisation. Les agencements nommés ne contiennent que les types et la géométrie des panneaux, sans conversation, brouillon ni verrou, et réutilisent les panneaux rangés sans démarrer d’exécution.
- **Préférences fiables** : le bouton principal ouvre une pop-up même depuis un onglet inactif ; Ajouter un onglet crée une instance ancrée. Les réglages restent globaux, mais chaque panneau garde sa catégorie, ses formulaires et le retour du focus depuis ses dialogues enfants. Une réponse tardive ne remplace plus une valeur confirmée plus récente.
- **Liens et images au premier clic** : une conversation principale ou secondaire inactive ouvre ses liens et images dès le premier clic. Les clics modifiés, le clavier, la sélection de texte et les brouillons sont préservés.
- **Contexte actualisé** : les panneaux Session affichent le propriétaire, l’action et le raccourci d’arrêt de Computer Use depuis un seul moniteur partagé. Les commandes restent liées à la conversation active. La recherche dans l’aperçu du projet et le focus mobile ne reviennent plus à la conversation principale.
- **Compatibilité** : les modes classique et mobile restent disponibles. Fermer un onglet ne supprime pas son contenu et n’arrête pas son exécution. Les fenêtres natives détachées ne sont pas incluses.

## 4.3.0-beta.8

- **Conversations immédiatement utilisables** : la saisie et les quatre suggestions d’accueil apparaissent dès l’ouverture, y compris après l’ajout d’un projet. Les suggestions remplissent le bon panneau et suivent la langue choisie.
- **Création sans remplacement** : le bouton Nouvelle session, Ctrl+N et le menu projet ajoutent un onglet distinct dans l’espace modulable. Conversations ouvertes, brouillons, pièces jointes et positions de lecture restent préservés ; la limite de huit onglets refuse une création supplémentaire sans écrasement.
- **Restauration cohérente** : les onglets et leurs noms de projet reviennent après rechargement. Une conversation vide n’hérite plus de l’état d’un autre agent encore sans identifiant de session.
- **Roadmap débloquée** : les écritures équivalentes d’un chemin Windows ne font plus rejeter une réponse valide. Les erreurs initiales quittent le chargement et proposent de réessayer. Les changements de conversation ou de projet pendant une requête conservent le document courant et les brouillons, sans afficher une ancienne réponse.
- **Régressions vérifiées** : tests des créations et changements rapides d’onglet, réponses retardées, erreurs, traductions et restauration ajoutés aux commandes habituelles. Modes classique et mobile conservés.

## 4.3.0-beta.7

- **Redimensionnement plus fluide** : les poids des séparateurs ne propagent plus leurs changements de style à toute la conversation. Les hauteurs des espaces virtuels ne sont jamais animées.
- **Historique dynamique** : les 80 derniers messages sont chargés d’abord, puis les pages antérieures en remontant ou via le bouton de chargement. Seuls les blocs proches sont montés ; les activités repliées diffèrent la création de leur contenu lourd.
- **Panneaux indépendants** : pagination, streaming, reprise après reconnexion et fin de réponse avec identifiants sauvegardés préservent la lecture, les brouillons et le focus du panneau concerné. Les liens d’historique peuvent révéler les anciens messages non montés.
- **Données complètes** : historiques sauvegardés, contexte moteur, reçus de lecture et exports complets ne sont pas tronqués. Les appels API existants sans pagination conservent la réponse intégrale.
- **Limites connues** : la recherche du navigateur couvre le texte monté uniquement. Un message ou une activité développée très volumineuse peut rester coûteux. Les fenêtres natives détachées et les problèmes préexistants de navigation après reconnexion et de retour du focus depuis Skills restent hors de ce changement.

## 4.3.0-beta.6

- **Commandes slash par panneau** : le menu `/` apparaît au-dessus du champ actif, en mode classique comme dans l’espace modulable. Les insertions, le redimensionnement et la restauration des brouillons restent liés au bon panneau.
- **Skills dans le texte** : insérez plusieurs `/skill:nom` à différents endroits du message. Les instructions sont développées à leur position, dans l’ordre, sans retirer le texte environnant. Les chemins, URL, échappements et blocs de code restent du texte ; les commandes natives conservent leur comportement.
- **Saisie cohérente** : hauteur de base et croissance harmonisées, boutons envoyer/arrêter de même taille, contrôles de modèle et permissions lisibles dans les panneaux étroits. Les brouillons et les chips de skills restent indépendants après rechargement.
- **Finitions** : pied de champ aligné, noms de modèle mieux visibles, ponctuation française insécable et lignes complètes dans le champ rempli. La revue visuelle porte sur des captures isolées, pas sur une certification de tous les appareils.
- **Limites connues** : les fenêtres natives détachées ne sont pas incluses. Le rendu initial des très longs historiques et les problèmes préexistants de navigation après reconnexion et de retour du focus depuis Skills restent suivis séparément.

## 4.3.0-beta.5

- **Moins de chargements inutiles** : les conversations non ouvertes utilisent les états lu/non lu déjà fournis par le serveur, sans télécharger leur historique complet. La conversation active continue de recevoir les nouvelles réponses, y compris celles ajoutées depuis un autre appareil.
- **Historiques compressés** : les réponses volumineuses de l’API d’historique utilisent gzip lorsque le navigateur l’accepte. Tous les messages et résultats d’outils sont conservés ; les droits d’accès et l’absence de cache restent inchangés.
- **Fermeture des onglets** : le menu contextuel affiche simplement « Fermer ». Un clic molette ferme aussi l’onglet, sans supprimer la conversation ni son brouillon et sans activer le défilement automatique. Le bouton × conserve son libellé accessible descriptif.
- **Mesures et limites** : sur un scénario isolé de 13 conversations, les chargements d’historique passent de 14 à 1 ; un historique synthétique varié passe de 198 598 à 33 493 octets avec gzip. Ces mesures ne représentent pas un gain global garanti sur téléphone réel. Le rendu initial des très longs historiques et les problèmes préexistants de navigation après reconnexion et de retour du focus depuis Skills restent suivis séparément.

## 4.3.0-beta.4

- **Rendu des conversations ciblé** : le streaming ne recalcule plus les historiques des panneaux non concernés. Les mises à jour concurrentes restent regroupées, sans tronquer les messages ni perdre les brouillons.
- **Reprise après mise à jour** : un serveur déjà à jour et dont l’identité est vérifiée ne redemande plus inutilement un redémarrage. Le guide affiche le bouton de redémarrage et conserve la confirmation lorsque des agents travaillent.
- **États plus clairs** : les messages distinguent la version de Studio, celle du moteur et un serveur arrêté. Une vérification indisponible n’est plus présentée comme une activation en attente ; une opération ancienne non confirmée après relance ne signifie pas que l’installation a échoué.
- **Démarrage Windows** : une préférence impossible à lire est affichée comme inconnue dans le lanceur et les Préférences, sans la remplacer par « désactivé ». L’identité de l’application et les protections de l’installateur pour les réglages et raccourcis existants sont couvertes par des contrôles supplémentaires.
- **Limites connues** : le coût des très grands historiques du panneau actif reste à optimiser. Le test de retour du focus après fermeture de Skills échoue également sur beta.3 et reste suivi séparément. Les protections Windows ont été contrôlées sans exécuter une mise à jour réelle du poste.

## 4.3.0-beta.3

- **Streaming multi-conversations plus fluide** : les mises à jour sont regroupées au lieu de recalculer immédiatement chaque événement en arrière-plan, et les panneaux masqués ne sont plus redessinés. Les aperçus de dépôt ne sont actualisés que si nécessaire et les aperçus en attente sont annulés à la fin du geste.
- **Conversations restaurées** : tous les panneaux sauvegardés visibles chargent leur historique sans nécessiter de clic, sans changer la conversation active ni ses brouillons.
- **Chargement de la Roadmap** : les requêtes invalidées sont remplacées sans attendre le prochain rafraîchissement périodique, avec un délai maximal et les protections contre les réponses périmées conservées.
- **Indicateur unique** : suppression du libellé de travail en double au-dessus des composers indépendants, sans retirer les indications de chargement ou d’indisponibilité.

## 4.3.0-beta.2

- **Historique des conversations rétabli** : corrige une régression introduite dans 4.3.0-beta.1 qui pouvait laisser la conversation vide lorsqu’elle contenait des appels d’outils. Les messages étaient chargés, mais leur affichage s’arrêtait avec `Assignment to constant variable.`
- **Ouverture depuis un autre projet** : le même correctif s’applique à l’ajout ou au glisser-déposer d’une conversation dans l’espace modulable. Aucune migration ni réinitialisation de l’historique n’est nécessaire.
- **Couverture de régression** : les appels d’outils natifs historiques et leurs résultats sont désormais testés en mode classique, dans le panneau principal et dans les vues supplémentaires, y compris entre projets.

## 4.3.0-beta.1

- **Espace modulable** : activez-le depuis **Agencement** sur les écrans desktop de plus de 1080 px. Séparez, regroupez, réordonnez et redimensionnez les vrais panneaux sans gouttière. Les dispositions classique et mobile restent disponibles.
- **Conversations indépendantes** : affichez jusqu’à huit panneaux, chacun avec son compositeur complet et ses réglages de modèle, de réflexion et de questions. Brouillons, pièces jointes et flux restent liés à leur conversation ; seul le panneau focalisé fournit le contexte des outils partagés.
- **Onglets et navigation précis** : glissez une conversation depuis la barre latérale ou insérez un onglet entre ses voisins. **Ajouter un onglet** propose un sélecteur projet/conversation ; le bouton principal **Nouvelle conversation** et **Ctrl+N** réutilisent le panneau focalisé.
- **Fermer les autres** : gardez l’onglet choisi et rangez uniquement ses frères du même groupe, sans perdre les brouillons ou pièces jointes ni arrêter les exécutions. Les autres groupes restent intacts.
- **Outils indépendants et Préférences** : Session, Agents, Fichiers et Roadmap s’agencent séparément. Le bouton Préférences ouvre une pop-up modale par défaut ; **Ajouter un onglet → Préférences** ouvre explicitement un onglet ancré. Les deux chemins conservent le même formulaire vivant et ses dialogues enfants.
- **Agencements nommés et restauration sûre** : sauvegardez la géométrie des panneaux sans y inclure le contenu ni les références de session. Fermeture, réouverture, rechargement et passage à une fenêtre étroite conservent les états par vue. Les icônes reflètent le type de panneau et la couleur du projet propriétaire.
- **Redimensionnement fiable** : les panneaux à leur largeur minimale ne laissent plus de bande vide et ne provoquent plus de saut de largeur. Le redimensionnement au pointeur ou au clavier, l’annulation et la géométrie sauvegardée restent cohérents.

## 4.2.1-beta.3

- **Bandeau et champ de saisie mobiles** : les actions regroupées tiennent à 320 et 390 px, le texte indicatif reste entièrement visible pendant un tour, et les libellés courts des permissions conservent leurs noms accessibles complets. La disposition desktop et le panneau de détails mobile plein écran sont préservés.
- **Provenance des validations Roadmap** : chaque nouvelle étape validée enregistre l’identifiant du Studio, la conversation associée (si disponible) et la date de validation. Ces détails se consultent sous l’étape sans lancer d’agent.
- **Historique conservé** : recocher une étape déjà validée ou modifier un autre champ conserve l’attribution ; rouvrir l’étape l’efface. La synchronisation et l’export/import `.pastudio` conservent la source sans l’attribuer au Studio destinataire. Les anciennes validations ne sont pas renseignées rétroactivement.
- **API et OpenAPI** : les métadonnées `completion`, en lecture seule, sont documentées et renvoyées pour les étapes Roadmap. `step.check` accepte un `sessionId` facultatif vérifié dans le projet choisi ; les agents natifs utilisent leur conversation courante vérifiée, y compris une conversation enfant.

## 4.2.1-beta.2

- **API publique v1 pour les intégrations externes** : jetons Bearer limités aux projets choisis, projets et conversations, contrôle des runs, SSE avec reprise, lecture et écriture Roadmap, téléchargement des fichiers liés. L’API est désactivée par défaut et se gère localement dans **Préférences → API**.
- **Documentation OpenAPI interactive** : ouvrir `/api-docs` depuis les Préférences pour tester manuellement chacune des 18 opérations, avec JSON, cURL, statut, en-têtes et réponse. Les jetons restent en mémoire dans la page ; les tests POST demandent une confirmation ; les aperçus de flux et fichiers sont limités et annulables.
- **Droits limités et reprises sûres** : permissions distinctes pour les runs, roadmaps et fichiers, expiration et révocation des jetons, déduplication des requêtes en mémoire pendant une heure, conflits de révision et nouvelle vérification des droits avant les actions différées.
- **Transfert et reprise des fichiers** : HEAD, plages d’octets et validateurs, avec contrôle de provenance locale par référence pour éviter de substituer un fichier venant d’un autre PC.
- **Limites distantes conservées** : les jetons API n’ouvrent ni les routes internes ni la gestion distante des jetons. Les appels distants exigent Tailscale ou HTTPS ; le LAN HTTP non chiffré et les navigateurs d’une autre origine ne sont pas ouverts.
- **Documentation et validation** : guides FR/EN, contrat OpenAPI généré et contrôles navigateur pour toutes les opérations. L’exécution peut lancer du code et engendrer des coûts fournisseur ; les fichiers liés peuvent être hors du projet. Désactiver l’API n’arrête pas les agents déjà en cours.

## 4.2.1-beta.1

Bêta de maintenance basée sur la 4.2.0. Aucune nouvelle fonctionnalité visible ni modification de l’API.

- **Moins de code dupliqué** : les tests d’intégration Computer Use utilisent désormais le résolveur d’appelant de production ; l’analyse JSONC, l’attente du processus desktop et les utilitaires de mise à jour Rust réutilisent leurs implémentations existantes.
- **CRC32 standard** : les archives et les images de test utilisent le CRC32 de Node.js au lieu de copies séparées. Un test de régression couvre les archives stockées et compressées et refuse les données endommagées.
- **Nettoyage de l’interface** : suppression d’un calcul d’état de synchronisation inutilisé, d’un import inutilisé et d’un export de traduction inutilisé.
- **Maintenance simplifiée** : les tests d’interface conservent les mêmes choix et replis de navigateur avec moins de code de préparation. Un seul workflow de release gère les nouveaux builds et la reconstruction des brouillons.

## 4.2.0

Version stable. Inclut toutes les bêtas 4.1.5 ci-dessous, plus :

- **Contrôle complet depuis le téléphone** : un appareil distant en contrôle complet peut tout faire comme le PC (fournisseurs et clés, modèles, synchronisation, archives `.pastudio`, worktrees, réglages d’accès distant). Le mode consultation reste en lecture seule. Les sélecteurs de dossier et l’Explorateur s’ouvrent toujours sur l’écran du PC.
- **Message de commit proposé** : « Proposer un message » dans le panneau Git rédige un message conventionnel à partir des fichiers cochés, dans la langue de vos commits récents. Il utilise le modèle auxiliaire s’il est défini, sinon le modèle par défaut ; les identifiants restent dans un processus séparé.
- **Avertissement de conflit de Roadmap** : quand une Roadmap ne peut pas être fusionnée, le panneau de synchronisation indique le projet et l’emplacement de la copie de l’autre PC, et le statut de synchronisation passe en orange.
- **Marqueur d’origine des conversations** : l’icône de PC indique le PC qui a écrit le dernier message, et non un PC qui a seulement renvoyé l’état lu.
- **Corrections** : l’aperçu du raisonnement reste visible sur les réponses terminées ; la barre de saisie tient à 320 px ; les Fournisseurs sont accessibles sur téléphone.
- **Fiabilité** : les tests d’interface choisissent un navigateur installé, et les tests instables (interface et mise à jour Rust) sont corrigés.

## 4.1.5-beta.15

- **Plus de tours inutiles après une réponse** : quand un sous-agent se termine après avoir déjà répondu à un parent occupé, son avis de fin est gardé comme contexte pour le prochain message, au lieu de lancer un appel au modèle par sous-agent après la réponse. Un parent inactif, ou un sous-agent qui n’a pas répondu, réveille toujours le parent.

## 4.1.5-beta.14

- **Clé de recherche web** : la clé Serper utilisée par la recherche web de l’agent se configure dans Préférences → Modèles et agents → Fournisseurs (rechercher « web »). Elle est enregistrée au même endroit que `/login` du CLI.
- **Fin de réponse plus lisible** : les notices de fin des sous-agents (terminé, sans réponse, annulé) rejoignent le groupe d’activité de l’agent au lieu d’afficher une carte « Contexte » chacune après la réponse.

## 4.1.5-beta.13

- **Mise à jour** : même code que la 4.1.5-beta.12, publié sous un nouveau numéro pour que les installations d’un build de test local 4.1.5-beta.12 reçoivent la mise à jour.

## 4.1.5-beta.12

- **Couleurs dans le menu du plan** : le menu du plan (« ··· » ou clic droit) affiche les pastilles de couleur ; un clic applique la couleur.
- **Synchronisation de la Roadmap plus rapide** : une modification est envoyée 2 secondes après le changement, et une Roadmap ouverte récupère les changements des autres PC au plus une fois par minute.
- **Couleur du PC** : le choix de la couleur de ce PC dans Préférences → Synchronisation fonctionne (il était refusé comme configuration invalide).

## 4.1.5-beta.11

- **Synchronisation de la Roadmap** : la Roadmap de chaque projet synchronisé se synchronise entre PC, avec une fusion à trois versions basée sur la dernière version synchronisée ; une modification d’un seul côté l’emporte, en cas de modification des deux côtés la plus récente gagne, et ajouts comme suppressions sont conservés. Une copie distante inutilisable est sauvegardée, jamais perdue.
- **Backlog horodaté** : les entrées reçoivent un identifiant stable et des dates ; si deux PC créent le même numéro hors ligne, l’entrée la plus ancienne le garde.
- **Couleurs** : palettes distinctes pour les projets, les plans de Roadmap et les PC. Les couleurs des plans, des projets et de chaque PC se synchronisent.
- **Marqueur d’origine** : une conversation lancée en dernier sur un autre PC affiche une icône d’écran à la couleur de ce PC, dans la barre latérale et l’en-tête.
- **Menu contextuel de la Roadmap** : un clic droit sur un plan, un jalon ou une ligne du backlog ouvre le même menu que « ··· ».

## 4.1.5-beta.10

- **Machines dans la PWA** : un nouvel écran Machines liste les PC qui font tourner le Studio. Ajoutez un PC en scannant le QR code de ses Préférences → Accès distant, à partir d’une photo de ce code, ou en saisissant son adresse. Renommez, modifiez ou retirez une machine ; la liste reste sur le téléphone.
- **Ouverture sur la liste** : dès qu’une autre machine est enregistrée, la PWA s’ouvre sur cette liste. Elle s’ouvre aussi quand le PC ne répond pas, et l’écran de reconnexion propose « Ouvrir une autre machine ».
- **Un accès par PC** : chaque PC garde sa passerelle, son code d’accès et ses sessions. Un PC mis à jour vers cette version garde votre session quand vous l’ouvrez depuis la liste.

## 4.1.5-beta.9

- **Git dans l’onglet Fichiers** : sélecteur de branches avec recherche (branches locales et distantes, nouvelle branche), compteurs d’avance et de retard, Récupérer, Pull (avance rapide uniquement) et Push (jamais forcé, branche amont créée pour une nouvelle branche).
- **Commit depuis Studio** : choix des fichiers par cases à cocher, message sur plusieurs lignes, puis commit (Ctrl+Entrée). Les hooks du dépôt s’exécutent au commit et au push ; un commit refusé laisse l’index inchangé.
- **Sécurité** : changer de branche n’écrase jamais les modifications locales ; changement de branche et pull bloqués pendant qu’un agent travaille dans le projet. Disponible à distance en contrôle complet.

## 4.1.5-beta.8

- **Attente des sous-agents plus claire** : quand un tour se termine alors que des sous-agents travaillent encore, l’indicateur d’activité affiche « Attend ses sous-agents » au lieu de « Fin de tour ». Il passe à « Fin de tour » quand le dernier sous-agent a terminé.

## 4.1.5-beta.7

- **Aligner Git** est maintenant un bouton principal dans le panneau Session.
- **Lanceur** : l’écran de démarrage indique la version requise Prime Agent 0.9.8 au lieu de 0.9.7.
- **Code allégé** : fonctions dupliquées retirées sans changement de comportement ; 16 tests UI et natifs auparavant non branchés passent par `npm run test:*`.

## 4.1.5-beta.6

- **L’état lu se synchronise entre PC** : une conversation lue sur un PC n’est plus non lue sur l’autre ; « Marquer comme non lu » aussi. La dernière action l’emporte.
- **Contexte Git dans le panneau Session** : branche et commit enregistrés par la conversation, comparés à ce PC.
- **Aligner Git** : place le projet sur la branche et le commit de la conversation (fetch, switch, fast-forward uniquement). Refusé en cas de modifications non commitées, de divergence ou de commit non poussé ; rien n’est écrasé.
- **Statut plus clair** : une conversation en cours n’est plus comptée « à envoyer », et « Synchroniser maintenant » affiche toujours le résultat.

## 4.1.5-beta.5

- **Identité stable des projets entre PC** : un projet synchronisé est reconnu par son dépôt Git, puis par son nom, ou par un lien explicite, même après un renommage.
- **Liste des projets synchronisés** : voir les projets des autres PC, leur mode de liaison, et ajouter un projet manquant en choisissant son dossier local.
- **Choix du lien** à l’ajout d’un dossier, et « Lier la synchronisation… » dans le menu du projet.

## 4.1.5-beta.4

- **Panneau de synchronisation** : statut et « Synchroniser maintenant » en haut, configuration repliée en dessous ; « Oublier » est un bouton rouge avec confirmation intégrée.
- **Compteur exact** : les conversations déjà envoyées par une bêta précédente ne s’affichent plus « à envoyer ».
- **Mises à jour plus légères** : le statut ouvre directement l’onglet Synchronisation, et la barre latérale n’est redessinée que si un badge change.
- **Panneau Session** : le quota est juste sous la session et se met à jour toutes les 5 minutes ; la note sur le terminal est supprimée.

## 4.1.5-beta.3

- **Statut de synchronisation visible** : statut permanent sous l’état du moteur (synchronisé, envoi avec progression, changements à envoyer, erreur), badge sur les dossiers synchronisés et état de la conversation dans l’en-tête.
- **Vérification à l’ouverture** : ouvrir une conversation récupère rapidement sa dernière version depuis R2, en conservant le brouillon. Les tours terminés sont envoyés immédiatement.
- **Épinglage, titre et archivage** sont synchronisés entre PC ; la modification la plus récente l’emporte.
- **Reconnexion plus sûre** : oublier puis reconnecter le même bucket ne renvoie plus tout l’historique.

## 4.1.5-beta.2

- **Synchronisation des conversations (bêta)** : synchronise les conversations entre PC via votre propre bucket Cloudflare R2, avec chiffrement avant l’envoi. Seuls les nouveaux messages sont envoyés et les images ne sont stockées qu’une fois. Aucune machine n’a besoin de rester allumée.
- **Synchronisation par projet** : activée par défaut, désactivable à l’ajout d’un dossier ou depuis le menu du projet.
- **Roue Alt** : titres contenus dans les tranches, titre de conversation au-dessus du projet, légère teinte des tranches en cours ou non lues.

## 4.1.4

- **Prime Agent 0.9.8** : mise à jour de la découverte des modèles et rafraîchissement du sélecteur natif à chaque ouverture. Studio conserve son identité Codex plus récente pour GPT-6.1 Sol.

- **GPT-6.1 Sol** : ajout du modèle pour l’API OpenAI et les comptes Codex éligibles, avec raisonnement toujours actif, tarification du cache API et identité du client Codex officiel courant. Les réglages par défaut et les contrôles d’accès sont conservés.

- **Prime Agent 0.9.7** : mise à jour du moteur géré pour mieux traiter les grosses sorties Python, fiabiliser l’activité des sessions natives et intégrer les correctifs amont d’Azure Responses et de Gemma 4 sur Vertex.
- **Relais fiable des sous-agents** : le parent reçoit un avis natif de fin d’exécution, même après des messages de progression de l’enfant. Cet avis signale la fin de l’exécution, pas la réussite de la tâche.
- **Messages enfants ordonnés** : la tâche initiale est admise avant les messages précoces, y compris les diffusions et les messages entre agents frères. Les erreurs de démarrage, annulations et suppressions débloquent toujours les expéditeurs en attente.
- **Migration sûre du moteur** : une nouvelle génération du moteur et de Python est préparée en conservant les anciens fichiers. Aucun kernel actif n’est modifié sur place.
- **Diagnostics natifs fiables** : les vérifications en lecture seule ne s’annulent plus lorsque leur entrée est fermée, évitant les faux signalements de chemins moteur et uv invalides.
- **Confirmation après maintenance** : une opération terminée ne bloque plus la confirmation de redémarrage lorsque des agents travaillent. Les protections des opérations encore en cours sont conservées.

## 4.1.4-beta.2

- **GPT-6.1 Sol** : ajout du modèle pour l’API OpenAI et les comptes Codex éligibles, avec raisonnement toujours actif, tarification du cache API et identité du client Codex officiel courant. Les réglages par défaut et les contrôles d’accès sont conservés.

## 4.1.4-beta.1

- **Prime Agent 0.9.7** : mise à jour du moteur géré pour mieux traiter les grosses sorties Python, fiabiliser l’activité des sessions natives et intégrer les correctifs amont d’Azure Responses et de Gemma 4 sur Vertex.
- **Relais fiable des sous-agents** : le parent reçoit un avis natif de fin d’exécution, même après des messages de progression de l’enfant. Cet avis signale la fin de l’exécution, pas la réussite de la tâche.
- **Messages enfants ordonnés** : la tâche initiale est admise avant les messages précoces, y compris les diffusions et les messages entre agents frères. Les erreurs de démarrage, annulations et suppressions débloquent toujours les expéditeurs en attente.
- **Migration sûre du moteur** : une nouvelle génération du moteur et de Python est préparée en conservant les anciens fichiers. Aucun kernel actif n’est modifié sur place.
- **Diagnostics natifs fiables** : les vérifications en lecture seule ne s’annulent plus lorsque leur entrée est fermée, évitant les faux signalements de chemins moteur et uv invalides.
- **Confirmation après maintenance** : une opération terminée ne bloque plus la confirmation de redémarrage lorsque des agents travaillent. Les protections des opérations encore en cours sont conservées.

## 4.1.3

- **Suppression d’un sous-agent sans fermeture du parent** : l’annulation de l’attente d’un enfant reste locale à cet enfant. Le parent attend les autres travaux délégués au lieu de fermer la session. L’arrêt explicite du parent et les autres erreurs restent propagés.

- **Notices de contexte compactes** : les rappels ordinaires d’objectif rejoignent l’Activité de l’agent, les résumés de compactage et de branche sont repliés par défaut et les cartes d’activité terminées prennent moins de place. Les alertes de budget, changements d’objectif et notices inconnues restent visibles. Les détails complets restent accessibles ; l’historique natif et le contexte envoyé au modèle sont inchangés.

- **Clic sur les notifications Windows** : tant que Studio fonctionne, un clic affiche l’application et ouvre la conversation concernée, même dans un autre projet, en conservant les brouillons. Cela ne relance pas une application entièrement quittée.
- **Marquer comme non lu** : le menu de conversation met à jour l’état de lecture partagé par la barre latérale et le menu Alt. Marquer la conversation ouverte renvoie à la vue d’ensemble du projet et conserve son brouillon.
- **Couleurs de projet plus vives** : les anciennes couleurs pastel utilisent leur équivalent vif. Les épingles de projet et des conversations épinglées inactives reprennent cette couleur ; les indicateurs d’activité gardent leur priorité.
- **Préférences plus claires** : Computer Use reçoit une brève explication, les fournisseurs précèdent les modèles et les versions de l’application installée et du serveur en cours sont visibles sans déplier les détails techniques. Les notifications internes apparaissent au-dessus du flou des préférences.

- **Navigation rapide entre conversations** : maintenez **Alt** pour ouvrir un menu radial animé au-dessus de l’espace de travail. Il affiche les six conversations non archivées modifiées le plus récemment, tous projets confondus, triées par titre. Chaque portion indique le nom du projet en gras et sa couleur.
- Survolez une portion ou appuyez sur **1 à 6 au pavé numérique**, puis relâchez **Alt** pour l’ouvrir. Revenez au centre ou appuyez sur **Échap** pour annuler. Les brouillons sont conservés ; les préférences de réduction des animations sont respectées.
- **Indicateurs d’activité en direct** : le menu radial reprend les pastilles de la barre latérale pour les agents en cours, les réponses non lues et les questions en attente. Elles se mettent à jour sans fermer le menu.

## 4.1.2 (incluse dans 4.1.3)

- **Revue du harness dans Connaissances du projet** : nouveaux filtres **Prompts**, **Skills** et **Subagents** pour voir toutes les entrées natives reçues par l’agent. **Global** n’affiche que les entrées partagées entre projets.
- **Quota Claude** : les sessions qui utilisent un abonnement Claude lié (OAuth) affichent le quota sur 5 heures et hebdomadaire, comme Codex. Si l’agent principal et les sous-agents utilisent des abonnements différents, les deux quotas sont affichés. Actualisation manuelle uniquement ; aussi dans Fournisseurs.
- **Contexte de l’agent allégé** : les longues listes de variables Python restaurées sont remplacées par leur nombre dans les requêtes envoyées au modèle. Le fichier de session garde la liste complète. Mesuré sur une longue session : environ 816 000 caractères de ces notices ramenés à 8 000.
- **Quota plus stable** : le quota Codex ne disparaît plus brièvement environ toutes les minutes.
- **Annuler ce refinement** et **Corriger** pré-remplissent une commande native `/refine` dans la conversation concernée. Rien ne s’exécute avant l’envoi ; le Studio n’écrit jamais lui-même dans le harness. Masqués en accès distant en lecture seule.

## 4.1.1

- **Conversation** : messages inter-agents et notifications techniques regroupés dans « Activité de l’agent », sans modifier l’historique. Les réponses et interactions restent accessibles ; les aperçus de réflexion terminés sont masqués.

- **Maintenance** : suppression des helpers inutilisés du noyau, du bridge Computer Use et des composants UI ; détection du bridge et confirmation de redémarrage partagées, sans changer les règles d’autorisation ou d’annulation.
- **Implémentations partagées** : réutilisation de la détection des configurations JSONC, de la préparation des lancements PowerShell et du writer atomique Rust existant, avec conservation des validations et des erreurs.
- **Tests de sécurité des images** : retrait des filtres obsolètes et tests directs du normaliseur de contexte actif. Les limites des captures Computer Use et l’historique en entrée restent inchangés.
- **Couverture de régression** : vérifications renforcées de l’annulation du redémarrage et du nettoyage après échec d’écriture atomique. Aucune nouvelle dépendance.

## 4.1.0 (pre-release)

- **Prime Agent 0.9.6** : préparation du moteur épinglé avec un environnement Python géré distinct. Les contrôles exigent les nouvelles méthodes de découverte MCP. Le correctif natif des commandes en arrière-plan est reconnu sans réécrire son implémentation.
- **Réglages natifs des modèles** : le sélecteur partagé expose `imageModel` pour les tours avec images sur un modèle texte. L’aide du modèle auxiliaire couvre l’affinage et les résumés de compaction et de branche. Le niveau de service par défaut propose Standard, Flex, Priority et Auto sans modifier les sessions actives. Les tours routés avec images conservent le modèle de conversation lors d’une reprise ultérieure, par ajout de métadonnées natives sans réécriture.
- **Compatibilité OAuth MCP** : l’inscription dynamique confidentielle conserve l’identité du client pour l’échange du code et le renouvellement. Les options avancées acceptent un client ID, un nom de variable du secret, une URL de métadonnées et des scopes. Les serveurs personnalisés et les cartes Linear/Notion sont conservés.
- **Avertissement abonnement Anthropic** : confirmation explicite de l’identité Claude Code et du risque de restriction du compte avant la connexion. Le formulaire de clé API reste distinct.
- **Fiabilité du démarrage et de la Roadmap** : les processus enfants isolés n’héritent plus des loaders d’une ancienne installation Studio. Les refus temporaires d’accès aux fichiers Windows sont réessayés lors des sauvegardes Roadmap, sans retirer les contrôles de chemin ni masquer les erreurs persistantes.
- **Comportement préservé** : pas de nouvel agent délégué d’analyse de captures, pas d’installation ni de redémarrage automatiques, aucun changement de l’autorisation ou de l’arrêt Bureau expert. Les gains annoncés en amont ne sont pas des mesures Studio.

## 3.8.1

- **Connexion par abonnement Muse Code (expérimentale)** : fournisseur `muse-code` séparé, par code dans le navigateur, sans clé API et sans installation du CLI. Exige un abonnement actif et échoue sans repli vers un usage payant.
- **Consentement explicite avant connexion** : le parcours Connecter affiche l’avertissement expérimental et exige la case de confirmation avant toute demande de connexion. La case reste compacte et alignée sur la première ligne du texte, sur PC comme sur écran étroit.
- **Aucun changement silencieux de facturation** : tant qu’un modèle de secours moteur est configuré, une session Muse refuse de démarrer au lieu de changer de facturation en cas de quota ou de panne. Videz le secours moteur pour utiliser Muse. Ce garde-fou couvre le démarrage des sessions par le Studio.
- **Docs et tests** : guides fournisseurs mis à jour en français et en anglais, avec couverture unitaire et UI du fournisseur filtré.

## 3.8.0

- **Une seule fenêtre de bureau** : les préférences, les mises à jour et la récupération utilisent la fenêtre principale, même si le serveur est arrêté ou utilise encore une ancienne interface.
- **Des actions distinctes** : vérifier les mises à jour, mettre à jour Studio, réparer les composants manquants et redémarrer le serveur ont chacun leur rôle. Une réparation ne redémarre pas implicitement le serveur.
- **Progression réelle et annulation** : les étapes, octets reçus, totaux connus, durée et erreurs restent disponibles à la réouverture du panneau. Une opération interrompue ne laisse plus l’interface bloquée indéfiniment.
- **Redémarrage explicite du serveur** : confirmez l’interruption des agents actifs et des opérations annulables. Le redémarrage attend la fin de l’annulation, vérifie l’identité du serveur et refuse d’arrêter un processus étranger. Le passage à l’installateur ne peut pas être annulé.
- **Quitter arrête le serveur** : « Quitter l’application » depuis la zone de notification arrête le serveur Studio vérifié avant de fermer. La croix masque toujours la fenêtre et laisse les agents travailler.
- **Meta Model API** : connectez Muse Spark avec une clé API, sans le CLI Muse Code. Les réglages personnalisés sont préservés. Le modèle Contributor signale que les requêtes et réponses peuvent servir à l’entraînement ; les accès et la facturation restent gérés par Meta.
- **Interface française et anglaise** : confirmations, messages de récupération et panneaux de mise à jour plus clairs sur PC et mobile. Projets, comptes et historique des conversations sont préservés.

## 3.7.1

- **Reprise après les outils** : rétroportage du correctif amont Prime Agent #2372 dans les nouveaux environnements Python gérés par Studio. La consommation d’un résultat `bash()` retire sa notification avant la fin de la cellule, pour éviter une interruption de la continuation. Empreinte dédiée, contrôle de compatibilité et validation du protocole avant utilisation. Les environnements déjà utilisés et les Python externes ne sont pas modifiés.
- **Activité plus explicite** : la fin d’un tour sans fin de session affiche un état d’attente distinct de la génération. Une nouvelle activité réactive l’indicateur. Aucun succès implicite, aucune fermeture anticipée de la session, des sous-agents ou des tâches de fond.
- **Déploiement prudent** : moteur maintenu en 0.9.5. Les sessions déjà actives restent sur leur environnement actuel ; le correctif Python s’applique aux nouveaux noyaux après activation de cette version du Studio. Ce correctif ne traite pas l’erreur Codex `Previous response not found`.

## 3.7.0

- **Migration du moteur vers Prime Agent 0.9.5** : politique épinglée (npm 10.9.4 et uv 0.8.22 inchangés), explication unique pour les utilisateurs venant d'une version < 3.7.0. Après la mise à jour de l'application, préparez puis activez la version 0.9.5 depuis **Préférences → Mise à jour** ; le téléchargement exige votre accord, et l’activation peut redémarrer le serveur géré uniquement quand les agents sont inactifs. Comptes et sessions conservés. Secours natif conservé si le serveur est arrêté ou ancien.
- **Parcours de mise à jour** : composants intégrés aux Préférences, préparation puis activation distinguées avec reprise sans retéléchargement, opérations sérialisées et aucun arrêt automatique des agents actifs. Installations externes explicitement validées réactivables sans faux reçu de téléchargement.
- **Modèles avancés unifiés** : même sélecteur commun avec recherche, fournisseurs et choix « Défaut du moteur », sans changer le modèle de la conversation. Réglages d'affinage, de secours et de sous-agent natif avec budgets autonomes par défaut, sans activation implicite.
- **Conversation et suivi** : messages inter-agents 0.9.5 et anciens formats, progression et dernière activité des sous-agents, états d'attente, de secours et de restauration du fournisseur. Relais en direct ordonné avec limite mémoire explicite, sans rejouer l'historique. En-tête du message utilisateur en miroir de l'assistant — heure à gauche, « Vous » avec avatar à droite.
- **Authentification explicite** : résolution par environnement puis stockage natif, sans import silencieux des comptes du CLI. Parcours Grok OAuth et clé API conservés.

## 3.7.0-beta.2

- Composants intégrés aux Préférences, indication du moteur requis et guide après mise à jour de l’application. Secours natif conservé pour un serveur arrêté ou ancien.
- Préparation et activation distinguées ; composants validés conservés, erreurs d’activation explicites et journalisées, reprise sans retéléchargement.
- Préparation, mise à jour de l’application et redémarrage sérialisés ; aucun arrêt automatique des agents actifs.
- Installations externes explicitement validées réactivables sans faux reçu de téléchargement ; contrôles des installations gérées préservés.
- Modèles avancés unifiés avec le sélecteur commun : recherche, fournisseurs et choix « Défaut du moteur », sans changer le modèle de la conversation.
- Migration expliquée une seule fois pour les utilisateurs venant d’une version < 3.7.0 : explication FR/EN, préparation puis activation de la version 0.9.5, sans installation ni redémarrage automatiques, comptes et sessions conservés.
- Conversation : en-tête du message utilisateur en miroir de l’assistant — heure à gauche, « Vous » avec avatar à droite, au-dessus de la carte.

## 3.7.0-beta.1

- **Packaging guidé** : politique épinglée sur Prime Agent **0.9.5** (npm 10.9.4 et uv 0.8.22 inchangés), avec les trois dépendances `@earendil-works` vérifiées contre le même inventaire officiel.

- **Relais en direct** : les événements du worker restent ordonnés lorsque le tampon interne se remplit, avec une limite mémoire explicite et sans rejouer l’historique.
- **Runtime natif** : API Python `rlm.spawn(..., name=...)`, notes `rlm.progress_note(...)` et entrée Node directe du moteur pour préserver les hooks et l’identité du superviseur.
- **Réglages avancés** : modèles d’affinage, de secours et de sous-agent natif ; budgets autonomes par défaut. Aucun secours ni mode autonome activé implicitement. Sauvegardes, verrou natif et détection des modifications concurrentes conservés.
- **Authentification** : résolution par environnement puis stockage natif, sans import silencieux des comptes du CLI. Parcours Grok OAuth et clé API conservés.
- **Conversation et suivi** : messages inter-agents 0.9.5 et anciens formats, progression et dernière activité des sous-agents, états d’attente, de secours et de restauration du fournisseur.

## 3.6.1

- **Publication Windows** : nettoyage des fichiers temporaires du test de redémarrage avec reprises bornées après la fermeture du processus.

## 3.6.0

- **Lecture pendant le streaming** : remonter dans la conversation détache le suivi automatique. Revenir en bas ou utiliser le bouton de retour réactive le suivi, sans interrompre la réponse.
- **Progression par plan** : un pourcentage discret complète le compteur de tâches. Les cases terminées sont vertes ; les groupes partiellement terminés conservent leur couleur.
- **Reste à faire uniquement** : filtre réversible des tâches terminées dans les plans et le backlog, sans modifier les données ni les pourcentages. Les parents, notes et plans restent accessibles.
- **Précisions avant délégation** : champ facultatif d’instructions complémentaires, transmis à une nouvelle conversation ou à la file de la conversation active. La saisie est conservée lors d’un conflit de révision.
- **Validation** : tests unitaires et tests navigateur isolés, avec streaming simulé et contrôles de la roadmap sur PC et petits écrans.

## 3.5.0

- **Ouverture prioritaire** : écran de connexion dans la fenêtre principale, réutilisation immédiate du serveur actif et contrôle léger des composants au démarrage à froid. Le diagnostic complet affiche ses étapes et reste disponible à la demande.
- **Ordre stable des conversations** : les nouveaux messages ne déplacent plus les conversations. Les épinglées restent en haut ; déplacement par menu, clavier et glisser-déposer dans le même projet. Les nouvelles conversations apparaissent en tête de leur groupe.
- **Imports plus discrets** : conversations importées marquées lues, mention « importé » retirée à la première ouverture ou après trois minutes, sans bandeau jaune. Modèle historique conservé s’il est utilisable, sinon modèle par défaut configuré du PC ; choix manuel seulement si aucun modèle utilisable n’est disponible.
- **Validation** : revues de code, compilation native et vérifications isolées. Le temps total d’ouverture sur l’installation réelle et le parcours tactile complet restent à vérifier ; aucune suite de tests relancée pour cette publication.

## 3.4.1

- **Correctifs d’export .pastudio (fichier transférable, opération sur le PC lui-même)** : fichier transférable et importable sur un autre PC ; export et import depuis le Studio ouvert sur ce PC, pas depuis un navigateur distant (LAN/Tailscale/PWA). Compression sélective ZIP DEFLATE (niveau 6, seulement si plus petit, sinon stockée, en séquence avec repli stocké) ; tolérance de fork à l’export — l’identifiant canonique est `header.id`, le nom du fichier reste le chemin physique, seuls les doublons du même identifiant canonique via des fichiers physiques différents sont refusés ; code d’erreur d’origine préservé avec détail générique borné.
- **Limites inchangées et compatibilité** : archive compressée limitée à 128 Mio assortie côté serveur et interface, total non compressé 256 Mio et 128 Mio par entrée inchangés, une seule opération à la fois. La limite 128 Mio demeure, ce n’est pas de l’illimité. Une archive de plus de 64 Mio exportée en 3.4.1 ne peut pas être importée en 3.4.0 : mettez à jour les deux instances.
- **Contenu inchangé** : fichiers du projet, réglages, clés des fournisseurs, mémoires et moteur jamais inclus ; aucun traitement en flux — l’export reste en mémoire, séquentiel.
- **Validation honnête** : revue indépendante approuvée et aller-retour export/décodage sur projets réels avec empreinte identique par fichier (Vtrott 178 Mo → 88 Mo, PrimeAgentGUI 75 Mo → 30 Mo) ; import réel et reprise live non revendiqués.
- **Après installation** : redémarrez le serveur depuis les préférences une fois les agents terminés.

## 3.4.0

- **Archives .pastudio v1 (local uniquement)** : exportez un projet complet puis importez-le dans un autre projet existant, sur cet appareil uniquement. Contenu transféré : conversations complètes avec sous-agents et Roadmap du projet. Les fichiers du projet, les réglages, les clés des fournisseurs, les mémoires et le moteur ne sont jamais inclus.
- **Import additif sans écrasement** : sessions et Roadmap existantes conservées ; vision locale inchangée (vision source en note de backlog). Réimporter la même archive est détecté et ignoré par empreinte ; si la source a changé, de nouvelles copies sont créées vers le nouveau dossier, jamais de fusion.
- **Reprise explicite** : l’historique reste lisible, mais la prochaine exécution d’une session importée exige un modèle disponible choisi explicitement ; aucun modèle historique n’est réappliqué.
- **Secrets et reprise** : les historiques peuvent contenir des secrets — vérifiez avant de partager un fichier. Un import interrompu reste en attente et se relance sans doublon.
- **Limites validées** : revue source ACCEPT et fixtures isolées OK ; validation physique à deux PC et reprise live non revendiquées.
- **Après installation** : redémarrez le serveur depuis les préférences une fois les agents terminés.

## 3.3.3

- **Composants durcis** : hôtes de téléchargement fixes sans héritage de `NODE_OPTIONS`, reprise avec reçu vérifié, moteurs externes non exécutés sans sélection explicite, état du lanceur préservé après annulation, avertissement catalogue affiché après interruption.
- **Signature sécurisée** : les workflows ne signent jamais un installateur téléversé ; ils reconstruisent l’installateur depuis le tag avant signature.

## 3.3.2

- **Composants plus compacts** : état et versions sur une ou deux lignes. Le bouton Détails affiche les chemins, les sources de téléchargement et les options avancées ; cette zone est fermée par défaut.
- **Actions adaptées** : le bouton d’installation disparaît lorsque tout est prêt. La progression et les erreurs restent visibles.

## 3.3.1

- **Installation guidée corrigée** : les dépendances de Prime Agent sont installées depuis le dossier du moteur, quel que soit le dossier de lancement de Studio. Corrige l’échec de préparation dans l’application Windows installée. Les composants déjà validés sont réutilisés.
- **Validation** : installation complète testée avec le Node embarqué depuis un dossier sans `package.json`, comme dans l’application installée.

## 3.3.0

- **Installation guidée** : préparation de Prime Agent, uv et Python au premier lancement ou depuis les réglages, après un clic explicite. Réutilisation des installations compatibles, progression, annulation et reprise après échec.
- **Compatibilité du moteur** : Studio 3.3.0 cible Prime Agent 0.9.4. Une future version de Studio pourra demander sa mise à niveau ; aucun téléchargement automatique en arrière-plan.
- **Roadmap visible** : bouton complet dans la barre supérieure avec le pourcentage d’avancement du projet, actualisé même lorsque le panneau est fermé.
- **Configuration plus claire** : avertissement si aucun fournisseur n’est configuré ou aucun modèle n’est sélectionné ; correction de l’alignement et de la couleur du sélecteur de réflexion des sous-agents.
- **Après installation** : redémarrez le serveur depuis les préférences une fois les agents terminés.

## 3.2.7

- **Connexion optionnelle par clé d’accès** : enregistrement depuis Préférences → Accès distant sur l’adresse HTTPS Tailscale du téléphone. Validation par biométrie ou code de déverrouillage ; le code Studio reste disponible. Gestion et révocation des clés depuis le PC. Changer le code Studio invalide les clés existantes.
- **Interface tablette plus compacte** : barre supérieure réduite, mention redondante sous le champ de saisie et fausse version du panneau Session supprimées.
- **Questions en attente** : un point d’interrogation ambre près d’Espace de travail permet d’ouvrir une conversation en attente de réponse.
- **Activité roadmap** : texte et indicateur en cours en bleu pulsant, avec respect de la réduction des animations.
- **Après installation** : redémarrez le serveur dans Préférences → Mise à jour une fois les agents terminés.

## 3.2.6

- **Mises à jour sur mobile** : bouton permanent pour relancer la recherche et contourner le cache. Le bouton redevient disponible après une erreur ou un délai dépassé ; les erreurs de demande d’installation sont visibles dans le panneau mobile.
- **Questions dans le fil** : la question interactive et sa réponse restent à la position de leur appel d’outil pendant que les messages suivants arrivent, au lieu de rester en bas de la conversation jusqu’à la fin du tour.
- **Après installation** : redémarrez le serveur depuis les préférences, une fois les agents terminés.

## 3.2.5

- **Questions interactives** : les demandes natives restent transmises pendant une resynchronisation ou une saturation du flux du moteur, au lieu d’être écartées avec les événements d’affichage.
- **Notifications sonores** : son système activé sur Windows ; notifications PWA non muettes, selon les réglages du téléphone. Les règles de focus et les préférences Windows sont conservées.
- **Application du correctif** : après installation, redémarrez le serveur du Studio une fois les agents terminés.

## 3.2.4

- **Quota et contexte aussi à distance (authentifié)** : le quota Codex et le contexte de session restent consultables depuis l’accès mobile authentifié, via des endpoints limités et assainis. Actualisation manuelle uniquement, compte Codex lié (OAuth) requis ; le contexte affiche un état honnête quand la mesure est indisponible.
- **Notifications mobiles PWA (optionnel, par appareil)** : **Préférences → Notifications → Notifications mobiles** active les alertes **Questions** et **Fins de tour** sur cet appareil, même PWA fermée. Inscription Web Push VAPID par appareil, texte générique uniquement, désactivée par défaut. Prérequis : PWA installée depuis l’adresse HTTPS Tailscale, notifications autorisées, PC allumé et Tailscale connecté des deux côtés. Sur iPhone/iPad : iOS 16.4+, Safari, Partager → Sur l’écran d’accueil, puis ouvrir depuis l’icône. [Guide PWA](pwa.md).
- **Mise à jour à distance via le PC** : depuis l’accès distant, **Préférences → Mise à jour** affiche la version publiée et permet de demander l’installation sur le PC. Le PC télécharge, vérifie la signature puis installe via sa mise à jour native signée ; la demande est refusée si des agents sont actifs ou si l’accès est en lecture seule. Notes de version affichées en markdown assaini.
- **Limites validées** : push sur appareil physique et mise à jour distante réelle de bout en bout non validés.

## 3.2.3

- **Activité des conversations dans la Roadmap** : chaque élément affiche **En cours · …**, avec un compteur **+N** pour déplier les autres conversations. L’activité apparaît aussi sous chaque tâche et mène à sa conversation.
- **Champ Réflexion des sous-agents** : l’étiquette et la liste restent alignées et pleine largeur avec le sélecteur de modèle, sans chevauchement.
- **Quota Codex (optionnel)** : pour les modèles OpenAI/Codex, un bloc avec barres courte et hebdomadaire et bouton **Actualiser le quota**. Consultation manuelle uniquement, compte Codex lié (OAuth) requis ; les modèles via clé API affichent une note sans quota. Indisponible depuis l’accès distant.
- **Contexte Prime Agent** : la session affiche **X / Y jetons (Z %)** avec barre, depuis le contexte actuel natif, jamais le total cumulé. Masqué quand indisponible.

## 3.2.2

- **Notifications Windows rétablies** : correction d’un plantage à l’initialisation qui empêchait le suivi des questions et des fins de tour de démarrer. Les préférences de notification et le silence lorsque le Studio a le focus sont conservés.
- **Questions en attente visibles** : un **?** ambre remplace le point vert d’activité dans la liste des conversations et sur leur projet, y compris lorsqu’il est replié. La vue du projet indique également **Question en attente**.
- **Brouillons après envoi** : le texte accepté est effacé même si vous changez de conversation avant la fin de l’envoi, y compris pour les messages transmis à un agent déjà actif. Un nouveau brouillon saisi entre-temps reste conservé ; un envoi échoué ne l’efface pas.

## 3.2.1

- **Questions autorisées par défaut** : choisissez la valeur initiale dans **Préférences → Modèles et agents**. Le défaut est partagé par les appareils connectés au PC, tandis que chaque conversation conserve son choix enregistré.
- **Notifications Windows** : deux interrupteurs indépendants pour les questions en attente et les fins de tour, dans **Préférences → Notifications**. Les erreurs suivent le réglage de fin de tour ; les arrêts manuels restent silencieux.
- **Discrétion au premier plan** : aucune notification lorsqu’une fenêtre du Studio a le focus. Les événements silencieux ne sont pas rejoués après un changement de focus. Le suivi continue lorsque la fenêtre est masquée, tant que l’application reste ouverte.
- **Choix préservés** : un chargement reçu en retard ne remplace pas un nouveau défaut déjà enregistré. [Guide de configuration](configuration.md#notifications-windows).

## 3.2.0

- **Images dans les réponses de l’agent** : affichez les images du projet dans la conversation et cliquez pour les agrandir. Le Studio lit le fichier d’origine sans copie supplémentaire ; une image déplacée ou supprimée apparaît comme indisponible. Disponible sur PC et via l’accès mobile authentifié.
- **Questions interactives natives** : activez **Autoriser les questions** par conversation. Sélectionnez une réponse proposée, écrivez la vôtre ou passez. Les questions utilisent le mécanisme natif de demande et de réponse de Prime Agent, reprennent l’agent en attente et se synchronisent entre appareils connectés.
- **Précisions à la demande** : chaque choix possède une courte description, repliée par défaut. Le bouton **Passer** reçoit un contour discret. Le chargement des images et l’arrivée des questions préservent votre position de lecture.
- **Documentation illustrée** : les captures des README français et anglais présentent les deux fonctions dans une conversation fictive autour d’une Lotus Elise. [Guide de configuration](configuration.md#questions-interactives-et-images-dans-la-conversation).

## 3.1.4

- **Tout replier ou tout déplier** dans chaque plan de la Roadmap. Le plan reste ouvert, avec ses tâches principales et leurs compteurs visibles.
- **Modèle et réflexion propres à chaque conversation** : les choix sont enregistrés et retrouvés après rechargement ou depuis un autre appareil. Un ancien historique reçu en retard ne peut plus écraser une modification confirmée.
- **Changer la réflexion pendant le travail de l’agent** : le nouveau niveau s’applique aux prochains appels du modèle, sans interrompre l’outil en cours ni modifier les réglages globaux. Le modèle reste modifiable entre deux exécutions. [Guide de configuration](configuration.md).

## 3.1.3

- **Sélection de dossier Windows corrigée** : le sélecteur natif est rattaché à la fenêtre Tauri. La sélection ou l’annulation permet un nouvel essai ; fermer le formulaire dans le navigateur annule sa sélection en cours et préserve les nouveaux champs saisis.
- **Ouvrir le dossier du projet** directement depuis l’onglet **Fichiers** de l’espace de travail, à côté d’**Actualiser**. L’accès distant indique clairement le PC hôte ; l’accès en lecture seule ne peut pas ouvrir de dossier.

## 3.1.2

- **Roadmap agrandie** : ouvrez une vue sur tout l’espace de travail, puis retrouvez le panneau latéral avec le bouton de réduction ou Échap.
- **Listes compactes** : repliez les catégories et les tâches parentes en gardant leur compteur de tâches terminées sur le total en bout de ligne. Les descriptions sont masquées par défaut et s’ouvrent avec **Afficher la description**.
- **Lecture préservée** : les replis restent en place pendant les actualisations. Les contrôles s’adaptent au clavier et au téléphone. [Guide Roadmap](roadmap.md).

## 3.1.1

- **Les tests MCP dans l’application Windows** retrouvent désormais Python dans le dossier persistant de l’application, y compris après une mise à jour. Si Python n’a pas encore été préparé, le Studio le configure automatiquement avant de découvrir les outils. [Guide MCP](mcp.md).

## 3.1.0

- **Roadmap du projet** : organisez jalons, plans, checklists imbriquées et backlog dans un panneau partagé sur PC et téléphone.
- **Du plan à la conversation** : choisissez **Travailler dessus** pour démarrer ou poursuivre un travail avec Prime Agent. Suivez l’activité déclarée des agents et retrouvez les conversations liées, y compris l’historique des sous-agents.
- **Outils natifs pour les agents** : six outils utilisent le même document du projet que l’interface. Les contrôles de révision protègent les modifications simultanées et les brouillons restent récupérables après un conflit. Ouvrir le panneau ne lance aucun appel de modèle.
- **Connaissances du projet accessibles** : consultez les mémoires et refinements natifs depuis le panneau, ou exportez la Roadmap en Markdown. [Guide Roadmap](roadmap.md).

## 3.0.1

- **Catalogue natif Prime Agent 0.9.4** : le Studio utilise les modèles disponibles dans le registre du moteur installé, avec leurs niveaux de réflexion. Le bouton d’actualisation du sélecteur permet de recharger le catalogue.
- **Disponibilité OpenRouter** : les modèles retirés du catalogue public sont signalés comme indisponibles. Une variante gratuite disparue reste distincte de son équivalent payant ; aucun remplacement automatique n’est effectué. Les connexions à des endpoints personnalisés sont conservées.
- **Choix préservés** : actualiser conserve la sélection, les favoris, la recherche et le brouillon. En cas de panne réseau, le catalogue reste consultable et une nouvelle tentative est possible. [Guide des fournisseurs](providers.md).

## 3.0.0

- **Projets et conversations réunis** : les conversations apparaissent sous leur projet dépliable, dans une seule liste, avec les projets épinglés en tête et **Afficher plus** pour les sessions anciennes. Recherche, archives, indicateurs de non-lus et réorganisation des projets restent à portée de main. Replier un projet conserve la conversation active et son brouillon ouverts. Sur téléphone, toucher le nom d’un projet le déplie ou le replie en gardant le volet ouvert ; choisir une conversation le referme. Les actions d’une conversation s’ouvrent aussi par clic droit sur PC. [Guide de navigation](navigation.md).
- **Connaissances du projet** : retrouvez les travaux passés depuis **Session** dans le panneau de droite, la vue du projet ou son menu **⋯**. Recherchez du texte, filtrez les résultats et consultez la source native exacte, avec un lien vers la conversation d’origine lorsqu’il est disponible. La consultation fonctionne aussi sur téléphone et en accès distant authentifié en lecture seule. [Guide des connaissances](knowledge.md).
- **Mémoires et refinements natifs** : consultez les mémoires de session et les modifications avant/après enregistrées. Les éléments globaux portent la mention **Global** et restent partagés entre projets par Prime Agent. La consultation laisse les données natives intactes.
- **Outils d’historique pour les agents** : les nouvelles exécutions du Studio et leurs sous-agents peuvent rechercher et lire les sources utiles du projet à la demande. La recherche textuelle ne sollicite aucun modèle et un cache local évite de relire les conversations inchangées. L’historique complet n’est pas ajouté automatiquement au contexte de l’agent.

## 2.9

- **Mises à jour depuis les préférences en 2.9.3** : **Préférences → Mise à jour** affiche les versions de l’application et du serveur, les nouveautés et l’installation signée. Le redémarrage du serveur est optionnel ; des agents actifs demandent confirmation. Les réglages près de l’horloge conservent ces contrôles lorsqu’un ancien serveur tourne encore.
- **Correctifs Windows 2.9.3** : les liens web et la connexion Codex s’ouvrent dans le navigateur habituel ; les fichiers et images peuvent être déposés dans la conversation. Les réponses terminées vides sont masquées sans modifier l’historique natif.
- **Correctif 2.9.2** : les préférences système et le diagnostic lisent la version dans les métadonnées du serveur empaqueté. La version 2.9.0 affichait à tort 2.8.1 même lorsque son nouveau serveur fonctionnait. Un ancien serveur toujours actif continue d’indiquer sa propre version jusqu’à son redémarrage.
- **Messages d’agents** : aperçus compacts et repliés, avec le nom de l’expéditeur. Un clic ouvre le message complet et ses détails de transmission. Les messages automatiques en attente sont clairement identifiés et protégés contre la modification ou la suppression.
- **Ordre des projets** : glissez les projets directement dans la liste à la souris, ou utilisez la poignée sur écran tactile. L’ordre est conservé entre les appareils.
- **Non-lus partagés** : lire une réponse sur PC efface son indicateur sur le téléphone et inversement, y compris en accès distant en consultation.
- **Sessions Codex longues** : renouvellement des connexions WebSocket anciennes et inactives entre les requêtes, et suppression des états d’échec transitoires après une reprise native réussie. Les requêtes actives sont préservées.
- **Présentation sobre** : texte lisible et libellés discrets, sans liserés colorés. Rendu vérifié sur PC/mobile, en français/anglais et dans les thèmes clair/sombre.

## 2.8

- **Correctif 2.8.1** : l’installateur Windows inclut désormais les workers des messages, skills, fournisseurs et MCP, ainsi que les assistants de dossiers et fichiers. La mise à jour restaure aussi les fichiers absents du cache serveur 2.8.0 d’origine sans redémarrer ses agents.
- **Application Windows Tauri 2** : installateur pour votre utilisateur, raccourcis Bureau et Démarrer, Node.js inclus et icône nette adaptée à l’affichage Windows.
- **Travail en arrière-plan** : le raccourci démarre le serveur ou retrouve celui déjà actif. Fermer ou quitter l’application laisse les agents travailler. Le démarrage avec Windows est facultatif et désactivé par défaut.
- **Reprise et accès distant** : reprenez les projets et réglages d’une installation existante. Le LAN, Tailscale, HTTPS, les QR codes et la PWA mobile restent disponibles.

[Installation, reprise des données et mises à jour](desktop.md).

## 2.6

- **Dossier du projet** : dans **Un projet à explorer.**, **Choisir un dossier** ouvre le sélecteur Windows et remplit le chemin. Le nom saisi est conservé ; une annulation laisse le formulaire intact.
- **Skills et prompts** : les deux onglets de **Commandes et skills** proposent **Global · Tous les projets** ou **Projet sélectionné**, puis **Ouvrir le dossier**. Un dossier absent est créé à la demande.
- **Sur PC et à distance** : le sélecteur Windows est réservé au Studio local. L’ouverture des dossiers de ressources fonctionne aussi depuis un accès distant en contrôle complet et s’effectue sur le PC hôte.
- **Documentation bilingue** : README et guides disponibles en français et en anglais.

## 2.5

- **Français et anglais** : choix **Automatique / Français / English** dans les préférences et sur la page de connexion mobile, avec détection de la langue du navigateur.
- **Changement immédiat** : les conversations, brouillons, pièces jointes et formulaires restent intacts ; une réponse en cours continue. Les onglets d’une même adresse partagent le choix de langue.
- **Une table unique** : 1 051 textes regroupent leurs traductions côte à côte. Les paramètres, pluriels et références sont contrôlés automatiquement ; une traduction absente ou vide utilise le français.
- **Mobile et PWA** : connexion, erreurs, déconnexion, informations d’installation et écran hors connexion suivent la langue choisie.
- **De nouvelles langues à ajouter** : [le guide de traduction](translations.md) explique comment compléter la table et vérifier l’interface.
