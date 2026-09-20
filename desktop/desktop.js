const messages = {
  fr: {
    componentsHeading: 'Composants du Studio',
    componentsDetails: 'Détails',
    componentsHideDetails: 'Masquer les détails',
    componentsNote:
      'Cette version de Studio utilise Prime Agent 0.9.5. Le bouton télécharge les composants manquants ou la version requise du moteur, npm privé, uv et Python 3.11 si nécessaire. Une connexion Internet est nécessaire. Git Bash doit être installé séparément pour les commandes shell.',
    componentsInstall: 'Mettre à jour les composants',
    componentsApply: 'Activer les composants et redémarrer',
    componentsActivationFailed:
      'Les composants sont prêts, mais leur activation a échoué. Réessayez l’activation ; aucun téléchargement supplémentaire n’est nécessaire.',
    componentsValidation:
      'La validation du composant a échoué. Vérifiez les détails et les journaux avant de réessayer.',
    componentsServerMismatch:
      'Le serveur utilise encore une autre version. Les composants sont conservés ; réessayez leur activation.',
    componentsPort: 'Le port est occupé par un autre service. Libérez-le sans arrêter les agents du Studio.',
    updateGuideTitle: 'Terminer la mise à jour du Studio',
    updateGuideNote:
      'L’application a été mise à jour, mais l’ancien serveur est encore actif. Vérifiez Prime Agent {version}, puis activez les composants. Les agents en cours ne seront pas interrompus automatiquement.',
    migrationTitle: 'Prime Agent 0.9.5 : terminez la mise à jour',
    migrationDesc:
      'La mise à jour de l’application seule ne suffit pas. Préparez Prime Agent 0.9.5 avec « Mettre à jour les composants », puis activez-le quand les agents sont inactifs. Les éléments déjà validés sont conservés, vos comptes et sessions aussi. Inutile de redémarrer vous-même dans le flux normal.',
    migrationContinue: 'Voir les composants',
    migrationLater: 'Plus tard',
    componentsDiagnose: 'Vérifier à nouveau',
    componentsExisting: 'Choisir une installation existante',
    componentsExistingNote:
      'Sélectionnez la racine du paquet Prime Agent (avec package.json), uv.exe ou python.exe. Les chemins définis dans les variables d’environnement restent prioritaires.',
    componentsLater: 'Plus tard — ouvrir le Studio',
    componentsReady: 'Tous les composants sont prêts.',
    componentsDeferred:
      'Préparation enregistrée. Activation différée : attendez la fin des agents puis utilisez Redémarrer le serveur. Un serveur externe doit être arrêté depuis son lanceur.',
    componentsBusy: 'Une préparation est déjà en cours. Réessayez après sa fin.',
    componentsFailed: 'La préparation a échoué. Réessayez ; les composants déjà validés sont conservés.',
    componentsExplicit:
      'Le chemin explicitement configuré est invalide ou incompatible. Corrigez la variable d’environnement ou choisissez une autre installation.',
    componentsBash:
      'Git Bash est requis pour les commandes shell. Installez Git pour Windows, ou configurez shellPath dans les réglages Prime Agent, puis vérifiez à nouveau.',
    componentsUnsupported:
      'Cette préparation nécessite Windows x64 et le Node compatible fourni avec Studio.',
    componentsChecksum:
      'L’intégrité ou la structure du téléchargement est invalide. Aucun composant altéré n’est activé.',
    componentsCancelled: 'Préparation annulée. Vous pouvez réessayer.',
    componentsEngineVersion:
      'Cette version de Studio nécessite Prime Agent 0.9.5 avec ses modules et ressources complets. Installez la version proposée, ou choisissez un paquet compatible.',
    componentsNetwork: 'Le téléchargement a échoué. Vérifiez la connexion réseau et réessayez.',
    componentsDisk:
      'L’espace disque est insuffisant. Libérez de l’espace dans le dossier de données du Studio, puis réessayez.',
    componentsWrite:
      'Écriture refusée dans le dossier de préparation. Vérifiez ses autorisations, puis réessayez.',
    componentStates: {
      ready: 'Validé',
      missing: 'Manquant',
      error: 'À configurer',
      pending: 'À vérifier après le moteur',
      not_required: 'Non nécessaire',
    },
    componentStages: {
      download: 'Téléchargement',
      verify: 'Vérification de l’empreinte',
      install: 'Installation',
      python: 'Préparation de Python et des skills',
      validation: 'Validation des intégrations',
      opening: 'Activation dans le serveur',
      server_update_pending: 'Ancien serveur conservé jusqu’à l’activation',
      error: 'Échec',
    },
    restartAfter: 'Redémarrer le serveur après l’installation',
    serverHeading: 'Serveur du Studio',
    serverVersion: 'Version active : {version}',
    serverStopped: 'Le serveur est arrêté.',
    serverIdle: 'Aucune exécution en cours.',
    serverBusy: 'Des agents travaillent. Le redémarrage demandera confirmation.',
    serverUnmanaged: 'Ce serveur dépend d’un autre lanceur. Arrêtez-le depuis celui-ci.',
    restart: 'Redémarrer le serveur',
    restarting: 'Redémarrage du serveur…',
    restarted: 'Le serveur utilise maintenant la version installée.',
    restartFailed: 'Impossible de redémarrer le serveur. Réessayez ou consultez les journaux.',
    restartTitle: 'Redémarrer malgré les agents en cours ?',
    restartNote:
      'Le redémarrage peut interrompre les agents et déconnectera temporairement vos appareils. Vos projets et l’historique enregistré seront conservés.',
    restartCancel: 'Annuler',
    restartProceed: 'Redémarrer quand même',
    eyebrow: 'VOTRE APPLICATION DE BUREAU',
    title: 'Votre espace de travail, prêt à vous suivre.',
    description:
      'Retrouvez vos projets et vos agents dans une fenêtre dédiée. Le Studio démarre pour vous, en arrière-plan.',
    startup: 'Démarrer avec Windows',
    startupNote: 'Disponible dès votre connexion, sans ouvrir de fenêtre.',
    import: 'Reprendre une installation existante',
    importNote: 'Conservez vos projets, pièces jointes et accès distants.',
    imported: 'Les données de cette application sont déjà initialisées.',
    start: 'Ouvrir le Studio',
    footer: 'Fermer la fenêtre laisse les agents travailler sur ce PC.',
    progress: 'Préparation du Studio…',
    retry: 'Réessayer',
    logs: 'Ouvrir les journaux',
    settingsTitle: 'Démarrage et récupération.',
    settingsNote: 'Accès de secours lorsque le Studio est arrêté ou utilise encore une ancienne version.',
    connectingTitle: 'Votre espace se prépare.',
    connectingNote: 'Nous retrouvons le serveur actif ou le démarrons pour vous.',
    connectingProbe: 'Connexion au serveur…',
    startingServer: 'Démarrage du serveur…',
    checkingComponents: 'Vérification des composants…',
    failure: 'Le Studio n’a pas pu démarrer.',
    noBridge: 'Ouvrez cette page dans l’application Prime Agent Studio.',
    selected: 'Installation sélectionnée : ',
    autostartError: 'Le démarrage avec Windows n’a pas pu être modifié.',
    updates: 'Mises à jour',
    updateIdle: 'Recherchez les nouvelles versions publiées sur GitHub.',
    updateCheck: 'Vérifier les mises à jour',
    updateChecking: 'Recherche d’une nouvelle version…',
    updateCurrent: 'Vous utilisez la dernière version publiée.',
    updateAvailable: 'La version {version} est disponible.',
    updateInstall: 'Installer et relancer',
    updateNotes: 'Nouveautés de cette version',
    updateImpact:
      'L’application se relancera. Le redémarrage optionnel du serveur est automatique s’il est libre ; sinon, une confirmation sera nécessaire.',
    updateDownloading: 'Téléchargement',
    updateVerifying: 'Vérification de la signature…',
    updateInstalling: 'Installation et relance de l’application…',
    updateCheckFailed:
      'Impossible de consulter les mises à jour. Vérifiez votre connexion ou réessayez plus tard.',
    updateDownloadFailed:
      'Le téléchargement ou sa signature n’a pas pu être validé. Aucune mise à jour installée.',
    updateInstallFailed: 'L’installation n’a pas pu démarrer. Vous pouvez réessayer.',
  },
  en: {
    componentsHeading: 'Studio components',
    componentsDetails: 'Details',
    componentsHideDetails: 'Hide details',
    componentsNote:
      'This Studio version uses Prime Agent 0.9.5. The button downloads missing components or the required engine version, private npm, uv and Python 3.11 when needed. An Internet connection is required. Git Bash must be installed separately for shell commands.',
    componentsInstall: 'Update components',
    componentsApply: 'Activate components and restart',
    componentsActivationFailed:
      'Components are ready, but activation failed. Retry activation; no further download is needed.',
    componentsValidation: 'Component validation failed. Check the details and logs before trying again.',
    componentsServerMismatch:
      'The server is still using another version. Components are preserved; retry activation.',
    componentsPort: 'Another service is using the port. Free it without stopping Studio agents.',
    updateGuideTitle: 'Finish the Studio update',
    updateGuideNote:
      'The app was updated, but the previous server is still running. Check Prime Agent {version}, then activate components. Running agents will not be interrupted automatically.',
    migrationTitle: 'Prime Agent 0.9.5: finish the update',
    migrationDesc:
      'Updating the app alone is not enough. Prepare Prime Agent 0.9.5 with “Update components”, then activate it when agents are idle. Validated parts are kept, and so are your accounts and sessions. No need to restart manually in the normal flow.',
    migrationContinue: 'Show components',
    migrationLater: 'Later',
    componentsDiagnose: 'Check again',
    componentsExisting: 'Choose an existing installation',
    componentsExistingNote:
      'Select the Prime Agent package root (with package.json), uv.exe or python.exe. Environment variable paths take precedence.',
    componentsLater: 'Later — open Studio',
    componentsReady: 'All components are ready.',
    componentsDeferred:
      'Preparation saved. Activation deferred: wait for agents to finish, then use Restart server. Stop an external server through its own launcher.',
    componentsBusy: 'Another preparation is in progress. Try again when it finishes.',
    componentsFailed: 'Preparation failed. Try again; validated components are preserved.',
    componentsExplicit:
      'The explicitly configured path is invalid or incompatible. Correct the environment variable or choose another installation.',
    componentsBash:
      'Git Bash is required for shell commands. Install Git for Windows, or configure shellPath in Prime Agent settings, then check again.',
    componentsUnsupported: 'Setup requires Windows x64 and the compatible Node supplied with Studio.',
    componentsChecksum:
      'The download integrity or archive structure is invalid. No altered component is activated.',
    componentsCancelled: 'Preparation cancelled. You can try again.',
    componentsEngineVersion:
      'This Studio version requires Prime Agent 0.9.5 with complete modules and resources. Install the proposed version, or select a compatible package.',
    componentsNetwork: 'Download failed. Check your network connection and try again.',
    componentsDisk:
      'There is not enough disk space. Free space in the Studio data directory, then try again.',
    componentsWrite: 'Writing to the setup directory was denied. Check its permissions, then try again.',
    componentStates: {
      ready: 'Validated',
      missing: 'Missing',
      error: 'Needs setup',
      pending: 'Check after engine setup',
      not_required: 'Not needed',
    },
    componentStages: {
      download: 'Downloading',
      verify: 'Verifying checksum',
      install: 'Installing',
      python: 'Preparing Python and skills',
      validation: 'Validating integrations',
      opening: 'Activating in the server',
      server_update_pending: 'Previous server kept until activation',
      error: 'Failed',
    },
    restartAfter: 'Restart the server after installation',
    serverHeading: 'Studio server',
    serverVersion: 'Running version: {version}',
    serverStopped: 'The server is stopped.',
    serverIdle: 'No active runs.',
    serverBusy: 'Agents are working. Restarting will require confirmation.',
    serverUnmanaged: 'This server belongs to another launcher. Stop it through that launcher.',
    restart: 'Restart server',
    restarting: 'Restarting the server…',
    restarted: 'The server is now using the installed version.',
    restartFailed: 'Could not restart the server. Try again or check the logs.',
    restartTitle: 'Restart while agents are running?',
    restartNote:
      'Restarting may interrupt agents and will temporarily disconnect your devices. Your projects and saved history will be preserved.',
    restartCancel: 'Cancel',
    restartProceed: 'Restart anyway',
    eyebrow: 'YOUR DESKTOP APPLICATION',
    title: 'Your workspace, ready when you are.',
    description: 'Your projects and agents in a dedicated window. Studio starts for you, in the background.',
    startup: 'Start with Windows',
    startupNote: 'Ready when you sign in, without opening a window.',
    import: 'Use an existing installation',
    importNote: 'Keep your projects, attachments and remote access.',
    imported: 'This application’s data has already been initialized.',
    start: 'Open Studio',
    footer: 'Closing the window leaves agents working on this PC.',
    progress: 'Preparing Studio…',
    retry: 'Try again',
    logs: 'Open logs',
    settingsTitle: 'Startup and recovery.',
    settingsNote: 'Recovery controls when Studio is stopped or still running an older version.',
    connectingTitle: 'Preparing your workspace.',
    connectingNote: 'We are finding the running server or starting it for you.',
    connectingProbe: 'Connecting to server…',
    startingServer: 'Starting server…',
    checkingComponents: 'Checking components…',
    failure: 'Studio could not start.',
    noBridge: 'Open this page in the Prime Agent Studio application.',
    selected: 'Selected installation: ',
    autostartError: 'Could not change the start with Windows setting.',
    updates: 'Updates',
    updateIdle: 'Check for new versions published on GitHub.',
    updateCheck: 'Check for updates',
    updateChecking: 'Checking for a new version…',
    updateCurrent: 'You are using the latest published version.',
    updateAvailable: 'Version {version} is available.',
    updateInstall: 'Install and restart',
    updateNotes: 'What’s new',
    updateImpact:
      'The app will relaunch. The optional server restart is automatic when idle; otherwise, confirmation will be required.',
    updateDownloading: 'Downloading',
    updateVerifying: 'Verifying the signature…',
    updateInstalling: 'Installing and restarting the app…',
    updateCheckFailed: 'Could not check for updates. Check your connection or try again later.',
    updateDownloadFailed: 'The download or its signature could not be verified. No update was installed.',
    updateInstallFailed: 'The installer could not start. You can try again.',
  },
};
const language = navigator.language.toLowerCase().startsWith('fr') ? 'fr' : 'en',
  t = messages[language],
  $ = (id) => document.getElementById(id);
document.documentElement.lang = language;
const settings = new URLSearchParams(location.search).has('settings');
const backgroundParam = new URLSearchParams(location.search).has('background');
document.body.classList.toggle('app-settings', settings);
// Boot class hides launcher controls until explicit settings/needs-config.
// Main window shows minimal connecting state first, never settings visually.
document.body.classList.add('boot');
document.body.classList.add('boot-connecting');
for (const [id, key] of Object.entries({
  eyebrow: 'eyebrow',
  title: settings ? 'settingsTitle' : 'title',
  description: settings ? 'settingsNote' : 'description',
  'startup-label': 'startup',
  'components-heading': 'componentsHeading',
  'components-note': 'componentsNote',
  'components-install': 'componentsInstall',
  'components-apply': 'componentsApply',
  'components-diagnose': 'componentsDiagnose',
  'components-existing': 'componentsExisting',
  'components-existing-note': 'componentsExistingNote',
  'components-cancel': 'restartCancel',
  'startup-note': 'startupNote',
  import: 'import',
  'import-note': 'importNote',
  start: 'start',
  footer: 'footer',
  'progress-text': 'progress',
  logs: 'logs',
  'update-heading': 'updates',
  'update-status': 'updateIdle',
  'update-check': 'updateCheck',
  'update-install': 'updateInstall',
  'update-notes-label': 'updateNotes',
  'update-impact': 'updateImpact',
  'update-restart-label': 'restartAfter',
  'server-heading': 'serverHeading',
  'server-restart': 'restart',
  'restart-confirm-title': 'restartTitle',
  'restart-confirm-note': 'restartNote',
  'restart-cancel': 'restartCancel',
  'restart-proceed': 'restartProceed',
  'migration-title': 'migrationTitle',
  'migration-desc': 'migrationDesc',
  'migration-continue': 'migrationContinue',
  'migration-later': 'migrationLater',
}))
  $(id).textContent = t[key];
const invoke = window.__TAURI__?.core?.invoke;
let componentsBusy = false;
let latestComponents;
let updatePending = false;
// One-time 0.9.5/3.7 family migration notice: narrow dialog in this window
// only, never another settings window and never engine code.
const MIGRATION_STORAGE_KEY = 'prime-studio.migration-095-dismissed';
let migrationDismissedMemory = false;
function migrationDismissed() {
  if (migrationDismissedMemory) return true;
  try {
    return localStorage.getItem(MIGRATION_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}
function rememberMigrationDismissed() {
  // Memory first so a storage failure still shows the notice once per page.
  migrationDismissedMemory = true;
  try {
    localStorage.setItem(MIGRATION_STORAGE_KEY, '1');
  } catch {}
}
function versionTriple(value) {
  const match = String(value || '')
    .trim()
    .replace(/^v/i, '')
    .match(/^(\d+)\.(\d+)\.(\d+)/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function tripleLess(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] < b[i];
  return false;
}
function tripleEqual(a, b) {
  return Boolean(a && b && a[0] === b[0] && a[1] === b[1] && a[2] === b[2]);
}
// Numeric major/minor/patch below 3.7.0. A 3.7.0 prerelease (beta) already
// belongs to the 3.7 family, so its suffix alone never counts as legacy.
function isLegacyStudioVersion(value) {
  const triple = versionTriple(value);
  return triple ? tripleLess(triple, [3, 7, 0]) : false;
}
function isOlderEngineVersion(installed, required) {
  const current = versionTriple(installed),
    wanted = versionTriple(required);
  return Boolean(current && wanted && tripleLess(current, wanted));
}
function shouldShowMigrationNotice(result) {
  if (!result || backgroundParam) return false;
  if (migrationDismissed()) return false;
  // Current migration only: never present a stale 0.9.5 notice for a future engine.
  if (!tripleEqual(versionTriple(result.requiredEngine), [0, 9, 5])) return false;
  const legacyServer =
    Boolean(result.server && result.server.running) && isLegacyStudioVersion(result.server.version);
  const legacyEngine = isOlderEngineVersion(result.installedEngine, result.requiredEngine);
  if (!legacyServer && !legacyEngine) return false;
  // No notice once the migration is already satisfied.
  if (!(result.needsUpdate || result.needsRestart || result.serverUpdatePending || !result.ready))
    return false;
  return true;
}
function focusMigrationTarget() {
  // Reveal/focus only: never install, apply, or restart from the notice itself.
  if ($('components')) $('components').hidden = false;
  for (const id of ['components-apply', 'components-install', 'components-toggle']) {
    const el = $(id);
    if (el && !el.hidden && !el.disabled) {
      el.focus();
      return id;
    }
  }
  return null;
}
function showMigrationNotice() {
  const dialog = $('migration-dialog');
  if (!dialog || dialog.open) return;
  try {
    dialog.showModal();
  } catch {
    dialog.setAttribute('open', '');
  }
  $('migration-continue').focus();
}
$('migration-continue').onclick = () => {
  rememberMigrationDismissed();
  const dialog = $('migration-dialog');
  if (dialog && dialog.open) dialog.close();
  if (dialog) dialog.removeAttribute('open');
  focusMigrationTarget();
};
$('migration-later').onclick = () => {
  rememberMigrationDismissed();
  const dialog = $('migration-dialog');
  if (dialog && dialog.open) dialog.close();
  if (dialog) dialog.removeAttribute('open');
};
$('migration-dialog').addEventListener('cancel', () => {
  rememberMigrationDismissed();
});
$('migration-dialog').addEventListener('close', () => {
  rememberMigrationDismissed();
  $('migration-dialog').removeAttribute('open');
});
// Warm-first helpers: connecting-first UI, never silent frozen.
function isComponentsRequired(error) {
  return String(error || '').includes('components_required');
}
function setPhase(text) {
  if (text) {
    $('progress').hidden = false;
    $('progress-text').textContent = text;
  }
}
function showConnecting(title, note, phase) {
  document.body.classList.add('boot');
  document.body.classList.add('boot-connecting');
  document.body.classList.remove('boot-ready');
  $('choices').hidden = true;
  $('components').hidden = true;
  if ($('updates') && !settings) $('updates').hidden = true;
  if (title) $('title').textContent = title;
  if (note) $('description').textContent = note;
  if (phase) setPhase(phase);
  else $('progress').hidden = false;
  $('start').disabled = true;
  showError('');
}
function showLauncher() {
  document.body.classList.remove('boot-connecting');
  document.body.classList.add('boot-ready');
  document.body.classList.remove('boot');
  $('choices').hidden = false;
  $('progress').hidden = true;
  $('start').disabled = false;
}
const componentNames = {
  engine: 'Prime Agent',
  uv: 'uv',
  python: 'Python',
  node: 'Node (Studio)',
  npm: 'npm',
  bash: 'Git Bash',
  studio: 'Studio',
};
function componentError(code) {
  if (code === 'engine_incompatible') return t.componentsEngineVersion;
  if (code === 'download_failed') return t.componentsNetwork;
  if (code === 'disk_full') return t.componentsDisk;
  if (code === 'write_denied') return t.componentsWrite;
  if (code === 'explicit_invalid') return t.componentsExplicit;
  if (code === 'bash_missing') return t.componentsBash;
  if (['architecture_unsupported', 'node_incompatible'].includes(code)) return t.componentsUnsupported;
  if (['checksum_mismatch', 'checksum_missing', 'unsafe_archive'].includes(code)) return t.componentsChecksum;
  if (code === 'cancelled') return t.componentsCancelled;
  if (['setup_busy', 'update_busy'].includes(code)) return t.componentsBusy;
  if (['server_validation_failed', 'server_version_mismatch'].includes(code))
    return t.componentsServerMismatch;
  if (code === 'server_not_managed') return t.serverUnmanaged;
  if (code === 'server_port_occupied') return t.componentsPort;
  if (code === 'validation_failed') return t.componentsValidation;
  if (['server_activation_failed', 'server_status_failed', 'server_restart_failed'].includes(code))
    return t.componentsActivationFailed;
  return t.componentsFailed;
}
function renderComponents(result) {
  if (!result || result.cancelled) {
    latestComponents = undefined;
    return;
  }
  if (result.failure) {
    latestComponents = undefined;
    $('components-status').textContent =
      `${componentNames[result.failure.component] || ''} : ${componentError(result.failure.error)}`;
    return;
  }
  latestComponents = result;
  $('components-list').replaceChildren();
  $('components-detail-list').replaceChildren();
  for (const [key, info] of Object.entries(result.components || {})) {
    const stateLabel = t.componentStates[info.status] || info.status;
    const chip = document.createElement('li');
    chip.className = 'component-chip';
    chip.dataset.state = info.status;
    chip.textContent = `${componentNames[key] || key}${info.version ? ` ${info.version}` : ''}${info.status !== 'ready' ? ` · ${stateLabel}` : ''}`;
    chip.title = stateLabel;
    chip.setAttribute('aria-label', `${chip.textContent} — ${stateLabel}`);
    $('components-list').append(chip);
    const row = document.createElement('li');
    row.textContent = `${componentNames[key] || key} — ${t.componentStates[info.status] || info.status}${info.version ? ` · ${info.version}` : ''}`;
    if (info.path) {
      const path = document.createElement('small');
      path.textContent = info.path;
      row.append(path);
    }
    if (info.provenance) {
      const source = document.createElement('small');
      source.textContent = info.provenance;
      row.append(source);
    }
    if (info.error && info.error !== 'missing') {
      const error = document.createElement('small');
      error.textContent = componentError(info.explicit ? 'explicit_invalid' : info.error);
      row.append(error);
    }
    $('components-detail-list').append(row);
  }
  $('components-status').textContent =
    result.activation === 'failed'
      ? `${t.componentsActivationFailed} ${componentError(result.activationError)}`
      : result.activation === 'deferred'
        ? t.componentsDeferred
        : result.ready
          ? t.componentsReady
          : Object.entries(result.components || {})
              .filter(([, info]) => info.error && info.error !== 'missing')
              .map(
                ([key, info]) =>
                  `${componentNames[key] || key} : ${componentError(info.explicit ? 'explicit_invalid' : info.error)}`,
              )
              .join(' ');
  $('components-install').hidden = result.ready;
  const needsActivation =
    result.ready && (result.needsRestart || ['failed', 'deferred'].includes(result.activation));
  $('components-apply').hidden = !needsActivation;
  $('components-apply').disabled = result.server?.managed === false;
  $('components-actions').hidden = result.ready && !needsActivation;
  $('start').textContent = updatePending || !result.ready ? t.componentsLater : t.start;
  if (result.activation === 'failed') $('logs').hidden = false;
}
$('components-toggle').textContent = t.componentsDetails;
$('components-toggle').onclick = () => {
  const expanded = $('components-details').hidden;
  $('components-details').hidden = !expanded;
  $('components-toggle').setAttribute('aria-expanded', String(expanded));
  $('components-toggle').textContent = expanded ? t.componentsHideDetails : t.componentsDetails;
};
async function componentsAction(action, component) {
  if (componentsBusy) return;
  componentsBusy = true;
  // Concrete phase immediately, never silent frozen window.
  $('components').hidden = false;
  document.body.classList.remove('boot-connecting');
  document.body.classList.add('boot-ready');
  document.body.classList.remove('boot');
  setPhase(t.checkingComponents);
  $('components-status').textContent = t.checkingComponents;
  for (const el of $('components').querySelectorAll('button')) el.disabled = true;
  $('components-cancel').hidden = action !== 'install';
  $('components-cancel').disabled = false;
  $('start').disabled = true;
  let result;
  try {
    result = await invoke('desktop_components', { action, component: component || null });
    renderComponents(result);
    if (['install', 'apply'].includes(action) && result.ready && result.activation === 'active')
      await start({ allowUnconfigured: true, background: backgroundParam });
    return result;
  } catch (error) {
    latestComponents = undefined;
    const message = isComponentsRequired(error) ? t.checkingComponents : componentError(String(error));
    $('components-status').textContent = message;
    setPhase(message);
  } finally {
    componentsBusy = false;
    for (const el of $('components').querySelectorAll('button')) el.disabled = false;
    $('components-apply').disabled = latestComponents?.server?.managed === false;
    $('components-cancel').hidden = true;
    $('start').disabled = false;
  }
}
$('components-install').onclick = () => componentsAction('install');
$('components-apply').onclick = () => componentsAction('apply');
$('components-diagnose').onclick = () => componentsAction('diagnose');
$('components-cancel').onclick = () => invoke('desktop_components_cancel');
for (const name of ['engine', 'uv', 'python'])
  $('components-' + name).onclick = () => componentsAction('select', name);
void window.__TAURI__?.event?.listen('components-progress', ({ payload }) => {
  const received =
    payload.received === undefined
      ? ''
      : ` · ${payload.received.toLocaleString(language)} ${language === 'fr' ? 'octets reçus' : 'bytes received'}${payload.total ? ` / ${payload.total.toLocaleString(language)}` : ''}`;
  // Detailed diagnose steps (engine/python/shell/uv) plus download progress.
  const text = `${componentNames[payload.component] || payload.component || ''} — ${t.componentStages[payload.stage] || payload.stage || ''}${received}`;
  $('components-status').textContent = text;
  // Mirror diagnose phases in the main connecting line so the window never freezes silently.
  if ($('components') && !$('components').hidden) setPhase(text);
});
// Launcher has no vendor marked/DOMPurify bundle. Escape first, then allow a
// small markdown subset (headings, lists, bold, code, allowlisted links).
// Raw HTML such as <img onerror=...> stays inert text, never an element.
function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}
function inlineNotes(text) {
  let out = escapeHtml(text);
  out = out.replace(/`([^`\n]+?)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\[\]\n]+?)\]\(([^\)\s]+?)\)/g, (m, label, href) => {
    if (!/^(https?:|mailto:|#|\/)/i.test(href)) return label;
    const safe = escapeHtml(href);
    const extra = /^https?:/i.test(href) ? ' target="_blank" rel="noopener noreferrer"' : '';
    return `<a href="${safe}"${extra}>${label}</a>`;
  });
  return out;
}
function renderLauncherNotes(raw) {
  const body = $('update-notes-body');
  body.replaceChildren();
  const lines = String(raw || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  let list = null;
  const closeList = () => {
    list = null;
  };
  let fence = null;
  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (fence) {
        fence = null;
      } else {
        closeList();
        fence = document.createElement('pre');
        const code = document.createElement('code');
        fence.append(code);
        body.append(fence);
      }
      continue;
    }
    if (fence) {
      fence.firstChild.append(document.createTextNode(line + '\n'));
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.*\S)\s*$/);
    if (heading) {
      closeList();
      const level = heading[1].length;
      const el = document.createElement(level === 1 ? 'h4' : 'h5');
      el.innerHTML = inlineNotes(heading[2]);
      body.append(el);
      continue;
    }
    const item = line.match(/^\s*(?:[-*]|\d+[.)])\s+(.*\S)\s*$/);
    if (item) {
      if (!list) {
        list = document.createElement('ul');
        body.append(list);
      }
      const li = document.createElement('li');
      li.innerHTML = inlineNotes(item[1]);
      list.append(li);
      continue;
    }
    if (!line.trim()) {
      closeList();
      continue;
    }
    closeList();
    const p = document.createElement('p');
    p.innerHTML = inlineNotes(line.trim());
    body.append(p);
  }
}
let updateBusy = false,
  availableVersion;
function updateStatus(message, error = false) {
  $('update-status').textContent = message;
  $('update-status').classList.toggle('failed', error);
}
$('update-check').onclick = async () => {
  if (updateBusy) return;
  updateBusy = true;
  availableVersion = undefined;
  $('update-check').disabled = true;
  $('update-install').hidden = true;
  $('update-notes').hidden = true;
  $('update-impact').hidden = true;
  $('update-restart-option').hidden = true;
  updateStatus(t.updateChecking);
  try {
    const update = await invoke('desktop_update_check');
    if (update.available) {
      availableVersion = update.version;
      updateStatus(t.updateAvailable.replace('{version}', update.version));
      $('update-install').hidden = false;
      $('update-impact').hidden = false;
      $('update-restart-option').hidden = false;
      renderLauncherNotes(update.notes || '');
      $('update-notes').hidden = !update.notes;
    } else updateStatus(t.updateCurrent);
  } catch {
    updateStatus(t.updateCheckFailed, true);
  } finally {
    updateBusy = false;
    $('update-check').disabled = false;
  }
};
$('update-install').onclick = async () => {
  if (updateBusy || !availableVersion) return;
  updateBusy = true;
  $('update-check').disabled = true;
  $('update-install').disabled = true;
  $('start').disabled = true;
  $('update-progress').hidden = false;
  $('update-progress').removeAttribute('value');
  updateStatus(t.updateDownloading + '…');
  try {
    const onEvent = new window.__TAURI__.core.Channel();
    onEvent.onmessage = ({ stage, percent }) => {
      if (stage === 'downloading') {
        updateStatus(t.updateDownloading + (percent == null ? '…' : ` · ${percent} %`));
        if (percent != null) $('update-progress').value = percent;
      } else {
        updateStatus(stage === 'verifying' ? t.updateVerifying : t.updateInstalling);
        $('update-progress').removeAttribute('value');
      }
    };
    await invoke('desktop_update_install', {
      version: availableVersion,
      onEvent,
      restartServer: $('update-restart-after').checked,
    });
  } catch (error) {
    updateStatus(error === 'install_failed' ? t.updateInstallFailed : t.updateDownloadFailed, true);
    $('update-progress').hidden = true;
    $('update-check').disabled = false;
    $('update-install').disabled = false;
    $('start').disabled = false;
    updateBusy = false;
  }
};
let restarting = false;
async function refreshServer() {
  const state = await invoke('desktop_update_status');
  $('server-state').textContent = state.running
    ? t.serverVersion.replace('{version}', state.version)
    : t.serverStopped;
  $('server-agents').textContent = !state.managed
    ? t.serverUnmanaged
    : state.activeRuns
      ? t.serverBusy
      : t.serverIdle;
  $('server-restart').disabled = !state.managed || restarting || updateBusy;
  return state;
}
$('server-restart').onclick = async () => {
  if (restarting || updateBusy) return;
  restarting = true;
  try {
    const state = await refreshServer();
    if (!state.managed) return;
    let force = false;
    if (state.activeRuns) {
      const dialog = $('restart-confirm');
      const accepted = new Promise((done) => {
        dialog.returnValue = '';
        $('restart-cancel').onclick = () => dialog.close('cancel');
        $('restart-proceed').onclick = () => dialog.close('proceed');
        dialog.addEventListener('close', () => done(dialog.returnValue === 'proceed'), { once: true });
      });
      dialog.showModal();
      $('restart-cancel').focus();
      if (!(await accepted)) return;
      force = true;
    }
    $('server-state').textContent = t.restarting;
    const result = await invoke('desktop_server_restart', { force });
    if (result.restarted) {
      await refreshServer();
      $('server-agents').textContent = t.restarted;
    } else await refreshServer();
  } catch {
    $('server-state').textContent = t.restartFailed;
  } finally {
    restarting = false;
    $('server-restart').disabled = false;
  }
};
let busy = false;
function showError(value) {
  $('error').textContent = value;
  $('error').hidden = !value;
  $('logs').hidden = !value;
}
async function start(options = {}) {
  if (busy) return;
  const allowUnconfigured = Boolean(options.allowUnconfigured);
  const background = options.background !== undefined ? Boolean(options.background) : backgroundParam;
  busy = true;
  showError('');
  $('start').disabled = true;
  $('import').disabled = true;
  setPhase(t.connectingProbe);
  try {
    // B3: decide on live probe only (inside desktop_start), not persisted
    // prefs.started. Always persist validated components via activate when
    // ready, so explicit paths survive to installation.json before strict start.
    if (latestComponents?.ready) await invoke('desktop_components', { action: 'activate', component: null });
    setPhase(t.startingServer);
    const started = await invoke('desktop_start', { allowUnconfigured, background });
    if (started?.showUpdates && !allowUnconfigured && !background) {
      updatePending = true;
      showLauncher();
      $('title').textContent = t.updateGuideTitle;
      const components = await componentsAction('diagnose');
      $('description').textContent = t.updateGuideNote.replace(
        '{version}',
        components?.requiredEngine || '0.9.5',
      );
      $('progress').hidden = true;
      $('start').textContent = t.componentsLater;
      if (shouldShowMigrationNotice(components)) showMigrationNotice();
      return;
    }
    if (settings) {
      $('progress').hidden = true;
      $('start').disabled = false;
    }
    // Success: Rust navigates MAIN to Studio; keep connecting visible until navigation.
  } catch (error) {
    // Setup necessary: let boot run full diagnose with phases, not generic failure.
    if (isComponentsRequired(error) && !allowUnconfigured) throw error;
    // Occupied/transient or real failure: no duplicate spawn, no settings popup.
    $('progress').hidden = true;
    showLauncher();
    $('title').textContent = t.failure;
    showError(String(error));
    $('start').textContent = t.retry;
    $('start').disabled = false;
    $('start').focus();
    if (options.rethrow) throw error;
  } finally {
    busy = false;
    $('import').disabled = false;
  }
}
$('start').onclick = () => {
  // Later (not ready) explicitly opens Studio anyway; otherwise strict warm-first.
  const later = updatePending || (latestComponents && latestComponents.ready === false);
  return start({ allowUnconfigured: Boolean(later), background: backgroundParam });
};
$('logs').onclick = async () => {
  try {
    await invoke('desktop_logs');
  } catch (error) {
    showError(String(error));
  }
};
$('autostart').onchange = async () => {
  const input = $('autostart');
  input.disabled = true;
  try {
    await invoke('desktop_autostart', { enabled: input.checked });
    showError('');
  } catch {
    input.checked = !input.checked;
    showError(t.autostartError);
  } finally {
    input.disabled = false;
  }
};
$('import').onclick = async () => {
  const button = $('import');
  button.disabled = true;
  try {
    const selected = await invoke('desktop_choose_legacy');
    if (selected) {
      $('source').textContent = t.selected + selected;
      $('source').hidden = false;
      showError('');
    }
  } catch (error) {
    showError(String(error));
  } finally {
    button.disabled = false;
  }
};
(async () => {
  if (!invoke) {
    document.body.classList.remove('boot', 'boot-connecting');
    showError(t.noBridge);
    return;
  }
  try {
    const state = await invoke('desktop_state');
    $('app-version').textContent = `v${state.version}`;
    $('updates').hidden = !settings;
    if (settings)
      void refreshServer().catch(() => {
        $('server-state').textContent = t.restartFailed;
      });
    $('autostart').checked = state.autostart;
    $('start').disabled = false;
    if (state.imported) {
      $('import').hidden = true;
      $('import-note').textContent = t.imported;
    } else if (state.legacyRoot) {
      $('source').hidden = false;
      $('source').textContent = t.selected + state.legacyRoot;
    }
    const background = backgroundParam;
    if (settings) {
      // Settings: visible launcher controls, no auto-start. Run the same
      // read-only diagnose so components can be configured here; installs
      // still require an explicit click and never start automatically.
      showLauncher();
      const diagnosed = await componentsAction('diagnose');
      // Explicit recovery surface: explain the 0.9.5 step when legacy
      // evidence is present. Fresh installs have none, so stay silent.
      if (shouldShowMigrationNotice(diagnosed || latestComponents)) showMigrationNotice();
      return;
    }
    if (background) {
      // Preserve hidden background: silent warm-first, allow unconfigured
      // so a missing receipt never pops a window or downloads. Native keeps
      // the window hidden on failure (explicit background arg) and logs.
      try {
        await invoke('desktop_start', { allowUnconfigured: true, background: true });
      } catch {
        // Stay hidden; Rust already logged desktop-error.log. Next foreground handles setup.
      }
      return;
    }
    // Foreground MAIN: connecting-first, live probe only (not persisted flag).
    showConnecting(t.connectingTitle, t.connectingNote, t.connectingProbe);
    try {
      await start({});
    } catch (error) {
      if (!isComponentsRequired(error)) throw error;
      // Setup necessary: concrete diagnose phases. When ready, persist via
      // activate before strict start so explicit paths are recorded (B3);
      // otherwise show launcher with Later/install.
      $('title').textContent = t.title;
      $('description').textContent = t.description;
      showLauncher();
      await componentsAction('diagnose');
      $('choices').hidden = false;
      if (latestComponents?.ready) {
        try {
          await start({});
        } catch (retryError) {
          if (!isComponentsRequired(retryError)) throw retryError;
          $('components').hidden = false;
          if (shouldShowMigrationNotice(latestComponents)) showMigrationNotice();
        }
      } else {
        $('components').hidden = false;
        // Cold foreground with a known older engine receipt and no running
        // server: explain the 0.9.5 step. Empty fresh installs carry no
        // legacy evidence, so the predicate stays silent there.
        if (shouldShowMigrationNotice(latestComponents)) showMigrationNotice();
      }
    }
  } catch (error) {
    document.body.classList.remove('boot-connecting');
    showError(String(error));
  }
})();
