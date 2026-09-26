// Tiny shared hidden-helper PowerShell invocation for the desktop openers.
// Only node:path, no UI or heavy imports. Shares launch path, flags and
// options only. Each opener keeps its own validation, platform branch,
// stdout check, error mapping, pending map and injected run/env.
// Only the helper stays hidden: the script gets an explicit visible
// ShellExecute request, even when the Studio inherited SW_HIDE.
import { join } from 'node:path';

export function powershellLaunch(helperPath, env, extraEnv) {
  return {
    exe: join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-File', helperPath],
    options: {
      shell: false,
      windowsHide: true,
      timeout: 15000,
      maxBuffer: 16384,
      encoding: 'utf8',
      env: { ...env, ...extraEnv },
    },
  };
}
