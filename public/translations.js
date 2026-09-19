// One row per message, all languages together. See docs/translations.md.
export const fallbackLanguage = 'fr';
export const languages = [
  { id: 'fr', label: 'Français' },
  { id: 'en', label: 'English' },
];
export const messages = {
  'configuration.connect': { fr: 'Configurer un fournisseur', en: 'Configure a provider' },
  'configuration.choose': { fr: 'Choisir un modèle', en: 'Choose a model' },
  'configuration.components': { fr: 'Configurer les composants', en: 'Set up components' },
  'configuration.components_hint': {
    fr: 'Ouvrir les réglages de l’application pour préparer Prime Agent, uv et Python (aucune installation automatique)',
    en: 'Open the application settings to prepare Prime Agent, uv and Python (no automatic install)',
  },
  'configuration.providerMissing': { fr: 'Aucun fournisseur configuré.', en: 'No provider configured.' },
  'configuration.modelMissing': { fr: 'Aucun modèle sélectionné.', en: 'No model selected.' },
  'configuration.bothMissing': {
    fr: 'Aucun fournisseur configuré et aucun modèle sélectionné.',
    en: 'No provider configured and no model selected.',
  },
  'roadmap.toolbarProgress': {
    fr: 'Roadmap du projet : {percent} % terminés',
    en: 'Project roadmap: {percent}% complete',
  },
  'questions.defaultLabel': { fr: 'Autoriser les questions par défaut', en: 'Allow questions by default' },
  'questions.defaultNote': {
    fr: 'Nouvelles conversations sur ce PC. Le choix de chaque conversation reste indépendant.',
    en: 'New conversations on this PC. Each conversation keeps its own choice.',
  },
  'notifications.title': { fr: 'Notifications', en: 'Notifications' },
  'notifications.scope': { fr: 'Application Windows · Ce PC', en: 'Windows application · This PC' },
  'notifications.questions': { fr: 'Question de l’agent', en: 'Agent question' },
  'notifications.questionsNote': {
    fr: 'Quand une question attend votre réponse.',
    en: 'When a question is waiting for your answer.',
  },
  'notifications.turnComplete': { fr: 'Fin de tour de l’agent', en: 'Agent turn completed' },
  'notifications.turnCompleteNote': {
    fr: 'Quand l’agent termine ou rencontre une erreur. Les arrêts manuels restent silencieux.',
    en: 'When the agent finishes or encounters an error. Manual stops stay silent.',
  },
  'notifications.focusNote': {
    fr: 'Aucune notification lorsque le Studio est au premier plan.',
    en: 'No notifications while Studio is in the foreground.',
  },
  'notifications.windowsNote': {
    fr: 'Les réglages de notification et le mode Ne pas déranger de Windows s’appliquent également.',
    en: 'Windows notification settings and Do not disturb also apply.',
  },
  'notifications.desktopOnly': {
    fr: 'Ouvrez cette page dans l’application Windows à jour pour régler ses notifications.',
    en: 'Open this page in the updated Windows application to manage its notifications.',
  },
  'push.title': { fr: 'Notifications mobiles', en: 'Mobile notifications' },
  'push.scope': { fr: 'PWA · Cet appareil', en: 'PWA · This device' },
  'push.enable': { fr: 'Alertes sur cet appareil', en: 'Alerts on this device' },
  'push.enableNote': {
    fr: 'Questions et fins de tour, même si la PWA est fermée.',
    en: 'Questions and turn ends, even when the PWA is closed.',
  },
  'push.questions': { fr: 'Questions', en: 'Questions' },
  'push.questionsNote': {
    fr: 'Quand une question attend votre réponse.',
    en: 'When a question is waiting for your answer.',
  },
  'push.turnComplete': { fr: 'Fins de tour', en: 'Turn ends' },
  'push.turnCompleteNote': {
    fr: 'Quand le tour se termine, en succès ou en erreur.',
    en: 'When the turn ends, on success or error.',
  },
  'push.consentNote': {
    fr: 'L’inscription persiste jusqu’à désactivation. La déconnexion ne la supprime pas.',
    en: 'Subscription persists until disabled. Sign-out does not remove it.',
  },
  'push.requirementsNote': {
    fr: 'PWA installée en HTTPS, notifications autorisées, PC allumé et Tailscale connecté.',
    en: 'Installed HTTPS PWA, notifications allowed, PC on and Tailscale connected.',
  },
  'push.unsupported': {
    fr: 'Push non pris en charge ici : utilisez la PWA installée en HTTPS.',
    en: 'Push not supported here: use the installed HTTPS PWA.',
  },
  'push.blocked': {
    fr: 'Notifications bloquées dans le navigateur. Autorisez-les pour cet appareil, puis réessayez.',
    en: 'Notifications are blocked in the browser. Allow them for this device, then try again.',
  },
  'push.failed': {
    fr: 'Impossible d’activer les alertes. Vérifiez la connexion au PC, puis réessayez.',
    en: 'Could not enable alerts. Check the connection to the PC, then try again.',
  },
  'push.locked': {
    fr: 'Inscription introuvable sur cet appareil. Désactivez puis réactivez pour créer une inscription neuve.',
    en: 'Subscription not found on this device. Disable then re-enable to create a fresh one.',
  },
  'push.endpoint_not_allowed': {
    fr: 'Service de notification non reconnu. Utilisez un navigateur à jour (Chrome, Safari, Firefox).',
    en: 'Unrecognized push service. Use an up-to-date browser (Chrome, Safari, Firefox).',
  },
  'push.invalid_endpoint': {
    fr: 'Inscription invalide. Désactivez puis réactivez les alertes.',
    en: 'Invalid subscription. Disable then re-enable alerts.',
  },
  'push.invalid_p256dh': {
    fr: 'Clé d’inscription invalide. Désactivez puis réactivez les alertes.',
    en: 'Invalid subscription key. Disable then re-enable alerts.',
  },
  'push.invalid_auth': {
    fr: 'Clé d’inscription invalide. Désactivez puis réactivez les alertes.',
    en: 'Invalid subscription key. Disable then re-enable alerts.',
  },
  'push.invalid_session_id': {
    fr: 'Notification reçue avec un identifiant invalide. Elle a été ignorée.',
    en: 'Notification received with an invalid identifier. It was ignored.',
  },
  'push.invalid_run_id': {
    fr: 'Notification reçue avec un identifiant invalide. Elle a été ignorée.',
    en: 'Notification received with an invalid identifier. It was ignored.',
  },
  'push.not_found': {
    fr: 'Inscription introuvable. Désactivez puis réactivez les alertes.',
    en: 'Subscription not found. Disable then re-enable alerts.',
  },
  'push.nothing_enabled': {
    fr: 'Activez au moins les questions ou les fins de tour.',
    en: 'Enable at least questions or turn ends.',
  },
  'push.too_many_subscriptions': {
    fr: 'Trop d’appareils inscrits. Désactivez un appareil inutilisé, puis réessayez.',
    en: 'Too many subscribed devices. Disable an unused device, then try again.',
  },
  'push.unauthorized': {
    fr: 'Inscription non reconnue sur cet appareil. Désactivez puis réactivez pour en créer une neuve.',
    en: 'Subscription not recognized on this device. Disable then re-enable to create a fresh one.',
  },
  'push.unavailable': {
    fr: 'Service de notification momentanément indisponible. Réessayez dans un instant.',
    en: 'Push service temporarily unavailable. Try again shortly.',
  },
  'interactionSettings.saveError': {
    fr: 'Impossible de charger ou d’enregistrer ce réglage. Réessayez en rouvrant cette catégorie.',
    en: 'Could not load or save this setting. Open this category again to retry.',
  },
  'questions.title': { fr: 'Question de l’agent', en: 'Agent question' },
  'questions.pending': { fr: 'Question en attente', en: 'Question awaiting an answer' },
  'questions.toggle': { fr: 'Autoriser les questions', en: 'Allow questions' },
  'questions.allow': { fr: 'Autoriser les questions', en: 'Allow questions' },
  'questions.scope': {
    fr: 'Propre à cette conversation · modifiable entre deux exécutions',
    en: 'For this conversation · editable between runs',
  },
  'questions.other': { fr: 'Ou écrivez une autre réponse…', en: 'Or write another answer…' },
  'questions.answer': { fr: 'Votre réponse…', en: 'Your answer…' },
  'questions.send': { fr: 'Envoyer la réponse', en: 'Send answer' },
  'questions.skip': { fr: 'Passer', en: 'Skip' },
  'questions.showDescription': { fr: 'Afficher la description', en: 'Show description' },
  'questions.hideDescription': { fr: 'Masquer la description', en: 'Hide description' },
  'questions.waiting': { fr: 'L’agent attend votre réponse.', en: 'The agent is waiting for your answer.' },
  'questions.readOnly': {
    fr: 'Répondez depuis un appareil connecté en contrôle complet.',
    en: 'Answer from a device connected with full control.',
  },
  'questions.answered': { fr: 'Votre réponse :', en: 'Your answer:' },
  'questions.closed': {
    fr: 'Cette demande n’attend plus de réponse.',
    en: 'This request is no longer awaiting an answer.',
  },
  'questions.required': {
    fr: 'Choisissez une option ou écrivez votre réponse.',
    en: 'Choose an option or write your answer.',
  },
  'questions.yes': { fr: 'Oui', en: 'Yes' },
  'questions.no': { fr: 'Non', en: 'No' },
  'images.open': { fr: 'Agrandir : {name}', en: 'Enlarge: {name}' },
  'images.missing': {
    fr: 'Image indisponible — fichier déplacé ou supprimé',
    en: 'Image unavailable — file moved or deleted',
  },
  'images.unavailable': { fr: 'Impossible d’afficher cette image', en: 'Unable to display this image' },
  'images.offline': { fr: 'Connexion au Studio indisponible', en: 'Studio connection unavailable' },
  'images.outside': {
    fr: 'Cette image n’est pas accessible dans le projet',
    en: 'This image is not accessible within the project',
  },
  'images.unsupported': { fr: 'Format d’image non pris en charge', en: 'Unsupported image format' },
  'images.localOnly': {
    fr: 'Utilisez une image située dans le projet',
    en: 'Use an image located in the project',
  },
  'conversation.unconfirmed': {
    fr: 'Le moteur n’a pas confirmé le changement de réflexion. Réessayez lorsque la connexion est rétablie.',
    en: 'The engine did not confirm the thinking change. Try again when the connection is restored.',
  },
  'conversation.scope': { fr: 'Réglage propre à cette conversation', en: 'Setting for this conversation' },
  'conversation.thinkingNextCall': {
    fr: 'S’applique aux prochains appels du modèle, sans interrompre l’agent',
    en: 'Applies to the next model calls without interrupting the agent',
  },
  'conversation.thinkingApplied': {
    fr: 'Réflexion mise à jour pour les prochains appels du modèle.',
    en: 'Thinking updated for the next model calls.',
  },
  'conversation.liveUnavailable': {
    fr: 'Le changement de réflexion en direct est momentanément indisponible.',
    en: 'Live thinking changes are temporarily unavailable.',
  },
  'roadmap.open': { fr: 'Roadmap du projet', en: 'Project roadmap' },
  'roadmap.linkWarning': {
    fr: 'Le travail a été envoyé, mais son lien n’a pas pu être enregistré. Vous pouvez réparer les liens dans la Roadmap.',
    en: 'The work was sent, but its link could not be saved. You can repair links in the Roadmap.',
  },
  'roadmap.command': { fr: 'Ouvrir la roadmap du projet', en: 'Open project roadmap' },
  'roadmap.backlogCommand': { fr: 'Consulter le backlog du projet', en: 'View project backlog' },
  'navigation.pinned': { fr: 'Épinglés', en: 'Pinned' },
  'navigation.collapse': { fr: 'Replier {name}', en: 'Collapse {name}' },
  'navigation.expand': { fr: 'Déplier {name}', en: 'Expand {name}' },
  'navigation.empty': { fr: 'Aucune conversation', en: 'No conversations' },
  'navigation.show_more': { fr: 'Afficher plus', en: 'Show more' },
  'navigation.show_more_project': {
    fr: 'Afficher plus de conversations dans {name}',
    en: 'Show more conversations in {name}',
  },
  'navigation.show_less': { fr: 'Afficher moins', en: 'Show less' },
  'knowledge.open': { fr: 'Connaissances du projet', en: 'Project knowledge' },
  'knowledge.close': { fr: 'Fermer les connaissances du projet', en: 'Close project knowledge' },
  'knowledge.search': {
    fr: 'Rechercher une décision, un problème, une solution…',
    en: 'Search for a decision, a problem, a solution…',
  },
  'knowledge.filter': { fr: 'Type de source', en: 'Source type' },
  'knowledge.kind.all': { fr: 'Tout', en: 'All' },
  'knowledge.kind.history': { fr: 'Travaux passés', en: 'Past work' },
  'knowledge.kind.memory': { fr: 'Mémoires', en: 'Memories' },
  'knowledge.kind.refinement': { fr: 'Refinements', en: 'Refinements' },
  'knowledge.scope.global': { fr: 'Global', en: 'Global' },
  'knowledge.scope.session': { fr: 'Session', en: 'Session' },
  'knowledge.native': {
    fr: 'Sources natives de Prime Agent · Consultation uniquement',
    en: 'Native Prime Agent sources · Read only',
  },
  'knowledge.more': { fr: 'Afficher plus de résultats', en: 'Show more results' },
  'knowledge.choose': {
    fr: 'Sélectionnez un résultat pour consulter sa source.',
    en: 'Select a result to read its source.',
  },
  'knowledge.back': { fr: '← Résultats', en: '← Results' },
  'knowledge.changes': { fr: 'Modifications enregistrées', en: 'Recorded changes' },
  'knowledge.not_applied': { fr: 'Modification non appliquée', en: 'Change not applied' },
  'knowledge.before': { fr: 'Avant', en: 'Before' },
  'knowledge.after': { fr: 'Après', en: 'After' },
  'knowledge.absent': { fr: 'Aucune entrée', en: 'No entry' },
  'knowledge.source': { fr: 'Source exacte', en: 'Exact source' },
  'knowledge.line': { fr: 'Ligne {line}', en: 'Line {line}' },
  'knowledge.message': { fr: 'Message', en: 'Message' },
  'knowledge.open_session': { fr: 'Ouvrir la conversation', en: 'Open conversation' },
  'knowledge.loading': { fr: 'Recherche dans les sources natives…', en: 'Searching native sources…' },
  'knowledge.retry': { fr: 'Réessayer', en: 'Try again' },
  'knowledge.results': {
    fr: { one: '{count} résultat', other: '{count} résultats' },
    en: { one: '{count} result', other: '{count} results' },
  },
  'knowledge.partial': {
    fr: 'Certaines sources n’ont pas pu être consultées. Les résultats peuvent être incomplets.',
    en: 'Some sources could not be read. Results may be incomplete.',
  },
  'knowledge.truncated': {
    fr: 'Cet extrait est limité. Consultez la source pour retrouver le contenu complet.',
    en: 'This excerpt is limited. Consult the source for the full content.',
  },
  'knowledge.invalid_project': { fr: 'Choisissez un projet valide.', en: 'Choose a valid project.' },
  'knowledge.invalid_query': {
    fr: 'Cette recherche est invalide. Utilisez au maximum 500 caractères.',
    en: 'Invalid search. Use up to 500 characters.',
  },
  'knowledge.invalid_limit': {
    fr: 'Le nombre de résultats demandé est invalide.',
    en: 'The requested result count is invalid.',
  },
  'knowledge.invalid_cursor': {
    fr: 'La recherche a changé. Relancez-la pour afficher les résultats.',
    en: 'The search has changed. Run it again to view results.',
  },
  'knowledge.invalid_id': {
    fr: 'Cette référence de source est invalide.',
    en: 'This source reference is invalid.',
  },
  'knowledge.not_found': {
    fr: 'Cette source n’est plus disponible. Relancez la recherche.',
    en: 'This source is no longer available. Run the search again.',
  },
  'knowledge.no_results': {
    fr: 'Aucun résultat. Essayez un autre terme ou un autre type de source.',
    en: 'No results. Try another term or source type.',
  },
  'knowledge.empty': {
    fr: 'Aucune source de ce type pour ce projet pour le moment.',
    en: 'No sources of this type for this project yet.',
  },
  'updates.title': { fr: 'Mise à jour', en: 'Updates' },
  'updates.scope': { fr: 'Application Windows · Ce PC', en: 'Windows application · This PC' },
  'updates.browser': {
    fr: 'Ouvrez le Studio dans l’application Windows pour installer une mise à jour ou redémarrer son serveur.',
    en: 'Open Studio in the Windows application to install an update or restart its server.',
  },
  'updates.app_version': { fr: 'Application installée', en: 'Installed application' },
  'updates.server_version': { fr: 'Serveur en cours', en: 'Running server' },
  'updates.idle': {
    fr: 'Recherchez les nouvelles versions publiées sur GitHub.',
    en: 'Check for new versions published on GitHub.',
  },
  'updates.check': { fr: 'Vérifier les mises à jour', en: 'Check for updates' },
  'updates.checking': { fr: 'Recherche d’une nouvelle version…', en: 'Checking for a new version…' },
  'updates.current': {
    fr: 'L’application installée est à jour.',
    en: 'The installed application is up to date.',
  },
  'updates.available': { fr: 'La version {version} est disponible.', en: 'Version {version} is available.' },
  'updates.notes': { fr: 'Nouveautés de cette version', en: 'What’s new' },
  'updates.install': { fr: 'Installer et relancer', en: 'Install and relaunch' },
  'updates.restart_after': {
    fr: 'Redémarrer le serveur après l’installation',
    en: 'Restart the server after installation',
  },
  'updates.restart_after_note': {
    fr: 'S’il reste des agents en cours, le serveur attendra votre confirmation.',
    en: 'If agents are still running, the server will wait for your confirmation.',
  },
  'updates.server_title': { fr: 'Serveur du Studio', en: 'Studio server' },
  'updates.pending': {
    fr: 'La version installée sera appliquée au prochain redémarrage du serveur.',
    en: 'The installed version will take effect when the server restarts.',
  },
  'updates.server_current': {
    fr: 'Le serveur utilise la version installée de l’application.',
    en: 'The server is using the installed application version.',
  },
  'updates.unmanaged': {
    fr: 'Ce serveur a été lancé depuis une autre installation. Arrêtez-le depuis son lanceur avant de démarrer celui de l’application.',
    en: 'This server was started by another installation. Stop it through its launcher before starting the application’s server.',
  },
  'updates.agents': {
    fr: {
      one: '{count} exécution en cours. Un redémarrage peut l’interrompre.',
      other: '{count} exécutions en cours. Un redémarrage peut les interrompre.',
    },
    en: {
      one: '{count} active run. Restarting may interrupt it.',
      other: '{count} active runs. Restarting may interrupt them.',
    },
  },
  'updates.no_agents': { fr: 'Aucune exécution en cours dans le Studio.', en: 'No active runs in Studio.' },
  'updates.stopped': { fr: 'Arrêté', en: 'Stopped' },
  'updates.stopped_note': {
    fr: 'Démarrez le serveur avec la version installée.',
    en: 'Start the server with the installed version.',
  },
  'updates.restart': { fr: 'Redémarrer le serveur', en: 'Restart server' },
  'updates.restarting': {
    fr: 'Redémarrage du serveur… La connexion va se rétablir.',
    en: 'Restarting the server… The connection will be restored.',
  },
  'updates.restarted': {
    fr: 'Le serveur a redémarré avec la version installée.',
    en: 'The server restarted with the installed version.',
  },
  'updates.agents_changed': {
    fr: 'Une exécution a démarré entre-temps. Le serveur a été conservé ; cliquez à nouveau pour confirmer son redémarrage.',
    en: 'A run started in the meantime. The server was kept running; click again to confirm a restart.',
  },
  'updates.cancel': { fr: 'Annuler', en: 'Cancel' },
  'updates.interrupt_title': {
    fr: 'Redémarrer malgré les agents en cours ?',
    en: 'Restart while agents are running?',
  },
  'updates.interrupt_note': {
    fr: {
      one: '{count} exécution est en cours. Le redémarrage peut l’interrompre et déconnectera temporairement vos appareils. Les projets et l’historique enregistré seront conservés.',
      other:
        '{count} exécutions sont en cours. Le redémarrage peut les interrompre et déconnectera temporairement vos appareils. Les projets et l’historique enregistré seront conservés.',
    },
    en: {
      one: '{count} run is active. Restarting may interrupt it and will temporarily disconnect your devices. Projects and saved history will be preserved.',
      other:
        '{count} runs are active. Restarting may interrupt them and will temporarily disconnect your devices. Projects and saved history will be preserved.',
    },
  },
  'updates.interrupt': { fr: 'Redémarrer quand même', en: 'Restart anyway' },
  'updates.install_busy_title': {
    fr: 'Installer pendant que les agents travaillent ?',
    en: 'Install while agents are working?',
  },
  'updates.install_busy_note': {
    fr: {
      one: '{count} exécution est en cours. L’application se relancera ; le serveur et son agent continueront. Si un agent travaille encore après l’installation, vous devrez confirmer le redémarrage du serveur.',
      other:
        '{count} exécutions sont en cours. L’application se relancera ; le serveur et ses agents continueront. Si des agents travaillent encore après l’installation, vous devrez confirmer le redémarrage du serveur.',
    },
    en: {
      one: '{count} run is active. The application will relaunch; the server and its agent will continue. If an agent is still working after installation, you must confirm the server restart.',
      other:
        '{count} runs are active. The application will relaunch; the server and its agents will continue. If agents are still working after installation, you must confirm the server restart.',
    },
  },
  'updates.downloading': { fr: 'Téléchargement de la mise à jour…', en: 'Downloading the update…' },
  'updates.verifying': { fr: 'Vérification de la signature…', en: 'Verifying the signature…' },
  'updates.installing': {
    fr: 'Installation et relance de l’application…',
    en: 'Installing and relaunching the application…',
  },
  'updates.releases': { fr: 'Voir les versions sur GitHub', en: 'View releases on GitHub' },
  'updates.check_failed': {
    fr: 'Impossible de vérifier les mises à jour. Vérifiez votre connexion et réessayez.',
    en: 'Could not check for updates. Check your connection and try again.',
  },
  'updates.download_failed': {
    fr: 'Le téléchargement ou sa signature n’a pas pu être validé. Aucune mise à jour installée.',
    en: 'The download or its signature could not be verified. No update was installed.',
  },
  'updates.install_failed': {
    fr: 'L’installation n’a pas pu démarrer. Réessayez.',
    en: 'The installer could not start. Try again.',
  },
  'updates.server_not_managed': {
    fr: 'Ce serveur appartient à un autre lanceur. Aucun processus n’a été arrêté.',
    en: 'This server belongs to another launcher. No process was stopped.',
  },
  'updates.server_port_occupied': {
    fr: 'Le port du Studio est occupé par un autre service.',
    en: 'Another service is using the Studio port.',
  },
  'updates.server_version_mismatch': {
    fr: 'La version attendue du serveur n’a pas pu être confirmée. Consultez les journaux du Studio.',
    en: 'The expected server version could not be confirmed. Check the Studio logs.',
  },
  'updates.update_busy': {
    fr: 'Une opération est déjà en cours. Patientez avant de réessayer.',
    en: 'An operation is already in progress. Wait before trying again.',
  },
  'updates.failed': {
    fr: 'L’opération n’a pas abouti. Réessayez ou consultez les journaux de l’application.',
    en: 'The operation did not complete. Try again or check the application logs.',
  },
  'updates.remote_title': { fr: 'Mise à jour à distance', en: 'Remote update' },
  'updates.published_version': { fr: 'Version publiée', en: 'Published version' },
  'updates.installed_version': { fr: 'Version installée', en: 'Installed version' },
  'updates.meta_unavailable': {
    fr: 'Version publiée indisponible pour le moment.',
    en: 'Published version currently unavailable.',
  },
  'updates.desktop_offline': {
    fr: 'L’application de bureau semble hors ligne. Ouvrez-la sur le PC pour appliquer une mise à jour.',
    en: 'The desktop application looks offline. Open it on the PC to apply an update.',
  },
  'updates.remote_read_only': {
    fr: 'Cet accès distant est en lecture seule : la mise à jour demande un accès complet.',
    en: 'This remote access is read-only: updating requires full access.',
  },
  'updates.request_install': {
    fr: 'Installer cette version sur le PC',
    en: 'Install this version on the PC',
  },
  'updates.request_confirm_title': {
    fr: 'Installer la mise à jour sur le PC ?',
    en: 'Install the update on the PC?',
  },
  'updates.request_confirm_note': {
    fr: 'La version {version} sera téléchargée, vérifiée puis installée sur le PC, qui relancera l’application. Le serveur redémarrera s’il est libre, sinon après votre confirmation sur place.',
    en: 'Version {version} will be downloaded, verified and installed on the PC, which will relaunch the application. The server will restart if idle, otherwise after your on-site confirmation.',
  },
  'updates.request_confirm': { fr: 'Confirmer l’installation', en: 'Confirm installation' },
  'updates.queued': {
    fr: 'Demande envoyée. Suivi en cours…',
    en: 'Request sent. Tracking progress…',
  },
  'updates.stage_checking': { fr: 'Vérification de la version…', en: 'Checking the version…' },
  'updates.stage_downloading': { fr: 'Téléchargement sur le PC…', en: 'Downloading on the PC…' },
  'updates.stage_verifying': { fr: 'Vérification de la signature…', en: 'Verifying the signature…' },
  'updates.stage_installing': {
    fr: 'Installation et relance sur le PC…',
    en: 'Installing and relaunching on the PC…',
  },
  'updates.stage_installed': { fr: 'Version installée sur le PC.', en: 'Version installed on the PC.' },
  'updates.stage_pending_restart': {
    fr: 'Installée. Le serveur redémarrera après confirmation sur place.',
    en: 'Installed. The server will restart after on-site confirmation.',
  },
  'updates.stage_refused': {
    fr: 'Demande refusée : {detail}',
    en: 'Request refused: {detail}',
  },
  'updates.stage_failed': {
    fr: 'Échec de la mise à jour : {detail}',
    en: 'Update failed: {detail}',
  },
  'updates.stage_expired': {
    fr: 'Demande expirée sans réponse du PC. Renvoyez-la si besoin.',
    en: 'Request expired with no response from the PC. Send it again if needed.',
  },
  'agents.message_title': { fr: 'Message d’agent', en: 'Agent message' },
  'agents.message_child': { fr: 'Sous-agent', en: 'Subagent' },
  'agents.parent': { fr: 'Agent parent', en: 'Parent agent' },
  'agents.protected': { fr: 'Automatique · protégé', en: 'Automatic · protected' },
  'agents.message_protected': {
    fr: 'Les messages entre agents sont protégés et ne peuvent pas être modifiés.',
    en: 'Messages between agents are protected and cannot be changed.',
  },
  'agents.details': { fr: 'Détails de transmission', en: 'Delivery details' },
  'agents.sender': { fr: 'Expéditeur', en: 'Sender' },
  'agents.recipient': { fr: 'Destinataire', en: 'Recipient' },
  'agents.identifier': { fr: 'Identifiant', en: 'Identifier' },
  'projects.move_up': { fr: 'Monter le projet', en: 'Move project up' },
  'projects.drag': { fr: 'Déplacer {name}', en: 'Reorder {name}' },
  'projects.drag_hint': {
    fr: 'Glisser pour déplacer · Au clavier : flèches haut et bas. Les projets épinglés restent en tête.',
    en: 'Drag to reorder · Keyboard: up and down arrows. Pinned projects stay at the top.',
  },
  'projects.move_down': { fr: 'Descendre le projet', en: 'Move project down' },
  'projects.invalid_order': {
    fr: 'L’ordre des projets a changé. Actualisez la liste.',
    en: 'The project order changed. Refresh the list.',
  },
  'sessions.move_up': { fr: 'Monter la conversation', en: 'Move conversation up' },
  'sessions.move_down': { fr: 'Descendre la conversation', en: 'Move conversation down' },
  'sessions.drag_hint': {
    fr: 'Glisser pour déplacer · Au clavier : flèches haut et bas. Les conversations épinglées restent en tête.',
    en: 'Drag to reorder · Keyboard: up and down arrows. Pinned conversations stay at the top.',
  },
  'sessions.invalid_order': {
    fr: 'L’ordre des conversations a changé. Actualisez la liste.',
    en: 'The conversation order changed. Refresh the list.',
  },
  'activity.invalid_receipt': {
    fr: 'Ce message ne peut pas être marqué comme lu.',
    en: 'This message cannot be marked as read.',
  },
  'https.authorization': {
    fr: 'Tailscale demande une autorisation pour activer HTTPS.',
    en: 'Tailscale requires authorization to enable HTTPS.',
  },
  'https.not_installed': {
    fr: 'Tailscale est introuvable. Installez et connectez Tailscale sur ce PC, puis réessayez.',
    en: 'Tailscale was not found. Install and connect Tailscale on this PC, then retry.',
  },
  'https.failed': {
    fr: 'Tailscale n’a pas confirmé l’activation. Vérifiez sa connexion et réessayez.',
    en: 'Tailscale did not confirm activation. Check its connection and retry.',
  },
  'https.connect': {
    fr: 'Connectez Tailscale sur ce PC avant d’activer HTTPS.',
    en: 'Connect Tailscale on this PC before enabling HTTPS.',
  },
  'https.magicdns': {
    fr: 'Activez MagicDNS dans les paramètres DNS de Tailscale, puis réessayez.',
    en: 'Enable MagicDNS in Tailscale DNS settings, then retry.',
  },
  'https.conflict': {
    fr: 'Le port HTTPS de Tailscale est utilisé par un autre service ou par Funnel. Sa configuration a été conservée.',
    en: 'The Tailscale HTTPS port is used by another service or Funnel. Its configuration was preserved.',
  },
  'https.changed': {
    fr: 'La configuration Tailscale a changé pendant l’activation. Actualisez et réessayez.',
    en: 'Tailscale configuration changed during activation. Refresh and retry.',
  },
  'https.not_serving': {
    fr: 'Tailscale Serve ne dessert pas cette passerelle. Réessayez l’activation.',
    en: 'Tailscale Serve is not serving this gateway. Retry activation.',
  },
  'https.rollback_failed': {
    fr: 'L’enregistrement a échoué. La nouvelle passerelle locale a été fermée, mais vérifiez la configuration Tailscale Serve.',
    en: 'Saving failed. The new local gateway was closed, but check the Tailscale Serve configuration.',
  },
  'https.local_port': { fr: 'Port local HTTPS', en: 'Local HTTPS port' },
  'https.port_note': {
    fr: 'Port interne réservé à HTTPS. Par défaut : 3090. Le LAN et l’accès HTTP Tailscale gardent leur port.',
    en: 'Internal port reserved for HTTPS. Default: 3090. LAN and HTTP Tailscale keep their port.',
  },
  'https.activating': {
    fr: 'Activation HTTPS en cours… Cela peut prendre quelques secondes.',
    en: 'Enabling HTTPS… This may take a few seconds.',
  },
  'https.approval_note': {
    fr: 'Terminez l’étape demandée dans Tailscale, puis revenez ici pour réessayer.',
    en: 'Complete the required step in Tailscale, then return here and retry.',
  },
  'https.open_tailscale': { fr: 'Ouvrir Tailscale', en: 'Open Tailscale' },
  'https.retry': { fr: 'Réessayer', en: 'Retry' },
  'https.intro': {
    fr: 'Crée une adresse privée avec Tailscale Serve. Le PIN est conservé et les agents continuent.',
    en: 'Creates a private address with Tailscale Serve. Your PIN is preserved and agents keep running.',
  },
  'https.saved': {
    fr: 'HTTPS est actif. Utilisez son lien ou son QR code pour installer le Studio.',
    en: 'HTTPS is active. Use its link or QR code to install Studio.',
  },
  'settings.qr_scan_lan': {
    fr: 'Scannez avec votre téléphone connecté au même réseau local.',
    en: 'Scan with your phone connected to the same local network.',
  },
  'settings.qr_scan_tailscale': {
    fr: 'Scannez avec votre téléphone connecté à Tailscale.',
    en: 'Scan with your phone connected to Tailscale.',
  },
  'settings.title': { fr: 'Préférences', en: 'Preferences' },
  'settings.categories': { fr: 'Catégories', en: 'Categories' },
  'settings.appearance': { fr: 'Apparence', en: 'Appearance' },
  'settings.models': { fr: 'Modèles et agents', en: 'Models & agents' },
  'settings.tools': { fr: 'Outils', en: 'Tools' },
  'settings.remote': { fr: 'Accès distant', en: 'Remote access' },
  'settings.system': { fr: 'Système', en: 'System' },
  'settings.scope_browser': {
    fr: 'Pour ce navigateur · Apparence et conversation',
    en: 'This browser · Appearance and conversation',
  },
  'settings.scope_desktop': {
    fr: 'Pour cette application · Apparence et conversation',
    en: 'This application · Appearance and conversation',
  },
  'settings.components': { fr: 'Composants du Studio', en: 'Studio components' },
  'settings.components_note': {
    fr: 'Vérifier ou préparer Prime Agent, uv et Python dans les réglages de l’application Windows.',
    en: 'Check or prepare Prime Agent, uv and Python in the Windows application settings.',
  },
  'settings.components_open': { fr: 'Configurer', en: 'Set up' },
  'settings.scope_agent': {
    fr: 'Prime Agent sur ce PC · Configuration partagée',
    en: 'Prime Agent on this PC · Shared configuration',
  },
  'settings.scope_tools': {
    fr: 'Prime Agent sur ce PC · Outils et ressources',
    en: 'Prime Agent on this PC · Tools and resources',
  },
  'settings.scope_pc': {
    fr: 'Ce PC · Connexion de vos autres appareils',
    en: 'This PC · Connect your other devices',
  },
  'settings.scope_studio': {
    fr: 'Le Studio auquel vous êtes connecté',
    en: 'The Studio you are connected to',
  },
  'settings.resources': { fr: 'Skills et prompts', en: 'Skills and prompts' },
  'settings.resources_note': {
    fr: 'Retrouvez vos ressources et ouvrez leurs dossiers.',
    en: 'Browse your resources and open their folders.',
  },
  'settings.resources_scope': {
    fr: 'Ressources globales et ressources du projet sélectionné. Leur emplacement est indiqué dans le catalogue.',
    en: 'Global resources and resources for the selected project. The catalog shows their location.',
  },
  'settings.choose_project': {
    fr: 'Sélectionnez un projet pour consulter ses ressources.',
    en: 'Select a project to browse its resources.',
  },
  'settings.models_note': {
    fr: 'Les valeurs par défaut concernent les nouvelles sessions et délégations. Les sous-agents peuvent aussi être réglés par projet. Le modèle de la conversation se choisit près du message.',
    en: 'Defaults apply to new sessions and delegations. Subagents can also be configured per project. Choose the conversation model beside the message.',
  },
  'settings.remote_intro': {
    fr: 'Activez une connexion sans interrompre les agents.',
    en: 'Enable a connection without interrupting agents.',
  },
  'settings.refresh': { fr: 'Actualiser', en: 'Refresh' },
  'settings.loading': { fr: 'Chargement…', en: 'Loading…' },
  'settings.lan': { fr: 'Réseau local', en: 'Local network' },
  'settings.tailscale': { fr: 'Tailscale', en: 'Tailscale' },
  'settings.https': { fr: 'Tailscale HTTPS', en: 'Tailscale HTTPS' },
  'settings.lan_note': {
    fr: 'Sur le même Wi-Fi ou réseau Ethernet.',
    en: 'On the same Wi-Fi or Ethernet network.',
  },
  'settings.tailscale_note': {
    fr: 'Entre vos appareils connectés à Tailscale.',
    en: 'Between your devices connected to Tailscale.',
  },
  'settings.https_note': {
    fr: 'Pour installer le Studio sur votre téléphone.',
    en: 'Install Studio on your phone.',
  },
  'settings.lan_missing': {
    fr: 'Aucune adresse locale détectée. Connectez ce PC au Wi-Fi ou à Ethernet, puis actualisez.',
    en: 'No local address detected. Connect this PC to Wi-Fi or Ethernet, then refresh.',
  },
  'settings.tailscale_missing': {
    fr: 'Connectez Tailscale sur ce PC, puis actualisez.',
    en: 'Connect Tailscale on this PC, then refresh.',
  },
  'settings.status_active': { fr: 'Actif', en: 'Active' },
  'settings.status_disabled': { fr: 'Désactivé', en: 'Off' },
  'settings.status_error': { fr: 'Indisponible', en: 'Unavailable' },
  'settings.connection_options': { fr: 'Options de connexion', en: 'Connection options' },
  'settings.interface': { fr: 'Interface réseau', en: 'Network interface' },
  'settings.port': { fr: 'Port', en: 'Port' },
  'settings.port_note': {
    fr: 'Port commun au LAN et à Tailscale. Après un changement, utilisez le nouveau lien sur vos appareils.',
    en: 'Shared by LAN and Tailscale. After changing it, use the new link on your devices.',
  },
  'settings.apply': { fr: 'Appliquer', en: 'Apply' },
  'settings.copy_link': { fr: 'Copier le lien', en: 'Copy link' },
  'settings.qr': { fr: 'QR code', en: 'QR code' },
  'settings.qr_title': { fr: 'Connecter un appareil', en: 'Connect a device' },
  'settings.qr_scan': {
    fr: 'Scannez avec votre téléphone connecté à {network}.',
    en: 'Scan with your phone connected to {network}.',
  },
  'settings.qr_note': {
    fr: 'Le QR code contient uniquement le lien. Votre code PIN sera demandé à la connexion.',
    en: 'The QR code contains only the link. Your PIN will be requested when connecting.',
  },
  'settings.new_code': { fr: 'Votre code d’accès', en: 'Your access code' },
  'settings.new_code_note': {
    fr: 'Notez ce PIN avant de fermer cet encart. Il ne pourra pas être réaffiché.',
    en: 'Save this PIN before dismissing this notice. It cannot be shown again.',
  },
  'settings.copy_code': { fr: 'Copier le code', en: 'Copy code' },
  'settings.code_saved': { fr: 'J’ai noté le code', en: 'I saved the code' },
  'settings.permissions': { fr: 'Autorisations à distance', en: 'Remote permissions' },
  'settings.permissions_note': {
    fr: 'Un changement déconnecte les appareils distants. Les agents continuent.',
    en: 'Changing this signs out remote devices. Agents keep running.',
  },
  'settings.full_access': { fr: 'Contrôle complet', en: 'Full control' },
  'settings.read_only': { fr: 'Lecture seule', en: 'Read only' },
  'settings.pin': { fr: 'Code PIN', en: 'PIN code' },
  'settings.pin_note': {
    fr: 'Commun au LAN, à Tailscale et à la PWA.',
    en: 'Shared by LAN, Tailscale and the PWA.',
  },
  'settings.network_saved': {
    fr: 'Accès réseau mis à jour. Les agents continuent.',
    en: 'Network access updated. Agents keep running.',
  },
  'settings.permissions_saved': {
    fr: 'Autorisations mises à jour. Reconnectez vos appareils.',
    en: 'Permissions updated. Reconnect your devices.',
  },
  'settings.diagnostics': { fr: 'Diagnostic', en: 'Diagnostics' },
  'settings.diagnostics_note': {
    fr: 'Versions et état du moteur, sans clés ni conversations.',
    en: 'Versions and engine status, without keys or conversations.',
  },
  'settings.copy': { fr: 'Copier', en: 'Copy' },
  'settings.logs': { fr: 'Journaux du Studio', en: 'Studio logs' },
  'settings.logs_note': {
    fr: 'Pour consulter les erreurs de lancement et du serveur.',
    en: 'Inspect launcher and server errors.',
  },
  'settings.open_folder': { fr: 'Ouvrir le dossier', en: 'Open folder' },
  'settings.studio_version': { fr: 'Version du Studio', en: 'Studio version' },
  'settings.engine': { fr: 'Moteur Prime Agent', en: 'Prime Agent engine' },
  'settings.engine_version': { fr: 'Version de Prime Agent', en: 'Prime Agent version' },
  'settings.running': { fr: 'Agents en cours', en: 'Running agents' },
  'settings.node': { fr: 'Node.js', en: 'Node.js' },
  'settings.available': { fr: 'Disponible', en: 'Available' },
  'settings.unavailable': { fr: 'Indisponible', en: 'Unavailable' },
  'network.closed': { fr: 'Le Studio est en cours de fermeture.', en: 'Studio is shutting down.' },
  'network.invalid_port': {
    fr: 'Choisissez un port libre entre 1024 et 65535, différent de celui du Studio et de la PWA.',
    en: 'Choose a free port between 1024 and 65535, different from the Studio and PWA ports.',
  },
  'network.invalid_address': {
    fr: 'Cette adresse réseau n’est pas disponible sur ce PC. Actualisez les interfaces.',
    en: 'This network address is not available on this PC. Refresh the interfaces.',
  },
  'network.port_busy': {
    fr: 'Ce port est déjà utilisé. Choisissez-en un autre dans les options de connexion.',
    en: 'This port is in use. Choose another one in connection options.',
  },
  'network.bind_failed': {
    fr: 'Impossible d’ouvrir cette connexion. Vérifiez l’interface réseau et le port.',
    en: 'Could not open this connection. Check the network interface and port.',
  },
  'network.address_lost': {
    fr: 'Cette adresse n’est plus disponible. Actualisez et choisissez une interface connectée.',
    en: 'This address is no longer available. Refresh and choose a connected interface.',
  },
  'network.not_listening': {
    fr: 'Cette connexion est configurée mais n’écoute pas. Réappliquez les options de connexion.',
    en: 'This connection is configured but not listening. Reapply connection options.',
  },
  'network.invalid_config': { fr: 'Les paramètres réseau sont invalides.', en: 'Invalid network settings.' },
  'network.enable_first': {
    fr: 'Activez d’abord un accès réseau sur ce PC.',
    en: 'Enable network access on this PC first.',
  },
  'network.qr_unavailable': {
    fr: 'Activez cette connexion avant de générer son QR code.',
    en: 'Enable this connection before generating its QR code.',
  },
  'folders.browse': {
    fr: 'Choisir un dossier',
    en: 'Choose folder',
  },
  'folders.choose': {
    fr: 'Choisir le dossier du projet',
    en: 'Choose the project folder',
  },
  'folders.scope': {
    fr: 'Emplacement des ressources',
    en: 'Resource location',
  },
  'folders.global': {
    fr: 'Global · Tous les projets',
    en: 'Global · All projects',
  },
  'folders.project': {
    fr: 'Projet sélectionné',
    en: 'Selected project',
  },
  'folders.windows_only': {
    fr: 'Le sélecteur de dossier est disponible sur le PC Windows.',
    en: 'The folder picker is available on the Windows PC.',
  },
  'folders.already_open': {
    fr: 'Un sélecteur est déjà ouvert sur le PC. Terminez la sélection ou annulez-la.',
    en: 'A folder picker is already open on the PC. Finish or cancel that selection.',
  },
  'folders.picker_failed': {
    fr: 'Impossible de sélectionner le dossier sur le PC. Réessayez ou saisissez son chemin.',
    en: 'Could not select the folder on the PC. Try again or enter its path.',
  },
  'folders.invalid_resource': {
    fr: 'Choisissez Skills ou Prompts et un emplacement global ou projet.',
    en: 'Choose Skills or Prompts and a global or project location.',
  },
  'login.title': {
    fr: 'Prime Agent Studio · Accès mobile',
    en: 'Prime Agent Studio · Mobile access',
  },
  'login.heading': {
    fr: 'Votre studio, à portée de main.',
    en: 'Your studio, within reach.',
  },
  'login.intro': {
    fr: 'Retrouvez vos projets et vos sessions depuis votre téléphone.',
    en: 'Access your projects and sessions from your phone.',
  },
  'login.code': {
    fr: 'Code d’accès',
    en: 'Access code',
  },
  'login.open': {
    fr: 'Ouvrir le studio',
    en: 'Open Studio',
  },
  'pwa.description': {
    fr: 'Espace de travail local pour Prime Agent, avec sessions persistantes.',
    en: 'Local workspace for Prime Agent with persistent sessions.',
  },
  'language.label': {
    fr: 'Langue',
    en: 'Language',
  },
  'language.note': {
    fr: 'Ce choix s’applique à cet appareil.',
    en: 'This choice applies to this device.',
  },
  'language.auto': {
    fr: 'Automatique',
    en: 'Automatic',
  },
  'ui.modele_par_defaut': {
    fr: 'Modèle par défaut',
    en: 'Default model',
  },
  'ui.modele_personnalise': {
    fr: 'Modèle personnalisé',
    en: 'Custom model',
  },
  'ui.configuration_prime_agent': {
    fr: 'Configuration Prime Agent',
    en: 'Prime Agent configuration',
  },
  'ui.choisir_le_modele_selection_actuelle': {
    fr: 'Choisir le modèle. Sélection actuelle : {value1}',
    en: 'Choose a model. Current selection: {value1}',
  },
  'ui.configuration_de_prime_agent': {
    fr: 'Configuration de Prime Agent',
    en: 'Prime Agent configuration',
  },
  'ui.ajouter': {
    fr: 'Ajouter',
    en: 'Add',
  },
  'ui.retirer_des_favoris': {
    fr: 'Retirer des favoris',
    en: 'Remove from favorites',
  },
  'ui.ajouter_aux_favoris': {
    fr: 'Ajouter aux favoris',
    en: 'Add to favorites',
  },
  'ui.modele_par_defaut_configuration_prime_agent': {
    fr: 'Modèle par défaut configuration Prime Agent',
    en: 'Default model from Prime Agent configuration',
  },
  'ui.favoris': {
    fr: 'Favoris',
    en: 'Favorites',
  },
  'ui.aucun_favori_trouve': {
    fr: 'Aucun favori trouvé',
    en: 'No favorites found',
  },
  'ui.aucun_modele_trouve': {
    fr: 'Aucun modèle trouvé',
    en: 'No models found',
  },
  'ui.ajoutez_un_favori_ou_modifiez_votre_recherche': {
    fr: 'Ajoutez un favori ou modifiez votre recherche.',
    en: 'Add a favorite or change your search.',
  },
  'ui.essayez_un_autre_nom_fournisseur_ou_identifiant': {
    fr: 'Essayez un autre nom, fournisseur ou identifiant.',
    en: 'Try another name, provider or identifier.',
  },
  'ui.choisir_un_modele': {
    fr: 'Choisir un modèle',
    en: 'Choose a model',
  },
  'ui.cette_connexion_permet_de_consulter_les_sessions': {
    fr: 'Cette connexion permet de consulter les sessions.',
    en: 'This connection allows you to view sessions.',
  },
  'ui.le_serveur_a_renvoye_une_reponse_illisible': {
    fr: 'Le serveur a renvoyé une réponse illisible.',
    en: 'The server returned an unreadable response.',
  },
  'ui.prime_agent_indisponible': {
    fr: 'Prime Agent indisponible',
    en: 'Prime Agent unavailable',
  },
  'ui.moteur_connecte': {
    fr: 'Moteur connecté',
    en: 'Engine connected',
  },
  'ui.reconnexion_au_serveur': {
    fr: 'Reconnexion au serveur…',
    en: 'Reconnecting to the server…',
  },
  'ui.entree_pour_envoyer_maj_entree_pour_un_saut_de_ligne': {
    fr: 'Entrée pour envoyer · Maj Entrée pour un saut de ligne',
    en: 'Enter to send · Shift Enter for a new line',
  },
  'ui.ctrl_entree_pour_envoyer': {
    fr: 'Ctrl Entrée pour envoyer',
    en: 'Ctrl Enter to send',
  },
  'ui.masquer_le_panneau': {
    fr: 'Masquer le panneau',
    en: 'Hide panel',
  },
  'ui.afficher_le_panneau_session_agents_et_fichiers': {
    fr: 'Afficher le panneau Session, Agents et Fichiers',
    en: 'Show the Session, Agents and Files panel',
  },
  'ui.consultation_a_distance': {
    fr: 'Consultation à distance',
    en: 'Remote viewer',
  },
  'ui.studio_a_distance': {
    fr: 'Studio à distance',
    en: 'Remote Studio',
  },
  'ui.lecture_seule': {
    fr: '· lecture seule',
    en: '· read only',
  },
  'ui.controle_complet': {
    fr: '· contrôle complet',
    en: '· full control',
  },
  'ui.sessions_sur_le_pc_connecte': {
    fr: 'Sessions sur le PC connecté',
    en: 'Sessions on the connected PC',
  },
  'ui.sessions_sur_ce_pc': {
    fr: 'Sessions sur ce PC',
    en: 'Sessions on this PC',
  },
  'ui.aller_a_la_conversation': {
    fr: 'Aller à la conversation',
    en: 'Skip to conversation',
  },
  'ui.aller_au_message': {
    fr: 'Aller au message',
    en: 'Skip to message',
  },
  'ui.distant': {
    fr: 'DISTANT',
    en: 'REMOTE',
  },
  'ui.cet_appareil': {
    fr: 'Cet appareil',
    en: 'This device',
  },
  'ui.studio_local': {
    fr: 'Studio local',
    en: 'Local Studio',
  },
  'ui.vos_projets_a_portee_de_main': {
    fr: 'Vos projets, à portée de main.',
    en: 'Your projects, within reach.',
  },
  'ui.choisissez_un_projet_pour_retrouver_ses_sessions_et_suivre_l_agen': {
    fr: 'Choisissez un projet pour retrouver ses sessions et suivre l’agent en direct.',
    en: 'Choose a project to find its sessions and follow the agent live.',
  },
  'ui.votre_studio_a_distance': {
    fr: 'VOTRE STUDIO À DISTANCE',
    en: 'YOUR STUDIO, REMOTELY',
  },
  'ui.arret_de_l_agent': {
    fr: 'Arrêt de l’agent…',
    en: 'Stopping the agent…',
  },
  'ui.l_agent_travaille': {
    fr: 'L’agent travaille…',
    en: 'The agent is working…',
  },
  'ui.ajoutez_vos_consignes': {
    fr: 'Ajoutez vos consignes…',
    en: 'Add your instructions…',
  },
  'ui.preparez_votre_prochain_message': {
    fr: 'Préparez votre prochain message…',
    en: 'Prepare your next message…',
  },
  'ui.que_souhaitez_vous_construire': {
    fr: 'Que souhaitez-vous construire ?',
    en: 'What would you like to build?',
  },
  'ui.ajoutez_un_projet_pour_commencer': {
    fr: 'Ajoutez un projet pour commencer…',
    en: 'Add a project to get started…',
  },
  'ui.dossier_introuvable': {
    fr: 'Dossier introuvable',
    en: 'Folder not found',
  },
  'ui.options_du_projet': {
    fr: 'Options du projet {value1}',
    en: 'Options for project {value1}',
  },
  'ui.aucun_projet_a_consulter_pour_le_moment': {
    fr: 'Aucun projet à consulter pour le moment.',
    en: 'No projects to view yet.',
  },
  'ui.vos_projets_au_meme_endroit': {
    fr: 'Vos projets, au même endroit. ',
    en: 'Your projects, in one place. ',
  },
  'ui.ajouter_un_dossier': {
    fr: 'Ajouter un dossier',
    en: 'Add a folder',
  },
  'ui.agent_en_cours': {
    fr: 'Agent en cours',
    en: 'Agent running',
  },
  'ui.reponse_terminee_non_lue': {
    fr: 'Réponse terminée non lue',
    en: 'Completed response, unread',
  },
  'ui.epinglees': {
    fr: 'Épinglées',
    en: 'Pinned',
  },
  'ui.aujourd_hui': {
    fr: 'Aujourd’hui',
    en: 'Today',
  },
  'ui.cette_semaine': {
    fr: 'Cette semaine',
    en: 'This week',
  },
  'ui.ce_mois_ci': {
    fr: 'Ce mois-ci',
    en: 'This month',
  },
  'ui.plus_anciennes': {
    fr: 'Plus anciennes',
    en: 'Older',
  },
  'ui.sessions_archivees': {
    fr: 'SESSIONS ARCHIVÉES',
    en: 'ARCHIVED SESSIONS',
  },
  'ui.resultats_de_recherche': {
    fr: 'RÉSULTATS DE RECHERCHE',
    en: 'SEARCH RESULTS',
  },
  'ui.sessions_recentes': {
    fr: 'SESSIONS RÉCENTES',
    en: 'RECENT SESSIONS',
  },
  'ui.afficher_les_sessions_recentes': {
    fr: 'Afficher les sessions récentes',
    en: 'Show recent sessions',
  },
  'ui.afficher_les_sessions_archivees': {
    fr: 'Afficher les sessions archivées',
    en: 'Show archived sessions',
  },
  'ui.sans_titre': {
    fr: 'Sans titre',
    en: 'Untitled',
  },
  'projects.new_conversation': {
    fr: 'Nouvelle conversation',
    en: 'New conversation',
  },
  'ui.nouvelle_session': {
    fr: 'Nouvelle session',
    en: 'New session',
  },
  'ui.options_de_la_session': {
    fr: 'Options de la session',
    en: 'Session options',
  },
  'ui.aucune_session_ne_correspond_a_votre_recherche': {
    fr: 'Aucune session ne correspond à votre recherche.',
    en: 'No sessions match your search.',
  },
  'ui.aucune_session_archivee': {
    fr: 'Aucune session archivée.',
    en: 'No archived sessions.',
  },
  'ui.aucune_session_a_consulter_dans_ce_projet_pour_le_moment': {
    fr: 'Aucune session à consulter dans ce projet pour le moment.',
    en: 'No sessions to view in this project yet.',
  },
  'ui.vos_conversations_apparaitront_ici_commencez_une_nouvelle_session': {
    fr: 'Vos conversations apparaîtront ici. Commencez une nouvelle session.',
    en: 'Your conversations will appear here. Start a new session.',
  },
  'ui.aller_aux_sessions_du_projet': {
    fr: 'Aller aux sessions du projet',
    en: 'Go to project sessions',
  },
  'ui.sessions_du_projet': {
    fr: 'Sessions du projet',
    en: 'Project sessions',
  },
  'ui.ouvrez_une_conversation_pour_consulter_ses_echanges_et_suivre_l_a': {
    fr: 'Ouvrez une conversation pour consulter ses échanges et suivre l’agent en direct.',
    en: 'Open a conversation to read its messages and follow the agent live.',
  },
  'ui.retrouvez_une_conversation_et_reprenez_la_ou_vous_en_etiez': {
    fr: 'Retrouvez une conversation et reprenez là où vous en étiez.',
    en: 'Find a conversation and pick up where you left off.',
  },
  'ui.reponse_non_lue': {
    fr: 'Réponse non lue',
    en: 'Unread response',
  },
  'ui.epinglee': {
    fr: 'Épinglée',
    en: 'Pinned',
  },
  'ui.aucun_resultat': {
    fr: 'Aucun résultat',
    en: 'No results',
  },
  'ui.aucune_session_archivee_2': {
    fr: 'Aucune session archivée',
    en: 'No archived sessions',
  },
  'ui.votre_premiere_session': {
    fr: 'Votre première session',
    en: 'Your first session',
  },
  'ui.essayez_un_autre_mot_pour_retrouver_votre_conversation': {
    fr: 'Essayez un autre mot pour retrouver votre conversation.',
    en: 'Try another word to find your conversation.',
  },
  'ui.les_conversations_archivees_de_ce_projet_apparaitront_ici': {
    fr: 'Les conversations archivées de ce projet apparaîtront ici.',
    en: 'Archived conversations from this project will appear here.',
  },
  'ui.ce_projet_ne_contient_pas_encore_de_conversation': {
    fr: 'Ce projet ne contient pas encore de conversation.',
    en: 'This project has no conversations yet.',
  },
  'ui.creez_une_session_pour_commencer_a_travailler_avec_prime_agent': {
    fr: 'Créez une session pour commencer à travailler avec Prime Agent.',
    en: 'Create a session to start working with Prime Agent.',
  },
  'ui.espace_de_travail': {
    fr: 'Espace de travail',
    en: 'Workspace',
  },
  'ui.afficher_les_sessions_de': {
    fr: 'Afficher les sessions de {value1}',
    en: 'Show sessions for {value1}',
  },
  'ui.session_en_cours': {
    fr: 'Session en cours',
    en: 'Session running',
  },
  'ui.sessions': {
    fr: 'Sessions',
    en: 'Sessions',
  },
  'ui.consultation_des_sessions': {
    fr: 'Consultation des sessions',
    en: 'Session viewer',
  },
  'ui.vos_projets': {
    fr: 'Vos projets',
    en: 'Your projects',
  },
  'ui.votre_prochain_projet': {
    fr: 'Votre prochain projet',
    en: 'Your next project',
  },
  'ui.les_projets_du_studio_sont_accessibles_depuis_le_menu': {
    fr: 'Les projets du Studio sont accessibles depuis le menu.',
    en: 'Studio projects are available from the menu.',
  },
  'ui.connectez_un_dossier_local_pour_donner_du_contexte_a_votre_agent': {
    fr: 'Connectez un dossier local pour donner du contexte à votre agent.',
    en: 'Connect a local folder to give your agent context.',
  },
  'ui.dossier_introuvable_2': {
    fr: '{value1} · dossier introuvable',
    en: '{value1} · folder not found',
  },
  'ui.vos_sessions_apparaitront_ici': {
    fr: 'Vos sessions apparaîtront ici',
    en: 'Your sessions will appear here',
  },
  'ui.ajoutez_un_projet_pour_commencer_2': {
    fr: 'Ajoutez un projet pour commencer',
    en: 'Add a project to get started',
  },
  'ui.arret_en_cours': {
    fr: 'Arrêt en cours',
    en: 'Stopping',
  },
  'ui.en_cours': {
    fr: 'En cours',
    en: 'Running',
  },
  'ui.archivee': {
    fr: 'Archivée',
    en: 'Archived',
  },
  'ui.disponible': {
    fr: 'Disponible',
    en: 'Ready',
  },
  'ui.consultation': {
    fr: 'Consultation',
    en: 'View only',
  },
  'ui.prete_a_demarrer': {
    fr: 'Prête à démarrer',
    en: 'Ready to start',
  },
  'ui.le_dossier_de_ce_projet_est_introuvable_ses_conversations_restent': {
    fr: 'Le dossier de ce projet est introuvable. Ses conversations restent consultables.',
    en: 'The folder for this project cannot be found. Its conversations are still available to read.',
  },
  'ui.le_dossier_de_ce_projet_est_introuvable_ajoutez_son_nouvel_emplac': {
    fr: 'Le dossier de ce projet est introuvable. Ajoutez son nouvel emplacement pour poursuivre.',
    en: 'The folder for this project cannot be found. Add its new location to continue.',
  },
  'ui.copier': {
    fr: 'Copier',
    en: 'Copy',
  },
  'ui.code_copie': {
    fr: 'Code copié',
    en: 'Code copied',
  },
  'ui.preparation': {
    fr: 'Préparation',
    en: 'Preparing',
  },
  'ui.termine': {
    fr: 'Terminé',
    en: 'Done',
  },
  'ui.quota_codex_label': {
    fr: 'Quota Codex (optionnel)',
    en: 'Codex quota (optional)',
  },
  'ui.quota_non_consulte': {
    fr: 'Quota non consulté — actualisation manuelle uniquement.',
    en: 'Quota not checked — manual refresh only.',
  },
  'ui.quota_actualiser': {
    fr: 'Actualiser le quota',
    en: 'Refresh quota',
  },
  'ui.quota_chargement': {
    fr: 'Consultation du quota…',
    en: 'Checking quota…',
  },
  'ui.quota_indisponible': {
    fr: 'Quota indisponible pour le moment.',
    en: 'Quota unavailable for now.',
  },
  'ui.quota_courte': {
    fr: 'Fenêtre courte : {used}% utilisés ({remaining}% restants){reset}',
    en: 'Short window: {used}% used ({remaining}% left){reset}',
  },
  'ui.quota_hebdo': {
    fr: 'Fenêtre hebdomadaire : {used}% utilisés ({remaining}% restants){reset}',
    en: 'Weekly window: {used}% used ({remaining}% left){reset}',
  },
  'ui.quota_reinitialisation': {
    fr: ' — réinitialisation {date}',
    en: ' — resets {date}',
  },
  'ui.quota_plan': {
    fr: 'Formule : {plan}',
    en: 'Plan: {plan}',
  },
  'ui.quota_actualisee': {
    fr: 'Actualisé {time}.',
    en: 'Updated {time}.',
  },
  'ui.quota_short_label': {
    fr: 'Fenêtre courte',
    en: 'Short window',
  },
  'ui.quota_weekly_label': {
    fr: 'Fenêtre hebdomadaire',
    en: 'Weekly window',
  },
  'ui.session_quota_codex_title': {
    fr: 'Quota Codex — session',
    en: 'Codex quota — session',
  },
  'ui.session_quota_api_title': {
    fr: 'Usage OpenAI (API)',
    en: 'OpenAI usage (API)',
  },
  'ui.session_quota_api_note': {
    fr: 'Modèle OpenAI via clé API : facturation à l’usage, sans quota d’abonnement Codex.',
    en: 'OpenAI model via API key: usage-based billing, no Codex subscription quota.',
  },
  'ui.session_quota_unlinked': {
    fr: 'Compte Codex non lié — liez votre compte (OAuth) dans Fournisseurs pour voir le quota. Aucune consultation automatique.',
    en: 'Codex account not linked — link your account (OAuth) in Providers to see quota. No automatic check.',
  },
  'ui.session_quota_remote': {
    fr: 'Quota indisponible depuis l’accès à distance (local uniquement).',
    en: 'Quota unavailable from remote access (local only).',
  },
  'ui.session_quota_auth': {
    fr: 'Quota indisponible — reconnectez votre compte Codex.',
    en: 'Quota unavailable — reconnect your Codex account.',
  },
  'ui.session_context_title': {
    fr: 'Contexte Prime Agent',
    en: 'Prime Agent context',
  },
  'ui.session_context_detail': {
    fr: '{used} / {total} jetons ({percent} %)',
    en: '{used} / {total} tokens ({percent}%)',
  },
  'ui.session_context_note': {
    fr: 'Contexte actuel / fenêtre du modèle — pas le total cumulé.',
    en: 'Current context / model window — not cumulative total.',
  },
  'ui.session_context_unavailable': {
    fr: 'Contexte indisponible pour le moment.',
    en: 'Context unavailable for now.',
  },
  'ui.session_context_idle': {
    fr: 'Disponible pendant une session active.',
    en: 'Available during an active session.',
  },
  'ui.session_context_pending': {
    fr: 'Mesure momentanément indisponible.',
    en: 'Measurement temporarily unavailable.',
  },
  'ui.parametres': {
    fr: 'PARAMÈTRES',
    en: 'PARAMETERS',
  },
  'ui.resultat_2': {
    fr: 'RÉSULTAT',
    en: 'RESULT',
  },
  'ui.en_attente_du_resultat': {
    fr: 'En attente du résultat…',
    en: 'Waiting for the result…',
  },
  'ui.vous': {
    fr: 'Vous',
    en: 'You',
  },
  'ui.contexte': {
    fr: 'Contexte',
    en: 'Context',
  },
  'ui.reflexion_en_cours': {
    fr: 'Réflexion en cours',
    en: 'Thinking',
  },
  'ui.raisonnement': {
    fr: 'Raisonnement',
    en: 'Reasoning',
  },
  'ui.reponse_interrompue': {
    fr: 'Réponse interrompue.',
    en: 'Response interrupted.',
  },
  'ui.aucun_contenu_textuel': {
    fr: 'Aucun contenu textuel.',
    en: 'No text content.',
  },
  'ui.message_copie': {
    fr: 'Message copié',
    en: 'Message copied',
  },
  'ui.optimisation_du_contexte': {
    fr: 'Optimisation du contexte…',
    en: 'Optimizing context…',
  },
  'ui.nouvelle_tentative_en_cours': {
    fr: 'Nouvelle tentative en cours…',
    en: 'Retrying…',
  },
  'ui.le_debut_de_cette_execution_sera_recharge_depuis_l_historique_a_l': {
    fr: 'Le début de cette exécution sera rechargé depuis l’historique à la fin.',
    en: 'The beginning of this run will be reloaded from history when it finishes.',
  },
  'ui.evenement_prime_agent_invalide': {
    fr: 'Événement Prime Agent invalide',
    en: 'Invalid Prime Agent event',
  },
  'ui.reconnexion_a_l_agent': {
    fr: 'Reconnexion à l’agent…',
    en: 'Reconnecting to the agent…',
  },
  'ui.l_agent_a_ete_arrete': {
    fr: 'L’agent a été arrêté.',
    en: 'The agent has been stopped.',
  },
  'ui.analyse_les_pieces_jointes': {
    fr: 'Analyse les pièces jointes.',
    en: 'Analyze the attachments.',
  },
  'ui.cette_execution_n_est_plus_active_l_historique_enregistre_a_ete_c': {
    fr: 'Cette exécution n’est plus active. L’historique enregistré a été conservé.',
    en: 'This run is no longer active. Its saved history has been preserved.',
  },
  'ui.choix_automatique': {
    fr: 'Choix automatique',
    en: 'Automatic selection',
  },
  'ui.modele_indisponible': {
    fr: 'Modèle indisponible',
    en: 'Model unavailable',
  },
  'ui.choix_automatique_de_prime_agent': {
    fr: 'Choix automatique de Prime Agent',
    en: 'Prime Agent automatic selection',
  },
  'ui.modele_principal_par_defaut': {
    fr: 'Modèle principal par défaut. {value1}{value2}',
    en: 'Default main model. {value1}{value2}',
  },
  'ui.aucun_modele_configure': {
    fr: 'Aucun modèle configuré',
    en: 'No configured models',
  },
  'ui.api_heritee': {
    fr: 'API héritée',
    en: 'Inherited API',
  },
  'ui.images': {
    fr: 'Images',
    en: 'Images',
  },
  'ui.identification_a_verifier': {
    fr: 'Identification à vérifier',
    en: 'Credentials need checking',
  },
  'ui.options_avancees_en_lecture_seule': {
    fr: 'Options avancées en lecture seule',
    en: 'Advanced options are read only',
  },
  'ui.modifier': {
    fr: 'Modifier',
    en: 'Edit',
  },
  'ui.supprimer': {
    fr: 'Supprimer',
    en: 'Delete',
  },
  'ui.modifier_le_modele': {
    fr: 'Modifier le modèle',
    en: 'Edit model',
  },
  'ui.ajouter_un_modele': {
    fr: 'Ajouter un modèle',
    en: 'Add a model',
  },
  'ui.identification_existante_conservee': {
    fr: 'Identification existante conservée',
    en: 'Existing credentials preserved',
  },
  'ui.la_configuration_des_modeles_est_disponible_uniquement_sur_l_ordi': {
    fr: 'La configuration des modèles est disponible uniquement sur l’ordinateur local.',
    en: 'Model configuration is only available on the local computer.',
  },
  'ui.chargement_de_la_configuration': {
    fr: 'Chargement de la configuration…',
    en: 'Loading configuration…',
  },
  'ui.le_serveur_en_cours_doit_etre_redemarre_pour_activer_le_configura': {
    fr: 'Le serveur en cours doit être redémarré pour activer le configurateur. Arrêtez puis relancez Prime Agent Studio.',
    en: 'The running server needs to be restarted to enable the configurator. Stop and restart Prime Agent Studio.',
  },
  'ui.impossible_de_charger_la_configuration': {
    fr: 'Impossible de charger la configuration. {value1}',
    en: 'Unable to load configuration. {value1}',
  },
  'ui.le_modele_par_defaut_de_l_agent_principal_a_ete_enregistre': {
    fr: 'Le modèle par défaut de l’agent principal a été enregistré.',
    en: 'The default main agent model has been saved.',
  },
  'ui.prime_agent_choisira_automatiquement_le_modele_principal': {
    fr: 'Prime Agent choisira automatiquement le modèle principal.',
    en: 'Prime Agent will choose the main model automatically.',
  },
  'ui.impossible_d_enregistrer_le_modele_par_defaut': {
    fr: 'Impossible d’enregistrer le modèle par défaut. {value1}',
    en: 'Unable to save the default model. {value1}',
  },
  'ui.a_ete_enregistre': {
    fr: '{value1} a été enregistré.',
    en: '{value1} has been saved.',
  },
  'ui.supprimer_de_prime_agent': {
    fr: 'Supprimer « {value1} » de Prime Agent ?',
    en: 'Remove “{value1}” from Prime Agent?',
  },
  'ui.a_ete_supprime': {
    fr: '{value1} a été supprimé.',
    en: '{value1} has been removed.',
  },
  'ui.impossible_de_supprimer_ce_modele': {
    fr: 'Impossible de supprimer ce modèle. {value1}',
    en: 'Unable to remove this model. {value1}',
  },
  'ui.prime_agent_introuvable_sur_cet_ordinateur': {
    fr: 'Prime Agent introuvable sur cet ordinateur',
    en: 'Prime Agent was not found on this computer',
  },
  'ui.prime_agent_sessions_natives_conservees': {
    fr: 'Prime Agent {value1} · sessions natives conservées',
    en: 'Prime Agent {value1} · native sessions preserved',
  },
  'ui.prime_agent_est_introuvable_installez_ou_configurez_le_cli_puis_r': {
    fr: 'Prime Agent est introuvable. Installez ou configurez le CLI puis relancez le Studio.',
    en: 'Prime Agent was not found. Install or configure the CLI, then restart the Studio.',
  },
  'ui.impossible_de_joindre_le_serveur': {
    fr: 'Impossible de joindre le serveur. {value1}',
    en: 'Unable to reach the server. {value1}',
  },
  'ui.le_serveur_local_est_indisponible_reconnexion_automatique': {
    fr: 'Le serveur local est indisponible. Reconnexion automatique…',
    en: 'The local server is unavailable. Reconnecting automatically…',
  },
  'ui.projet_ajoute_a_votre_espace_de_travail': {
    fr: 'Projet ajouté à votre espace de travail.',
    en: 'Project added to your workspace.',
  },
  'ui.desepingler': {
    fr: 'Désépingler',
    en: 'Unpin',
  },
  'ui.epingler': {
    fr: 'Épingler',
    en: 'Pin',
  },
  'ui.dossier_ouvert_sur_le_pc': {
    fr: 'Dossier ouvert sur le PC.',
    en: 'Folder opened on the PC.',
  },
  'ui.projet_retire_du_studio': {
    fr: 'Projet retiré du Studio.',
    en: 'Project removed from the Studio.',
  },
  'ui.la_deconnexion_a_echoue_reessayez': {
    fr: 'La déconnexion a échoué. Réessayez.',
    en: 'Sign out failed. Please try again.',
  },
  'ui.desarchiver': {
    fr: 'Désarchiver',
    en: 'Unarchive',
  },
  'ui.archiver': {
    fr: 'Archiver',
    en: 'Archive',
  },
  'ui.session_desepinglee': {
    fr: 'Session désépinglée.',
    en: 'Session unpinned.',
  },
  'ui.session_epinglee': {
    fr: 'Session épinglée.',
    en: 'Session pinned.',
  },
  'ui.session_restauree': {
    fr: 'Session restaurée.',
    en: 'Session restored.',
  },
  'ui.session_archivee': {
    fr: 'Session archivée.',
    en: 'Session archived.',
  },
  'ui.session_renommee': {
    fr: 'Session renommée.',
    en: 'Session renamed.',
  },
  'ui.copie': {
    fr: 'Copié',
    en: 'Copied',
  },
  'ui.le_navigateur_ne_permet_pas_la_copie_selectionnez_le_texte_manuel': {
    fr: 'Le navigateur ne permet pas la copie. Sélectionnez le texte manuellement.',
    en: 'Your browser does not allow copying. Select the text manually.',
  },
  'ui.conversation_prime_agent': {
    fr: 'Conversation Prime Agent',
    en: 'Prime Agent conversation',
  },
  'ui.parametres_2': {
    fr: 'Paramètres :\n\n{value1}',
    en: 'Parameters:\n\n{value1}',
  },
  'ui.resultat_3': {
    fr: 'Résultat :\n\n{value1}',
    en: 'Result:\n\n{value1}',
  },
  'ui.conversation_exportee_en_markdown': {
    fr: 'Conversation exportée en Markdown.',
    en: 'Conversation exported as Markdown.',
  },
  'ui.ce_raccourci_du_studio_s_utilise_sans_argument': {
    fr: 'Ce raccourci du Studio s’utilise sans argument.',
    en: 'This Studio shortcut does not accept arguments.',
  },
  'ui.le_modele_et_son_effort_se_choisissent_entre_deux_tours': {
    fr: 'Le modèle et son effort se choisissent entre deux tours.',
    en: 'The model and its reasoning effort can be changed between turns.',
  },
  'ui.ouvrez_d_abord_une_session': {
    fr: 'Ouvrez d’abord une session.',
    en: 'Open a session first.',
  },
  'ui.niveau_attendu_off_minimal_low_medium_high_xhigh_ou_max': {
    fr: 'Niveau attendu : off, minimal, low, medium, high, xhigh ou max.',
    en: 'Expected level: off, minimal, low, medium, high, xhigh or max.',
  },
  'ui.effort_de_raisonnement_modifie': {
    fr: 'Effort de raisonnement modifié.',
    en: 'Reasoning effort changed.',
  },
  'ui.aucune_reponse_a_copier': {
    fr: 'Aucune réponse à copier.',
    en: 'No response to copy.',
  },
  'ui.derniere_reponse_copiee': {
    fr: 'Dernière réponse copiée.',
    en: 'Latest response copied.',
  },
  'ui.chemin_du_projet_copie': {
    fr: 'Chemin du projet copié.',
    en: 'Project path copied.',
  },
  'ui.modele_principal_par_defaut_2': {
    fr: 'Modèle principal par défaut',
    en: 'Default main model',
  },
  'ui.laisser_prime_agent_choisir_le_modele_principal': {
    fr: 'Laisser Prime Agent choisir le modèle principal',
    en: 'Let Prime Agent choose the main model',
  },
  'ui.commandes_et_skills': {
    fr: 'Commandes et skills',
    en: 'Commands and skills',
  },
  'ui.parcourir_les_skills_de_prime_agent': {
    fr: 'Parcourir les skills de Prime Agent',
    en: 'Browse Prime Agent skills',
  },
  'ui.ouvrir_les_preferences': {
    fr: 'Ouvrir les préférences',
    en: 'Open preferences',
  },
  'ui.choisir_l_effort_de_raisonnement': {
    fr: 'Choisir l’effort de raisonnement',
    en: 'Choose reasoning effort',
  },
  'ui.gerer_les_connexions_mcp': {
    fr: 'Gérer les connexions MCP',
    en: 'Manage MCP connections',
  },
  'ui.nouvelle_session_dans_ce_projet': {
    fr: 'Nouvelle session dans ce projet',
    en: 'New session in this project',
  },
  'ui.renommer_cette_session': {
    fr: 'Renommer cette session',
    en: 'Rename this session',
  },
  'ui.afficher_les_informations_de_la_session': {
    fr: 'Afficher les informations de la session',
    en: 'Show session information',
  },
  'ui.afficher_le_contexte_de_la_session': {
    fr: 'Afficher le contexte de la session',
    en: 'Show session context',
  },
  'ui.copier_la_derniere_reponse_de_l_agent': {
    fr: 'Copier la dernière réponse de l’agent',
    en: 'Copy the agent’s latest response',
  },
  'ui.exporter_la_conversation_depuis_le_studio': {
    fr: 'Exporter la conversation depuis le Studio',
    en: 'Export the conversation from the Studio',
  },
  'ui.rechercher_une_session': {
    fr: 'Rechercher une session',
    en: 'Search sessions',
  },
  'ui.commandes_proposees': {
    fr: 'Commandes proposées',
    en: 'Suggested commands',
  },
  'ui.choisissez_un_raccourci_ajoutez_vos_consignes_puis_envoyez_les_sk': {
    fr: 'Choisissez un raccourci, ajoutez vos consignes puis envoyez. Les skills et prompts sont développés par Prime Agent.',
    en: 'Choose a shortcut, add your instructions, then send. Prime Agent expands skills and prompts.',
  },
  'ui.rechercher_un_nom_ou_une_description': {
    fr: 'Rechercher un nom ou une description',
    en: 'Search by name or description',
  },
  'ui.rechercher_une_commande_ou_un_skill': {
    fr: 'Rechercher une commande ou un skill',
    en: 'Search commands and skills',
  },
  'ui.afficher_la_suite': {
    fr: 'Afficher la suite',
    en: 'Show more',
  },
  'ui.actualiser': {
    fr: 'Actualiser',
    en: 'Refresh',
  },
  'ui.comment_utiliser_les_skills': {
    fr: 'Comment utiliser les skills ?',
    en: 'How do skills work?',
  },
  'ui.un_skill_regroupe_des_instructions_et_parfois_des_scripts_skill_n': {
    fr: 'Un skill regroupe des instructions et parfois des scripts. /skill:nom charge ses instructions dans votre message ; ajoutez votre demande après le nom. Prime Agent découvre les skills globaux, ceux du projet et ceux des packages installés. Les changements sont pris en compte par les nouvelles sessions ; une session active conserve ses ressources chargées. Les skills Python nécessitent leurs dépendances dans le Python du moteur.',
    en: 'A skill contains instructions and sometimes scripts. /skill:name loads its instructions into your message; add your request after the name. Prime Agent discovers global skills, project skills and skills from installed packages. Changes apply to new sessions; active sessions keep their loaded resources. Python skills require their dependencies in the engine’s Python environment.',
  },
  'ui.choisissez_un_projet_pour_voir_ses_commandes': {
    fr: 'Choisissez un projet pour voir ses commandes.',
    en: 'Choose a project to see its commands.',
  },
  'ui.le_projet_selectionne_a_change': {
    fr: 'Le projet sélectionné a changé.',
    en: 'The selected project has changed.',
  },
  'ui.chargement_des_skills_et_prompts': {
    fr: 'Chargement des skills et prompts…',
    en: 'Loading skills and prompts…',
  },
  'ui.ressources_chargees_dans_cette_session': {
    fr: 'Ressources chargées dans cette session.',
    en: 'Resources loaded in this session.',
  },
  'ui.ressources_du_projet_pour_les_nouvelles_sessions': {
    fr: 'Ressources du projet pour les nouvelles sessions.',
    en: 'Project resources for new sessions.',
  },
  'ui.invocation_explicite_uniquement': {
    fr: 'Invocation explicite uniquement',
    en: 'Explicit invocation only',
  },
  'ui.inclut_un_module_python': {
    fr: 'Inclut un module Python',
    en: 'Includes a Python module',
  },
  'ui.aucun_resultat_pour_ce_filtre': {
    fr: 'Aucun résultat pour ce filtre.',
    en: 'No results for this filter.',
  },
  'ui.afficher_la_suite_sur': {
    fr: 'Afficher la suite · {value1} sur {value2}',
    en: 'Show more · {value1} of {value2}',
  },
  'ui.aucune_commande_correspondante': {
    fr: 'Aucune commande correspondante.',
    en: 'No matching commands.',
  },
  'ui.reessayer': {
    fr: 'Réessayer',
    en: 'Try again',
  },
  'ui.commande_inconnue_ouvrez_le_menu_pour_voir_les_commandes_du_proje': {
    fr: 'Commande /{value1} inconnue. Ouvrez le menu / pour voir les commandes du projet.',
    en: 'Unknown command /{value1}. Open the / menu to see this project’s commands.',
  },
  'ui.retirez_les_pieces_jointes_avant_d_utiliser_ce_raccourci_du_studi': {
    fr: 'Retirez les pièces jointes avant d’utiliser ce raccourci du Studio.',
    en: 'Remove attachments before using this Studio shortcut.',
  },
  'ui.retirer_la_commande': {
    fr: 'Retirer la commande /{value1}',
    en: 'Remove command /{value1}',
  },
  'ui.activite_de_l_agent': {
    fr: 'Activité de l’agent',
    en: 'Agent activity',
  },
  'ui.preparation_2': {
    fr: 'Préparation…',
    en: 'Preparing…',
  },
  'ui.etape': {
    fr: 'Étape {value1}',
    en: 'Step {value1}',
  },
  'ui.l_agent_prepare_la_prochaine_etape': {
    fr: 'L’agent prépare la prochaine étape…',
    en: 'The agent is preparing the next step…',
  },
  'ui.apercu_du_fichier': {
    fr: 'Aperçu du fichier : {value1}',
    en: 'File preview: {value1}',
  },
  'ui.fichier_joint': {
    fr: 'Fichier joint',
    en: 'Attached file',
  },
  'ui.image_dans_la_session_native': {
    fr: 'Image dans la session native',
    en: 'Image in the native session',
  },
  'ui.image_jointe': {
    fr: 'Image jointe {value1}',
    en: 'Attached image {value1}',
  },
  'ui.fermer': {
    fr: 'Fermer',
    en: 'Close',
  },
  'ui.ajouter_une_photo': {
    fr: 'Ajouter une photo',
    en: 'Add a photo',
  },
  'ui.ajouter_une_piece_jointe': {
    fr: 'Ajouter une pièce jointe',
    en: 'Add an attachment',
  },
  'ui.pieces_jointes': {
    fr: 'Pièces jointes',
    en: 'Attachments',
  },
  'ui.stockage_des_pieces_jointes_indisponible': {
    fr: 'Stockage des pièces jointes indisponible.',
    en: 'Attachment storage unavailable.',
  },
  'ui.les_pieces_jointes_restent_dans_cet_onglet_leur_sauvegarde_locale': {
    fr: 'Les pièces jointes restent dans cet onglet ; leur sauvegarde locale est indisponible.',
    en: 'Attachments will remain in this tab; local saving is unavailable.',
  },
  'ui.impossible_de_sauvegarder_les_pieces_jointes_du_brouillon': {
    fr: 'Impossible de sauvegarder les pièces jointes du brouillon.',
    en: 'Unable to save draft attachments.',
  },
  'ui.impossible_de_relire_les_pieces_jointes_du_brouillon': {
    fr: 'Impossible de relire les pièces jointes du brouillon.',
    en: 'Unable to restore draft attachments.',
  },
  'ui.les_pieces_jointes_seront_disponibles_apres_la_mise_a_jour_du_ser': {
    fr: 'Les pièces jointes seront disponibles après la mise à jour du serveur.',
    en: 'Attachments will be available after the server update.',
  },
  'ui.brouillon_conserve_les_pieces_jointes_attendent_la_mise_a_jour_du': {
    fr: 'Brouillon conservé : les pièces jointes attendent la mise à jour du serveur.',
    en: 'Draft preserved: attachments are waiting for the server update.',
  },
  'ui.ce_modele_ne_prend_pas_en_charge_les_images_choisissez_un_modele': {
    fr: 'Ce modèle ne prend pas en charge les images. Choisissez un modèle compatible.',
    en: 'This model does not support images. Choose a compatible model.',
  },
  'ui.preparation_des_pieces_jointes': {
    fr: 'Préparation des pièces jointes…',
    en: 'Preparing attachments…',
  },
  'ui.8_pieces_jointes_images_4_mo_fichiers_10_mo': {
    fr: '{value1}/8 pièces jointes · images 4 Mo, fichiers 10 Mo',
    en: '{value1}/8 attachments · images 4 MB, files 10 MB',
  },
  'ui.choisissez_une_image_png_jpeg_gif_ou_webp_pour_les_autres_formats': {
    fr: '{value1} : choisissez une image PNG, JPEG, GIF ou WebP. Pour les autres formats, utilisez Pièce jointe.',
    en: '{value1}: choose a PNG, JPEG, GIF or WebP image. For other formats, use Attach file.',
  },
  'ui.limite_de_mo': {
    fr: '{value1} : limite de {value2} Mo.',
    en: '{value1}: {value2} MB limit.',
  },
  'ui.limite_8_pieces_jointes_dont_4_images_8_mo_d_images_et_20_mo_de_f': {
    fr: 'Limite : 8 pièces jointes, dont 4 images ; 8 Mo d’images et 20 Mo de fichiers.',
    en: 'Limit: 8 attachments, including up to 4 images; 8 MB of images and 20 MB of files.',
  },
  'ui.impossible_de_lire_ce_fichier': {
    fr: 'Impossible de lire ce fichier.',
    en: 'Unable to read this file.',
  },
  'ui.image_illisible': {
    fr: '{value1} : image illisible.',
    en: '{value1}: unreadable image.',
  },
  'ui.image_collee': {
    fr: 'Image collée',
    en: 'Pasted image',
  },
  'ui.travaille': {
    fr: 'Travaille',
    en: 'Working',
  },
  'ui.execute_un_outil': {
    fr: 'Exécute un outil',
    en: 'Running a tool',
  },
  'ui.attend_ses_sous_agents': {
    fr: 'Attend ses sous-agents',
    en: 'Waiting for subagents',
  },
  'ui.en_attente': {
    fr: 'En attente',
    en: 'Waiting',
  },
  'ui.dans_la_file': {
    fr: 'Dans la file',
    en: 'Queued',
  },
  'ui.resume_le_contexte': {
    fr: 'Résume le contexte',
    en: 'Summarizing context',
  },
  'ui.historique': {
    fr: 'Historique',
    en: 'History',
  },
  'ui.arrete': {
    fr: 'Arrêté',
    en: 'Stopped',
  },
  'ui.etat_inconnu': {
    fr: 'État inconnu',
    en: 'Unknown status',
  },
  'ui.vue_remplacee': {
    fr: 'Vue remplacée',
    en: 'View replaced',
  },
  'ui.consommation_de_la_session': {
    fr: 'CONSOMMATION DE LA SESSION',
    en: 'SESSION USAGE',
  },
  'ui.tokens_entrants': {
    fr: 'Tokens entrants',
    en: 'Input tokens',
  },
  'ui.tokens_sortants': {
    fr: 'Tokens sortants',
    en: 'Output tokens',
  },
  'ui.tokens_en_cache': {
    fr: 'Tokens en cache',
    en: 'Cached tokens',
  },
  'ui.cout_estime': {
    fr: 'Coût estimé',
    en: 'Estimated cost',
  },
  'ui.donnees_du_moteur_pour_cet_agent_le_cout_indique_ne_represente_pa': {
    fr: 'Données du moteur pour cet agent. Le coût indiqué ne représente pas la facturation de votre abonnement.',
    en: 'Engine data for this agent. The displayed cost does not represent your subscription billing.',
  },
  'ui.ouvrez_une_session_pour_retrouver_son_agent_et_ses_delegations': {
    fr: 'Ouvrez une session pour retrouver son agent et ses délégations.',
    en: 'Open a session to see its agent and delegations.',
  },
  'ui.en_activite': {
    fr: ' · {value1} en activité',
    en: ' · {value1} active',
  },
  'ui.suivi_en_direct': {
    fr: 'Suivi en direct',
    en: 'Live updates',
  },
  'ui.delegations_conservees_par_prime_agent': {
    fr: 'Délégations conservées par Prime Agent.',
    en: 'Delegations saved by Prime Agent.',
  },
  'ui.agent_principal': {
    fr: 'Agent principal',
    en: 'Main agent',
  },
  'ui.reflexion_2': {
    fr: 'Réflexion · {value1}',
    en: 'Reasoning · {value1}',
  },
  'ui.voir_les_details': {
    fr: '{value1} · {value2} · Voir les détails',
    en: '{value1} · {value2} · View details',
  },
  'ui.aucun_sous_agent_enregistre_pour_cette_session': {
    fr: 'Aucun sous-agent enregistré pour cette session.',
    en: 'No subagents saved for this session.',
  },
  'ui.les_200_premiers_sous_agents_sont_affiches': {
    fr: 'Les 200 premiers sous-agents sont affichés.',
    en: 'Showing the first 200 subagents.',
  },
  'ui.chargement_des_agents': {
    fr: 'Chargement des agents…',
    en: 'Loading agents…',
  },
  'ui.contient_des_modifications_indexees': {
    fr: 'Contient des modifications indexées',
    en: 'Contains staged changes',
  },
  'ui.non_indexe': {
    fr: 'Non indexé',
    en: 'Unstaged',
  },
  'ui.aucune_modification_dans_ce_projet': {
    fr: 'Aucune modification dans ce projet.',
    en: 'No changes in this project.',
  },
  'ui.utilisez_parcourir_pour_consulter_ses_fichiers': {
    fr: 'Utilisez « Parcourir » pour consulter ses fichiers.',
    en: 'Use Browse to view its files.',
  },
  'ui.les_1_000_premieres_modifications_sont_affichees': {
    fr: 'Les 1 000 premières modifications sont affichées.',
    en: 'Showing the first 1,000 changes.',
  },
  'ui.lecture_seule_dossiers_techniques_masques': {
    fr: 'Lecture seule · dossiers techniques masqués',
    en: 'Read only · technical folders hidden',
  },
  'ui.projet': {
    fr: 'Projet',
    en: 'Project',
  },
  'ui.ouvrir_le_dossier': {
    fr: 'Ouvrir le dossier',
    en: 'Open folder',
  },
  'ui.ce_dossier_est_vide': {
    fr: 'Ce dossier est vide.',
    en: 'This folder is empty.',
  },
  'ui.chargement_des_fichiers': {
    fr: 'Chargement des fichiers…',
    en: 'Loading files…',
  },
  'ui.reessayez_avec_le_bouton_actualiser': {
    fr: 'Réessayez avec le bouton Actualiser.',
    en: 'Try again using the Refresh button.',
  },
  'ui.presentation_du_fichier': {
    fr: 'Présentation du fichier',
    en: 'File presentation',
  },
  'ui.source_du_fichier': {
    fr: 'Source du fichier',
    en: 'File source',
  },
  'ui.contenu_du_fichier': {
    fr: 'Contenu du fichier',
    en: 'File content',
  },
  'ui.apercu': {
    fr: 'Aperçu',
    en: 'Preview',
  },
  'ui.source': {
    fr: 'Source',
    en: 'Source',
  },
  'ui.modifications': {
    fr: 'Modifications',
    en: 'Changes',
  },
  'ui.ouvrir_sur_le_pc': {
    fr: 'Ouvrir sur le PC',
    en: 'Open on PC',
  },
  'ui.ouvrir': {
    fr: 'Ouvrir',
    en: 'Open',
  },
  'ui.ouvrir_dans_l_application_du_pc': {
    fr: 'Ouvrir dans l’application du PC',
    en: 'Open in the PC application',
  },
  'ui.ouverture_sur_le_pc': {
    fr: 'Ouverture sur le PC…',
    en: 'Opening on the PC…',
  },
  'ui.ouverture_demandee_sur_le_pc': {
    fr: 'Ouverture demandée sur le PC.',
    en: 'Opening requested on the PC.',
  },
  'ui.etat_actuel_compare_au_dernier_commit_head_index_et_fichiers_de_t': {
    fr: 'État actuel comparé au dernier commit (HEAD), index et fichiers de travail compris.',
    en: 'Current state compared with the latest commit (HEAD), including staged and working files.',
  },
  'ui.fichier_vide': {
    fr: 'Fichier vide.',
    en: 'Empty file.',
  },
  'ui.plusieurs_documents_portent_ce_nom_choisissez_le_fichier_a_consul': {
    fr: 'Plusieurs documents portent ce nom. Choisissez le fichier à consulter.',
    en: 'Several documents have this name. Choose the file to view.',
  },
  'ui.la_conversation_sera_disponible_des_son_enregistrement_par_prime': {
    fr: 'La conversation sera disponible dès son enregistrement par Prime Agent.',
    en: 'The conversation will be available once Prime Agent saves it.',
  },
  'ui.les_150_derniers_messages_sont_affiches': {
    fr: 'Les 150 derniers messages sont affichés.',
    en: 'Showing the last 150 messages.',
  },
  'ui.agent': {
    fr: 'Agent',
    en: 'Agent',
  },
  'ui.appel_enregistre': {
    fr: 'Appel enregistré',
    en: 'Recorded call',
  },
  'ui.aucun_message_enregistre_pour_le_moment': {
    fr: 'Aucun message enregistré pour le moment.',
    en: 'No messages saved yet.',
  },
  'ui.delegations_de_la_session': {
    fr: 'Délégations de la session',
    en: 'Session delegations',
  },
  'ui.prochaines_delegations': {
    fr: 'Prochaines délégations',
    en: 'Next delegations',
  },
  'ui.les_agents_apparaitront_apres_le_premier_message': {
    fr: 'Les agents apparaîtront après le premier message.',
    en: 'Agents will appear after the first message.',
  },
  'ui.choisissez_un_projet_pour_preparer_ses_sous_agents': {
    fr: 'Choisissez un projet pour préparer ses sous-agents.',
    en: 'Choose a project to configure its subagents.',
  },
  'ui.choisissez_un_projet_pour_parcourir_ses_fichiers': {
    fr: 'Choisissez un projet pour parcourir ses fichiers.',
    en: 'Choose a project to browse its files.',
  },
  'ui.reorienter': {
    fr: 'Réorienter',
    en: 'Steer',
  },
  'ui.a_la_suite': {
    fr: 'À la suite',
    en: 'Follow up',
  },
  'ui.le_formulaire_de_conversation_est_introuvable': {
    fr: 'Le formulaire de conversation est introuvable.',
    en: 'The conversation form could not be found.',
  },
  'ui.ce_message': {
    fr: 'Ce message',
    en: 'This message',
  },
  'ui.envoyer_pendant_l_execution': {
    fr: 'Envoyer pendant l’exécution',
    en: 'Send during a run',
  },
  'ui.transmettre_une_nouvelle_consigne_a_l_agent_en_cours': {
    fr: 'Transmettre une nouvelle consigne à l’agent en cours',
    en: 'Send new instructions to the running agent',
  },
  'ui.ajouter_un_message_apres_la_reponse_en_cours': {
    fr: 'Ajouter un message après la réponse en cours',
    en: 'Add a message after the current response',
  },
  'ui.messages_en_attente': {
    fr: 'Messages en attente',
    en: 'Queued messages',
  },
  'ui.modifier_le_message_en_attente': {
    fr: 'Modifier le message en attente',
    en: 'Edit queued message',
  },
  'ui.quand_transmettre_le_message_modifie': {
    fr: 'Quand transmettre le message modifié',
    en: 'When to send the edited message',
  },
  'ui.annuler': {
    fr: 'Annuler',
    en: 'Cancel',
  },
  'ui.enregistrer': {
    fr: 'Enregistrer',
    en: 'Save',
  },
  'ui.la_file_a_change_votre_modification_reste_ici_ce_message_ne_peut': {
    fr: 'La file a changé. Votre modification reste ici ; ce message ne peut plus être remplacé à cette position.',
    en: 'The queue has changed. Your edit is kept here; this message can no longer be replaced at this position.',
  },
  'ui.fichier_s_joint_s_conserve_s': {
    fr: 'Fichier(s) joint(s) conservé(s)',
    en: 'Attachment(s) preserved',
  },
  'ui.modifier_le_message': {
    fr: 'Modifier le message',
    en: 'Edit message',
  },
  'ui.passer_a_la_suite': {
    fr: 'Passer à la suite',
    en: 'Move to follow-up',
  },
  'ui.reorienter_avec_ce_message': {
    fr: 'Réorienter avec ce message',
    en: 'Steer with this message',
  },
  'ui.monter_le_message': {
    fr: 'Monter le message',
    en: 'Move message up',
  },
  'ui.descendre_le_message': {
    fr: 'Descendre le message',
    en: 'Move message down',
  },
  'ui.retirer_le_message': {
    fr: 'Retirer le message',
    en: 'Remove message',
  },
  'ui.l_envoi_pendant_l_execution_n_est_pas_disponible_pour_cette_sessi': {
    fr: 'L’envoi pendant l’exécution n’est pas disponible pour cette session.',
    en: 'Sending during a run is not available for this session.',
  },
  'ui.connexion_a_la_file_de_messages_interrompue_nouvelle_tentative_en': {
    fr: 'Connexion à la file de messages interrompue. Nouvelle tentative en cours…',
    en: 'Connection to the message queue interrupted. Retrying…',
  },
  'ui.le_message_n_a_pas_pu_etre_modifie': {
    fr: 'Le message n’a pas pu être modifié.',
    en: 'The message could not be updated.',
  },
  'ui.reorienter_l_agent': {
    fr: 'Réorienter l’agent',
    en: 'Steer the agent',
  },
  'ui.envoyer_a_la_suite': {
    fr: 'Envoyer à la suite',
    en: 'Send follow-up',
  },
  'ui.envoyer_le_message': {
    fr: 'Envoyer le message',
    en: 'Send message',
  },
  'ui.connexion_a_la_session': {
    fr: 'Connexion à la session…',
    en: 'Connecting to the session…',
  },
  'ui.preparation_de_la_session': {
    fr: 'Préparation de la session…',
    en: 'Preparing the session…',
  },
  'ui.configuration_a_corriger': {
    fr: 'Configuration à corriger',
    en: 'Configuration needs fixing',
  },
  'ui.configure': {
    fr: 'Configuré',
    en: 'Configured',
  },
  'ui.desactive': {
    fr: 'Désactivé',
    en: 'Disabled',
  },
  'ui.variable_manquante': {
    fr: 'Variable manquante',
    en: 'Missing variable',
  },
  'ui.connexion_requise': {
    fr: 'Connexion requise',
    en: 'Sign-in required',
  },
  'ui.nom_natif_reserve': {
    fr: 'Nom natif réservé',
    en: 'Reserved native name',
  },
  'ui.outils_et_services': {
    fr: 'OUTILS ET SERVICES',
    en: 'TOOLS AND SERVICES',
  },
  'ui.connexions_mcp': {
    fr: 'Connexions MCP',
    en: 'MCP connections',
  },
  'ui.reliez_prime_agent_a_vos_services_et_a_vos_outils_locaux_la_confi': {
    fr: 'Reliez Prime Agent à vos services et à vos outils locaux. La configuration est partagée par les projets sur ce PC.',
    en: 'Connect Prime Agent to your services and local tools. Projects on this PC share the configuration.',
  },
  'ui.rechercher_un_mcp': {
    fr: 'Rechercher un MCP',
    en: 'Search MCP connections',
  },
  'ui.ajouter_un_mcp': {
    fr: 'Ajouter un MCP',
    en: 'Add an MCP',
  },
  'ui.retour': {
    fr: 'Retour',
    en: 'Back',
  },
  'ui.nom_du_serveur': {
    fr: 'Nom du serveur',
    en: 'Server name',
  },
  'ui.http_service_distant': {
    fr: 'HTTP · service distant',
    en: 'HTTP · remote service',
  },
  'ui.stdio_processus_sur_le_pc': {
    fr: 'stdio · processus sur le PC',
    en: 'stdio · process on the PC',
  },
  'ui.adresse_du_serveur': {
    fr: 'Adresse du serveur',
    en: 'Server address',
  },
  'ui.aucune': {
    fr: 'Aucune',
    en: 'None',
  },
  'ui.jeton_par_variable_d_environnement': {
    fr: 'Jeton par variable d’environnement',
    en: 'Token from an environment variable',
  },
  'ui.connexion_oauth': {
    fr: 'Connexion OAuth',
    en: 'OAuth sign-in',
  },
  'ui.variable_contenant_le_jeton': {
    fr: 'Variable contenant le jeton',
    en: 'Variable containing the token',
  },
  'ui.executable_sur_le_pc': {
    fr: 'Exécutable sur le PC',
    en: 'Executable on the PC',
  },
  'ui.arguments_un_argument_par_ligne': {
    fr: 'Arguments · un argument par ligne',
    en: 'Arguments · one per line',
  },
  'ui.dossier_de_travail_facultatif': {
    fr: 'Dossier de travail · facultatif',
    en: 'Working folder · optional',
  },
  'ui.options_avancees': {
    fr: 'Options avancées',
    en: 'Advanced options',
  },
  'ui.delai_de_demarrage_ms': {
    fr: 'Délai de démarrage · ms',
    en: 'Startup timeout · ms',
  },
  'ui.delai_par_appel_ms': {
    fr: 'Délai par appel · ms',
    en: 'Timeout per call · ms',
  },
  'ui.acces_aux_outils': {
    fr: 'Accès aux outils',
    en: 'Tool access',
  },
  'ui.tous_sauf_les_outils_interdits': {
    fr: 'Tous sauf les outils interdits',
    en: 'All except blocked tools',
  },
  'ui.seulement_la_liste_autorisee': {
    fr: 'Seulement la liste autorisée',
    en: 'Allowlist only',
  },
  'ui.une_liste_vide_n_autorise_aucun_outil': {
    fr: 'Une liste vide n’autorise aucun outil.',
    en: 'An empty list allows no tools.',
  },
  'ui.outils_interdits_un_par_ligne': {
    fr: 'Outils interdits · un par ligne',
    en: 'Blocked tools · one per line',
  },
  'ui.en_tetes_http_objet_json': {
    fr: 'En-têtes HTTP · objet JSON',
    en: 'HTTP headers · JSON object',
  },
  'ui.une_valeur_null_conserve_l_en_tete_prive_existant_les_valeurs_enr': {
    fr: 'Une valeur null conserve l’en-tête privé existant. Les valeurs enregistrées ne sont pas renvoyées au navigateur.',
    en: 'A null value preserves the existing private header. Saved values are not sent back to the browser.',
  },
  'ui.les_parametres_prives_de_l_adresse_sont_conserves_tant_que_vous_n': {
    fr: 'Les paramètres privés de l’adresse sont conservés tant que vous ne changez pas celle-ci.',
    en: 'Private address parameters are preserved until you change the address.',
  },
  'ui.enregistrer_prepare_la_connexion_tester_demarre_une_connexion_sep': {
    fr: 'Enregistrer prépare la connexion. « Tester » démarre une connexion séparée pour découvrir ses outils ; aucun outil métier n’est exécuté.',
    en: 'Save prepares the connection. Test starts a separate connection to discover tools; it does not run any business tools.',
  },
  'ui.test_de_connexion': {
    fr: 'Test de connexion',
    en: 'Connection test',
  },
  'ui.autoriser_dans_le_navigateur': {
    fr: 'Autoriser dans le navigateur',
    en: 'Authorize in the browser',
  },
  'ui.sur_mobile_apres_autorisation_le_navigateur_peut_afficher_une_adr': {
    fr: 'Sur mobile, après autorisation, le navigateur peut afficher une adresse localhost inaccessible. Copiez cette adresse complète et collez-la ici. Sur le PC, le retour est automatique.',
    en: 'After authorization on mobile, the browser may display an inaccessible localhost address. Copy that entire address and paste it here. On the PC, the return is automatic.',
  },
  'ui.adresse_complete_de_retour': {
    fr: 'Adresse complète de retour',
    en: 'Full return address',
  },
  'ui.valider_le_retour': {
    fr: 'Valider le retour',
    en: 'Confirm return',
  },
  'ui.supprimer_cette_connexion': {
    fr: 'Supprimer cette connexion ?',
    en: 'Delete this connection?',
  },
  'ui.la_configuration_de_ce_serveur_et_ses_identifiants_mcp_enregistre': {
    fr: 'La configuration de ce serveur et ses identifiants MCP enregistrés seront retirés. Les autres connexions et les comptes de modèles sont conservés.',
    en: 'This server’s configuration and saved MCP credentials will be removed. Other connections and model accounts are preserved.',
  },
  'ui.les_nouveaux_reglages_s_appliquent_aux_nouvelles_sessions_les_ses': {
    fr: 'Les nouveaux réglages s’appliquent aux nouvelles sessions. Les sessions déjà en cours continuent avec leurs connexions actuelles.',
    en: 'New settings apply to new sessions. Running sessions continue with their current connections.',
  },
  'ui.fermer_les_connexions_mcp': {
    fr: 'Fermer les connexions MCP',
    en: 'Close MCP connections',
  },
  'ui.rechercher_une_connexion': {
    fr: 'Rechercher une connexion…',
    en: 'Search connections…',
  },
  'ui.outils_autorises_un_par_ligne': {
    fr: 'Outils autorisés, un par ligne',
    en: 'Allowed tools, one per line',
  },
  'ui.un_outil_par_ligne': {
    fr: 'Un outil par ligne',
    en: 'One tool per line',
  },
  'ui.integration_native_oauth': {
    fr: 'Intégration native · OAuth',
    en: 'Native integration · OAuth',
  },
  'ui.processus_local_stdio': {
    fr: 'Processus local · stdio',
    en: 'Local process · stdio',
  },
  'ui.service_distant_http': {
    fr: 'Service distant · HTTP',
    en: 'Remote service · HTTP',
  },
  'ui.authentifie': {
    fr: 'Authentifié',
    en: 'Authenticated',
  },
  'ui.configuration_invalide': {
    fr: 'Configuration invalide',
    en: 'Invalid configuration',
  },
  'ui.a_definir_sur_le_pc': {
    fr: 'À définir sur le PC : ',
    en: 'Set on the PC: ',
  },
  'ui.tester': {
    fr: 'Tester',
    en: 'Test',
  },
  'ui.reconnecter': {
    fr: 'Reconnecter',
    en: 'Reconnect',
  },
  'ui.connecter': {
    fr: 'Connecter',
    en: 'Connect',
  },
  'ui.deconnecter': {
    fr: 'Déconnecter',
    en: 'Disconnect',
  },
  'ui.activer': {
    fr: 'Activer',
    en: 'Enable',
  },
  'ui.desactiver': {
    fr: 'Désactiver',
    en: 'Disable',
  },
  'ui.aucune_connexion_ne_correspond_a_votre_recherche': {
    fr: 'Aucune connexion ne correspond à votre recherche.',
    en: 'No connections match your search.',
  },
  'ui.ajoutez_votre_premiere_connexion_mcp': {
    fr: 'Ajoutez votre première connexion MCP.',
    en: 'Add your first MCP connection.',
  },
  'ui.les_en_tetes_doivent_etre_un_objet_json_valide': {
    fr: 'Les en-têtes doivent être un objet JSON valide.',
    en: 'Headers must be a valid JSON object.',
  },
  'ui.chaque_variable_utilise_nom_enfant_nom_variable_du_pc': {
    fr: 'Chaque variable utilise NOM_ENFANT=NOM_VARIABLE_DU_PC.',
    en: 'Each variable uses CHILD_NAME=PC_VARIABLE_NAME.',
  },
  'ui.une_variable_est_declaree_plusieurs_fois': {
    fr: 'Une variable est déclarée plusieurs fois.',
    en: 'A variable is declared more than once.',
  },
  'ui.configuration_mcp_enregistree': {
    fr: 'Configuration MCP enregistrée.',
    en: 'MCP configuration saved.',
  },
  'ui.connexion_et_decouverte_des_outils': {
    fr: 'Connexion et découverte des outils…',
    en: 'Connecting and discovering tools…',
  },
  'ui.aucune_description': {
    fr: 'Aucune description',
    en: 'No description',
  },
  'ui.preparation_de_la_connexion': {
    fr: 'Préparation de la connexion…',
    en: 'Preparing sign-in…',
  },
  'ui.autorisez_prime_agent_dans_le_navigateur': {
    fr: 'Autorisez Prime Agent dans le navigateur.',
    en: 'Authorize Prime Agent in the browser.',
  },
  'ui.connexion_mcp_autorisee': {
    fr: 'Connexion MCP autorisée.',
    en: 'MCP connection authorized.',
  },
  'ui.connexion_annulee': {
    fr: 'Connexion annulée.',
    en: 'Sign-in cancelled.',
  },
  'ui.la_connexion_n_a_pas_abouti': {
    fr: 'La connexion n’a pas abouti.',
    en: 'Sign-in did not complete.',
  },
  'ui.chargement_des_connexions': {
    fr: 'Chargement des connexions…',
    en: 'Loading connections…',
  },
  'ui.enregistre_sur_ce_pc': {
    fr: 'Enregistré sur ce PC',
    en: 'Saved on this PC',
  },
  'ui.configuration_prime_cli': {
    fr: 'Configuration Prime CLI',
    en: 'Prime CLI configuration',
  },
  'ui.configuration_des_modeles': {
    fr: 'Configuration des modèles',
    en: 'Model configuration',
  },
  'ui.gestionnaire_de_secrets': {
    fr: 'Gestionnaire de secrets',
    en: 'Secret manager',
  },
  'ui.configuration_externe': {
    fr: 'Configuration externe',
    en: 'External configuration',
  },
  'ui.a_reconnecter': {
    fr: 'À reconnecter',
    en: 'Reconnect required',
  },
  'ui.session_actuelle': {
    fr: 'Session actuelle',
    en: 'Current session',
  },
  'ui.comptes_et_cles_api_ce_pc': {
    fr: 'COMPTES ET CLÉS API · CE PC',
    en: 'ACCOUNTS AND API KEYS · THIS PC',
  },
  'ui.fournisseurs': {
    fr: 'Fournisseurs',
    en: 'Providers',
  },
  'ui.connexions_partagees_avec_prime_agent_sur_ce_pc': {
    fr: 'Connexions partagées avec Prime Agent sur ce PC.',
    en: 'Connections shared with Prime Agent on this PC.',
  },
  'ui.fermer_les_fournisseurs': {
    fr: 'Fermer les fournisseurs',
    en: 'Close providers',
  },
  'ui.connexion_enregistree_le_catalogue_sera_actualise_a_la_prochaine': {
    fr: 'Connexion enregistrée. Le catalogue sera actualisé à la prochaine ouverture.',
    en: 'Connection saved. The catalog will refresh the next time you open it.',
  },
  'ui.chargement_des_fournisseurs': {
    fr: 'Chargement des fournisseurs…',
    en: 'Loading providers…',
  },
  'ui.connectez_un_compte_ou_ajoutez_une_cle_api_pour_retrouver_ses_mod': {
    fr: 'Connectez un compte ou ajoutez une clé API pour retrouver ses modèles dans le Studio. Les clés enregistrées ne sont jamais réaffichées.',
    en: 'Connect an account or add an API key to access its models in the Studio. Saved keys are never displayed again.',
  },
  'ui.des_agents_travaillent_vous_pouvez_ajouter_un_fournisseur_le_remp': {
    fr: 'Des agents travaillent. Vous pouvez ajouter un fournisseur ; le remplacement et la déconnexion seront disponibles à la fin des exécutions.',
    en: 'Agents are working. You can add a provider; replacing or disconnecting one will be available when the runs finish.',
  },
  'ui.rechercher_un_fournisseur': {
    fr: 'Rechercher un fournisseur…',
    en: 'Search providers…',
  },
  'ui.rechercher_un_fournisseur_2': {
    fr: 'Rechercher un fournisseur',
    en: 'Search providers',
  },
  'ui.fournisseurs_disponibles': {
    fr: 'Fournisseurs disponibles',
    en: 'Available providers',
  },
  'ui.aucun_fournisseur_trouve_les_fournisseurs_personnalises_se_creent': {
    fr: 'Aucun fournisseur trouvé. Les fournisseurs personnalisés se créent dans le configurateur de modèles.',
    en: 'No providers found. Create custom providers in the model configurator.',
  },
  'ui.modeles': {
    fr: '{value1} · {value2} modèles{value3}',
    en: '{value1} · {value2} models{value3}',
  },
  'ui.non_configure': {
    fr: 'Non configuré',
    en: 'Not configured',
  },
  'ui.reconnecter_le_compte': {
    fr: 'Reconnecter le compte',
    en: 'Reconnect account',
  },
  'ui.connecter_un_compte': {
    fr: 'Connecter un compte',
    en: 'Connect an account',
  },
  'ui.remplacer_la_cle': {
    fr: 'Remplacer la clé',
    en: 'Replace key',
  },
  'ui.ajouter_une_cle_api': {
    fr: 'Ajouter une clé API',
    en: 'Add an API key',
  },
  'ui.disponible_a_la_fin_des_executions': {
    fr: 'Disponible à la fin des exécutions.',
    en: 'Available when the runs finish.',
  },
  'ui.les_reglages_externes_restent_geres_a_leur_emplacement_d_origine': {
    fr: 'Les réglages externes restent gérés à leur emplacement d’origine.',
    en: 'External settings remain managed at their original location.',
  },
  'ui.cle_api': {
    fr: 'Clé API',
    en: 'API key',
  },
  'ui.la_cle_est_conservee_dans_le_stockage_natif_de_prime_agent_sur_ce': {
    fr: 'La clé est conservée dans le stockage natif de Prime Agent sur ce PC. Elle n’est pas enregistrée dans le navigateur.',
    en: 'The key is kept in Prime Agent’s native storage on this PC. It is not saved in the browser.',
  },
  'ui.nom_de_la_variable': {
    fr: 'Nom de la variable',
    en: 'Variable name',
  },
  'ui.mode_de_connexion': {
    fr: 'Mode de connexion',
    en: 'Sign-in method',
  },
  'ui.cette_action_remplace_la_connexion_actuelle_de_ce_fournisseur_att': {
    fr: 'Cette action remplace la connexion actuelle de ce fournisseur. Attendez aussi la fin des agents lancés hors du Studio.',
    en: 'This replaces the current connection for this provider. Also wait for agents launched outside the Studio to finish.',
  },
  'ui.connexion_enregistree': {
    fr: 'Connexion enregistrée.',
    en: 'Connection saved.',
  },
  'ui.deconnecter_2': {
    fr: 'Déconnecter {value1} ?',
    en: 'Disconnect {value1}?',
  },
  'ui.les_identifiants_enregistres_pour_ce_fournisseur_seront_retires_d': {
    fr: 'Les identifiants enregistrés pour ce fournisseur seront retirés du PC. Les conversations sont conservées. Les variables d’environnement et la configuration Prime CLI ou des modèles restent en place et peuvent continuer à fournir une connexion.',
    en: 'Saved credentials for this provider will be removed from the PC. Conversations are preserved. Environment variables and Prime CLI or model configuration remain in place and may still provide a connection.',
  },
  'ui.cette_connexion_est_partagee_avec_les_agents_lances_hors_du_studi': {
    fr: 'Cette connexion est partagée avec les agents lancés hors du Studio. Attendez la fin de leur travail avant de la retirer.',
    en: 'Agents launched outside the Studio share this connection. Wait for them to finish before removing it.',
  },
  'ui.confirmer_la_deconnexion': {
    fr: 'Confirmer la déconnexion',
    en: 'Confirm disconnection',
  },
  'ui.identifiants_enregistres_retires': {
    fr: 'Identifiants enregistrés retirés.',
    en: 'Saved credentials removed.',
  },
  'ui.remplacer_la_connexion_de_attendez_aussi_la_fin_des_agents_lances': {
    fr: 'Remplacer la connexion de {value1} ? Attendez aussi la fin des agents lancés hors du Studio.',
    en: 'Replace the connection for {value1}? Also wait for agents launched outside the Studio to finish.',
  },
  'ui.connexion_au_fournisseur': {
    fr: 'Connexion au fournisseur',
    en: 'Provider sign-in',
  },
  'ui.autorisez_la_connexion_sur_le_site_du_fournisseur_revenez_ensuite': {
    fr: 'Autorisez la connexion sur le site du fournisseur. Revenez ensuite dans cette fenêtre pour terminer.',
    en: 'Authorize the connection on the provider’s website. Then return to this window to finish.',
  },
  'ui.ouvrir_la_page_de_connexion': {
    fr: 'Ouvrir la page de connexion',
    en: 'Open sign-in page',
  },
  'ui.annuler_la_connexion': {
    fr: 'Annuler la connexion',
    en: 'Cancel sign-in',
  },
  'ui.en_attente_de_votre_autorisation': {
    fr: 'En attente de votre autorisation…',
    en: 'Waiting for your authorization…',
  },
  'ui.enregistrement_de_la_connexion': {
    fr: 'Enregistrement de la connexion…',
    en: 'Saving connection…',
  },
  'ui.valider': {
    fr: 'Valider',
    en: 'Confirm',
  },
  'ui.compte_connecte_a_prime_agent': {
    fr: 'Compte connecté à Prime Agent.',
    en: 'Account connected to Prime Agent.',
  },
  'ui.installer_prime_agent_studio': {
    fr: 'Installer Prime Agent Studio',
    en: 'Install Prime Agent Studio',
  },
  'ui.sur_le_telephone_ouvrez_l_adresse_https_du_studio_avec_tailscale': {
    fr: 'Sur le téléphone, ouvrez l’adresse HTTPS du Studio avec Tailscale connecté. L’adresse HTTP du réseau local ne permet pas l’installation complète.',
    en: 'On your phone, open the Studio’s HTTPS address with Tailscale connected. The local network HTTP address does not support full installation.',
  },
  'ui.ouvrez_cette_page_dans_safari_puis_utilisez_partager_sur_l_ecran': {
    fr: 'Ouvrez cette page dans Safari, puis utilisez Partager → Sur l’écran d’accueil. Activez « Ouvrir comme app web » si cette option est proposée.',
    en: 'Open this page in Safari, then use Share → Add to Home Screen. Enable “Open as Web App” if offered.',
  },
  'ui.dans_le_menu_de_votre_navigateur_choisissez_installer_l_applicati': {
    fr: 'Dans le menu de votre navigateur, choisissez « Installer l’application » ou « Ajouter à l’écran d’accueil ». Si cette option manque, utilisez Chrome ou Edge et rechargez la page.',
    en: 'In your browser menu, choose “Install app” or “Add to Home screen”. If this option is missing, use Chrome or Edge and reload the page.',
  },
  'ui.le_pc_doit_rester_allume_fermer_l_application_laisse_les_agents_t': {
    fr: 'Le PC doit rester allumé. Fermer l’application laisse les agents travailler.',
    en: 'The PC must stay on. Closing the app leaves agents working.',
  },
  'ui.compris': {
    fr: 'Compris',
    en: 'Got it',
  },
  'ui.desactivee': {
    fr: 'Désactivée',
    en: 'Off',
  },
  'ui.minimale': {
    fr: 'Minimale',
    en: 'Minimal',
  },
  'ui.faible': {
    fr: 'Faible',
    en: 'Low',
  },
  'ui.moyenne': {
    fr: 'Moyenne',
    en: 'Medium',
  },
  'ui.elevee': {
    fr: 'Élevée',
    en: 'High',
  },
  'ui.tres_elevee': {
    fr: 'Très élevée',
    en: 'Very high',
  },
  'ui.maximum': {
    fr: 'Maximum',
    en: 'Maximum',
  },
  'ui.non_renseignee': {
    fr: 'Non renseignée',
    en: 'Not specified',
  },
  'ui.changer_le_code': {
    fr: 'Changer le code',
    en: 'Change code',
  },
  'ui.chargement_de_l_acces_mobile': {
    fr: 'Chargement de l’accès mobile…',
    en: 'Loading mobile access…',
  },
  'ui.un_meme_code_pour_le_wi_fi_tailscale_et_la_pwa': {
    fr: 'Un même code pour le Wi-Fi, Tailscale et la PWA.',
    en: 'One code for Wi-Fi, Tailscale and the PWA.',
  },
  'ui.l_acces_mobile_n_est_pas_encore_configure_sur_ce_pc': {
    fr: 'L’accès mobile n’est pas encore configuré sur ce PC.',
    en: 'Mobile access is not configured on this PC yet.',
  },
  'ui.code_d_acces_indisponible': {
    fr: 'Code d’accès indisponible.',
    en: 'Access code unavailable.',
  },
  'ui.cette_option_necessite_un_redemarrage_du_studio_apres_la_fin_des': {
    fr: 'Cette option nécessite un redémarrage du Studio, après la fin des sessions actives.',
    en: 'This option requires restarting the Studio after active sessions finish.',
  },
  'ui.les_deux_codes_ne_correspondent_pas': {
    fr: 'Les deux codes ne correspondent pas.',
    en: 'The two codes do not match.',
  },
  'ui.code_modifie_reconnectez_vos_appareils_avec_le_nouveau_code': {
    fr: 'Code modifié. Reconnectez vos appareils avec le nouveau code.',
    en: 'Code changed. Reconnect your devices using the new code.',
  },
  'ui.modele': {
    fr: 'Modèle',
    en: 'Model',
  },
  'ui.reflexion_3': {
    fr: 'Réflexion',
    en: 'Reasoning',
  },
  'ui.recharger_les_reglages': {
    fr: 'Recharger les réglages',
    en: 'Reload settings',
  },
  'ui.sous_agents_du_projet': {
    fr: 'Sous-agents du projet',
    en: 'Project subagents',
  },
  'ui.ce_projet': {
    fr: 'Ce projet',
    en: 'This project',
  },
  'ui.reglages_des_sous_agents_du_projet': {
    fr: 'Réglages des sous-agents du projet',
    en: 'Project subagent settings',
  },
  'ui.valeurs_par_defaut_pour_tous_les_projets_les_reglages_propres_a_u': {
    fr: 'Valeurs par défaut pour tous les projets. Les réglages propres à un projet se trouvent dans l’onglet Agents d’une session. Les choix explicites restent prioritaires ; les sous-agents déjà créés conservent leurs réglages.',
    en: 'Defaults for all projects. Project-specific settings are in the Agents tab of a session. Explicit choices take priority; existing subagents keep their settings.',
  },
  'ui.modele_parent': {
    fr: 'Modèle parent',
    en: 'Parent model',
  },
  'ui.heriter_du_parent': {
    fr: 'Hériter du parent',
    en: 'Inherit from parent',
  },
  'ui.utiliser_le_modele_de_l_agent_parent': {
    fr: 'Utiliser le modèle de l’agent parent',
    en: 'Use the parent agent’s model',
  },
  'ui.modele_des_sous_agents': {
    fr: 'Modèle des sous-agents. {value1}{value2}',
    en: 'Subagent model. {value1}{value2}',
  },
  'ui.niveau_parent': {
    fr: 'Niveau parent',
    en: 'Parent level',
  },
  'ui.prochaines_delegations_2': {
    fr: '{value1} · prochaines délégations',
    en: '{value1} · next delegations',
  },
  'ui.reglages_globaux': {
    fr: 'Réglages globaux',
    en: 'Global settings',
  },
  'ui.reglages_du_projet': {
    fr: 'Réglages du projet',
    en: 'Project settings',
  },
  'ui.applique_aux_prochaines_delegations_dans_tous_les_projets': {
    fr: 'Appliqué aux prochaines délégations dans tous les projets.',
    en: 'Applies to the next delegations in all projects.',
  },
  'ui.chargement_des_reglages': {
    fr: 'Chargement des réglages…',
    en: 'Loading settings…',
  },
  'ui.reglages_indisponibles': {
    fr: 'Réglages indisponibles.',
    en: 'Settings unavailable.',
  },
  'ui.rechargez_le_studio_apres_sa_mise_a_jour_pour_acceder_a_ces_regla': {
    fr: 'Rechargez le Studio après sa mise à jour pour accéder à ces réglages.',
    en: 'Reload the Studio after updating it to access these settings.',
  },
  'ui.reglages_des_sous_agents_enregistres': {
    fr: 'Réglages des sous-agents enregistrés.',
    en: 'Subagent settings saved.',
  },
  'ui.modification_non_enregistree': {
    fr: 'Modification non enregistrée.',
    en: 'Change not saved.',
  },
  'ui.modele_des_sous_agents_2': {
    fr: 'Modèle des sous-agents',
    en: 'Subagent model',
  },
  'ui.heriter_du_modele_parent': {
    fr: 'Hériter du modèle parent',
    en: 'Inherit parent model',
  },
  'ui.utiliser_le_modele_de_l_agent_qui_delegue': {
    fr: 'Utiliser le modèle de l’agent qui délègue',
    en: 'Use the delegating agent’s model',
  },
  'ui.espace_de_travail_2': {
    fr: 'ESPACE DE TRAVAIL',
    en: 'WORKSPACE',
  },
  'ui.installer_le_studio': {
    fr: 'Installer le Studio',
    en: 'Install Studio',
  },
  'ui.preferences': {
    fr: 'Préférences',
    en: 'Preferences',
  },
  'ui.votre_projet': {
    fr: 'VOTRE PROJET',
    en: 'YOUR PROJECT',
  },
  'ui.recentes': {
    fr: 'Récentes',
    en: 'Recent',
  },
  'ui.archivees': {
    fr: 'Archivées',
    en: 'Archived',
  },
  'ui.de_l_idee_au_code': {
    fr: 'DE L’IDÉE AU CODE',
    en: 'FROM IDEA TO CODE',
  },
  'ui.un_nouvel_elan': {
    fr: 'Un nouvel élan',
    en: 'Fresh momentum',
  },
  'ui.pour_vos_projets': {
    fr: 'pour vos projets.',
    en: 'for your projects.',
  },
  'ui.un_agent_votre_code_et_toutes_vos_idees': {
    fr: 'Un agent, votre code et toutes vos idées.',
    en: 'An agent, your code and all your ideas.',
  },
  'ui.choisissez_une_piste_ou_commencez_simplement_a_ecrire': {
    fr: 'Choisissez une piste, ou commencez simplement à écrire.',
    en: 'Choose a starting point, or simply start typing.',
  },
  'ui.explorer_le_projet': {
    fr: 'Explorer le projet',
    en: 'Explore the project',
  },
  'ui.comprendre_avant_de_construire': {
    fr: 'Comprendre avant de construire',
    en: 'Understand before you build',
  },
  'ui.creer_une_fonctionnalite': {
    fr: 'Créer une fonctionnalité',
    en: 'Build a feature',
  },
  'ui.donner_vie_a_la_prochaine_idee': {
    fr: 'Donner vie à la prochaine idée',
    en: 'Bring the next idea to life',
  },
  'ui.resoudre_un_probleme': {
    fr: 'Résoudre un problème',
    en: 'Fix a problem',
  },
  'ui.trouver_la_cause_corriger_le_code': {
    fr: 'Trouver la cause, corriger le code',
    en: 'Find the cause, fix the code',
  },
  'ui.ameliorer_l_existant': {
    fr: 'Améliorer l’existant',
    en: 'Improve what’s there',
  },
  'ui.prendre_du_recul_sur_votre_code': {
    fr: 'Prendre du recul sur votre code',
    en: 'Take a fresh look at your code',
  },
  'ui.chargement_de_la_session': {
    fr: 'Chargement de la session…',
    en: 'Loading session…',
  },
  'ui.derniers_messages': {
    fr: 'Derniers messages',
    en: 'Latest messages',
  },
  'ui.votre_message_a_prime_agent': {
    fr: 'Votre message à Prime Agent',
    en: 'Your message to Prime Agent',
  },
  'ui.effort_de_raisonnement': {
    fr: 'Effort de raisonnement',
    en: 'Reasoning effort',
  },
  'ui.effort_par_defaut': {
    fr: 'Effort par défaut',
    en: 'Default effort',
  },
  'ui.sans_raisonnement': {
    fr: 'Sans raisonnement',
    en: 'No reasoning',
  },
  'ui.leger': {
    fr: 'Léger',
    en: 'Low',
  },
  'ui.eleve': {
    fr: 'Élevé',
    en: 'High',
  },
  'ui.tres_eleve': {
    fr: 'Très élevé',
    en: 'Very high',
  },
  'ui.session': {
    fr: 'Session',
    en: 'Session',
  },
  'ui.agents': {
    fr: 'Agents',
    en: 'Agents',
  },
  'ui.fichiers': {
    fr: 'Fichiers',
    en: 'Files',
  },
  'ui.projet_actif': {
    fr: 'PROJET ACTIF',
    en: 'ACTIVE PROJECT',
  },
  'ui.copier_le_chemin': {
    fr: 'Copier le chemin',
    en: 'Copy path',
  },
  'ui.etat': {
    fr: 'État',
    en: 'Status',
  },
  'ui.derniere_activite': {
    fr: 'Dernière activité',
    en: 'Last activity',
  },
  'ui.exporter_la_conversation': {
    fr: 'Exporter la conversation',
    en: 'Export conversation',
  },
  'ui.en_cours_2': {
    fr: 'EN COURS',
    en: 'RUNNING',
  },
  'ui.le_terminal_en_toute_discretion': {
    fr: 'Le terminal, en toute discrétion.',
    en: 'The terminal, quietly in the background.',
  },
  'ui.prime_agent_s_execute_en_arriere_plan_retrouvez_ses_actions_et_se': {
    fr: 'Prime Agent s’exécute en arrière-plan. Retrouvez ses actions et ses résultats dans la conversation.',
    en: 'Prime Agent runs in the background. Follow its actions and results in the conversation.',
  },
  'ui.fichiers_du_projet': {
    fr: 'Fichiers du projet',
    en: 'Project files',
  },
  'ui.parcourir': {
    fr: 'Parcourir',
    en: 'Browse',
  },
  'ui.renommer': {
    fr: 'Renommer',
    en: 'Rename',
  },
  'ui.exporter_en_markdown': {
    fr: 'Exporter en Markdown',
    en: 'Export as Markdown',
  },
  'ui.ouvrir_le_dossier_sur_le_pc': {
    fr: 'Ouvrir le dossier sur le PC',
    en: 'Open folder on PC',
  },
  'ui.supprimer_du_studio': {
    fr: 'Supprimer du Studio',
    en: 'Remove from Studio',
  },
  'ui.supprimer_ce_projet_du_studio': {
    fr: 'Supprimer ce projet du Studio ?',
    en: 'Remove this project from the Studio?',
  },
  'ui.le_dossier_et_les_sessions_restent_sur_le_pc_vous_pourrez_les_ret': {
    fr: 'Le dossier et les sessions restent sur le PC. Vous pourrez les retrouver en ajoutant à nouveau ce dossier.',
    en: 'The folder and sessions will remain on the PC. You can find them again by adding this folder back.',
  },
  'ui.un_projet_a_explorer': {
    fr: 'Un projet à explorer.',
    en: 'A project to explore.',
  },
  'ui.indiquez_le_dossier_de_travail_de_prime_agent_vos_sessions_seront': {
    fr: 'Indiquez le dossier de travail de Prime Agent. Vos sessions seront regroupées ici.',
    en: 'Choose Prime Agent’s working folder. Your sessions will be grouped here.',
  },
  'ui.dossier_du_projet': {
    fr: 'Dossier du projet',
    en: 'Project folder',
  },
  'ui.nom_du_projet': {
    fr: 'Nom du projet',
    en: 'Project name',
  },
  'ui.ajouter_le_projet': {
    fr: 'Ajouter le projet',
    en: 'Add project',
  },
  'ui.renommer_la_session': {
    fr: 'Renommer la session',
    en: 'Rename session',
  },
  'ui.titre_de_la_session': {
    fr: 'Titre de la session',
    en: 'Session title',
  },
  'ui.recherchez_un_modele_ou_placez_vos_modeles_preferes_en_tete_de_li': {
    fr: 'Recherchez un modèle ou placez vos modèles préférés en tête de liste.',
    en: 'Search for a model or pin your favorite models to the top of the list.',
  },
  'ui.rechercher_un_modele': {
    fr: 'Rechercher un modèle',
    en: 'Search models',
  },
  'ui.faites_comme_chez_vous': {
    fr: 'Faites comme chez vous.',
    en: 'Make yourself at home.',
  },
  'ui.personnalisez_votre_espace_de_travail': {
    fr: 'Personnalisez votre espace de travail.',
    en: 'Personalize your workspace.',
  },
  'ui.apparence': {
    fr: 'Apparence',
    en: 'Appearance',
  },
  'ui.sombre': {
    fr: 'Sombre',
    en: 'Dark',
  },
  'ui.clair': {
    fr: 'Clair',
    en: 'Light',
  },
  'ui.systeme': {
    fr: 'Système',
    en: 'System',
  },
  'ui.entree_pour_envoyer': {
    fr: 'Entrée pour envoyer',
    en: 'Enter to send',
  },
  'ui.sinon_utilisez_ctrl_entree': {
    fr: 'Sinon, utilisez Ctrl + Entrée.',
    en: 'Otherwise, use Ctrl + Enter.',
  },
  'ui.raisonnement_de_l_agent': {
    fr: 'Raisonnement de l’agent',
    en: 'Agent reasoning',
  },
  'ui.un_apercu_de_la_derniere_reflexion_meme_lorsque_l_activite_est_re': {
    fr: 'Un aperçu de la dernière réflexion, même lorsque l’activité est repliée.',
    en: 'Preview the latest reflection, even when activity is collapsed.',
  },
  'ui.masque': {
    fr: 'Masqué',
    en: 'Hidden',
  },
  'ui.detaille': {
    fr: 'Détaillé',
    en: 'Expanded',
  },
  'ui.modeles_et_valeurs_par_defaut': {
    fr: 'Modèles et valeurs par défaut',
    en: 'Models and defaults',
  },
  'ui.choisissez_le_modele_principal_et_gerez_les_definitions_personnal': {
    fr: 'Choisissez le modèle principal et gérez les définitions personnalisées.',
    en: 'Choose the main model and manage custom definitions.',
  },
  'ui.connectez_vos_comptes_et_gerez_les_cles_api_de_prime_agent': {
    fr: 'Connectez vos comptes et gérez les clés API de Prime Agent.',
    en: 'Connect accounts and manage Prime Agent API keys.',
  },
  'ui.gerer_les_connexions': {
    fr: 'Gérer les connexions',
    en: 'Manage connections',
  },
  'ui.connectez_des_outils_et_services_a_prime_agent': {
    fr: 'Connectez des outils et services à Prime Agent.',
    en: 'Connect tools and services to Prime Agent.',
  },
  'ui.gerer_les_mcp': {
    fr: 'Gérer les MCP',
    en: 'Manage MCPs',
  },
  'ui.acces_mobile': {
    fr: 'Accès mobile',
    en: 'Mobile access',
  },
  'ui.modifiez_le_code_pin_de_connexion_a_distance': {
    fr: 'Modifiez le code PIN de connexion à distance.',
    en: 'Change the remote sign-in PIN.',
  },
  'ui.interface_locale_pour_prime_agent': {
    fr: 'Interface locale pour Prime Agent',
    en: 'Local interface for Prime Agent',
  },
  'ui.se_deconnecter': {
    fr: 'Se déconnecter',
    en: 'Sign out',
  },
  'ui.code_d_acces_mobile': {
    fr: 'Code d’accès mobile',
    en: 'Mobile access code',
  },
  'ui.nouveau_code_8_chiffres': {
    fr: 'Nouveau code · 8 chiffres',
    en: 'New code · 8 digits',
  },
  'ui.confirmer_le_nouveau_code': {
    fr: 'Confirmer le nouveau code',
    en: 'Confirm new code',
  },
  'ui.afficher_les_codes': {
    fr: 'Afficher les codes',
    en: 'Show codes',
  },
  'ui.les_appareils_connectes_devront_saisir_le_nouveau_code_vos_agents': {
    fr: 'Les appareils connectés devront saisir le nouveau code. Vos agents continuent de travailler.',
    en: 'Connected devices will need to enter the new code. Your agents will keep working.',
  },
  'ui.configurer_les_modeles': {
    fr: 'Configurer les modèles',
    en: 'Configure models',
  },
  'ui.les_definitions_sont_enregistrees_localement_dans_prime_agent': {
    fr: 'Les définitions sont enregistrées localement dans Prime Agent.',
    en: 'Definitions are saved locally in Prime Agent.',
  },
  'ui.comportement_natif_prime_agent': {
    fr: 'COMPORTEMENT NATIF PRIME AGENT',
    en: 'NATIVE PRIME AGENT BEHAVIOR',
  },
  'ui.modeles_par_defaut': {
    fr: 'Modèles par défaut',
    en: 'Default models',
  },
  'ui.le_modele_principal_s_applique_aux_nouvelles_sessions_les_session': {
    fr: 'Le modèle principal s’applique aux nouvelles sessions. Les sessions en cours conservent leur modèle.',
    en: 'The main model applies to new sessions. Running sessions keep their model.',
  },
  'ui.vos_modeles_personnalises': {
    fr: 'Vos modèles personnalisés',
    en: 'Your custom models',
  },
  'ui.aucun_modele_personnalise_ajoutez_une_definition_pour_un_fourniss': {
    fr: 'Aucun modèle personnalisé. Ajoutez une définition pour un fournisseur compatible.',
    en: 'No custom models. Add a definition for a compatible provider.',
  },
  'ui.ce_configurateur_reste_sur_cet_ordinateur_les_cles_enregistrees_n': {
    fr: 'Ce configurateur reste sur cet ordinateur. Les clés enregistrées ne sont jamais renvoyées au navigateur. Pour une nouvelle clé, indiquez uniquement le nom de sa variable d’environnement.',
    en: 'This configurator stays on this computer. Saved keys are never sent back to the browser. For a new key, enter only its environment variable name.',
  },
  'ui.definition_prime_agent': {
    fr: 'DÉFINITION PRIME AGENT',
    en: 'PRIME AGENT DEFINITION',
  },
  'ui.fournisseur': {
    fr: 'Fournisseur',
    en: 'Provider',
  },
  'ui.identifiant_du_modele': {
    fr: 'Identifiant du modèle',
    en: 'Model identifier',
  },
  'ui.nom_affiche': {
    fr: 'Nom affiché',
    en: 'Display name',
  },
  'ui.protocole_api': {
    fr: 'Protocole API',
    en: 'API protocol',
  },
  'ui.variable_de_cle_api': {
    fr: 'Variable de clé API',
    en: 'API key variable',
  },
  'ui.si_necessaire': {
    fr: '(si nécessaire)',
    en: '(if needed)',
  },
  'ui.adresse_de_base_de_l_api': {
    fr: 'Adresse de base de l’API',
    en: 'API base URL',
  },
  'ui.fenetre_de_contexte': {
    fr: 'Fenêtre de contexte',
    en: 'Context window',
  },
  'ui.sortie_maximale': {
    fr: 'Sortie maximale',
    en: 'Maximum output',
  },
  'ui.images_en_entree': {
    fr: 'Images en entrée',
    en: 'Image input',
  },
  'ui.ne_saisissez_jamais_une_cle_secrete_ici_prime_agent_resout_la_var': {
    fr: 'Ne saisissez jamais une clé secrète ici. Prime Agent résout la variable indiquée ou conserve l’identification déjà configurée pour ce fournisseur.',
    en: 'Never enter a secret key here. Prime Agent resolves the specified variable or keeps the credentials already configured for this provider.',
  },
  'ui.projets_et_sessions': {
    fr: 'Projets et sessions',
    en: 'Projects and sessions',
  },
  'ui.prime_agent_studio_accueil': {
    fr: 'Prime Agent Studio, accueil',
    en: 'Prime Agent Studio, home',
  },
  'ui.ajouter_un_projet': {
    fr: 'Ajouter un projet',
    en: 'Add a project',
  },
  'ui.projets': {
    fr: 'Projets',
    en: 'Projects',
  },
  'ui.afficher_les_projets': {
    fr: 'Afficher les projets',
    en: 'Show projects',
  },
  'ui.masquer_le_contexte': {
    fr: 'Masquer le contexte',
    en: 'Hide context',
  },
  'ui.sessions_affichees': {
    fr: 'Sessions affichées',
    en: 'Displayed sessions',
  },
  'ui.rechercher_dans_ce_projet': {
    fr: 'Rechercher dans ce projet',
    en: 'Search this project',
  },
  'ui.sessions_de_ce_projet': {
    fr: 'Sessions de ce projet',
    en: 'Sessions in this project',
  },
  'ui.explore_ce_projet_et_explique_moi_son_architecture_ses_principaux': {
    fr: 'Explore ce projet et explique-moi son architecture, ses principaux composants et comment le lancer.',
    en: 'Explore this project and explain its architecture, main components and how to run it.',
  },
  'ui.aide_moi_a_developper_une_nouvelle_fonctionnalite_dans_ce_projet': {
    fr: 'Aide-moi à développer une nouvelle fonctionnalité dans ce projet. Commence par explorer le code, puis demande-moi ce que je souhaite ajouter.',
    en: 'Help me build a new feature in this project. Start by exploring the code, then ask what I would like to add.',
  },
  'ui.analyse_ce_projet_pour_reperer_les_bugs_et_les_cas_limites_presen': {
    fr: 'Analyse ce projet pour repérer les bugs et les cas limites. Présente les problèmes concrets avec leurs emplacements et propose des corrections.',
    en: 'Analyze this project for bugs and edge cases. Describe concrete problems with their locations and suggest fixes.',
  },
  'ui.fais_une_revue_de_qualite_du_projet_lisibilite_robustesse_tests_e': {
    fr: 'Fais une revue de qualité du projet : lisibilité, robustesse, tests et maintenabilité. Propose des améliorations concrètes, classées par priorité.',
    en: 'Review the project’s quality: readability, robustness, tests and maintainability. Suggest concrete improvements, ordered by priority.',
  },
  'ui.aller_au_dernier_message': {
    fr: 'Aller au dernier message',
    en: 'Go to the latest message',
  },
  'ui.arreter_l_agent': {
    fr: 'Arrêter l’agent',
    en: 'Stop the agent',
  },
  'ui.session_agents_et_fichiers': {
    fr: 'Session, agents et fichiers',
    en: 'Session, agents and files',
  },
  'ui.fermer_le_panneau': {
    fr: 'Fermer le panneau',
    en: 'Close panel',
  },
  'ui.informations_du_projet': {
    fr: 'Informations du projet',
    en: 'Project information',
  },
  'ui.vue_des_fichiers': {
    fr: 'Vue des fichiers',
    en: 'File view',
  },
  'ui.options_du_projet_2': {
    fr: 'Options du projet',
    en: 'Project options',
  },
  'ui.mon_projet': {
    fr: 'Mon projet',
    en: 'My project',
  },
  'ui.rechercher_par_nom_fournisseur_ou_identifiant': {
    fr: 'Rechercher par nom, fournisseur ou identifiant…',
    en: 'Search by name, provider or identifier…',
  },
  'ui.modeles_disponibles': {
    fr: 'Catalogue des modèles',
    en: 'Model catalogue',
  },
  'ui.prime_agent_studio_reconnexion': {
    fr: 'Prime Agent Studio · Reconnexion',
    en: 'Prime Agent Studio · Reconnecting',
  },
  'ui.retrouvons_votre_studio': {
    fr: 'Retrouvons votre Studio.',
    en: 'Let’s reconnect to your Studio.',
  },
  'ui.la_connexion_au_pc_est_interrompue_verifiez_qu_il_est_allume_et_q': {
    fr: 'La connexion au PC est interrompue. Vérifiez qu’il est allumé et que Tailscale est connecté sur vos deux appareils.',
    en: 'The connection to the PC was interrupted. Check that it is on and that Tailscale is connected on both devices.',
  },
  'ui.vos_brouillons_restent_dans_cet_appareil_le_travail_sur_le_pc_peu': {
    fr: 'Vos brouillons restent dans cet appareil. Le travail sur le PC peut continuer pendant cette coupure.',
    en: 'Your drafts remain on this device. Work on the PC may continue during this interruption.',
  },
  'model.use': {
    fr: 'Utiliser {value1}',
    en: 'Use {value1}',
  },
  'model.unavailable': {
    fr: 'Indisponible',
    en: 'Unavailable',
  },
  'model.unavailableSelection': {
    fr: 'Ce modèle n’est plus disponible. Choisissez-en un autre ; aucun remplacement automatique ne sera effectué.',
    en: 'This model is no longer available. Choose another model; no automatic replacement will be made.',
  },
  'model.refresh': {
    fr: 'Actualiser les modèles',
    en: 'Refresh models',
  },
  'model.refreshing': {
    fr: 'Actualisation des modèles…',
    en: 'Refreshing models…',
  },
  'model.refreshFailed': {
    fr: 'Impossible d’actualiser les modèles : {value1}',
    en: 'Could not refresh models: {value1}',
  },
  'model.refreshInterrupted': {
    fr: 'Actualisation interrompue. Catalogue conservé.',
    en: 'Refresh interrupted. Catalogue retained.',
  },
  'model.refreshDelayed': {
    fr: 'Actualisation incomplète. Réessayez.',
    en: 'Refresh incomplete. Try again.',
  },
  'model.favoritesCount': {
    fr: 'Favoris ({value1})',
    en: 'Favorites ({value1})',
  },
  'common.other': {
    fr: 'Autres',
    en: 'Other',
  },
  'common.error': {
    fr: 'Erreur',
    en: 'Error',
  },
  'common.tool': {
    fr: 'Outil',
    en: 'Tool',
  },
  'common.httpError': {
    fr: 'Erreur {value1}',
    en: 'Error {value1}',
  },
  'common.options': {
    fr: 'Options : {value1}',
    en: 'Options: {value1}',
  },
  'common.unavailable': {
    fr: 'Indisponible · {value1}',
    en: 'Unavailable · {value1}',
  },
  'model.tokens': {
    fr: '{value1} jetons',
    en: '{value1} tokens',
  },
  'common.editName': {
    fr: 'Modifier {value1}',
    en: 'Edit {value1}',
  },
  'common.deleteName': {
    fr: 'Supprimer {value1}',
    en: 'Delete {value1}',
  },
  'export.project': {
    fr: 'Projet : {value1}',
    en: 'Project: {value1}',
  },
  'export.session': {
    fr: 'Session : {value1}',
    en: 'Session: {value1}',
  },
  'common.all': {
    fr: 'Tout',
    en: 'All',
  },
  'images.enlarge': {
    fr: 'Agrandir l’image {value1}',
    en: 'Enlarge image {value1}',
  },
  'common.removeName': {
    fr: 'Retirer {value1}',
    en: 'Remove {value1}',
  },
  'agents.child': {
    fr: 'Sous-agent{value1}',
    en: 'Subagent{value1}',
  },
  'agents.level': {
    fr: ' · niveau {value1}',
    en: ' · level {value1}',
  },
  'common.view': {
    fr: 'Consulter',
    en: 'View',
  },
  'common.loading': {
    fr: 'Chargement…',
    en: 'Loading…',
  },
  'files.content': {
    fr: 'Contenu',
    en: 'Content',
  },
  'agents.instruction': {
    fr: 'Consigne',
    en: 'Instruction',
  },
  'mcp.removeConfirm': {
    fr: 'Supprimer « {value1} » ?',
    en: 'Delete “{value1}”?',
  },
  'mcp.testName': {
    fr: 'Tester {value1}',
    en: 'Test {value1}',
  },
  'mcp.connectName': {
    fr: 'Connecter {value1}',
    en: 'Connect {value1}',
  },
  'providers.environment': {
    fr: 'Variable d’environnement',
    en: 'Environment variable',
  },
  'common.saving': {
    fr: 'Enregistrement…',
    en: 'Saving…',
  },
  'agents.subagents': {
    fr: 'Sous-agents',
    en: 'Subagents',
  },
  'agents.global': {
    fr: 'Globaux',
    en: 'Global',
  },
  'mcp.transport': {
    fr: 'Transport',
    en: 'Transport',
  },
  'mcp.auth': {
    fr: 'Authentification',
    en: 'Authentication',
  },
  'mcp.envMapping': {
    fr: 'Variables · NOM_ENFANT=NOM_VARIABLE_DU_PC',
    en: 'Variables · CHILD_NAME=PC_VARIABLE_NAME',
  },
  'common.messages': {
    fr: 'Messages',
    en: 'Messages',
  },
  'commands.searchHint': {
    fr: '[recherche]',
    en: '[search]',
  },
  'commands.levelHint': {
    fr: '[niveau]',
    en: '[level]',
  },
  'commands.nameHint': {
    fr: '[nom]',
    en: '[name]',
  },
  'model.addFavorite': {
    fr: 'Ajouter {name} aux favoris',
    en: 'Add {name} to favorites',
  },
  'model.removeFavorite': {
    fr: 'Retirer {name} des favoris',
    en: 'Remove {name} from favorites',
  },
  'count.sessions': {
    fr: {
      one: '{count} session',
      other: '{count} sessions',
    },
    en: {
      one: '{count} session',
      other: '{count} sessions',
    },
  },
  'count.messages': {
    fr: {
      one: '{count} message',
      other: '{count} messages',
    },
    en: {
      one: '{count} message',
      other: '{count} messages',
    },
  },
  'count.tools': {
    fr: {
      one: '{count} appel d’outil',
      other: '{count} appels d’outil',
    },
    en: {
      one: '{count} tool call',
      other: '{count} tool calls',
    },
  },
  'count.errors': {
    fr: {
      one: '{count} erreur',
      other: '{count} erreurs',
    },
    en: {
      one: '{count} error',
      other: '{count} errors',
    },
  },
  'count.reflections': {
    fr: {
      one: '{count} réflexion',
      other: '{count} réflexions',
    },
    en: {
      one: '{count} reflection',
      other: '{count} reflections',
    },
  },
  'count.attachments': {
    fr: {
      one: '{count} pièce jointe dans la session native.',
      other: '{count} pièces jointes dans la session native.',
    },
    en: {
      one: '{count} attachment in the native session.',
      other: '{count} attachments in the native session.',
    },
  },
  'count.subagents': {
    fr: {
      one: '{count} sous-agent{activity}',
      other: '{count} sous-agents{activity}',
    },
    en: {
      one: '{count} subagent{activity}',
      other: '{count} subagents{activity}',
    },
  },
  'count.models': {
    fr: {
      one: '{count} modèle configuré',
      other: '{count} modèles configurés',
    },
    en: {
      one: '{count} configured model',
      other: '{count} configured models',
    },
  },
  'count.filesChanged': {
    fr: {
      one: '{branch} · {count} fichier modifié',
      other: '{branch} · {count} fichiers modifiés',
    },
    en: {
      one: '{branch} · {count} changed file',
      other: '{branch} · {count} changed files',
    },
  },
  'count.toolsAvailable': {
    fr: {
      one: 'Connexion réussie · {count} outil disponible',
      other: 'Connexion réussie · {count} outils disponibles',
    },
    en: {
      one: 'Connected · {count} tool available',
      other: 'Connected · {count} tools available',
    },
  },
  'count.results': {
    fr: {
      one: '{count} résultat',
      other: '{count} résultats',
    },
    en: {
      one: '{count} result',
      other: '{count} results',
    },
  },
  'count.choices': {
    fr: {
      one: '{count} choix',
      other: '{count} choix',
    },
    en: {
      one: '{count} option',
      other: '{count} options',
    },
  },
  'count.providers': {
    fr: {
      one: '{count} fournisseur · {configured} configuré(s)',
      other: '{count} fournisseurs · {configured} configuré(s)',
    },
    en: {
      one: '{count} provider · {configured} configured',
      other: '{count} providers · {configured} configured',
    },
  },
  'server.un_corps_json_est_requis': {
    fr: 'Un corps JSON est requis.',
    en: 'A JSON body is required.',
  },
  'server.la_demande_depasse_la_taille_autorisee': {
    fr: 'La demande dépasse la taille autorisée.',
    en: 'The request exceeds the allowed size.',
  },
  'server.la_demande_depasse_512_ko': {
    fr: 'La demande dépasse 512 Ko.',
    en: 'The request exceeds 512 KB.',
  },
  'server.la_demande_json_est_invalide': {
    fr: 'La demande JSON est invalide.',
    en: 'The JSON request is invalid.',
  },
  'server.selection_de_modele_invalide': {
    fr: 'Sélection de modèle invalide.',
    en: 'Invalid model selection.',
  },
  'server.ce_modele_n_est_pas_disponible_dans_prime_agent': {
    fr: 'Ce modèle n’est pas disponible dans Prime Agent.',
    en: 'This model is not available in Prime Agent.',
  },
  'server.le_serveur_est_en_cours_d_arret': {
    fr: 'Le serveur est en cours d’arrêt.',
    en: 'The server is shutting down.',
  },
  'server.huit_sessions_tournent_deja_arretez_en_une_avant_de_continuer': {
    fr: 'Huit sessions tournent déjà. Arrêtez-en une avant de continuer.',
    en: 'Eight sessions are already running. Stop one before continuing.',
  },
  'server.ajoutez_au_maximum_8_pieces_jointes': {
    fr: 'Ajoutez au maximum 8 pièces jointes.',
    en: 'Add no more than 8 attachments.',
  },
  'server.le_message_depasse_200_000_caracteres': {
    fr: 'Le message dépasse 200 000 caractères.',
    en: 'The message exceeds 200,000 characters.',
  },
  'server.modele_invalide': {
    fr: 'Modèle invalide.',
    en: 'Invalid model.',
  },
  'server.niveau_de_reflexion_invalide': {
    fr: 'Niveau de réflexion invalide.',
    en: 'Invalid reasoning level.',
  },
  'server.identifiant_de_session_invalide': {
    fr: 'Identifiant de session invalide.',
    en: 'Invalid session identifier.',
  },
  'server.cette_session_appartient_a_un_autre_dossier': {
    fr: 'Cette session appartient à un autre dossier.',
    en: 'This session belongs to a different folder.',
  },
  'server.cette_session_travaille_deja': {
    fr: 'Cette session travaille déjà.',
    en: 'This session is already working.',
  },
  'server.hote_non_autorise': {
    fr: 'Hôte non autorisé.',
    en: 'Host not allowed.',
  },
  'server.origine_non_autorisee': {
    fr: 'Origine non autorisée.',
    en: 'Origin not allowed.',
  },
  'server.requete_externe_non_autorisee': {
    fr: 'Requête externe non autorisée.',
    en: 'External request not allowed.',
  },
  'server.reglages_des_sous_agents_invalides': {
    fr: 'Réglages des sous-agents invalides.',
    en: 'Invalid subagent settings.',
  },
  'server.ce_niveau_de_reflexion_n_est_pas_compatible_avec_le_modele_chois': {
    fr: 'Ce niveau de réflexion n’est pas compatible avec le modèle choisi.',
    en: 'This reasoning level is not compatible with the selected model.',
  },
  'server.un_agent_travaille_dans_ce_projet_attendez_sa_fin_avant_de_le_re': {
    fr: 'Un agent travaille dans ce projet. Attendez sa fin avant de le retirer.',
    en: 'An agent is working in this project. Wait for it to finish before removing the project.',
  },
  'server.execution_introuvable_rechargez_son_historique': {
    fr: 'Exécution introuvable. Rechargez son historique.',
    en: 'Run not found. Reload its history.',
  },
  'server.fichier_introuvable': {
    fr: 'Fichier introuvable.',
    en: 'File not found.',
  },
  'server.une_erreur_interne_est_survenue': {
    fr: 'Une erreur interne est survenue. ',
    en: 'An internal error occurred. ',
  },
  'server.port_doit_etre_compris_entre_1_et_65535': {
    fr: 'PORT doit être compris entre 1 et 65535.',
    en: 'PORT must be between 1 and 65535.',
  },
  'server.acces_indisponible': {
    fr: 'Accès {value1} indisponible : {value2}',
    en: '{value1} access unavailable: {value2}',
  },
  'server.acces': {
    fr: 'Accès {value1} — {value2}',
    en: '{value1} access — {value2}',
  },
  'server.acces_mobile_indisponible': {
    fr: 'Accès mobile indisponible : {value1}',
    en: 'Mobile access unavailable: {value1}',
  },
  'server.le_port_est_deja_utilise_ouvrez_http_127_0_0_1_ou_definissez_por': {
    fr: 'Le port {value1} est déjà utilisé. Ouvrez http://127.0.0.1:{value2} ou définissez PORT.',
    en: 'Port {value1} is already in use. Open http://127.0.0.1:{value2} or set PORT.',
  },
  'server.ce_dossier_est_introuvable_ou_inaccessible': {
    fr: 'Ce dossier est introuvable ou inaccessible.',
    en: 'This folder was not found or cannot be accessed.',
  },
  'server.impossible_de_lire_les_preferences_locales': {
    fr: 'Impossible de lire les préférences locales : ',
    en: 'Unable to read local preferences: ',
  },
  'server.le_nom_doit_contenir_entre_1_et_100_caracteres': {
    fr: 'Le nom doit contenir entre 1 et 100 caractères.',
    en: 'The name must contain between 1 and 100 characters.',
  },
  'server.le_titre_doit_contenir_entre_1_et_200_caracteres': {
    fr: 'Le titre doit contenir entre 1 et 200 caractères.',
    en: 'The title must contain between 1 and 200 characters.',
  },
  'server.acces_prive_au_studio': {
    fr: 'Accès privé au Studio',
    en: 'Private access to the Studio',
  },
  'server.l_acces_mobile_doit_utiliser_une_adresse_locale_privee': {
    fr: 'L’accès mobile doit utiliser une adresse locale privée.',
    en: 'Mobile access must use a private local address.',
  },
  'server.configuration_du_code_d_acces_invalide': {
    fr: 'Configuration du code d’accès invalide.',
    en: 'Invalid access code configuration.',
  },
  'server.la_passerelle_https_doit_ecouter_uniquement_sur_loopback': {
    fr: 'La passerelle HTTPS doit écouter uniquement sur loopback.',
    en: 'The HTTPS gateway must listen on loopback only.',
  },
  'server.acces_prive_tailscale_https': {
    fr: 'Accès privé · Tailscale · HTTPS',
    en: 'Private access · Tailscale · HTTPS',
  },
  'server.acces_prive_tailscale': {
    fr: 'Accès privé · Tailscale',
    en: 'Private access · Tailscale',
  },
  'server.acces_prive_reseau_local': {
    fr: 'Accès privé · réseau local',
    en: 'Private access · local network',
  },
  'server.acces_limite_au_reseau_prive_configure': {
    fr: 'Accès limité au réseau privé configuré.',
    en: 'Access restricted to the configured private network.',
  },
  'server.trop_de_tentatives_reessayez_dans_quelques_minutes': {
    fr: 'Trop de tentatives. Réessayez dans quelques minutes.',
    en: 'Too many attempts. Try again in a few minutes.',
  },
  'server.code_incorrect_reessayez': {
    fr: 'Code incorrect. Réessayez.',
    en: 'Incorrect code. Please try again.',
  },
  'server.mise_a_jour_indisponible_verifiez_votre_connexion': {
    fr: 'Version publiée indisponible. Vérifiez la connexion du Studio puis réessayez.',
    en: 'Published version unavailable. Check the Studio connection and try again.',
  },
  'server.demande_de_mise_a_jour_invalide': {
    fr: 'Demande de mise à jour invalide.',
    en: 'Invalid update request.',
  },
  'server.trop_de_demandes_de_mise_a_jour_patientez': {
    fr: 'Trop de demandes de mise à jour. Patientez avant de réessayer.',
    en: 'Too many update requests. Wait before trying again.',
  },
  'server.application_deja_a_jour': {
    fr: 'L’application installée est déjà à jour.',
    en: 'The installed application is already up to date.',
  },
  'server.version_obsolete_reactualisez': {
    fr: 'Cette version n’est plus la version publiée. Réactualisez avant de réessayer.',
    en: 'This is no longer the published version. Refresh before trying again.',
  },
  'server.application_de_bureau_hors_ligne': {
    fr: 'L’application de bureau est hors ligne. Ouvrez-la sur ce PC puis réessayez.',
    en: 'The desktop application is offline. Open it on this PC and try again.',
  },
  'server.agents_en_cours_reessayez_plus_tard': {
    fr: 'Des agents travaillent. Réessayez quand aucune exécution ne sera en cours.',
    en: 'Agents are working. Try again when no run is active.',
  },
  'server.demande_deja_en_cours': {
    fr: 'Une demande de mise à jour est déjà en cours.',
    en: 'An update request is already in progress.',
  },
  'server.saisissez_votre_code_d_acces_sur_la_page_d_accueil': {
    fr: 'Saisissez votre code d’accès sur la page d’accueil.',
    en: 'Enter your access code on the home page.',
  },
  'server.cet_acces_permet_uniquement_de_consulter_les_sessions': {
    fr: 'Cet accès permet uniquement de consulter les sessions.',
    en: 'This access only allows viewing sessions.',
  },
  'server.saisissez_le_nouveau_code_d_acces_sur_la_page_d_accueil': {
    fr: 'Saisissez le nouveau code d’accès sur la page d’accueil.',
    en: 'Enter the new access code on the home page.',
  },
  'server.impossible_de_lire_le_studio_local': {
    fr: 'Impossible de lire le studio local.',
    en: 'Unable to read the local Studio.',
  },
  'server.le_studio_local_ne_repond_pas_reessayez_dans_un_instant': {
    fr: 'Le studio local ne répond pas. Réessayez dans un instant.',
    en: 'The local Studio is not responding. Try again in a moment.',
  },
  'server.une_erreur_est_survenue': {
    fr: 'Une erreur est survenue.',
    en: 'An error occurred.',
  },
  'server.la_configuration_de_l_acces_mobile_est_illisible_elle_a_ete_cons': {
    fr: 'La configuration de l’accès mobile est illisible. Elle a été conservée.',
    en: 'The mobile access configuration is unreadable. It has been preserved.',
  },
  'server.saisissez_deux_fois_le_meme_code_a_8_chiffres': {
    fr: 'Saisissez deux fois le même code à 8 chiffres.',
    en: 'Enter the same 8-digit code twice.',
  },
  'server.activez_d_abord_l_acces_mobile_sur_ce_pc': {
    fr: 'Activez d’abord l’accès mobile sur ce PC.',
    en: 'Enable mobile access on this PC first.',
  },
  'server.l_acces_mobile_a_ete_modifie_dans_une_autre_fenetre_rouvrez_ce_p': {
    fr: 'L’accès mobile a été modifié dans une autre fenêtre. Rouvrez ce panneau avant de réessayer.',
    en: 'Mobile access was changed in another window. Reopen this panel before trying again.',
  },
  'server.la_configuration_a_change_rouvrez_ce_panneau_avant_de_reessayer': {
    fr: 'La configuration a changé. Rouvrez ce panneau avant de réessayer.',
    en: 'The configuration has changed. Reopen this panel before trying again.',
  },
  'server.impossible_d_enregistrer_le_nouveau_code_l_ancien_code_reste_uti': {
    fr: 'Impossible d’enregistrer le nouveau code. L’ancien code reste utilisable.',
    en: 'Unable to save the new code. The old code remains usable.',
  },
  'server.acces_mobile_non_configure': {
    fr: 'Accès mobile non configuré.',
    en: 'Mobile access is not configured.',
  },
  'server.resumer_le_contexte_de_la_session': {
    fr: 'Résumer le contexte de la session',
    en: 'Summarize the session context',
  },
  'server.ameliorer_les_instructions_et_ressources_reutilisables': {
    fr: 'Améliorer les instructions et ressources réutilisables',
    en: 'Improve reusable instructions and resources',
  },
  'server.definir_ou_gerer_un_objectif_persistant': {
    fr: 'Définir ou gérer un objectif persistant',
    en: 'Set or manage a persistent goal',
  },
  'server.afficher_activer_ou_desactiver_le_mode_autonome': {
    fr: 'Afficher, activer ou désactiver le mode autonome',
    en: 'View, enable or disable autonomous mode',
  },
  'server.cette_commande_necessite_l_interface_terminal_de_prime_agent': {
    fr: 'Cette commande nécessite l’interface terminal de Prime Agent.',
    en: 'This command requires Prime Agent’s terminal interface.',
  },
  'server.les_extensions_interactives_necessitent_le_terminal_prime_agent': {
    fr: 'Les extensions interactives nécessitent le terminal Prime Agent.',
    en: 'Interactive extensions require the Prime Agent terminal.',
  },
  'server.cette_commande_s_utilise_depuis_le_menu_du_studio': {
    fr: 'Cette commande s’utilise depuis le menu du Studio.',
    en: 'Use this command from the Studio menu.',
  },
  'server.une_commande_de_session_s_ecrit_sur_une_seule_ligne_sans_piece_j': {
    fr: 'Une commande de session s’écrit sur une seule ligne, sans pièce jointe.',
    en: 'Write a session command on a single line, without attachments.',
  },
  'server.le_catalogue_se_charge_reessayez_dans_un_instant': {
    fr: 'Le catalogue se charge. Réessayez dans un instant.',
    en: 'The catalog is loading. Try again in a moment.',
  },
  'server.le_catalogue_prime_agent_met_trop_de_temps_a_repondre': {
    fr: 'Le catalogue Prime Agent met trop de temps à répondre.',
    en: 'The Prime Agent catalog is taking too long to respond.',
  },
  'server.impossible_de_lire_le_catalogue_prime_agent': {
    fr: 'Impossible de lire le catalogue Prime Agent.',
    en: 'Unable to read the Prime Agent catalog.',
  },
  'server.le_lecteur_du_catalogue_prime_agent_s_est_arrete': {
    fr: 'Le lecteur du catalogue Prime Agent s’est arrêté.',
    en: 'The Prime Agent catalog reader stopped.',
  },
  'server.le_catalogue_necessite_une_version_compatible_de_prime_agent': {
    fr: 'Le catalogue nécessite une version compatible de Prime Agent.',
    en: 'The catalog requires a compatible version of Prime Agent.',
  },
  'server.le_studio_s_arrete': {
    fr: 'Le Studio s’arrête.',
    en: 'The Studio is shutting down.',
  },
  'server.le_message_est_vide': {
    fr: 'Le message est vide.',
    en: 'The message is empty.',
  },
  'server.le_message_depasse_256_ko': {
    fr: 'Le message dépasse 256 Ko.',
    en: 'The message exceeds 256 KB.',
  },
  'server.cette_execution_est_terminee_votre_brouillon_est_conserve': {
    fr: 'Cette exécution est terminée. Votre brouillon est conservé.',
    en: 'This run has finished. Your draft has been preserved.',
  },
  'server.l_agent_est_en_cours_d_arret': {
    fr: 'L’agent est en cours d’arrêt.',
    en: 'The agent is stopping.',
  },
  'server.l_envoi_pendant_l_execution_est_momentanement_indisponible': {
    fr: 'L’envoi pendant l’exécution est momentanément indisponible.',
    en: 'Sending during a run is temporarily unavailable.',
  },
  'server.cet_identifiant_correspond_a_un_autre_envoi': {
    fr: 'Cet identifiant correspond à un autre envoi.',
    en: 'This identifier belongs to another submission.',
  },
  'server.trop_de_demandes_reessayez_dans_quelques_instants': {
    fr: 'Trop de demandes. Réessayez dans quelques instants.',
    en: 'Too many requests. Try again in a moment.',
  },
  'server.identifiant_d_envoi_invalide': {
    fr: 'Identifiant d’envoi invalide.',
    en: 'Invalid submission identifier.',
  },
  'server.le_message_n_a_pas_ete_accepte_votre_brouillon_est_conserve': {
    fr: 'Le message n’a pas été accepté. Votre brouillon est conservé.',
    en: 'The message was not accepted. Your draft has been preserved.',
  },
  'server.deplacement_invalide': {
    fr: 'Déplacement invalide.',
    en: 'Invalid move.',
  },
  'server.la_file_a_change_ou_ce_message_a_deja_ete_transmis_actualisez_la': {
    fr: 'La file a changé ou ce message a déjà été transmis. Actualisez-la.',
    en: 'The queue has changed or this message has already been delivered. Refresh it.',
  },
  'server.methode_non_autorisee': {
    fr: 'Méthode non autorisée.',
    en: 'Method not allowed.',
  },
  'server.nom_de_fichier_invalide': {
    fr: 'Nom de fichier invalide.',
    en: 'Invalid file name.',
  },
  'server.fichier_encode_incorrectement': {
    fr: 'Fichier encodé incorrectement.',
    en: 'Incorrectly encoded file.',
  },
  'server.formats_acceptes_png_jpeg_gif_et_webp': {
    fr: 'Formats acceptés : PNG, JPEG, GIF et WebP.',
    en: 'Accepted formats: PNG, JPEG, GIF and WebP.',
  },
  'server.une_image_depasse_4_mo': {
    fr: 'Une image dépasse 4 Mo.',
    en: 'An image exceeds 4 MB.',
  },
  'server.image_encodee_incorrectement': {
    fr: 'Image encodée incorrectement.',
    en: 'Incorrectly encoded image.',
  },
  'server.le_contenu_ne_correspond_pas_au_format_de_l_image': {
    fr: 'Le contenu ne correspond pas au format de l’image.',
    en: 'The content does not match the image format.',
  },
  'server.ce_chemin_n_est_pas_accessible_dans_les_fichiers_du_projet': {
    fr: 'Ce chemin n’est pas accessible dans les fichiers du projet.',
    en: 'This path is not accessible in the project files.',
  },
  'server.dossier_du_projet_introuvable': {
    fr: 'Dossier du projet introuvable.',
    en: 'Project folder not found.',
  },
  'server.ce_lien_sort_du_projet': {
    fr: 'Ce lien sort du projet.',
    en: 'This link points outside the project.',
  },
  'server.ce_dossier_contient_les_donnees_privees_du_moteur_ou_du_studio': {
    fr: 'Ce dossier contient les données privées du moteur ou du Studio.',
    en: 'This folder contains private engine or Studio data.',
  },
  'server.le_resultat_git_est_trop_volumineux': {
    fr: 'Le résultat Git est trop volumineux.',
    en: 'The Git result is too large.',
  },
  'server.git_met_trop_de_temps_a_repondre_reessayez': {
    fr: 'Git met trop de temps à répondre. Réessayez.',
    en: 'Git is taking too long to respond. Please try again.',
  },
  'server.git_n_est_pas_installe_sur_le_pc': {
    fr: 'Git n’est pas installé sur le PC.',
    en: 'Git is not installed on the PC.',
  },
  'server.ce_projet_n_est_pas_un_depot_git': {
    fr: 'Ce projet n’est pas un dépôt Git.',
    en: 'This project is not a Git repository.',
  },
  'server.impossible_de_consulter_ce_depot_git': {
    fr: 'Impossible de consulter ce dépôt Git.',
    en: 'Unable to inspect this Git repository.',
  },
  'server.le_fichier_depasse_la_limite_de_mo': {
    fr: 'Le fichier dépasse la limite de {value1} Mo.',
    en: 'The file exceeds the {value1} MB limit.',
  },
  'server.le_fichier_a_grandi_pendant_sa_lecture': {
    fr: 'Le fichier a grandi pendant sa lecture.',
    en: 'The file grew while it was being read.',
  },
  'server.le_fichier_a_change_pendant_sa_lecture_reessayez': {
    fr: 'Le fichier a changé pendant sa lecture. Réessayez.',
    en: 'The file changed while it was being read. Please try again.',
  },
  'server.ce_fichier_ne_se_trouve_pas_dans_le_projet': {
    fr: 'Ce fichier ne se trouve pas dans le projet.',
    en: 'This file is not inside the project.',
  },
  'server.reference_de_fichier_invalide': {
    fr: 'Référence de fichier invalide.',
    en: 'Invalid file reference.',
  },
  'server.fichier_trop_volumineux_pour_l_apercu_utilisez_ouvrir_pour_le_co': {
    fr: 'Fichier trop volumineux pour l’aperçu. Utilisez « Ouvrir » pour le consulter sur cet appareil.',
    en: 'This file is too large to preview. Use Open to view it on this device.',
  },
  'server.apercu_indisponible_pour_ce_type_de_fichier': {
    fr: 'Aperçu indisponible pour ce type de fichier.',
    en: 'Preview unavailable for this file type.',
  },
  'server.head_detachee': {
    fr: 'HEAD détachée',
    en: 'Detached HEAD',
  },
  'server.cette_modification_n_est_plus_presente_actualisez_la_liste': {
    fr: 'Cette modification n’est plus présente. Actualisez la liste.',
    en: 'This change is no longer present. Refresh the list.',
  },
  'server.fichier_supprime_dans_un_depot_sans_commit': {
    fr: 'Fichier supprimé dans un dépôt sans commit.',
    en: 'Deleted file in a repository with no commits.',
  },
  'server.le_contenu_de_ce_fichier_ne_peut_pas_etre_affiche_en_diff': {
    fr: 'Le contenu de ce fichier ne peut pas être affiché en diff.',
    en: 'This file’s content cannot be displayed as a diff.',
  },
  'server.le_contenu_final_est_identique_a_head_des_changements_peuvent_en': {
    fr: 'Le contenu final est identique à HEAD ; des changements peuvent encore être présents dans l’index.',
    en: 'The final content is identical to HEAD; staged changes may still be present.',
  },
  'server.le_suivi_en_direct_est_momentanement_indisponible': {
    fr: 'Le suivi en direct est momentanément indisponible.',
    en: 'Live tracking is temporarily unavailable.',
  },
  'server.l_historique_des_delegations_n_est_pas_disponible': {
    fr: 'L’historique des délégations n’est pas disponible.',
    en: 'Delegation history is unavailable.',
  },
  'server.historique_deplace_actualisez_les_agents': {
    fr: 'Historique déplacé. Actualisez les agents.',
    en: 'History moved. Refresh the agents.',
  },
  'server.nom_du_modele_invalide': {
    fr: 'Nom du modèle invalide.',
    en: 'Invalid model name.',
  },
  'server.nom_du_fournisseur_invalide': {
    fr: 'Nom du fournisseur invalide.',
    en: 'Invalid provider name.',
  },
  'server.api_de_modele_non_prise_en_charge': {
    fr: 'API de modèle non prise en charge.',
    en: 'Unsupported model API.',
  },
  'server.utilisez_une_adresse_http_s_sans_identifiants_parametres_ni_frag': {
    fr: 'Utilisez une adresse HTTP(S) sans identifiants, paramètres ni fragment.',
    en: 'Use an HTTP(S) address without credentials, parameters or a fragment.',
  },
  'server.la_reference_de_cle_doit_etre_un_nom_de_variable_d_environnement': {
    fr: 'La référence de clé doit être un nom de variable d’environnement.',
    en: 'The key reference must be an environment variable name.',
  },
  'server.doit_etre_un_entier_positif_inferieur_ou_egal_a': {
    fr: '{value1} doit être un entier positif inférieur ou égal à {value2}.',
    en: '{value1} must be a positive integer less than or equal to {value2}.',
  },
  'server.types_d_entree_invalides': {
    fr: 'Types d’entrée invalides.',
    en: 'Invalid input types.',
  },
  'server.identite': {
    fr: 'Identité',
    en: 'Identity',
  },
  'server.configuration_de_modele_invalide': {
    fr: 'Configuration de modèle invalide.',
    en: 'Invalid model configuration.',
  },
  'server.la_fenetre_de_contexte': {
    fr: 'La fenêtre de contexte',
    en: 'The context window',
  },
  'server.la_sortie_maximale': {
    fr: 'La sortie maximale',
    en: 'The maximum output',
  },
  'server.la_sortie_maximale_ne_peut_pas_depasser_la_fenetre_de_contexte': {
    fr: 'La sortie maximale ne peut pas dépasser la fenêtre de contexte.',
    en: 'Maximum output cannot exceed the context window.',
  },
  'server.modele_original': {
    fr: 'Modèle original',
    en: 'Original model',
  },
  'server.le_fichier_models_json_ne_contient_pas_une_configuration_valide': {
    fr: 'Le fichier models.json ne contient pas une configuration valide.',
    en: 'The models.json file does not contain a valid configuration.',
  },
  'server.la_configuration_du_fournisseur_est_invalide': {
    fr: 'La configuration du fournisseur « {value1} » est invalide.',
    en: 'The configuration for provider “{value1}” is invalid.',
  },
  'server.la_liste_de_modeles_du_fournisseur_est_invalide': {
    fr: 'La liste de modèles du fournisseur « {value1} » est invalide.',
    en: 'The model list for provider “{value1}” is invalid.',
  },
  'server.un_modele_du_fournisseur_est_invalide': {
    fr: 'Un modèle du fournisseur « {value1} » est invalide.',
    en: 'A model from provider “{value1}” is invalid.',
  },
  'server.ce_fournisseur_integre_ou_deja_authentifie_ne_peut_etre_ajoute_q': {
    fr: 'Ce fournisseur intégré ou déjà authentifié ne peut être ajouté qu’avec un préréglage approuvé.',
    en: 'This built-in or already authenticated provider can only be added using an approved preset.',
  },
  'server.l_adresse_d_un_fournisseur_identifie_ne_peut_pas_etre_changee_ic': {
    fr: 'L’adresse d’un fournisseur identifié ne peut pas être changée ici, afin de protéger ses clés.',
    en: 'You cannot change an authenticated provider’s address here, to protect its keys.',
  },
  'server.le_fichier_models_json_est_absent_inaccessible_ou_trop_volumineu': {
    fr: 'Le fichier models.json est absent, inaccessible ou trop volumineux.',
    en: 'The models.json file is missing, inaccessible or too large.',
  },
  'server.impossible_de_lire_le_fichier_models_json': {
    fr: 'Impossible de lire le fichier models.json.',
    en: 'Unable to read models.json.',
  },
  'server.le_fichier_models_json_contient_un_json_invalide_corrigez_le_ava': {
    fr: 'Le fichier models.json contient un JSON invalide. Corrigez-le avant de continuer.',
    en: 'The models.json file contains invalid JSON. Fix it before continuing.',
  },
  'server.le_fichier_models_json_doit_etre_un_fichier_normal': {
    fr: 'Le fichier models.json doit être un fichier normal.',
    en: 'The models.json file must be a regular file.',
  },
  'server.la_sauvegarde_models_json_doit_etre_un_fichier_normal': {
    fr: 'La sauvegarde models.json doit être un fichier normal.',
    en: 'The models.json backup must be a regular file.',
  },
  'server.impossible_d_enregistrer_models_json_la_configuration_precedente': {
    fr: 'Impossible d’enregistrer models.json. La configuration précédente est conservée.',
    en: 'Unable to save models.json. The previous configuration has been preserved.',
  },
  'server.le_modele_a_modifier_est_introuvable': {
    fr: 'Le modèle à modifier est introuvable.',
    en: 'The model to edit was not found.',
  },
  'server.un_modele_utilise_deja_cet_identifiant_pour_ce_fournisseur': {
    fr: 'Un modèle utilise déjà cet identifiant pour ce fournisseur.',
    en: 'A model already uses this identifier for this provider.',
  },
  'server.ce_modele_est_deja_configure_utilisez_modifier': {
    fr: 'Ce modèle est déjà configuré. Utilisez Modifier.',
    en: 'This model is already configured. Use Edit.',
  },
  'server.la_limite_de_64_fournisseurs_est_atteinte': {
    fr: 'La limite de 64 fournisseurs est atteinte.',
    en: 'The limit of 64 providers has been reached.',
  },
  'server.la_limite_de_128_modeles_pour_ce_fournisseur_est_atteinte': {
    fr: 'La limite de 128 modèles pour ce fournisseur est atteinte.',
    en: 'The limit of 128 models for this provider has been reached.',
  },
  'server.la_limite_totale_de_512_modeles_personnalises_est_atteinte': {
    fr: 'La limite totale de 512 modèles personnalisés est atteinte.',
    en: 'The total limit of 512 custom models has been reached.',
  },
  'server.indiquez_la_variable_d_environnement_contenant_la_cle_du_fournis': {
    fr: 'Indiquez la variable d’environnement contenant la clé du fournisseur.',
    en: 'Specify the environment variable containing the provider’s key.',
  },
  'server.modele_personnalise_introuvable': {
    fr: 'Modèle personnalisé introuvable.',
    en: 'Custom model not found.',
  },
  'server.le_fichier_settings_json_est_inaccessible_ou_trop_volumineux': {
    fr: 'Le fichier settings.json est inaccessible ou trop volumineux.',
    en: 'The settings.json file is inaccessible or too large.',
  },
  'server.le_fichier_settings_json_contient_un_json_invalide_corrigez_le_a': {
    fr: 'Le fichier settings.json contient un JSON invalide. Corrigez-le avant de continuer.',
    en: 'The settings.json file contains invalid JSON. Fix it before continuing.',
  },
  'server.le_fichier_settings_json_contient_un_json_invalide': {
    fr: 'Le fichier settings.json contient un JSON invalide.',
    en: 'The settings.json file contains invalid JSON.',
  },
  'server.la_sauvegarde_settings_json_doit_etre_un_fichier_normal': {
    fr: 'La sauvegarde settings.json doit être un fichier normal.',
    en: 'The settings.json backup must be a regular file.',
  },
  'server.impossible_d_enregistrer_settings_json_la_configuration_preceden': {
    fr: 'Impossible d’enregistrer settings.json. La configuration précédente est conservée.',
    en: 'Unable to save settings.json. The previous configuration has been preserved.',
  },
  'server.ces_reglages_ont_change_dans_une_autre_fenetre_rechargez_les_ava': {
    fr: 'Ces réglages ont changé dans une autre fenêtre. Rechargez-les avant d’enregistrer.',
    en: 'These settings changed in another window. Reload them before saving.',
  },
  'server.nom_mcp_invalide_1_a_64_lettres_chiffres_tirets_ou_underscores': {
    fr: 'Nom MCP invalide : 1 à 64 lettres, chiffres, tirets ou underscores.',
    en: 'Invalid MCP name: use 1 to 64 letters, digits, hyphens or underscores.',
  },
  'server.les_delais_doivent_etre_compris_entre_1_000_et_300_000_ms': {
    fr: 'Les délais doivent être compris entre 1 000 et 300 000 ms.',
    en: 'Timeouts must be between 1,000 and 300,000 ms.',
  },
  'server.utilisez_une_adresse_http_s_sans_identifiants_integres_ni_fragme': {
    fr: 'Utilisez une adresse HTTP(S) sans identifiants intégrés ni fragment.',
    en: 'Use an HTTP(S) address without embedded credentials or a fragment.',
  },
  'server.oauth_necessite_https': {
    fr: 'OAuth nécessite HTTPS.',
    en: 'OAuth requires HTTPS.',
  },
  'server.en_tetes_http_invalides': {
    fr: 'En-têtes HTTP invalides.',
    en: 'Invalid HTTP headers.',
  },
  'server.nom_d_en_tete_http_invalide': {
    fr: 'Nom d’en-tête HTTP invalide.',
    en: 'Invalid HTTP header name.',
  },
  'server.valeur_d_en_tete': {
    fr: 'Valeur d’en-tête',
    en: 'Header value',
  },
  'server.retour_a_la_ligne_interdit_dans_un_en_tete': {
    fr: 'Retour à la ligne interdit dans un en-tête.',
    en: 'Line breaks are not allowed in headers.',
  },
  'server.pour_changer_d_adresse_retirez_ou_remplacez_les_en_tetes_prives_': {
    fr: 'Pour changer d’adresse, retirez ou remplacez les en-têtes privés conservés.',
    en: 'To change the address, remove or replace the preserved private headers.',
  },
  'server.indiquez_un_executable_avec_ses_arguments_dans_la_liste_separee': {
    fr: 'Indiquez un exécutable, avec ses arguments dans la liste séparée.',
    en: 'Specify an executable, with its arguments in the separate list.',
  },
  'server.le_dossier_de_travail_doit_etre_un_chemin_absolu_sur_le_pc': {
    fr: 'Le dossier de travail doit être un chemin absolu sur le PC.',
    en: 'The working folder must be an absolute path on the PC.',
  },
  'server.utilisez_des_references_de_variables': {
    fr: 'Utilisez des références de variables : { "TOKEN": { "env": "MON_TOKEN" } }.',
    en: 'Use variable references: { "TOKEN": { "env": "MY_TOKEN" } }.',
  },
  'server.settings_json_doit_etre_un_fichier_normal_de_moins_de_2_mo': {
    fr: 'settings.json doit être un fichier normal de moins de 2 Mo.',
    en: 'settings.json must be a regular file smaller than 2 MB.',
  },
  'server.settings_json_contient_une_configuration_invalide_le_fichier_est': {
    fr: 'settings.json contient une configuration invalide. Le fichier est conservé.',
    en: 'settings.json contains an invalid configuration. The file has been preserved.',
  },
  'server.retirez_la_configuration_qui_masque_cette_integration_native': {
    fr: 'Retirez la configuration qui masque cette intégration native.',
    en: 'Remove the configuration hiding this native integration.',
  },
  'server.ce_serveur_a_ete_modifie_ailleurs_rechargez_la_liste_avant_de_re': {
    fr: 'Ce serveur a été modifié ailleurs. Rechargez la liste avant de réessayer.',
    en: 'This server was changed elsewhere. Reload the list before trying again.',
  },
  'server.ce_nom_est_reserve_a_une_integration_native_choisissez_un_autre_': {
    fr: 'Ce nom est réservé à une intégration native. Choisissez un autre nom.',
    en: 'This name is reserved for a native integration. Choose another name.',
  },
  'server.rechargez_la_liste_ce_serveur_a_change': {
    fr: 'Rechargez la liste : ce serveur a changé.',
    en: 'Reload the list: this server has changed.',
  },
  'server.la_configuration_a_change_pendant_la_connexion': {
    fr: 'La configuration a changé pendant la connexion.',
    en: 'The configuration changed during sign-in.',
  },
  'server.impossible_de_conserver_la_connexion_oauth': {
    fr: 'Impossible de conserver la connexion OAuth.',
    en: 'Unable to preserve the OAuth connection.',
  },
  'server.la_gestion_mcp_est_en_cours_de_fermeture': {
    fr: 'La gestion MCP est en cours de fermeture.',
    en: 'MCP management is shutting down.',
  },
  'server.deux_tests_mcp_sont_deja_en_cours': {
    fr: 'Deux tests MCP sont déjà en cours.',
    en: 'Two MCP tests are already running.',
  },
  'server.le_moteur_python_configure_est_introuvable': {
    fr: 'Le moteur Python configuré est introuvable. Vérifiez le chemin PRIME_AGENT_KERNEL_PYTHON sur ce PC.',
    en: 'The configured Python engine was not found. Check the PRIME_AGENT_KERNEL_PYTHON path on this PC.',
  },
  'server.la_preparation_automatique_de_python_a_echoue': {
    fr: 'La préparation automatique de Python a échoué. Vérifiez que Prime Agent et uv sont installés, puis réessayez.',
    en: 'Automatic Python setup failed. Check that Prime Agent and uv are installed, then try again.',
  },
  'server.le_test_mcp_a_depasse_le_delai_de_connexion': {
    fr: 'Le test MCP a dépassé le délai de connexion.',
    en: 'The MCP test exceeded the connection timeout.',
  },
  'server.le_catalogue_mcp_depasse_la_taille_autorisee': {
    fr: 'Le catalogue MCP dépasse la taille autorisée.',
    en: 'The MCP catalog exceeds the allowed size.',
  },
  'server.impossible_de_lancer_le_test_mcp': {
    fr: 'Impossible de lancer le test MCP.',
    en: 'Unable to start the MCP test.',
  },
  'server.connexion_mcp_impossible_verifiez_la_commande_ou_l_url_les_varia': {
    fr: 'Connexion MCP impossible. Vérifiez la commande ou l’URL, les variables et l’authentification.',
    en: 'Unable to connect to the MCP. Check the command or URL, variables and authentication.',
  },
  'server.deux_connexions_oauth_sont_deja_en_cours': {
    fr: 'Deux connexions OAuth sont déjà en cours.',
    en: 'Two OAuth sign-ins are already running.',
  },
  'server.connexion_expiree_relancez_la_pour_reessayer': {
    fr: 'Connexion expirée. Relancez-la pour réessayer.',
    en: 'Sign-in expired. Start again to retry.',
  },
  'server.reponse_oauth_invalide': {
    fr: 'Réponse OAuth invalide.',
    en: 'Invalid OAuth response.',
  },
  'server.impossible_de_demarrer_la_connexion_oauth': {
    fr: 'Impossible de démarrer la connexion OAuth.',
    en: 'Unable to start OAuth sign-in.',
  },
  'server.la_connexion_oauth_a_ete_interrompue': {
    fr: 'La connexion OAuth a été interrompue.',
    en: 'OAuth sign-in was interrupted.',
  },
  'server.connexion_oauth_introuvable_ou_expiree': {
    fr: 'Connexion OAuth introuvable ou expirée.',
    en: 'OAuth sign-in not found or expired.',
  },
  'server.cette_connexion_n_attend_pas_de_reponse': {
    fr: 'Cette connexion n’attend pas de réponse.',
    en: 'This sign-in is not waiting for a response.',
  },
  'server.collez_l_adresse_complete_obtenue_apres_autorisation': {
    fr: 'Collez l’adresse complète obtenue après autorisation.',
    en: 'Paste the full address obtained after authorization.',
  },
  'server.cette_adresse_de_retour_ne_correspond_pas_a_la_connexion_en_cour': {
    fr: 'Cette adresse de retour ne correspond pas à la connexion en cours.',
    en: 'This return address does not match the current sign-in.',
  },
  'server.la_variable_prime_api_key_et_la_configuration_prime_cli_sont_pri': {
    fr: 'La variable PRIME_API_KEY et la configuration Prime CLI sont prioritaires sur la clé enregistrée ici. Elles restent gérées séparément.',
    en: 'The PRIME_API_KEY variable and Prime CLI configuration take priority over the key saved here. They remain managed separately.',
  },
  'server.utilisez_un_profil_aws_ou_les_variables_aws_du_pc_ces_reglages_r': {
    fr: 'Utilisez un profil AWS ou les variables AWS du PC. Ces réglages restent gérés par votre environnement.',
    en: 'Use an AWS profile or the PC’s AWS variables. These settings remain managed by your environment.',
  },
  'server.configurez_les_identifiants_google_cloud_le_projet_et_la_region_': {
    fr: 'Configurez les identifiants Google Cloud, le projet et la région dans l’environnement du PC.',
    en: 'Configure Google Cloud credentials, project and region in the PC’s environment.',
  },
  'server.la_cle_peut_etre_enregistree_ici_l_adresse_azure_et_les_deploiem': {
    fr: 'La clé peut être enregistrée ici. L’adresse Azure et les déploiements se règlent dans l’environnement du PC.',
    en: 'You can save the key here. Configure the Azure address and deployments in the PC’s environment.',
  },
  'server.la_cle_peut_etre_enregistree_ici_le_compte_et_la_passerelle_clou': {
    fr: 'La clé peut être enregistrée ici. Le compte et la passerelle Cloudflare se règlent dans l’environnement du PC.',
    en: 'You can save the key here. Configure the Cloudflare account and gateway in the PC’s environment.',
  },
  'server.la_cle_peut_etre_enregistree_ici_le_compte_cloudflare_se_regle_d': {
    fr: 'La clé peut être enregistrée ici. Le compte Cloudflare se règle dans l’environnement du PC.',
    en: 'You can save the key here. Configure the Cloudflare account in the PC’s environment.',
  },
  'server.le_fichier_de_configuration_doit_etre_un_fichier_local_de_taille': {
    fr: 'Le fichier de configuration doit être un fichier local de taille normale.',
    en: 'The configuration file must be a local file of normal size.',
  },
  'server.installez_prime_agent_pour_gerer_les_fournisseurs': {
    fr: 'Installez Prime Agent pour gérer les fournisseurs.',
    en: 'Install Prime Agent to manage providers.',
  },
  'server.le_fichier_auth_json_est_invalide_les_connexions_existantes_ont_': {
    fr: 'Le fichier auth.json est invalide. Les connexions existantes ont été conservées.',
    en: 'The auth.json file is invalid. Existing connections have been preserved.',
  },
  'server.impossible_de_lire_les_connexions_existantes_corrigez_auth_json_': {
    fr: 'Impossible de lire les connexions existantes. Corrigez auth.json avant de continuer.',
    en: 'Unable to read existing connections. Fix auth.json before continuing.',
  },
  'server.fournisseur_inconnu_ajoutez_d_abord_ses_modeles_dans_le_configur': {
    fr: 'Fournisseur inconnu. Ajoutez d’abord ses modèles dans le configurateur.',
    en: 'Unknown provider. Add its models in the configurator first.',
  },
  'server.cette_connexion_a_change_actualisez_la_liste_avant_de_reessayer': {
    fr: 'Cette connexion a changé. Actualisez la liste avant de réessayer.',
    en: 'This connection has changed. Refresh the list before trying again.',
  },
  'server.impossible_de_lire_les_connexions_existantes': {
    fr: 'Impossible de lire les connexions existantes.',
    en: 'Unable to read existing connections.',
  },
  'server.la_connexion_n_a_pas_pu_etre_enregistree': {
    fr: 'La connexion n’a pas pu être enregistrée.',
    en: 'The connection could not be saved.',
  },
  'server.certaines_definitions_de_modeles_ne_peuvent_pas_etre_chargees_ve': {
    fr: 'Certaines définitions de modèles ne peuvent pas être chargées. Vérifiez le configurateur de modèles.',
    en: 'Some model definitions cannot be loaded. Check the model configurator.',
  },
  'server.ce_fournisseur_utilise_un_autre_mode_de_connexion': {
    fr: 'Ce fournisseur utilise un autre mode de connexion.',
    en: 'This provider uses a different sign-in method.',
  },
  'server.saisissez_une_cle_valide_sans_espaces_ni_commande': {
    fr: 'Saisissez une clé valide, sans espaces ni commande.',
    en: 'Enter a valid key, without spaces or commands.',
  },
  'server.mode_de_cle_invalide': {
    fr: 'Mode de clé invalide.',
    en: 'Invalid key mode.',
  },
  'server.nom_de_variable_invalide': {
    fr: 'Nom de variable invalide.',
    en: 'Invalid variable name.',
  },
  'server.cette_variable_est_absente_ou_vide_dans_l_environnement_du_studi': {
    fr: 'Cette variable est absente ou vide dans l’environnement du Studio. Configurez-la sur le PC avant de continuer.',
    en: 'This variable is missing or empty in the Studio’s environment. Configure it on the PC before continuing.',
  },
  'server.cette_valeur_correspond_a_une_variable_du_pc_choisissez_le_mode_': {
    fr: 'Cette valeur correspond à une variable du PC. Choisissez le mode Variable d’environnement.',
    en: 'This value matches a PC variable. Choose Environment variable mode.',
  },
  'server.cette_connexion_est_geree_en_dehors_du_studio': {
    fr: 'Cette connexion est gérée en dehors du Studio.',
    en: 'This connection is managed outside the Studio.',
  },
  'server.la_connexion_par_compte_n_est_pas_disponible_pour_ce_fournisseur': {
    fr: 'La connexion par compte n’est pas disponible pour ce fournisseur.',
    en: 'Account sign-in is not available for this provider.',
  },
  'server.la_gestion_des_fournisseurs_est_en_cours_de_fermeture': {
    fr: 'La gestion des fournisseurs est en cours de fermeture.',
    en: 'Provider management is shutting down.',
  },
  'server.attendez_la_fin_des_executions_du_studio_pour_remplacer_ou_retir': {
    fr: 'Attendez la fin des exécutions du Studio pour remplacer ou retirer une connexion. Vous pouvez ajouter un autre fournisseur.',
    en: 'Wait for Studio runs to finish before replacing or removing a connection. You can add another provider.',
  },
  'server.reponse_du_fournisseur_trop_volumineuse': {
    fr: 'Réponse du fournisseur trop volumineuse.',
    en: 'Provider response too large.',
  },
  'server.reponse_du_fournisseur_invalide': {
    fr: 'Réponse du fournisseur invalide.',
    en: 'Invalid provider response.',
  },
  'server.impossible_de_demarrer_la_connexion': {
    fr: 'Impossible de démarrer la connexion.',
    en: 'Unable to start sign-in.',
  },
  'server.la_connexion_a_ete_interrompue': {
    fr: 'La connexion a été interrompue.',
    en: 'Sign-in was interrupted.',
  },
  'server.une_modification_de_ce_fournisseur_est_deja_en_cours': {
    fr: 'Une modification de ce fournisseur est déjà en cours.',
    en: 'A change to this provider is already in progress.',
  },
  'server.le_chargement_a_expire_reessayez': {
    fr: 'Le chargement a expiré. Réessayez.',
    en: 'Loading timed out. Please try again.',
  },
  'server.une_connexion_a_ce_fournisseur_est_deja_en_cours': {
    fr: 'Une connexion à ce fournisseur est déjà en cours.',
    en: 'Sign-in to this provider is already in progress.',
  },
  'server.connexion_introuvable_ou_expiree': {
    fr: 'Connexion introuvable ou expirée.',
    en: 'Sign-in not found or expired.',
  },
  'server.cette_etape_de_connexion_n_attend_plus_de_reponse': {
    fr: 'Cette étape de connexion n’attend plus de réponse.',
    en: 'This sign-in step is no longer waiting for a response.',
  },
  'server.saisissez_une_reponse_valide': {
    fr: 'Saisissez une réponse valide.',
    en: 'Enter a valid response.',
  },
  'server.ce_type_de_fichier_ne_peut_pas_etre_ouvert_depuis_le_studio': {
    fr: 'Ce type de fichier ne peut pas être ouvert depuis le Studio.',
    en: 'This file type cannot be opened from the Studio.',
  },
  'server.fichier_invalide': {
    fr: 'Fichier invalide.',
    en: 'Invalid file.',
  },
  'server.le_pc_n_a_pas_pu_ouvrir_ce_fichier_verifiez_qu_une_application_e': {
    fr: 'Le PC n’a pas pu ouvrir ce fichier. Vérifiez qu’une application est associée à ce format.',
    en: 'The PC could not open this file. Check that an application is associated with this format.',
  },
  'server.impossible_d_afficher_ce_dossier_dans_l_explorateur_du_pc_reessa': {
    fr: 'Impossible d’afficher ce dossier dans l’Explorateur du PC. Réessayez.',
    en: 'Unable to show this folder in the PC’s File Explorer. Please try again.',
  },
  'server.impossible_d_ouvrir_ce_dossier_sur_le_pc_reessayez': {
    fr: 'Impossible d’ouvrir ce dossier sur le PC. Réessayez.',
    en: 'Unable to open this folder on the PC. Please try again.',
  },
  'common.configuration': {
    fr: 'Configuration',
    en: 'Configuration',
  },
  'commands.skill': {
    fr: 'Skill',
    en: 'Skill',
  },
  'commands.skills': {
    fr: 'Skills',
    en: 'Skills',
  },
  'commands.prompt': {
    fr: 'Prompt',
    en: 'Prompt',
  },
  'commands.prompts': {
    fr: 'Prompts',
    en: 'Prompts',
  },
  'commands.extension': {
    fr: 'Extension',
    en: 'Extension',
  },
  'commands.terminal': {
    fr: 'Terminal',
    en: 'Terminal',
  },
  'example.projectPath': {
    fr: 'C:\\Users\\vous\\Projets\\mon-projet',
    en: 'C:\\Users\\you\\Projects\\my-project',
  },
  'example.provider': {
    fr: 'ex. opencode',
    en: 'e.g. opencode',
  },
  'example.model': {
    fr: 'ex. mon-modele',
    en: 'e.g. my-model',
  },
  'example.keyVariable': {
    fr: 'ex. PROVIDER_API_KEY',
    en: 'e.g. PROVIDER_API_KEY',
  },
  'example.baseUrl': {
    fr: 'https://api.exemple.fr/v1',
    en: 'https://api.example.com/v1',
  },
  'example.mcpUrl': {
    fr: 'https://exemple.fr/mcp',
    en: 'https://example.com/mcp',
  },
  'example.mcpName': {
    fr: 'mon-service',
    en: 'my-service',
  },
  'example.tokenVariable': {
    fr: 'MON_SERVICE_TOKEN',
    en: 'MY_SERVICE_TOKEN',
  },
  'example.mcpCwd': {
    fr: 'C:\\mes-outils',
    en: 'C:\\my-tools',
  },
  'example.mcpHeaders': {
    fr: '{"X-Service": "valeur"}',
    en: '{"X-Service": "value"}',
  },
  'ui.configurer': {
    fr: 'Configurer',
    en: 'Configure',
  },
  'ui.moyen': {
    fr: 'Moyen',
    en: 'Medium',
  },
  'ui.minimal': {
    fr: 'Minimal',
    en: 'Minimal',
  },
  'ui.obligatoire': {
    fr: 'obligatoire',
    en: 'required',
  },
  'ui.facultatif': {
    fr: 'facultatif',
    en: 'optional',
  },
  'ui.connexion': {
    fr: 'Connexion…',
    en: 'Connecting…',
  },
  'ui.local': {
    fr: 'LOCAL',
    en: 'LOCAL',
  },
  'server.ecrivez_un_message_avant_de_l_envoyer': {
    fr: 'Écrivez un message avant de l’envoyer.',
    en: 'Write a message before sending it.',
  },
  'server.projet_invalide': {
    fr: 'Projet invalide.',
    en: 'Invalid project.',
  },
  'server.choisissez_un_projet_pour_modifier_ses_sous_agents': {
    fr: 'Choisissez un projet pour modifier ses sous-agents.',
    en: 'Choose a project to change its subagent settings.',
  },
  'server.route_introuvable': {
    fr: 'Route introuvable.',
    en: 'Route not found.',
  },
  'server.port_mobile_invalide': {
    fr: 'Port mobile invalide.',
    en: 'Invalid mobile access port.',
  },
  'server.port_de_passerelle_invalide': {
    fr: 'Port de passerelle invalide.',
    en: 'Invalid gateway port.',
  },
  'server.contexte_optimise': {
    fr: 'Contexte optimisé.',
    en: 'Context optimized.',
  },
  'server.le_runtime_est_en_cours_d_arret': {
    fr: 'Le runtime est en cours d’arrêt.',
    en: 'The runtime is shutting down.',
  },
  'server.parametres_de_session_invalides': {
    fr: 'Paramètres de session invalides.',
    en: 'Invalid session parameters.',
  },
  'server.le_dossier_du_projet_est_introuvable': {
    fr: 'Le dossier du projet est introuvable.',
    en: 'The project folder could not be found.',
  },
  'server.le_message_depasse_512_ko': {
    fr: 'Le message dépasse 512 Ko.',
    en: 'The message exceeds 512 KB.',
  },
  'server.fichier_de_session_introuvable': {
    fr: 'Fichier de session introuvable.',
    en: 'Session file not found.',
  },
  'server.le_fournisseur_de_modele_a_renvoye_une_erreur': {
    fr: 'Le fournisseur de modèle a renvoyé une erreur.',
    en: 'The model provider returned an error.',
  },
  'server.une_reponse_de_prime_agent_depasse_la_limite_de_lecture_16_mo': {
    fr: 'Une réponse de Prime Agent dépasse la limite de lecture (16 Mo).',
    en: 'A Prime Agent response exceeds the read limit (16 MB).',
  },
  'server.commande_inconnue_dans_ce_projet_ouvrez_le_menu_pour_choisir_une': {
    fr: 'Commande /{value1} inconnue dans ce projet. Ouvrez le menu / pour choisir une commande.',
    en: 'Unknown command /{value1} in this project. Open the / menu to choose a command.',
  },
  'server.installez_prime_agent_pour_utiliser_ses_commandes_et_skills': {
    fr: 'Installez Prime Agent pour utiliser ses commandes et skills.',
    en: 'Install Prime Agent to use its commands and skills.',
  },
  'server.le_dossier_de_prime_agent_est_introuvable': {
    fr: 'Le dossier de Prime Agent est introuvable.',
    en: 'The Prime Agent folder could not be found.',
  },
  'server.le_moteur_est_en_cours_d_arret': {
    fr: 'Le moteur est en cours d’arrêt.',
    en: 'The engine is shutting down.',
  },
  'server.le_moteur_de_recuperation_ne_fournit_pas_une_identite_valide': {
    fr: 'Le moteur de récupération ne fournit pas une identité valide.',
    en: 'The recovery engine did not provide a valid identity.',
  },
  'server.moteur_arrete': {
    fr: 'Moteur arrêté ({value1}).',
    en: 'Engine stopped ({value1}).',
  },
  'server.le_moteur_prime_agent_s_est_arrete_au_demarrage': {
    fr: 'Le moteur Prime Agent s’est arrêté au démarrage.',
    en: 'The Prime Agent engine stopped during startup.',
  },
  'server.le_moteur_ne_correspond_pas_au_processus_lance_par_le_studio': {
    fr: 'Le moteur ne correspond pas au processus lancé par le studio.',
    en: 'The engine does not match the process started by Studio.',
  },
  'server.ajoutez_au_maximum_8_fichiers': {
    fr: 'Ajoutez au maximum 8 fichiers.',
    en: 'Add up to 8 files.',
  },
  'server.limite_10_mo_par_fichier': {
    fr: 'Limite : 10 Mo par fichier.',
    en: 'Limit: 10 MB per file.',
  },
  'server.limite_10_mo_par_fichier_et_20_mo_de_fichiers_par_message': {
    fr: 'Limite : 10 Mo par fichier et 20 Mo de fichiers par message.',
    en: 'Limit: 10 MB per file and 20 MB of files per message.',
  },
  'server.ajoutez_au_maximum_4_images': {
    fr: 'Ajoutez au maximum 4 images.',
    en: 'Add up to 4 images.',
  },
  'server.limite_4_mo_par_image_et_8_mo_par_message': {
    fr: 'Limite : 4 Mo par image et 8 Mo par message.',
    en: 'Limit: 4 MB per image and 8 MB per message.',
  },
  'server.preparation_du_noyau_annulee': {
    fr: 'Préparation du noyau annulée.',
    en: 'Kernel setup cancelled.',
  },
  'server.la_decouverte_des_skills_python_a_depasse_30_s': {
    fr: 'La découverte des skills Python a dépassé 30 s.',
    en: 'Python skill discovery timed out after 30 s.',
  },
  'server.la_decouverte_native_des_skills_a_echoue': {
    fr: 'La découverte native des skills a échoué. {value1}',
    en: 'Native skill discovery failed. {value1}',
  },
  'server.skills_python': {
    fr: 'Skills Python : {value1}',
    en: 'Python skills: {value1}',
  },
  'server.nom_du_package_python_absent_dans_pyproject_toml': {
    fr: 'Nom du package Python absent dans {value1}/pyproject.toml.',
    en: 'Python package name missing in {value1}/pyproject.toml.',
  },
  'server.package_python_introuvable': {
    fr: 'Package Python introuvable : {value1}',
    en: 'Python package not found: {value1}',
  },
  'server.deux_packages_python_locaux_portent_le_meme_nom_et': {
    fr: 'Deux packages Python locaux portent le même nom « {value1} » : {value2} et {value3}.',
    en: 'Two local Python packages share the name “{value1}”: {value2} and {value3}.',
  },
  'server.la_liste_des_dependances_python_est_invalide_dans': {
    fr: 'La liste des dépendances Python est invalide dans {value1}.',
    en: 'The Python dependency list is invalid in {value1}.',
  },
  'server.dependance_python_invalide_dans': {
    fr: 'Dépendance Python invalide dans {value1}.',
    en: 'Invalid Python dependency in {value1}.',
  },
  'server.dependance_locale_ambigue_pour': {
    fr: 'Dépendance locale ambiguë « {value1} » pour {value2}.',
    en: 'Ambiguous local dependency “{value1}” for {value2}.',
  },
  'server.le_delai_de_s_est_depasse_pour_vous_pouvez_relancer_npm_run_setup': {
    fr: 'Le délai de {value1} s est dépassé pour {value2}. Vous pouvez relancer « npm run setup:runtime ».',
    en: 'The {value1} s timeout was exceeded for {value2}. You can run “npm run setup:runtime” again.',
  },
  'server.une_autre_preparation_du_noyau_est_toujours_en_cours_reessayez_ap': {
    fr: 'Une autre préparation du noyau est toujours en cours. Réessayez après sa fin.',
    en: 'Another kernel setup is still running. Try again when it finishes.',
  },
  'server.resultat_de_validation_invalide': {
    fr: 'Résultat de validation invalide.',
    en: 'Invalid validation result.',
  },
  'server.verification_du_python': {
    fr: 'Vérification du Python {value1} : {value2}',
    en: 'Checking Python {value1}: {value2}',
  },
  'server.python': {
    fr: 'Python {value1} — {value2} « {value3} » : {value4}',
    en: 'Python {value1} — {value2} “{value3}”: {value4}',
  },
  'server.avertissement': {
    fr: 'Avertissement : {value1}',
    en: 'Warning: {value1}',
  },
  'server.le_runtime_python_fourni_avec_prime_agent_est_introuvable_reinsta': {
    fr: 'Le runtime Python fourni avec Prime Agent est introuvable. Réinstallez Prime Agent.',
    en: 'The Python runtime bundled with Prime Agent could not be found. Reinstall Prime Agent.',
  },
  'server.preparation_du_noyau_python_local': {
    fr: 'Préparation du noyau Python local…',
    en: 'Preparing the local Python kernel…',
  },
  'server.installation_du_runtime_et_de_skills_python': {
    fr: 'Installation du runtime et de {value1} skills Python…',
    en: 'Installing the runtime and {value1} Python skills…',
  },
  'server.noyau_python_pret_runtime_et_skills_verifies': {
    fr: 'Noyau Python prêt : runtime et {value1} skills vérifiés.',
    en: 'Python kernel ready: runtime and {value1} skills verified.',
  },
  'server.formulaire_attendu': {
    fr: 'Formulaire attendu.',
    en: 'A form is required.',
  },
  'server.formulaire_trop_long': {
    fr: 'Formulaire trop long.',
    en: 'The form is too large.',
  },
  'server.session_ou_projet_invalide': {
    fr: 'Session ou projet invalide.',
    en: 'Invalid session or project.',
  },
  'server.demande_invalide': {
    fr: 'Demande invalide.',
    en: 'Invalid request.',
  },
  'server.mode_d_envoi_invalide': {
    fr: 'Mode d’envoi invalide.',
    en: 'Invalid delivery mode.',
  },
  'server.session_invalide': {
    fr: 'Session invalide.',
    en: 'Invalid session.',
  },
  'server.stockage_des_fichiers_indisponible': {
    fr: 'Stockage des fichiers indisponible.',
    en: 'File storage is unavailable.',
  },
  'server.message_en_attente_invalide': {
    fr: 'Message en attente invalide.',
    en: 'Invalid queued message.',
  },
  'server.modification_invalide': {
    fr: 'Modification invalide.',
    en: 'Invalid change.',
  },
  'server.supprimez_puis_renvoyez_ce_message_pour_le_remplacer_par_une_comm': {
    fr: 'Supprimez puis renvoyez ce message pour le remplacer par une commande de session, ou inversement.',
    en: 'Delete and resend this message to replace it with a session command, or vice versa.',
  },
  'server.cette_session_n_est_plus_disponible_en_direct': {
    fr: 'Cette session n’est plus disponible en direct.',
    en: 'This session is no longer available live.',
  },
  'server.la_session_ou_le_dossier_du_projet_est_invalide': {
    fr: 'La session ou le dossier du projet est invalide.',
    en: 'The session or project folder is invalid.',
  },
  'server.le_message_est_vide_ou_depasse_512_ko': {
    fr: 'Le message est vide ou dépasse 512 Ko.',
    en: 'The message is empty or exceeds 512 KB.',
  },
  'server.le_point_d_acces_au_moteur_est_invalide': {
    fr: 'Le point d’accès au moteur est invalide.',
    en: 'The engine endpoint is invalid.',
  },
  'server.le_moteur_n_a_pas_confirme_cette_action_verifiez_la_file_avant_de': {
    fr: 'Le moteur n’a pas confirmé cette action. Vérifiez la file avant de réessayer.',
    en: 'The engine did not confirm this action. Check the queue before trying again.',
  },
  'server.le_moteur_a_refuse_cette_action_sur_la_session_active': {
    fr: 'Le moteur a refusé cette action sur la session active.',
    en: 'The engine rejected this action on the active session.',
  },
  'server.le_mode_d_envoi_est_invalide': {
    fr: 'Le mode d’envoi est invalide.',
    en: 'The delivery mode is invalid.',
  },
  'server.ce_modele_ne_prend_pas_en_charge_les_images': {
    fr: 'Ce modèle ne prend pas en charge les images.',
    en: 'This model does not support images.',
  },
  'server.une_commande_de_session_s_ecrit_sur_une_seule_ligne_sans_image': {
    fr: 'Une commande de session s’écrit sur une seule ligne, sans image.',
    en: 'A session command must be on one line with no image.',
  },
  'server.la_position_dans_la_file_est_invalide': {
    fr: 'La position dans la file est invalide.',
    en: 'The queue position is invalid.',
  },
  'server.la_modification_de_la_file_est_invalide': {
    fr: 'La modification de la file est invalide.',
    en: 'The queue change is invalid.',
  },
  'server.le_moteur_a_renvoye_une_reponse_de_file_invalide': {
    fr: 'Le moteur a renvoyé une réponse de file invalide.',
    en: 'The engine returned an invalid queue response.',
  },
  'server.configuration_mcp_invalide': {
    fr: 'Configuration MCP invalide.',
    en: 'Invalid MCP configuration.',
  },
  'server.option_mcp_inconnue': {
    fr: 'Option MCP inconnue.',
    en: 'Unknown MCP option.',
  },
  'server.option_invalide': {
    fr: 'Option {value1} invalide.',
    en: 'Invalid {value1} option.',
  },
  'server.adresse_http': {
    fr: 'Adresse HTTP',
    en: 'HTTP address',
  },
  'server.adresse_http_s_invalide': {
    fr: 'Adresse HTTP(S) invalide.',
    en: 'Invalid HTTP(S) address.',
  },
  'server.indiquez_le_nom_de_la_variable_d_environnement_du_jeton': {
    fr: 'Indiquez le nom de la variable d’environnement du jeton.',
    en: 'Enter the name of the token environment variable.',
  },
  'server.choisissez_oauth_ou_un_jeton_par_variable_pas_les_deux': {
    fr: 'Choisissez OAuth ou un jeton par variable, pas les deux.',
    en: 'Choose OAuth or a token environment variable, not both.',
  },
  'server.variables_d_environnement_invalides': {
    fr: 'Variables d’environnement invalides.',
    en: 'Invalid environment variables.',
  },
  'server.transport_mcp_non_pris_en_charge_choisissez_http_ou_stdio': {
    fr: 'Transport MCP non pris en charge. Choisissez HTTP ou stdio.',
    en: 'Unsupported MCP transport. Choose HTTP or stdio.',
  },
  'server.serveur_mcp_introuvable': {
    fr: 'Serveur MCP introuvable.',
    en: 'MCP server not found.',
  },
  'server.activation_mcp_invalide': {
    fr: 'Activation MCP invalide.',
    en: 'Invalid MCP activation.',
  },
  'server.terminez_ou_annulez_la_connexion_oauth_de_ce_serveur_avant_de_le': {
    fr: 'Terminez ou annulez la connexion OAuth de ce serveur avant de le modifier.',
    en: 'Complete or cancel this server’s OAuth sign-in before editing it.',
  },
  'server.activez_ce_serveur_avant_de_le_tester': {
    fr: 'Activez ce serveur avant de le tester.',
    en: 'Enable this server before testing it.',
  },
  'server.activez_oauth_sur_ce_serveur_avant_de_vous_connecter': {
    fr: 'Activez OAuth sur ce serveur avant de vous connecter.',
    en: 'Enable OAuth on this server before signing in.',
  },
  'server.adresse_api_invalide': {
    fr: 'Adresse API invalide.',
    en: 'Invalid API address.',
  },
  'server.option_de_raisonnement_invalide': {
    fr: 'Option de raisonnement invalide.',
    en: 'Invalid reasoning option.',
  },
  'server.installez_prime_agent_pour_gerer_les_mcp': {
    fr: 'Installez Prime Agent pour gérer les MCP.',
    en: 'Install Prime Agent to manage MCPs.',
  },
  'server.la_gestion_mcp_necessite_une_version_compatible_de_prime_agent': {
    fr: 'La gestion MCP nécessite une version compatible de Prime Agent.',
    en: 'MCP management requires a compatible version of Prime Agent.',
  },
  'server.chemin_de_fichier_invalide': {
    fr: 'Chemin de fichier invalide.',
    en: 'Invalid file path.',
  },
  'server.choisissez_un_fichier': {
    fr: 'Choisissez un fichier.',
    en: 'Choose a file.',
  },
  'server.indiquez_le_chemin_du_document_dans_le_projet_pour_le_retrouver': {
    fr: 'Indiquez le chemin du document dans le projet pour le retrouver.',
    en: 'Enter the document’s path within the project to find it.',
  },
  'server.plusieurs_fichiers_portent_ce_nom_indiquez_leur_chemin_dans_le_pr': {
    fr: 'Plusieurs fichiers portent ce nom. Indiquez leur chemin dans le projet.',
    en: 'Several files share this name. Enter their path within the project.',
  },
  'server.document_introuvable_dans_ce_projet': {
    fr: 'Document introuvable dans ce projet.',
    en: 'Document not found in this project.',
  },
  'server.page_invalide': {
    fr: 'Page invalide.',
    en: 'Invalid page.',
  },
  'server.choisissez_un_dossier': {
    fr: 'Choisissez un dossier.',
    en: 'Choose a folder.',
  },
  'server.fournisseur_invalide': {
    fr: 'Fournisseur invalide.',
    en: 'Invalid provider.',
  },
  'server.actualisez_la_liste_des_fournisseurs': {
    fr: 'Actualisez la liste des fournisseurs.',
    en: 'Refresh the provider list.',
  },
  'server.connexion_impossible': {
    fr: 'Connexion impossible.',
    en: 'Unable to connect.',
  },
  'server.patientez_pendant_le_chargement_des_fournisseurs': {
    fr: 'Patientez pendant le chargement des fournisseurs.',
    en: 'Please wait while providers are loading.',
  },
  'server.terminez_ou_annulez_la_connexion_en_cours_avant_d_en_ouvrir_une_a': {
    fr: 'Terminez ou annulez la connexion en cours avant d’en ouvrir une autre.',
    en: 'Complete or cancel the current sign-in before starting another.',
  },
  'server.choix_invalide': {
    fr: 'Choix invalide.',
    en: 'Invalid choice.',
  },
  'server.enregistrement_en_cours_patientez_un_instant': {
    fr: 'Enregistrement en cours, patientez un instant.',
    en: 'Saving, please wait a moment.',
  },
  'server.une_origine_https_tailscale_exacte_est_requise_pour_la_pwa': {
    fr: 'Une origine HTTPS Tailscale exacte est requise pour la PWA.',
    en: 'An exact Tailscale HTTPS origin is required for the PWA.',
  },
  'server.session_introuvable_dans_ce_projet': {
    fr: 'Session introuvable dans ce projet.',
    en: 'Session not found in this project.',
  },
  'server.agent_invalide': {
    fr: 'Agent invalide.',
    en: 'Invalid agent.',
  },
  'server.historique_de_cet_agent_indisponible': {
    fr: 'Historique de cet agent indisponible.',
    en: 'This agent’s history is unavailable.',
  },
  'server.historique_trop_volumineux': {
    fr: 'Historique trop volumineux.',
    en: 'The history is too large.',
  },
  'server.historique_introuvable': {
    fr: 'Historique introuvable.',
    en: 'History not found.',
  },
  'server.indiquez_le_chemin_absolu_d_un_dossier_existant': {
    fr: 'Indiquez le chemin absolu d’un dossier existant.',
    en: 'Enter the absolute path of an existing folder.',
  },
  'server.session_introuvable': {
    fr: 'Session introuvable.',
    en: 'Session not found.',
  },
  'server.epinglage_invalide': {
    fr: 'Épinglage invalide.',
    en: 'Invalid pin setting.',
  },
  'server.projet_introuvable': {
    fr: 'Projet introuvable.',
    en: 'Project not found.',
  },
  'server.valeur_invalide': {
    fr: 'Valeur invalide.',
    en: 'Invalid value.',
  },
  'passkeys.title': { fr: 'Connexion avec une clé d’accès', en: 'Passkey sign-in' },
  'passkeys.intro': {
    fr: 'Optionnel : Face ID, empreinte ou code du téléphone. Le code d’accès reste disponible.',
    en: 'Optional: Face ID, fingerprint or device PIN. Your access code remains available.',
  },
  'passkeys.desktop': {
    fr: 'Créez une clé depuis votre appareil mobile en HTTPS. Gérez ici les clés enregistrées.',
    en: 'Create a passkey from your mobile device over HTTPS. Manage registered keys here.',
  },
  'passkeys.https': {
    fr: 'Ouvrez la PWA depuis son adresse HTTPS Tailscale pour utiliser les clés d’accès.',
    en: 'Open the PWA using its Tailscale HTTPS address to use passkeys.',
  },
  'passkeys.add': { fr: 'Créer une clé d’accès', en: 'Create a passkey' },
  'passkeys.login': { fr: 'Se connecter avec une clé d’accès', en: 'Sign in with a passkey' },
  'passkeys.failed': {
    fr: 'La vérification de la clé d’accès a échoué. Réessayez ou utilisez votre code.',
    en: 'Passkey verification failed. Try again or use your access code.',
  },
  'passkeys.retry': {
    fr: 'Trop de tentatives. Patientez avant de réessayer.',
    en: 'Too many attempts. Please wait before trying again.',
  },
  'passkeys.none': { fr: 'Aucune clé d’accès enregistrée.', en: 'No passkeys registered.' },
  'passkeys.waiting': { fr: 'Validez sur votre appareil…', en: 'Confirm on your device…' },
  'passkeys.cancelled': {
    fr: 'Opération annulée. Vous pouvez réessayer ou utiliser le code.',
    en: 'Cancelled. You can try again or use your code.',
  },
  'passkeys.revoke': { fr: 'Révoquer', en: 'Revoke' },
  'passkeys.revokeNote': {
    fr: 'Révoquer « {name} » et fermer ses connexions ? Le code d’accès restera utilisable.',
    en: 'Revoke “{name}” and close its connections? The access code will remain available.',
  },
  'passkeys.registerNote': {
    fr: 'Confirmez votre code d’accès actuel, puis validez sur votre téléphone. Une clé peut être synchronisée par votre gestionnaire de mots de passe.',
    en: 'Confirm your current access code, then approve on your phone. Your password manager may sync the passkey.',
  },
  'passkeys.name': { fr: 'Nom de la clé d’accès', en: 'Passkey name' },
  'passkeys.cancel': { fr: 'Annuler', en: 'Cancel' },
  'passkeys.pendingQuestions': {
    fr: '{count} conversation(s) attendent une réponse',
    en: '{count} conversation(s) need an answer',
  },
  'archives.export': { fr: 'Exporter .pastudio', en: 'Export .pastudio' },
  'archives.import': { fr: 'Importer .pastudio', en: 'Import .pastudio' },
  'archives.export_title': { fr: 'Exporter l’archive du projet', en: 'Export project archive' },
  'archives.export_desc': {
    fr: 'Archive complète : conversations du projet, historiques natifs et Roadmap. Ni fichiers, ni réglages, ni fournisseurs. Aucune sélection à faire.',
    en: 'Full archive: project conversations, native histories and Roadmap. No files, settings or providers. Nothing to select.',
  },
  'archives.export_action': { fr: 'Exporter', en: 'Export' },
  'archives.export_done': { fr: 'Archive .pastudio exportée.', en: '.pastudio archive exported.' },
  'archives.export_failed': { fr: 'L’export de l’archive a échoué.', en: 'Archive export failed.' },
  'archives.import_title': { fr: 'Importer une archive .pastudio', en: 'Import a .pastudio archive' },
  'archives.import_desc': {
    fr: 'Choisissez un fichier .pastudio, vérifiez l’aperçu puis confirmez vers ce projet.',
    en: 'Choose a .pastudio file, review the preview, then confirm into this project.',
  },
  'archives.import_confirm': { fr: 'Importer', en: 'Import' },
  'archives.import_done': { fr: 'Archive importée dans ce projet.', en: 'Archive imported into this project.' },
  'archives.import_failed': { fr: 'L’import de l’archive a échoué.', en: 'Archive import failed.' },
  'archives.destination': { fr: 'Destination : {name}', en: 'Destination: {name}' },
  'archives.preview_source': { fr: 'Source : {name}', en: 'Source: {name}' },
  'archives.import_destination_note': {
    fr: 'Pour importer vers un nouveau projet, créez d’abord le projet puis rouvrez ce menu.',
    en: 'To import into a new project, create the project first, then reopen this menu.',
  },
  'archives.file_label': { fr: 'Fichier .pastudio', en: '.pastudio file' },
  'archives.file_hint': { fr: 'binaire .pastudio, 128 Mo maximum', en: '.pastudio binary, 128 MB maximum' },
  'archives.duplicate_note': {
    fr: 'Cette archive est déjà importée dans ce projet. Confirmer ne dupliquera rien.',
    en: 'This archive is already imported into this project. Confirming will not duplicate anything.',
  },
  'archives.warn_additive': { fr: 'Import additif : rien n’est écrasé.', en: 'Additive import: nothing is overwritten.' },
  'archives.warn_no_overwrite': {
    fr: 'Les sessions et la Roadmap existantes sont conservées.',
    en: 'Existing sessions and Roadmap are kept.',
  },
  'archives.warn_secret': {
    fr: 'L’historique peut contenir des secrets : vérifiez avant de partager ce fichier.',
    en: 'History may contain secrets: check before sharing this file.',
  },
  'archives.warn_needs_model': {
    fr: 'Prochaine exécution : choisissez un modèle disponible, l’historique reste lisible.',
    en: 'Next run: choose an available model; history stays readable.',
  },
  'archives.remote_unavailable': {
    fr: 'Fichier transférable sur un autre PC. Export et import depuis le Studio ouvert sur ce PC, pas depuis un navigateur distant (LAN/Tailscale/PWA).',
    en: 'File can be moved to another PC. Export and import from Studio opened on that PC, not from a remote browser (LAN/Tailscale/PWA).',
  },
  'archives.file_too_big': { fr: 'Le fichier dépasse 128 Mo.', en: 'The file exceeds 128 MB.' },
  'archives.invalid_file': { fr: 'Fichier .pastudio invalide.', en: 'Invalid .pastudio file.' },
  'archives.empty_archive': {
    fr: 'Aucun contenu importable dans ce fichier.',
    en: 'No importable content in this file.',
  },
  'archives.retry_preview': { fr: 'Relancer l’aperçu', en: 'Re-run preview' },
  'archives.import_pending': {
    fr: 'Import en attente de finalisation — nouvel essai sans doublon.',
    en: 'Import pending finalization — retrying without duplicating.',
  },
  'archives.pending_notice': {
    fr: 'Finalisation en attente : la reprise est sûre et sans doublon. Relancez l’aperçu si besoin, sans choisir un nouveau fichier.',
    en: 'Finalization pending: recovery is safe and duplicate-free. Re-run the preview if needed, no new file required.',
  },
  'archives.imported_badge': { fr: 'Importée', en: 'Imported' },
  'archives.count_sessions': { fr: 'Sessions', en: 'Sessions' },
  'archives.count_children': { fr: 'Sessions enfant', en: 'Child sessions' },
  'archives.count_messages': { fr: 'Messages', en: 'Messages' },
  'archives.count_plans': { fr: 'Plans Roadmap', en: 'Roadmap plans' },
  'archives.count_steps': { fr: 'Étapes Roadmap', en: 'Roadmap steps' },
  'archives.count_backlog_items': { fr: 'Points du backlog', en: 'Backlog items' },
  'archives.count_backlog_notes': { fr: 'Notes du backlog', en: 'Backlog notes' },
  'archives.count_journal': { fr: 'Entrées du journal', en: 'Journal entries' },
  'archives.count_milestones': { fr: 'Jalons', en: 'Milestones' },
};
