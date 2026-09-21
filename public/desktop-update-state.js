// Shared presentation rules for the served update surface. No process control lives here.
export function operationActive(operation) {
  return Boolean(
    operation &&
    !operation.done &&
    !operation.terminal &&
    !['done', 'error', 'cancelled', 'idle'].includes(operation.stage),
  );
}
export function operationCancellable(operation) {
  return (
    operationActive(operation) &&
    (operation.cancellable === true ||
      (['components', 'prepare'].includes(operation.kind) && operation.stage === 'working'))
  );
}
export function updateView({ server, components, operation, available, checked = false, localKind } = {}) {
  const active = operationActive(operation);
  const busy = Boolean(localKind || active);
  const locked =
    active && operation.kind === 'install' && ['verifying', 'installing'].includes(operation.stage);
  const repair = Boolean(
    components &&
    !components.failure &&
    !components.cancelled &&
    (!components.ready || components.needsUpdate),
  );
  const needsRestart =
    Boolean(server?.running && server.appVersion && server.version !== server.appVersion) ||
    Boolean(components?.needsRestart || components?.serverUpdatePending);
  const known = Boolean(server);
  const canControl =
    known &&
    (server.canRestart === true ||
      server.canStop === true ||
      (server.canRestart === undefined && server.managed === true) ||
      server.running === false);
  let status = 'updates.state_unknown';
  if (known)
    status = !server.running
      ? 'updates.state_stopped'
      : repair
        ? 'updates.state_repair'
        : needsRestart
          ? 'updates.state_restart'
          : available
            ? 'updates.available'
            : checked
              ? 'updates.current'
              : 'updates.state_running';
  return {
    active,
    busy,
    locked,
    repair,
    needsRestart,
    canControl,
    status,
    restartDisabled: locked || ['restart', 'quit'].includes(localKind) || (known && !canControl),
    cancellable: operationCancellable(operation),
  };
}
export function progressNumbers(operation, now = Date.now()) {
  const received = Number(operation?.receivedBytes ?? 0);
  const total = Number(operation?.totalBytes);
  const explicit = operation?.percent;
  const percent =
    explicit != null && Number.isFinite(Number(explicit))
      ? Number(explicit)
      : total > 0
        ? (received / total) * 100
        : null;
  return {
    received: Number.isFinite(received) ? Math.max(0, received) : 0,
    total: total > 0 && Number.isFinite(total) ? total : null,
    percent: percent == null ? null : Math.min(100, Math.max(0, percent)),
    seconds: operation?.startedAt ? Math.max(0, Math.floor((now - operation.startedAt) / 1000)) : 0,
    stalled: operationActive(operation) && operation?.updatedAt > 0 && now - operation.updatedAt > 15000,
  };
}
