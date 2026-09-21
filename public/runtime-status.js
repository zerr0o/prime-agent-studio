// Presentation only: never change the selected model or native retry policy.
// Nonterminal activity: agent_end maps to turn_end and keeps the run alive.
// Only an explicit done event finishes a run. Never treat a timeout as done.
export function applyRuntimeStatus(run, event, tr) {
  if (event.reason === 'backup' && event.backupModel) run.backupModel = event.backupModel;
  if (event.retryEnded) delete run.backupModel;
  if (event.status === 'compacting') {
    delete run.activityStatus;
    run.statusLabel = tr('ui.optimisation_du_contexte');
  } else if (event.status === 'retry_failed') {
    delete run.activityStatus;
    run.statusLabel = tr('providerRetry.failed');
  } else if (event.status === 'retrying' && ['usage', 'unavailable'].includes(event.reason)) {
    delete run.activityStatus;
    run.statusLabel = tr(`providerRetry.${event.reason}`, {
      seconds: Math.max(0, Math.ceil((Number.isFinite(event.delayMs) ? event.delayMs : 0) / 1000)),
    });
  } else if (event.status === 'turn_end') {
    run.activityStatus = 'turn_end';
    run.statusLabel = tr('ui.fin_de_tour');
  } else if (event.status === 'background') {
    run.activityStatus = 'background';
    run.statusLabel = tr('ui.en_arriere_plan');
  } else if (event.status === 'waiting') {
    run.activityStatus = 'waiting';
    run.statusLabel = tr('ui.en_attente');
  } else if (run.backupModel) {
    delete run.activityStatus;
    run.statusLabel = tr('providerRetry.backup', { model: run.backupModel });
  } else if (event.restoredModel) {
    delete run.activityStatus;
    run.statusLabel = tr('providerRetry.restored', { model: event.restoredModel });
  } else {
    delete run.activityStatus;
    run.statusLabel = tr(
      event.status === 'retrying' ? 'ui.nouvelle_tentative_en_cours' : 'ui.l_agent_travaille',
    );
  }
}

// Resume activity after a nonterminal turn boundary. Text, reasoning, tool,
// input, compaction and retry events prove the engine works again and clear
// the honest background or turn ended label. Backup display is preserved.
export function noteActivity(run, tr) {
  if (!run.activityStatus) return;
  delete run.activityStatus;
  if (run.backupModel) run.statusLabel = tr('providerRetry.backup', { model: run.backupModel });
  else delete run.statusLabel;
}
