// Presentation only: never change the selected model or native retry policy.
export function applyRuntimeStatus(run, event, tr) {
  if (event.reason === 'backup' && event.backupModel) run.backupModel = event.backupModel;
  if (event.retryEnded) delete run.backupModel;
  if (event.status === 'compacting') run.statusLabel = tr('ui.optimisation_du_contexte');
  else if (event.status === 'retry_failed') run.statusLabel = tr('providerRetry.failed');
  else if (event.status === 'retrying' && ['usage', 'unavailable'].includes(event.reason))
    run.statusLabel = tr(`providerRetry.${event.reason}`, {
      seconds: Math.max(0, Math.ceil((Number.isFinite(event.delayMs) ? event.delayMs : 0) / 1000)),
    });
  else if (run.backupModel) run.statusLabel = tr('providerRetry.backup', { model: run.backupModel });
  else if (event.restoredModel)
    run.statusLabel = tr('providerRetry.restored', { model: event.restoredModel });
  else
    run.statusLabel = tr(
      event.status === 'retrying' ? 'ui.nouvelle_tentative_en_cours' : 'ui.l_agent_travaille',
    );
}
