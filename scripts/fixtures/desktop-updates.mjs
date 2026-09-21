// UI-only native adapter for the updates settings panel.
// Never runs an installer, stops a process, or touches a real app.
export async function mockDesktopUpdates(context, seed = {}) {
  await context.addInitScript((seed) => {
    window.__PRIME_STUDIO_DESKTOP__ = true;
    window.__PRIME_STUDIO_COMPONENTS__ = true;
    window.updateFixture = {
      activeRuns: seed.activeRuns ?? 2,
      ownership: seed.ownership ?? 'managed',
      running: seed.running ?? true,
      mode: seed.mode ?? 'available',
      operation: seed.operation ?? null,
      componentsReady: seed.componentsReady ?? true,
      installTotal: seed.installTotal ?? 'known',
      calls: [],
      channel: null,
      cancelled: false,
    };
    const snapshot = () => {
      const f = window.updateFixture;
      const managed = f.ownership === 'managed';
      const can = f.running && (f.ownership === 'managed' || f.ownership === 'recoverable');
      return {
        appVersion: '2.9.3',
        version: '2.9.2',
        running: f.running,
        managed,
        ownership: f.running ? f.ownership : 'absent',
        source: !f.running
          ? 'none'
          : managed
            ? 'owner-file'
            : f.ownership === 'recoverable'
              ? 'os-verified'
              : 'mismatch',
        pid: f.running ? 26480 : null,
        canRestart: can,
        restartReason: can ? null : f.running ? 'server_not_managed' : 'server_stopped',
        canStop: can,
        stopReason: can ? null : f.running ? 'server_not_managed' : 'already-stopped',
        activeRuns: f.activeRuns,
      };
    };
    const downloadingSnapshot = () => {
      const f = window.updateFixture;
      const now = Date.now();
      const known = f.installTotal !== 'unknown';
      return {
        id: 'op-install',
        kind: 'install',
        stage: 'downloading',
        startedAt: now - 2000,
        updatedAt: now,
        receivedBytes: 420,
        totalBytes: known ? 1000 : undefined,
        percent: known ? 42 : undefined,
        detail: '',
        cancellable: true,
        done: false,
        terminal: false,
      };
    };
    window.__TAURI__ = {
      core: {
        Channel: class {},
        invoke: async (command, args) => {
          const f = window.updateFixture;
          f.calls.push({
            command,
            force: args?.force,
            restartServer: args?.restartServer,
            cancelCurrent: args?.cancelCurrent,
            version: args?.version,
            action: args?.action,
          });
          if (command === 'desktop_update_status') return snapshot();
          if (command === 'desktop_update_operation') return { operation: f.operation };
          if (command === 'desktop_components') {
            const action = args?.action;
            if (action === 'status') {
              if (f.componentsReady) {
                return { ready: true, components: { engine: { version: '9', status: 'ready' } } };
              }
              return { ready: false, components: { engine: { version: '9', status: 'missing' } } };
            }
            if (action === 'prepare' || action === 'diagnose') {
              if (action === 'prepare' && f.prepareHang) {
                return new Promise((resolve) => {
                  f.resolvePrepare = resolve;
                });
              }
              f.componentsReady = true;
              return { ready: true, components: { engine: { version: '9', status: 'ready' } } };
            }
            return { ready: true, components: {} };
          }
          if (command === 'desktop_components_cancel') return true;
          if (command === 'desktop_update_check') {
            if (f.mode === 'offline') throw 'check_failed';
            const available = f.mode !== 'current';
            return {
              available,
              version: '2.9.4',
              notes: available
                ? 'Amélioration des mises à jour et des interactions Windows.\n<img src=x onerror=alert(1)>'
                : '',
            };
          }
          if (command === 'desktop_update_install') {
            if (f.mode === 'invalid') throw 'download_failed';
            f.channel = args.onEvent;
            f.operation = downloadingSnapshot();
            args.onEvent.onmessage({ ...downloadingSnapshot() });
            return new Promise((resolve, reject) => {
              f.resolveInstall = resolve;
              f.rejectInstall = reject;
            });
          }
          if (command === 'desktop_server_restart') {
            if (f.mode === 'race') return { reason: 'agents_running' };
            if (f.mode === 'hang-restart') {
              return new Promise((resolve) => {
                f.resolveRestart = (value) => {
                  f.operation = null;
                  resolve(value);
                };
              });
            }
            f.operation = null;
            return { restarted: true, version: '2.9.3' };
          }
          if (command === 'desktop_quit') {
            if (f.mode === 'quit-race') return { reason: 'agents_running' };
            if (f.mode === 'quit-fail') throw 'server_stop_failed';
            if (!f.running) return { stopped: false, reason: 'already-stopped' };
            f.running = false;
            f.operation = null;
            return { stopped: true };
          }
          if (command === 'desktop_update_cancel') {
            f.cancelled = true;
            return true;
          }
          throw new Error('Unexpected fixture command: ' + command);
        },
      },
    };
  }, seed);
}
