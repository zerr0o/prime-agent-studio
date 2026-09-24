// UI-only native adapter for the unified components panel.
// Never runs an installer or stops a process. Deterministic fake IPC.
export async function mockDesktopComponentsPanel(context, overrides) {
  const mode = Object.assign({ componentsMode: 'needs_update', autostart: false }, overrides || {});
  await context.addInitScript((initial) => {
    window.__PRIME_STUDIO_DESKTOP__ = true;
    window.__PRIME_STUDIO_COMPONENTS__ = true;
    window.componentsFixture = {
      mode: initial.componentsMode,
      autostart: initial.autostart,
      calls: [],
      channels: [],
      installResolvers: [],
    };
    const baseComponents = (engineVersion) => ({
      engine: { version: engineVersion, status: 'ready', path: 'C:\\Studio\\engine\\cli.js' },
      uv: { version: '0.8.22', status: 'ready' },
      python: { status: 'ready', path: 'C:\\Studio\\python.exe' },
    });
    const statusResult = () => {
      const f = window.componentsFixture;
      if (f.mode === 'current') {
        return {
          ready: true,
          components: baseComponents('0.9.6'),
          requiredEngine: '0.9.6',
          installedEngine: '0.9.6',
          appVersion: '3.7.0',
          server: { running: true, managed: true, version: '3.7.0', activeRuns: 0 },
          needsUpdate: false,
          needsRestart: false,
          serverUpdatePending: false,
          activation: 'active',
        };
      }
      if (f.mode === 'deferred_status' || f.mode === 'server_pending') {
        return {
          ready: true,
          components: baseComponents('0.9.6'),
          requiredEngine: '0.9.6',
          installedEngine: '0.9.6',
          appVersion: '3.7.0',
          server: { running: true, managed: true, version: '3.7.0', activeRuns: 0 },
          needsUpdate: false,
          needsRestart: true,
          serverUpdatePending: true,
          activation: 'deferred',
          activationReason: 'agents_running',
        };
      }
      if (f.mode === 'unmanaged') {
        return {
          ready: true,
          components: baseComponents('0.9.2'),
          requiredEngine: '0.9.6',
          installedEngine: '0.9.2',
          appVersion: '3.7.0',
          server: { running: true, managed: false, version: '3.7.0', activeRuns: 0, error: 'not_managed' },
          needsUpdate: true,
          needsRestart: false,
          serverUpdatePending: false,
        };
      }
      if (f.mode === 'validation_failed') {
        return { failure: { error: 'validation_failed', component: 'engine' } };
      }
      return {
        ready: true,
        components: baseComponents('0.9.2'),
        requiredEngine: '0.9.6',
        installedEngine: '0.9.2',
        appVersion: '3.7.0',
        server: { running: true, managed: true, version: '3.7.0', activeRuns: 0 },
        needsUpdate: true,
        needsRestart: false,
        serverUpdatePending: false,
      };
    };
    class FakeChannel {
      constructor() {
        this.onmessage = null;
        window.componentsFixture.channels.push(this);
      }
    }
    window.__TAURI__ = {
      event: {
        listen: async () => () => {},
      },
      core: {
        Channel: FakeChannel,
        invoke: async (command, args) => {
          const f = window.componentsFixture;
          f.calls.push({ command, action: args?.action, enabled: args?.enabled });
          if (command === 'desktop_update_status')
            return { appVersion: '3.7.0', version: '3.7.0', running: true, managed: true, activeRuns: 0 };
          if (command === 'desktop_update_check') return { available: false };
          if (command === 'desktop_state') return { version: '3.7.0', autostart: f.autostart };
          if (command === 'desktop_autostart') {
            f.autostart = Boolean(args?.enabled);
            return {};
          }
          if (command === 'desktop_server_restart') {
            if (f.mode === 'restart_required') return { restarted: false, reason: 'components_required' };
            return { restarted: true };
          }
          if (command === 'desktop_components_cancel') {
            const pending = f.installResolvers.splice(0);
            for (const resolve of pending) resolve({ failure: { error: 'cancelled', component: 'engine' } });
            return {};
          }
          if (command === 'desktop_components') {
            const action = args?.action;
            if (action === 'status' || action === 'diagnose') {
              if (f.mode === 'setup_busy') throw 'setup_busy';
              const result = statusResult();
              if (result.failure) return result;
              return result;
            }
            if (action === 'install') {
              if (f.mode === 'setup_busy') throw 'setup_busy';
              if (f.mode === 'network_failed')
                return { failure: { error: 'download_failed', component: 'engine' } };
              if (f.mode === 'activation_failed') {
                const channel2 = args?.onProgress;
                if (channel2 && typeof channel2.onmessage === 'function') {
                  try {
                    channel2.onmessage({ component: 'engine', stage: 'server_update_pending' });
                  } catch {}
                }
                return {
                  ready: true,
                  components: baseComponents('0.9.6'),
                  requiredEngine: '0.9.6',
                  installedEngine: '0.9.6',
                  appVersion: '3.7.0',
                  server: { running: true, managed: true, version: '3.7.0', activeRuns: 0 },
                  activation: 'failed',
                  activationError: 'server_restart_failed',
                  needsUpdate: false,
                  needsRestart: false,
                  serverUpdatePending: false,
                };
              }
              const channel = args?.onProgress;
              if (channel && typeof channel.onmessage === 'function') {
                try {
                  channel.onmessage({ component: 'engine', stage: 'download', bytes: 16384, total: 32768 });
                } catch {}
              }
              if (f.mode === 'cancel_pending') {
                return new Promise((resolve) => {
                  f.installResolvers.push(resolve);
                });
              }
              return {
                ready: true,
                components: baseComponents('0.9.6'),
                requiredEngine: '0.9.6',
                installedEngine: '0.9.6',
                appVersion: '3.7.0',
                server: { running: true, managed: true, version: '3.7.0', activeRuns: 0 },
                activation: 'deferred',
                activationReason: 'agents_running',
                needsUpdate: false,
                needsRestart: true,
                serverUpdatePending: true,
              };
            }
            if (action === 'apply') {
              if (f.mode === 'apply_required') {
                return {
                  ready: false,
                  components: baseComponents('0.9.2'),
                  requiredEngine: '0.9.6',
                  installedEngine: '0.9.2',
                  appVersion: '3.7.0',
                  server: { running: true, managed: true, version: '3.7.0', activeRuns: 0 },
                  activation: 'incomplete',
                  activationError: 'components_required',
                  needsUpdate: true,
                  needsRestart: false,
                  serverUpdatePending: false,
                };
              }
              return {
                ready: true,
                components: baseComponents('0.9.6'),
                requiredEngine: '0.9.6',
                installedEngine: '0.9.6',
                appVersion: '3.7.0',
                server: { running: true, managed: true, version: '3.7.0', activeRuns: 0 },
                activation: 'active',
                needsUpdate: false,
                needsRestart: false,
                serverUpdatePending: false,
              };
            }
            throw 'action_invalid';
          }
          throw new Error('Unexpected fixture command: ' + command);
        },
      },
    };
  }, mode);
}
