import { formatMessage as tr } from '../public/i18n-core.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { open, readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { HttpError, cwdKey } from './store.mjs';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const PREVIEW_LIMIT = 512 * 1024;
const DOWNLOAD_LIMIT = 50 * 1024 * 1024;
const hidden = new Set(['.git', 'node_modules', '.local', '.codex-remote-attachments', '__pycache__']);
const imageTypes = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};
const within = (root, path) => cwdKey(path) === cwdKey(root) || cwdKey(path).startsWith(cwdKey(root) + sep);

export function projectPath(value = '') {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f:\\]/.test(value) || isAbsolute(value))
    throw new HttpError(400, tr('server.chemin_de_fichier_invalide'));
  const parts = value.split('/');
  if (
    parts.some(
      (part) => part === '..' || part === '.' || hidden.has(part.toLowerCase()) || /[. ]$/.test(part),
    )
  )
    throw new HttpError(403, tr('server.ce_chemin_n_est_pas_accessible_dans_les_fichiers_du_projet'));
  return parts.filter(Boolean).join('/');
}

export function createProjectFiles({ store, protectedRoots = [] }) {
  const protectedPaths = protectedRoots.map((path) => resolve(path));
  const protectedPath = (path) => protectedPaths.some((root) => within(root, path));
  async function target(cwd, input = '', { missing = false } = {}) {
    const project = await store.findProject(cwd);
    const root = await realpath(project.cwd).catch(() => {
      throw new HttpError(404, tr('server.dossier_du_projet_introuvable'));
    });
    const path = projectPath(input),
      absolute = join(root, path);
    let checked = absolute;
    while (true) {
      try {
        const actual = await realpath(checked);
        if (!within(root, actual)) throw new HttpError(403, tr('server.ce_lien_sort_du_projet'));
        projectPath(relative(root, actual).replaceAll('\\', '/'));
        if (protectedPath(actual))
          throw new HttpError(
            403,
            tr('server.ce_dossier_contient_les_donnees_privees_du_moteur_ou_du_studio'),
          );
        break;
      } catch (error) {
        if (error.status) throw error;
        if (!missing || error.code !== 'ENOENT' || checked === root)
          throw new HttpError(404, tr('server.fichier_introuvable'));
        checked = dirname(checked);
      }
    }
    return { root, path, absolute };
  }

  async function git(root, args) {
    try {
      return (
        await exec('git', ['--no-optional-locks', '--literal-pathspecs', '-C', root, ...args], {
          windowsHide: true,
          shell: false,
          timeout: 10000,
          maxBuffer: 2 * 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat' },
        })
      ).stdout;
    } catch (error) {
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER')
        throw new HttpError(413, tr('server.le_resultat_git_est_trop_volumineux'));
      if (error.killed) throw new HttpError(504, tr('server.git_met_trop_de_temps_a_repondre_reessayez'));
      throw error;
    }
  }

  async function gitRoot(root) {
    try {
      return (await git(root, ['rev-parse', '--show-toplevel'])).trim();
    } catch (error) {
      if (error.status) throw error;
      if (error.code === 'ENOENT') return { reason: tr('server.git_n_est_pas_installe_sur_le_pc') };
      if (/not a git repository/i.test(error.stderr || ''))
        return { reason: tr('server.ce_projet_n_est_pas_un_depot_git') };
      throw new HttpError(409, tr('server.impossible_de_consulter_ce_depot_git'));
    }
  }

  async function read(cwd, path, limit) {
    const found = await target(cwd, path);
    const handle = await open(found.absolute, 'r').catch(() => {
      throw new HttpError(404, tr('server.fichier_introuvable'));
    });
    try {
      const info = await handle.stat();
      if (!info.isFile()) throw new HttpError(400, tr('server.choisissez_un_fichier'));
      if (info.size > limit)
        throw new HttpError(
          413,
          tr('server.le_fichier_depasse_la_limite_de_mo', { value1: Math.round(limit / 1024 / 1024) }),
        );
      const data = Buffer.alloc(Math.min(info.size + 1, limit + 1));
      let length = 0;
      while (length < data.length) {
        const { bytesRead } = await handle.read(data, length, data.length - length, length);
        if (!bytesRead) break;
        length += bytesRead;
      }
      if (length > limit) throw new HttpError(413, tr('server.le_fichier_a_grandi_pendant_sa_lecture'));
      const after = await handle.stat();
      if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || length !== info.size)
        throw new HttpError(409, tr('server.le_fichier_a_change_pendant_sa_lecture_reessayez'));
      return {
        ...found,
        data: data.subarray(0, length),
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      };
    } finally {
      await handle.close();
    }
  }

  return {
    async image(cwd, reference, basePath = '') {
      const resolved = await this.resolveReference(cwd, reference, basePath);
      if (!resolved.path)
        throw new HttpError(
          409,
          tr('server.indiquez_le_chemin_du_document_dans_le_projet_pour_le_retrouver'),
        );
      const type = imageTypes[extname(resolved.path).toLowerCase()];
      if (!type) throw new HttpError(415, tr('images.unsupported'));
      const file = await read(cwd, resolved.path, 8 * 1024 * 1024);
      return { data: file.data, type };
    },
    async localDirectory(cwd, path) {
      const found = await target(cwd, path);
      if (!(await stat(found.absolute)).isDirectory())
        throw new HttpError(400, tr('server.choisissez_un_dossier'));
      const actual = await realpath(found.absolute);
      if (!within(found.root, actual) || protectedPath(actual))
        throw new HttpError(403, tr('server.ce_fichier_ne_se_trouve_pas_dans_le_projet'));
      projectPath(relative(found.root, actual).replaceAll('\\', '/'));
      return actual;
    },
    async localFile(cwd, path) {
      const found = await target(cwd, path);
      if (!(await stat(found.absolute)).isFile())
        throw new HttpError(400, tr('server.choisissez_un_fichier'));
      const actual = await realpath(found.absolute);
      if (!within(found.root, actual) || protectedPath(actual))
        throw new HttpError(403, tr('server.ce_fichier_ne_se_trouve_pas_dans_le_projet'));
      projectPath(relative(found.root, actual).replaceAll('\\', '/'));
      return actual;
    },
    async resolveReference(cwd, reference, basePath = '') {
      if (
        typeof reference !== 'string' ||
        !reference.trim() ||
        reference.length > 4096 ||
        /[\x00-\x1f]/.test(reference)
      )
        throw new HttpError(400, tr('server.reference_de_fichier_invalide'));
      const { root } = await target(cwd);
      let input = reference.trim();
      if (/^file:/i.test(input)) {
        const url = new URL(input);
        if (url.hostname && url.hostname !== 'localhost')
          throw new HttpError(403, tr('server.ce_fichier_ne_se_trouve_pas_dans_le_projet'));
        input = fileURLToPath(url);
      } else {
        try {
          input = decodeURIComponent(input);
        } catch {
          throw new HttpError(400, tr('server.reference_de_fichier_invalide'));
        }
      }
      input = input.replace(/(?:#L?\d+(?:[-:]L?\d+)?|:\d+(?::\d+)?)$/, '').replaceAll('\\', '/');
      if (process.platform === 'win32' && /^\/[a-z]:\//i.test(input)) input = input.slice(1);
      if (/^[a-z][\w+.-]*:/i.test(input) && !/^[a-z]:\//i.test(input))
        throw new HttpError(400, tr('server.reference_de_fichier_invalide'));
      const base = basePath ? dirname(projectPath(basePath)) : '';
      const absolute = resolve(root, base, input);
      if (!within(root, absolute))
        throw new HttpError(403, tr('server.ce_fichier_ne_se_trouve_pas_dans_le_projet'));
      const path = relative(root, absolute).replaceAll('\\', '/');
      try {
        await this.localFile(cwd, path);
        return { path };
      } catch (error) {
        if (error.status !== 404 || input.includes('/')) throw error;
      }
      // A bare filename is usable only when its project match is unambiguous.
      const matches = [],
        folders = [''];
      let visited = 0;
      const deadline = Date.now() + 1800;
      for (let i = 0; i < folders.length; i++) {
        if (Date.now() > deadline || visited > 20000)
          throw new HttpError(
            409,
            tr('server.indiquez_le_chemin_du_document_dans_le_projet_pour_le_retrouver'),
          );
        const dir = folders[i];
        const entries = await readdir(join(root, dir), { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          visited++;
          const candidate = [dir, entry.name].filter(Boolean).join('/');
          try {
            projectPath(candidate);
          } catch {
            continue;
          }
          if (protectedPath(join(root, candidate))) continue;
          if (entry.isDirectory()) folders.push(candidate);
          if (
            entry.isFile() &&
            (process.platform === 'win32'
              ? entry.name.toLowerCase() === input.toLowerCase()
              : entry.name === input)
          ) {
            await this.localFile(cwd, candidate);
            matches.push({ path: candidate });
            if (matches.length >= 20)
              throw new HttpError(
                409,
                tr('server.plusieurs_fichiers_portent_ce_nom_indiquez_leur_chemin_dans_le_pr'),
              );
          }
        }
      }
      if (!matches.length) throw new HttpError(404, tr('server.document_introuvable_dans_ce_projet'));
      return matches.length === 1 ? matches[0] : { matches };
    },
    async list(cwd, path = '', offset = 0) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new HttpError(400, tr('server.page_invalide'));
      const found = await target(cwd, path);
      if (!(await stat(found.absolute)).isDirectory())
        throw new HttpError(400, tr('server.choisissez_un_dossier'));
      const entries = (await readdir(found.absolute, { withFileTypes: true }))
        .filter(
          (entry) =>
            !hidden.has(entry.name.toLowerCase()) &&
            !protectedPath(join(found.absolute, entry.name)) &&
            (entry.isDirectory() || entry.isFile()),
        )
        .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
      return {
        path: found.path,
        total: entries.length,
        nextOffset: offset + 100 < entries.length ? offset + 100 : null,
        entries: entries.slice(offset, offset + 100).map((entry) => ({
          name: entry.name,
          path: [found.path, entry.name].filter(Boolean).join('/'),
          directory: entry.isDirectory(),
        })),
      };
    },
    async preview(cwd, path) {
      const file = await read(cwd, path, DOWNLOAD_LIMIT);
      const type = imageTypes[extname(path).toLowerCase()];
      if (type && file.size <= 8 * 1024 * 1024)
        return {
          path,
          size: file.size,
          type: 'image',
          image: `data:${type};base64,${file.data.toString('base64')}`,
        };
      if (file.size > PREVIEW_LIMIT)
        return {
          path,
          size: file.size,
          type: 'large',
          message: tr('server.fichier_trop_volumineux_pour_l_apercu_utilisez_ouvrir_pour_le_co'),
        };
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(file.data);
      } catch {
        /* Binary file. */
      }
      if (text === undefined || text.includes('\0'))
        return {
          path,
          size: file.size,
          type: 'binary',
          message: tr('server.apercu_indisponible_pour_ce_type_de_fichier'),
        };
      return { path, size: file.size, type: 'text', text, modifiedAt: file.modifiedAt };
    },
    async download(cwd, path) {
      const file = await read(cwd, path, DOWNLOAD_LIMIT);
      return { data: file.data, name: basename(file.path) };
    },
    async changes(cwd) {
      const { root } = await target(cwd);
      const repository = await gitRoot(root);
      if (typeof repository !== 'string') return { git: false, ...repository, entries: [] };
      const prefix = relative(repository, root).replaceAll('\\', '/');
      const toProject = (path) =>
        prefix ? (path.startsWith(prefix + '/') ? path.slice(prefix.length + 1) : null) : path;
      const raw = (
        await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--', '.'])
      ).split('\0');
      const entries = [];
      for (let i = 0; i < raw.length; i++) {
        if (!raw[i]) continue;
        const status = raw[i].slice(0, 2),
          path = toProject(raw[i].slice(3));
        const previousPath = /[RC]/.test(status) ? toProject(raw[++i] || '') : undefined;
        if (path === null) continue;
        if (protectedPath(join(root, path))) continue;
        try {
          projectPath(path);
          if (previousPath) projectPath(previousPath);
        } catch {
          continue;
        }
        entries.push({
          path,
          status,
          previousPath,
          staged: ![' ', '?'].includes(status[0]),
          untracked: status === '??',
          deleted: status.includes('D'),
        });
      }
      let branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD']).catch(() => '')).trim();
      if (!branch || branch === 'HEAD')
        branch = (
          await git(root, ['symbolic-ref', '--short', 'HEAD']).catch(() => tr('server.head_detachee'))
        ).trim();
      return {
        git: true,
        branch,
        entries: entries.slice(0, 1000),
        total: entries.length,
        truncated: entries.length > 1000,
      };
    },
    async diff(cwd, path) {
      const { root } = await target(cwd, path, { missing: true });
      const changes = await this.changes(cwd);
      const change = changes.entries.find((entry) => entry.path === path);
      if (!change)
        throw new HttpError(404, tr('server.cette_modification_n_est_plus_presente_actualisez_la_liste'));
      const hasHead = await git(root, ['rev-parse', '--verify', 'HEAD']).then(
        () => true,
        () => false,
      );
      if (change.untracked || !hasHead) {
        if (change.deleted)
          return { path, text: '', message: tr('server.fichier_supprime_dans_un_depot_sans_commit') };
        const preview = await this.preview(cwd, path);
        if (preview.type !== 'text')
          return {
            path,
            text: '',
            message: tr('server.le_contenu_de_ce_fichier_ne_peut_pas_etre_affiche_en_diff'),
          };
        const lines = preview.text.split('\n');
        if (lines.at(-1) === '') lines.pop();
        return {
          path,
          text: `--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((line) => '+' + line).join('\n')}`,
          newFile: true,
        };
      }
      if (change.previousPath) await target(cwd, change.previousPath, { missing: true });
      const text = await git(root, [
        'diff',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--no-renames',
        '--unified=3',
        'HEAD',
        '--',
        path,
        ...(change.previousPath ? [change.previousPath] : []),
      ]);
      return {
        path,
        text,
        message: text
          ? undefined
          : tr('server.le_contenu_final_est_identique_a_head_des_changements_peuvent_en'),
      };
    },
  };
}
