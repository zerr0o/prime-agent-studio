import { formatMessage as tr } from '../public/i18n-core.js';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { powershellLaunch } from './powershell-launch.mjs';
import { HttpError, validateDirectory } from './store.mjs';

const WINDOWS_HELPER = fileURLToPath(new URL('../scripts/open-terminal.ps1', import.meta.url));

export function createTerminalOpener({
  platform = process.platform,
  run = promisify(execFile),
  env = process.env,
} = {}) {
  const pending = new Map();
  async function launch(path) {
    try {
      if (platform !== 'win32') throw new HttpError(404, tr('server.powershell_uniquement_sur_windows'));
      const { exe, args, options } = powershellLaunch(WINDOWS_HELPER, env, {
        PRIME_STUDIO_OPEN_TERMINAL: path,
      });
      const { stdout } = await run(exe, args, options);
      const result = JSON.parse(stdout.trim());
      if (result.opened !== true) throw new Error('PowerShell did not open');
      return { opened: true };
    } catch (error) {
      if (error?.status) throw error;
      throw new HttpError(502, tr('server.impossible_d_ouvrir_powershell_reessayez'));
    }
  }
  return async (cwd) => {
    const path = await validateDirectory(cwd),
      key = path.toLowerCase();
    if (pending.has(key)) return pending.get(key);
    const job = launch(path);
    pending.set(key, job);
    try {
      return await job;
    } finally {
      if (pending.get(key) === job) pending.delete(key);
    }
  };
}

export const openTerminal = createTerminalOpener();
