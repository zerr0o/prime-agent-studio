const messages = {
  fr: {
    componentsHeading: 'Composants du Studio',
    componentsDetails: 'Détails',
    componentsHideDetails: 'Masquer les détails',
    componentsNote:
      'Cette version de Studio utilise Prime Agent 0.9.5. Le bouton télécharge les composants manquants ou la version requise du moteur, npm privé, uv et Python 3.11 si nécessaire. Une connexion Internet est nécessaire. Git Bash doit être installé séparément pour les commandes shell.',
    componentsInstall: 'Réparer Studio',
    componentsActivationFailed:
      'Les composants sont prêts, mais le redémarrage a échoué. Réessayez Redémarrer maintenant ; aucun téléchargement supplémentaire n’est nécessaire.',
    componentsValidation:
      'La validation du composant a échoué. Vérifiez les détails et les journaux avant de réessayer.',
    componentsServerMismatch:
      'Le serveur utilise encore une autre version. Les composants sont conservés ; réessayez Redémarrer maintenant.',
    componentsPort: 'Le port est occupé par un autre service. Libérez-le sans arrêter les agents du Studio.',
    updateGuideTitle: 'Terminer la mise à jour du Studio',
    updateGuideNote:
      'L’application a été mise à jour, mais l’ancien serveur est encore actif. Réparez si besoin, puis redémarrez. Les agents en cours ne seront pas interrompus sans confirmation.',
    componentsDiagnose: 'Vérifier à nouveau',
    componentsExisting: 'Choisir une installation existante',
    componentsExistingNote:
      'Sélectionnez la racine du paquet Prime Agent (avec package.json), uv.exe ou python.exe. Les chemins définis dans les variables d’environnement restent prioritaires.',
    componentsLater: 'Plus tard : ouvrir le Studio',
    componentsReady: 'Tous les composants sont prêts.',
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
      opening: 'Mise en route dans le serveur',
      server_update_pending: 'Ancien serveur conservé jusqu’au redémarrage',
      error: 'Échec',
    },
    serverHeading: 'Serveur du Studio',
    serverVersion: 'Version active : {version}',
    serverStopped: 'Le serveur est arrêté.',
    serverIdle: 'Aucune exécution en cours.',
    serverBusy: 'Des agents travaillent. Le redémarrage demandera confirmation.',
    serverUnmanaged: 'L’identité du serveur n’a pas pu être vérifiée. Aucun processus ne sera arrêté. Consultez les détails et réessayez la vérification.',
    restart: 'Redémarrer maintenant',
    restarting: 'Redémarrage du serveur…',
    restarted: 'Le serveur utilise maintenant la version installée.',
    restartFailed: 'Impossible de redémarrer le serveur. Réessayez ou consultez les journaux.',
    restartTitle: 'Redémarrer malgré les agents en cours ?',
    restartNote:
      'Le redémarrage peut interrompre les agents et déconnectera temporairement vos appareils. Vos projets et l’historique enregistré seront conservés.',
    restartCancel: 'Annuler',
    restartProceed: 'Redémarrer quand même',
    operationHeading: 'Opération en cours',
    operationCancel: 'Annuler l’opération',
    backStudio: 'Retour au Studio',
    quitTitle: 'Quitter le Studio ?',
    quitNote: 'Le serveur sera arrêté avant de fermer. Les agents en cours peuvent être interrompus.',
    quitCancel: 'Annuler',
    quitProceed: 'Arrêter et quitter',
    repairDone: 'Les composants sont prêts. Redémarrez maintenant pour les utiliser.',
    noOperation: 'Aucune opération en cours.',
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
    updateInstall: 'Mettre à jour Studio',
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
    componentsInstall: 'Repair Studio',
    componentsActivationFailed:
      'Components are ready, but restart failed. Retry Restart now; no further download is needed.',
    componentsValidation: 'Component validation failed. Check the details and logs before trying again.',
    componentsServerMismatch:
      'The server is still using another version. Components are kept; retry Restart now.',
    componentsPort: 'Another service is using the port. Free it without stopping Studio agents.',
    updateGuideTitle: 'Finish the Studio update',
    updateGuideNote:
      'The app was updated, but the previous server is still running. Repair if needed, then restart. Running agents will not be interrupted without confirmation.',
    componentsDiagnose: 'Check again',
    componentsExisting: 'Choose an existing installation',
    componentsExistingNote:
      'Select the Prime Agent package root (with package.json), uv.exe or python.exe. Environment variable paths take precedence.',
    componentsLater: 'Later: open Studio',
    componentsReady: 'All components are ready.',
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
      opening: 'Starting in the server',
      server_update_pending: 'Previous server kept until restart',
      error: 'Failed',
    },
    serverHeading: 'Studio server',
    serverVersion: 'Running version: {version}',
    serverStopped: 'The server is stopped.',
    serverIdle: 'No active runs.',
    serverBusy: 'Agents are working. Restarting will require confirmation.',
    serverUnmanaged: 'The server identity could not be verified. No process will be stopped. Check the details and retry the check.',
    restart: 'Restart now',
    restarting: 'Restarting the server…',
    restarted: 'The server is now using the installed version.',
    restartFailed: 'Could not restart the server. Try again or check the logs.',
    restartTitle: 'Restart while agents are running?',
    restartNote:
      'Restarting may interrupt agents and will temporarily disconnect your devices. Your projects and saved history will be preserved.',
    restartCancel: 'Cancel',
    restartProceed: 'Restart anyway',
    operationHeading: 'Current operation',
    operationCancel: 'Cancel operation',
    backStudio: 'Back to Studio',
    quitTitle: 'Quit Studio?',
    quitNote: 'The server will be stopped before closing. Running agents may be interrupted.',
    quitCancel: 'Cancel',
    quitProceed: 'Stop and quit',
    repairDone: 'Components are ready. Restart now to use them.',
    noOperation: 'No operation running.',
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
    updateInstall: 'Update Studio',
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
// Quit handshake flag: native request_quit_confirmation only dispatches
// studio:quit-request when this is true, otherwise it navigates here itself.
// An old server page without this flag falls back to the local quit shell.
window.__PRIME_STUDIO_QUIT_READY__ = true;
const settings = new URLSearchParams(location.search).has('settings');
const backgroundParam = new URLSearchParams(location.search).has('background');
document.body.classList.toggle('app-settings', settings);
// Boot class hides launcher controls until explicit settings/needs-config.
// Main window shows minimal connecting state first, never settings visually.
document.body.classList.add('boot');
document.body.classList.add('boot-connecting');
for (const [id, key] of Object.entries({
  'update-cancel': 'operationCancel',
  'back-studio': 'backStudio',
  'quit-confirm-title': 'quitTitle',
  'quit-confirm-note': 'quitNote',
  'quit-cancel': 'quitCancel',
  'quit-proceed': 'quitProceed',
  eyebrow: 'eyebrow',
  title: settings ? 'settingsTitle' : 'title',
  description: settings ? 'settingsNote' : 'description',
  'startup-label': 'startup',
  'components-heading': 'componentsHeading',
  'components-note': 'componentsNote',
  'components-install': 'componentsInstall',
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
  'server-heading': 'serverHeading',
  'server-restart': 'restart',
  'restart-confirm-title': 'restartTitle',
  'restart-confirm-note': 'restartNote',
  'restart-cancel': 'restartCancel',
  'restart-proceed': 'restartProceed',
}))
  $(id).textContent = t[key];
const invoke = window.__TAURI__?.core?.invoke;
let componentsBusy = false;
let latestComponents;
let updatePending = false;
// Migration notice removed: single clear flow (Check / Update or Repair / Restart + Back).

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
    chip.setAttribute('aria-label', `${chip.textContent}, ${stateLabel}`);
    $('components-list').append(chip);
    const row = document.createElement('li');
    row.textContent = `${componentNames[key] || key}, ${t.componentStates[info.status] || info.status}${info.version ? ` · ${info.version}` : ''}`;
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
        ? t.repairDone
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
  // Single restart rule: no second activation button. Repair (prepare) then the
  // one server Restart now below. Hide apply to avoid double activation.
  $('components-actions').hidden = result.ready;
  if (result.ready && (result.needsRestart || ['failed', 'deferred'].includes(result.activation))) {
    $('components-status').textContent = t.repairDone;
  }
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
  $('components-cancel').hidden = !['install', 'prepare'].includes(action);
  $('components-cancel').disabled = false;
  $('start').disabled = true;
  let result;
  try {
    result = await invoke('desktop_components', { action, component: component || null });
    renderComponents(result);
    // Never auto restart an active agent. Prepare only installs/validates;
    // the user triggers one explicit Restart now when idle (with force confirm).
    return result;
  } catch (error) {
    latestComponents = undefined;
    const message = isComponentsRequired(error) ? t.checkingComponents : componentError(String(error));
    $('components-status').textContent = message;
    setPhase(message);
  } finally {
    componentsBusy = false;
    for (const el of $('components').querySelectorAll('button')) el.disabled = false;
    $('components-cancel').hidden = true;
    $('start').disabled = false;
  }
}
$('components-install').onclick = () => componentsAction('prepare');
$('components-diagnose').onclick = () => componentsAction('diagnose');
$('components-cancel').onclick = () => invoke('desktop_components_cancel');
$('update-cancel').onclick = async () => {
  try {
    await invoke('desktop_update_cancel');
  } catch {
    try {
      await invoke('desktop_components_cancel');
    } catch {}
  }
  await pollOperationOnce();
};
for (const name of ['engine', 'uv', 'python'])
  $('components-' + name).onclick = () => componentsAction('select', name);
void window.__TAURI__?.event?.listen('components-progress', ({ payload }) => {
  const received =
    payload.received === undefined
      ? ''
      : ` · ${payload.received.toLocaleString(language)} ${language === 'fr' ? 'octets reçus' : 'bytes received'}${payload.total ? ` / ${payload.total.toLocaleString(language)}` : ''}`;
  // Detailed diagnose steps (engine/python/shell/uv) plus download progress.
  const text = `${componentNames[payload.component] || payload.component || ''}, ${t.componentStages[payload.stage] || payload.stage || ''}${received}`;
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
  if ($('update-cancel')) $('update-cancel').hidden = true;
  updateStatus(t.updateChecking);
  try {
    const update = await invoke('desktop_update_check');
    if (update.available) {
      availableVersion = update.version;
      updateStatus(t.updateAvailable.replace('{version}', update.version));
      $('update-install').hidden = false;
      $('update-impact').hidden = false;
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
      restartServer: false,
    });
    // Success: no stale busy UI. Installer relaunches the app; clear progress
    // at once so a lingering window never shows a frozen downloading state.
    currentOperation = null;
    if ($('update-cancel')) $('update-cancel').hidden = true;
    $('update-progress').hidden = true;
    $('update-progress').removeAttribute('value');
    updateStatus(t.updateCurrent);
    availableVersion = undefined;
    $('update-install').hidden = true;
    $('update-impact').hidden = true;
    $('update-check').disabled = false;
    $('start').disabled = false;
    updateBusy = false;
    await refreshServer().catch(() => {});
    await pollOperationOnce().catch(() => null);
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
    ? t.serverVersion.replace('{version}', state.version || '?')
    : t.serverStopped;
  // Control contract: ownership managed|recoverable|unverified|absent, canRestart,
  // restartReason, canStop/stopReason, source, pid/port/instanceId. Recoverable
  // (OS-verified, no owner file) stays restartable; foreign stays protected.
  const canRestart = state.canRestart !== undefined ? state.canRestart : state.managed;
  const restartReason = state.restartReason || (state.managed === false ? 'server_not_managed' : null);
  if (!state.running) {
    $('server-agents').textContent = t.serverStopped;
  } else if (canRestart === false) {
    $('server-agents').textContent =
      restartReason === 'server_port_occupied' ? t.componentsPort : t.serverUnmanaged;
  } else {
    $('server-agents').textContent = state.activeRuns ? t.serverBusy : t.serverIdle;
  }
  $('server-restart').disabled = !canRestart || restarting || updateBusy;
  $('server-restart').textContent = t.restart;
  return state;
}
let currentOperation = null;
function formatBytes(value) {
  if (value == null) return '';
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} o`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} Ko`;
  return `${(n / (1024 * 1024)).toFixed(1)} Mo`;
}
function formatElapsed(ms) {
  if (ms == null) return '';
  const n = Number(ms);
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(1)} s`;
}
function formatOperation(op) {
  // Shared snapshot, translated progress (bytes/time), never raw codes.
  if (!op) return '';
  const bits = [];
  if (op.kind) bits.push(op.kind);
  if (op.stage && !op.terminal) bits.push(op.stage);
  if (op.percent != null) bits.push(`${op.percent} %`);
  const bytes = formatBytes(op.receivedBytes);
  const total = formatBytes(op.totalBytes);
  if (bytes && total) bits.push(`${bytes} / ${total}`);
  else if (bytes) bits.push(bytes);
  if (op.updatedAt != null && op.startedAt != null) {
    const elapsed = formatElapsed(op.updatedAt - op.startedAt);
    if (elapsed) bits.push(elapsed);
  }
  if (op.detail) bits.push(op.detail);
  if (op.terminal && op.stage === 'done') bits.push(language === 'fr' ? 'termine' : 'done');
  return bits.join(', ');
}
async function pollOperationOnce() {
  try {
    const res = await invoke('desktop_update_operation');
    const op = res?.operation || null;
    currentOperation = op;
    const cancelBtn = $('update-cancel');
    if (!op || op.terminal) {
      if (cancelBtn) cancelBtn.hidden = true;
      return op;
    }
    // Single status line (no duplicate section): show live progress here.
    updateStatus(formatOperation(op));
    if (cancelBtn) {
      cancelBtn.hidden = !op.cancellable;
      cancelBtn.disabled = !op.cancellable;
    }
    return op;
  } catch {
    currentOperation = null;
    return null;
  }
}
function startOperationPoll() {
  if (window.__operationPoll) return;
  window.__operationPoll = setInterval(() => {
    if ($('updates') && !$('updates').hidden) void pollOperationOnce();
  }, 1000);
}
let quitting = false;
function showQuitDialog(prefill = {}) {
  const dialog = $('quit-confirm');
  if (!dialog) return;
  if (prefill.detail) {
    $('quit-confirm-detail').textContent = prefill.detail;
    $('quit-confirm-detail').hidden = false;
  } else {
    $('quit-confirm-detail').hidden = true;
  }
  try {
    if (!dialog.open) dialog.showModal();
  } catch {
    dialog.setAttribute('open', '');
  }
  $('quit-cancel').focus();
}
async function requestQuitFlow() {
  if (quitting) return;
  quitting = true;
  try {
    let snapshot = null;
    try {
      snapshot = await invoke('desktop_update_status');
    } catch {}
    const op = await pollOperationOnce().catch(() => null);
    const activeRuns = snapshot?.activeRuns || 0;
    const needsConfirm = activeRuns > 0 || (op && !op.terminal);
    if (!needsConfirm) {
      // Idle: stop direct after snapshot, exit only on confirmed stop.
      try {
        const res = await invoke('desktop_quit', { force: false, cancelCurrent: false });
        if (res && (res.stopped === true || res.reason === 'already-stopped')) return;
      } catch {}
      showQuitDialog();
      return;
    }
    const detail = activeRuns
      ? t.serverBusy
      : `${op?.kind || ''}, ${op?.stage || ''}`;
    showQuitDialog({ detail });
  } finally {
    quitting = false;
  }
}
if ($('quit-cancel')) $('quit-cancel').onclick = () => {
  const d = $('quit-confirm');
  if (d && d.open) d.close('cancel');
  if (d) d.removeAttribute('open');
};
if ($('quit-proceed')) $('quit-proceed').onclick = async () => {
  $('quit-proceed').disabled = true;
  try {
    const snapshot = await invoke('desktop_update_status').catch(() => null);
    const op = currentOperation;
    const force = Boolean(snapshot && snapshot.activeRuns);
    // Confirmation before cancel: quit with cancelCurrent only after explicit proceed.
    const cancelCurrent = Boolean(op && op.cancellable);
    const res = await invoke('desktop_quit', { force, cancelCurrent });
    if (res && (res.stopped === true || res.reason === 'already-stopped')) return;
    $('quit-confirm-note').textContent = t.restartFailed;
  } catch (error) {
    $('quit-confirm-note').textContent =
      String(error) === 'update_busy' ? t.componentsBusy : t.restartFailed;
  } finally {
    $('quit-proceed').disabled = false;
  }
};
window.addEventListener('studio:quit-request', () => requestQuitFlow());
if ($('back-studio')) $('back-studio').onclick = async () => {
  try {
    await start({ allowUnconfigured: true, background: false });
  } catch {}
};
$('server-restart').onclick = async () => {
  if (restarting) return;
  restarting = true;
  let restartedOk = false;
  try {
    const state = await refreshServer().catch(() => null);
    const canRestart = state ? (state.canRestart !== undefined ? state.canRestart : state.managed) : true;
    if (state && !canRestart) {
      await refreshServer();
      return;
    }
    const op = await pollOperationOnce().catch(() => null);
    let force = false;
    let cancelCurrent = false;
    // Confirmation before any cancel: impact of agents + current operation.
    if ((state && state.activeRuns) || (op && !op.terminal)) {
      if (op && op.cancellable) {
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
        force = Boolean(state && state.activeRuns);
        cancelCurrent = true;
      } else if (op && !op.cancellable) {
        // Noncancellable handoff (download/install): explicit retry, no fake cancel.
        updateStatus(t.updateDownloading + '…', false);
        return;
      } else {
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
    }
    $('server-state').textContent = t.restarting;
    restartedOk = false;
    try {
      const result = await invoke('desktop_server_restart', { force, cancelCurrent });
      if (result.restarted) {
        // No stale success UI: clear operation + refresh versions at once.
        currentOperation = null;
        if ($('update-cancel')) $('update-cancel').hidden = true;
        await refreshServer();
        $('server-agents').textContent = t.restarted;
        restartedOk = true;
      } else await refreshServer();
    } catch (error) {
      // Never fail silently: explicit busy vs failure.
      if (String(error) === 'update_busy') {
        $('server-state').textContent = t.componentsBusy;
      } else {
        throw error;
      }
    }
  } catch {
    $('server-state').textContent = t.restartFailed;
  } finally {
    restarting = false;
    // A final refresh must not clobber the post-restart confirmation line.
    if (!restartedOk) await refreshServer().catch(() => {});
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
    const params = new URLSearchParams(location.search);
    const isQuit = params.has('quit');
    const state = await invoke('desktop_state');
    $('app-version').textContent = `v${state.version}`;
    $('updates').hidden = !settings && !isQuit;
    if ($('back-studio')) $('back-studio').hidden = !settings && !isQuit;
    startOperationPoll();
    if (isQuit) {
      // Tray quit when server is down: same main shell shows quit choice.
      showLauncher();
      $('title').textContent = t.quitTitle;
      $('description').textContent = t.quitNote;
      showQuitDialog();
      return;
    }
    if (settings) {
      void refreshServer()
        .then((s) => {
          // Absent/stopped server: canRestart false, allow start path.
          if (s && !s.running) {
            $('start').disabled = false;
            $('start').textContent = t.retry;
          }
        })
        .catch(() => {
          $('server-state').textContent = t.restartFailed;
          // Same surface fallback with obvious retry when status is down.
          $('start').disabled = false;
          $('start').textContent = t.retry;
        });
      void pollOperationOnce().catch(() => null);
    }
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
        }
      } else {
        $('components').hidden = false;
        // Cold foreground with a known older engine receipt and no running
        // server: explain the 0.9.5 step. Empty fresh installs carry no
        // legacy evidence, so the predicate stays silent there.
      }
    }
  } catch (error) {
    document.body.classList.remove('boot-connecting');
    showError(String(error));
  }
})();
