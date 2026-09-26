import { formatMessage as tr } from '../public/i18n-core.js';
import { execFile } from 'node:child_process';
import { stat } from 'node:fs/promises';
import { extname, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { powershellLaunch } from './powershell-launch.mjs';
import { HttpError } from './store.mjs';

const helper = fileURLToPath(new URL('../scripts/open-file.ps1', import.meta.url));
const documents = new Set(
  'txt md markdown mdown mkd json jsonl log csv tsv pdf png jpg jpeg gif webp bmp tif tiff ico svg doc docx odt rtf xls xlsx ods ppt pptx odp zip 7z tar gz mp3 wav flac mp4 webm mov'.split(
    ' ',
  ),
);
const source = new Set(
  'html htm xml css js mjs cjs jsx ts tsx py pyw rs go java c h cpp hpp cs sh ps1 bat cmd yaml yml toml ini conf sql tex rb php vbs vbe wsf wsh jse reg inf'.split(
    ' ',
  ),
);
export function fileLaunchMode(path) {
  const extension = extname(path).slice(1).toLowerCase();
  if (source.has(extension) || !extension) return 'editor';
  if (documents.has(extension)) return 'associated';
  throw new HttpError(400, tr('server.ce_type_de_fichier_ne_peut_pas_etre_ouvert_depuis_le_studio'));
}

export function createFileOpener({
  platform = process.platform,
  run = promisify(execFile),
  env = process.env,
} = {}) {
  const pending = new Map();
  return async (path) => {
    if (typeof path !== 'string' || !isAbsolute(path) || /[\x00-\x1f]/.test(path))
      throw new HttpError(400, tr('server.fichier_invalide'));
    if (!(await stat(path).catch(() => null))?.isFile())
      throw new HttpError(404, tr('server.fichier_introuvable'));
    const mode = fileLaunchMode(path),
      key = platform === 'win32' ? path.toLowerCase() : path;
    if (pending.has(key)) return pending.get(key);
    const job = (async () => {
      try {
        if (platform === 'win32') {
          const { exe, args, options } = powershellLaunch(helper, env, {
            PRIME_STUDIO_OPEN_FILE: path,
            PRIME_STUDIO_FILE_MODE: mode,
          });
          const { stdout } = await run(exe, args, options);
          if (JSON.parse(stdout.trim()).opened !== true) throw new Error('File opening was not accepted');
        } else {
          if (mode === 'editor') throw new Error('Text editor not configured');
          await run(platform === 'darwin' ? 'open' : 'xdg-open', [path], {
            shell: false,
            timeout: 15000,
            env,
          });
        }
        return { opened: true };
      } catch {
        throw new HttpError(
          502,
          tr('server.le_pc_n_a_pas_pu_ouvrir_ce_fichier_verifiez_qu_une_application_e'),
        );
      }
    })();
    pending.set(key, job);
    try {
      return await job;
    } finally {
      if (pending.get(key) === job) pending.delete(key);
    }
  };
}
export const openFile = createFileOpener();
