import { formatMessage as tr } from '../public/i18n-core.js';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HttpError, validateDirectory } from './store.mjs';

const WINDOWS_HELPER = fileURLToPath(new URL('../scripts/open-directory.ps1', import.meta.url));

export function createDirectoryOpener({
  platform = process.platform,
  run = promisify(execFile),
  env = process.env,
} = {}) {
  const pending = new Map();
  async function launch(path) {
    try {
      if (platform === 'win32') {
        // Only the helper is hidden. Explorer must receive an explicit visible
        // ShellExecute request, even when the Studio inherited SW_HIDE.
        const { stdout } = await run(
          join(env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          [
            '-NoLogo',
            '-NoProfile',
            '-NonInteractive',
            '-STA',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            WINDOWS_HELPER,
          ],
          {
            shell: false,
            windowsHide: true,
            timeout: 15000,
            maxBuffer: 16384,
            encoding: 'utf8',
            env: { ...env, PRIME_STUDIO_OPEN_DIRECTORY: path },
          },
        );
        const result = JSON.parse(stdout.trim());
        if (result.opened !== true || result.visible !== true || result.foreground !== true)
          throw new Error('Explorer is not in the foreground');
      } else {
        await run(platform === 'darwin' ? 'open' : 'xdg-open', [path], { shell: false, timeout: 15000, env });
      }
      return { opened: true };
    } catch {
      throw new HttpError(
        502,
        platform === 'win32'
          ? tr('server.impossible_d_afficher_ce_dossier_dans_l_explorateur_du_pc_reessa')
          : tr('server.impossible_d_ouvrir_ce_dossier_sur_le_pc_reessayez'),
      );
    }
  }
  return async (cwd) => {
    const path = await validateDirectory(cwd),
      key = platform === 'win32' ? path.toLowerCase() : path;
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

export const openDirectory = createDirectoryOpener();
