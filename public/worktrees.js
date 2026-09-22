import { t as tr, translateKnown, onLanguageChange } from './i18n.js';

// Isolated Git task worktrees, frontend V1.
// Contract frozen with worktree-git and worktree-server:
// - GET  /api/worktrees?cwd=<abs> -> { worktrees: [...], current?: entry|null }
// - POST /api/worktrees { cwd, name } -> 201 { worktree, ... }
// - GET  /api/worktrees/<id>?cwd=<abs> -> inspect { worktree, main, task,
//        baseCommit, ahead, behind, diff: { patch, truncated, bytes,
//        workingPatch, workingTruncated, workingBytes, committedFiles,
//        files: [{ path, code }], binary, numstat, untracked,
//        untrackedIncluded: false, note } }
//   patch is the committed integration payload (source HEAD vs task HEAD).
//   workingPatch holds uncommitted task changes and always blocks integrate.
// - POST /api/worktrees/<id>/integrate { cwd, revision, confirm: true,
//        expectedSourceHead, expectedWorktreeHead }
// - POST /api/worktrees/<id>/remove { cwd, revision, confirm: true, discard }
// Per-file fallback uses the existing bounded API:
// - GET /api/project-files/diff?cwd=<taskPath>&path=<file>
// All paths and patch bodies render via textContent only, never innerHTML.
// Mutations stay local only: buttons disable on remote or read-only contexts.
// No auto commit, no push, no dependency install, no secret handling.

export const WORKTREE_ENDPOINTS = {
  list: '/api/worktrees',
};

const listQuery = (cwd) => `/api/worktrees?cwd=${encodeURIComponent(cwd || '')}`;
const inspectQuery = (id, cwd) =>
  `/api/worktrees/${encodeURIComponent(id)}?cwd=${encodeURIComponent(cwd || '')}`;
const integratePath = (id) => `/api/worktrees/${encodeURIComponent(id)}/integrate`;
const removePath = (id) => `/api/worktrees/${encodeURIComponent(id)}/remove`;
const preparePath = (id) => `/api/worktrees/${encodeURIComponent(id)}/prepare`;

const samePath = (a, b) => {
  const norm = (p) =>
    String(p || '').replaceAll('\\', '/').replace(/\/$/, '').toLowerCase();
  return norm(a) === norm(b);
};
const shortHead = (head) => (typeof head === 'string' && head.length >= 7 ? head.slice(0, 7) : head || '');
const asArray = (value) => (Array.isArray(value) ? value : []);

function workingCode(entry) {
  if (typeof entry === 'string') return '';
  return String(entry?.code || entry?.status || '');
}

function splitChanges(inspect) {
  const diff = inspect?.diff || {};
  const numstat = new Map(asArray(diff.numstat).map((row) => [row?.path, row]));
  const binary = new Set(asArray(diff.binary));
  const committed = asArray(diff.committedFiles)
    .map((path) => String(path || ''))
    .filter(Boolean)
    .map((path) => ({
      path,
      added: numstat.get(path)?.added ?? null,
      removed: numstat.get(path)?.removed ?? null,
      binary: binary.has(path),
      committed: true,
    }));
  const working = asArray(diff.files)
    .map((file) => (typeof file === 'string' ? { path: file } : file))
    .map((file) => String(file?.path || ''))
    .filter(Boolean)
    .map((path) => ({ path, code: workingCode(asArray(diff.files).find((f) => (typeof f === 'string' ? f : f?.path) === path)) }));
  return { committed, working, untracked: asArray(diff.untracked).map(String).filter(Boolean) };
}

export function createWorktreesUI({
  api,
  getContext,
  toast,
  refreshOverview,
  requestNewSession,
  startTaskSession,
  openTaskSession,
}) {
  const $ = (id) => document.getElementById(id);
  const context = () => getContext?.() || {};
  const ownerCwd = () => context().projectCwd || context().cwd || '';
  const execCwd = () => context().executionCwd || context().cwd || '';
  const mutationsAllowed = () => {
    const ctx = context();
    return ctx.remote !== true && ctx.readOnly !== true && ctx.online !== false;
  };

  const state = {
    supported: null,
    cwd: '',
    list: [],
    current: null,
    creating: false,
    inspect: null,
    inspectId: '',
    patch: '',
    workingPatch: '',
    inspectPending: false,
    filePending: false,
    mutatePending: false,
    preparePending: false,
    prepareSessionId: '',
    opener: null,
  };

  const els = () => ({
    entry: $('new-task'),
    banner: $('worktree-banner'),
    bannerBranch: $('worktree-banner-branch'),
    bannerPath: $('worktree-banner-path'),
    bannerCopy: $('worktree-banner-copy'),
    bannerButton: $('worktree-banner-button'),
    dialog: $('worktree-dialog'),
    form: $('worktree-form'),
    name: $('worktree-name'),
    nameField: $('worktree-name-field'),
    error: $('worktree-error'),
    list: $('worktree-list'),
    listEmpty: $('worktree-list-empty'),
    taskDialog: $('worktree-task-dialog'),
    taskTitle: $('worktree-task-title'),
    taskError: $('worktree-task-error'),
    taskStatus: $('worktree-task-status'),
    metaBranch: $('wt-meta-branch'),
    metaPath: $('wt-meta-path'),
    copyPath: $('wt-copy-path'),
    metaSource: $('wt-meta-source'),
    metaBase: $('wt-meta-base'),
    metaState: $('wt-meta-state'),
    files: $('wt-files'),
    filesEmpty: $('wt-files-empty'),
    diff: $('wt-diff'),
    diffNote: $('wt-diff-note'),
    prepareBox: $('wt-prepare-box'),
    prepareCheck: $('wt-prepare-confirm'),
    prepareButton: $('wt-prepare-button'),
    prepareOpen: $('wt-prepare-open'),
    integrateBox: $('wt-integrate-box'),
    integrateCheck: $('wt-integrate-confirm'),
    integrateButton: $('wt-integrate-button'),
    removeBox: $('wt-remove-box'),
    removeCheck: $('wt-remove-confirm'),
    discardCheck: $('wt-discard-changes'),
    discardRow: $('wt-discard-row'),
    removeButton: $('wt-remove-button'),
    refreshButton: $('wt-refresh-button'),
    remoteNote: $('wt-remote-note'),
  });

  function showError(node, error) {
    if (!node) return;
    if (!error) {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    node.hidden = false;
    node.textContent = typeof error === 'string' ? error : translateKnown(error?.message || error);
  }

  function guidanceFor(error) {
    const code = error?.code || '';
    if (code === 'worktree_dirty' || /non valid/i.test(error?.message || '')) return tr('worktrees.tache_modifiee');
    if (code === 'worktree_not_fast_forward') return tr('worktrees.non_avance_rapide');
    if (code === 'worktree_conflict') return tr('worktrees.etat_perime');
    if (code === 'worktree_busy') return tr('worktrees.execution_en_cours');
    return '';
  }

  function resolveCurrent(list) {
    const ctx = context();
    const exec = execCwd();
    return (
      list.find((entry) => ctx.sessionWorktreeId && entry?.id === ctx.sessionWorktreeId) ||
      list.find((entry) => exec && samePath(entry?.path, exec)) ||
      list.find((entry) => ctx.sessionId && entry?.sessionId === ctx.sessionId) ||
      null
    );
  }

  async function detect(cwd) {
    if (!cwd) {
      state.supported = null;
      state.list = [];
      state.current = null;
      renderEntry();
      renderBanner();
      renderCreateList();
      return;
    }
    let data;
    try {
      data = await api(listQuery(cwd));
    } catch (error) {
      if (error?.status === 404) {
        state.supported = false;
      }
      state.list = [];
      state.current = null;
      renderEntry();
      renderBanner();
      renderCreateList();
      return;
    }
    state.supported = true;
    state.cwd = cwd;
    state.list = asArray(data?.worktrees);
    state.current = resolveCurrent(state.list);
    renderEntry();
    renderBanner();
    renderCreateList();
  }

  function renderEntry() {
    const { entry } = els();
    if (!entry) return;
    const ctx = context();
    const blocked = ctx.remote === true || ctx.readOnly === true;
    entry.hidden = blocked || state.supported === false;
    entry.disabled = state.creating || !ownerCwd();
  }

  function renderBanner() {
    const { banner, bannerBranch, bannerPath, bannerCopy, bannerButton } = els();
    if (!banner) return;
    if (!state.current) {
      banner.hidden = true;
      return;
    }
    banner.hidden = false;
    if (bannerBranch) bannerBranch.textContent = state.current.branch || '';
    if (bannerPath) bannerPath.textContent = state.current.path || '';
    if (bannerCopy) bannerCopy.disabled = !state.current.path;
    if (bannerButton) bannerButton.disabled = false;
  }

  function renderCreateList() {
    const { list, listEmpty } = els();
    if (!list) return;
    list.replaceChildren();
    const entries = state.list;
    if (listEmpty) listEmpty.hidden = entries.length > 0 || state.supported === false;
    for (const entry of entries) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const mark = document.createElement('span');
      mark.className = 'wt-st';
      mark.textContent = entry?.branch || '';
      const label = document.createElement('span');
      label.className = 'wt-path';
      label.textContent = entry?.name || entry?.branch || '';
      button.append(mark, label);
      button.setAttribute('aria-label', `${tr('worktrees.ouvrir')} ${entry?.name || entry?.branch || ''}`);
      button.addEventListener('click', () => {
        els().dialog?.close();
        void openTask(entry?.id, button);
      });
      item.append(button);
      list.append(item);
    }
  }

  function syncNameField() {
    const ui = els();
    const mode = ui.form?.querySelector('input[name="worktree-mode"]:checked')?.value || 'current';
    if (ui.nameField) ui.nameField.hidden = mode !== 'isolated';
  }

  function openCreate(opener) {
    if (!mutationsAllowed()) return;
    const ui = els();
    if (!ui.dialog) return;
    if (state.supported === false) {
      toast(tr('worktrees.indisponible'), true);
      return;
    }
    state.opener = opener || document.activeElement;
    ui.form?.reset();
    const currentMode = ui.form?.querySelector('input[name="worktree-mode"][value="current"]');
    if (currentMode) currentMode.checked = true;
    syncNameField();
    showError(ui.error, null);
    if (typeof ui.dialog.showModal === 'function') ui.dialog.showModal();
    else ui.dialog.setAttribute('open', '');
    window.setTimeout(() => {
      const target =
        ui.nameField && !ui.nameField.hidden
          ? $('worktree-name')
          : ui.form?.querySelector('input[name="worktree-mode"]:checked');
      target?.focus({ preventScroll: true });
    }, 30);
  }

  function closeCreate() {
    const ui = els();
    if (ui.dialog?.open) ui.dialog.close();
    else ui.dialog?.removeAttribute('open');
    if (state.opener?.focus) state.opener.focus({ preventScroll: true });
    state.opener = null;
  }

  async function submitCreate(event) {
    event?.preventDefault();
    const ui = els();
    if (state.creating || !mutationsAllowed()) return;
    const mode = ui.form?.querySelector('input[name="worktree-mode"]:checked')?.value || 'current';
    if (mode === 'current') {
      closeCreate();
      requestNewSession?.();
      return;
    }
    const cwd = ownerCwd();
    const name = ui.name?.value?.trim() || '';
    if (!cwd) {
      showError(ui.error, tr('worktrees.indisponible'));
      return;
    }
    state.creating = true;
    renderEntry();
    showError(ui.error, null);
    try {
      const result = await api(WORKTREE_ENDPOINTS.list, {
        method: 'POST',
        body: { cwd, ...(name ? { name } : {}) },
      });
      closeCreate();
      toast(tr('worktrees.tache_creee'));
      await startTaskSession?.(result?.worktree?.path || '');
      await refreshOverview?.();
      await detect(ownerCwd());
    } catch (error) {
      showError(ui.error, error?.message ? error : String(error));
    } finally {
      state.creating = false;
      renderEntry();
    }
  }

  async function openTask(id, opener) {
    const ui = els();
    if (!ui.taskDialog) return;
    state.opener = opener || document.activeElement;
    state.inspect = null;
    state.inspectId = id || state.current?.id || '';
    renderTask();
    if (typeof ui.taskDialog.showModal === 'function') ui.taskDialog.showModal();
    else ui.taskDialog.setAttribute('open', '');
    window.setTimeout(() => ui.refreshButton?.focus({ preventScroll: true }), 30);
    await refreshInspect();
  }

  function closeTask() {
    const ui = els();
    if (ui.taskDialog?.open) ui.taskDialog.close();
    else ui.taskDialog?.removeAttribute('open');
    if (state.opener?.focus) state.opener.focus({ preventScroll: true });
    state.opener = null;
  }

  async function refreshInspect() {
    const ui = els();
    const id = state.inspectId;
    const cwd = ownerCwd() || state.current?.sourceCwd || state.current?.sourcePath || '';
    if (!id) {
      showError(ui.taskError, tr('worktrees.etat_perime'));
      return;
    }
    state.inspectPending = true;
    renderTask();
    showError(ui.taskError, null);
    try {
      state.inspect = await api(inspectQuery(id, cwd || undefined));
    } catch (error) {
      showError(ui.taskError, error?.message ? error : String(error));
      state.inspect = null;
    } finally {
      state.inspectPending = false;
      renderTask();
    }
  }

  function renderTask() {
    const ui = els();
    if (!ui.taskDialog) return;
    const inspect = state.inspect;
    const entry = inspect?.worktree || state.list.find((item) => item?.id === state.inspectId) || state.current || {};
    if (ui.taskTitle) ui.taskTitle.textContent = entry?.name || tr('worktrees.bandeau_tache');
    const allowed = mutationsAllowed();
    if (ui.remoteNote) ui.remoteNote.hidden = allowed;
    if (ui.metaBranch) ui.metaBranch.textContent = inspect?.task?.branch || entry?.branch || '';
    if (ui.metaPath) ui.metaPath.textContent = inspect?.task?.path || entry?.path || '';
    if (ui.copyPath) ui.copyPath.disabled = !(inspect?.task?.path || entry?.path);
    if (ui.metaSource) {
      const branch = inspect?.main?.branch || entry?.sourceBranch || '';
      const head = shortHead(inspect?.main?.head || '');
      ui.metaSource.textContent = head ? `${branch} · ${head}` : branch;
    }
    if (ui.metaBase) ui.metaBase.textContent = shortHead(inspect?.baseCommit || entry?.baseCommit || '');
    if (ui.metaState) {
      if (!inspect) {
        ui.metaState.textContent = state.inspectPending ? '…' : '';
      } else {
        const taskClean = inspect.task?.clean !== false;
        const ahead = Number(inspect.ahead || 0);
        const behind = Number(inspect.behind || 0);
        const parts = [taskClean ? tr('worktrees.etat_propre') : tr('worktrees.etat_modifie')];
        parts.push(tr('worktrees.avance_retard', { ahead, behind }));
        ui.metaState.textContent = parts.join(' · ');
      }
    }
    renderFiles(inspect);
    renderPatch(inspect);
    renderPrepare(inspect, allowed);
    renderMutations(inspect, allowed);
    if (ui.taskStatus) {
      ui.taskStatus.textContent = state.inspectPending ? '…' : '';
      ui.taskStatus.classList.remove('error');
    }
    if (ui.refreshButton) ui.refreshButton.disabled = state.inspectPending;
  }

  function renderFiles(inspect) {
    const ui = els();
    if (!ui.files) return;
    ui.files.replaceChildren();
    const { committed, working, untracked } = splitChanges(inspect);
    const binary = new Set(asArray(inspect?.diff?.binary));
    if (ui.filesEmpty) ui.filesEmpty.hidden = committed.length + working.length > 0 || state.inspectPending;
    const addRow = ({ path, marker, enabled, onClick, current }) => {
      if (!path) return;
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      const mark = document.createElement('span');
      mark.className = 'wt-st';
      mark.textContent = marker;
      const label = document.createElement('span');
      label.className = 'wt-path';
      label.textContent = path;
      button.append(mark, label);
      if (current) button.setAttribute('aria-current', 'true');
      if (onClick && enabled !== false) button.addEventListener('click', (event) => void onClick(event.currentTarget));
      else button.disabled = true;
      item.append(button);
      ui.files.append(item);
    };
    for (const file of committed.slice(0, 200)) {
      const bits = [tr('worktrees.fichiers_valides')];
      if (file.binary || binary.has(file.path)) bits.push(tr('worktrees.fichier_binaire'));
      if (Number.isInteger(file.added) || Number.isInteger(file.removed)) {
        bits.push(`+${file.added ?? 0}/-${file.removed ?? 0}`);
      }
      addRow({ path: file.path, marker: bits.join(' · '), enabled: true, onClick: (node) => showFileDiff(file.path, node, true) });
    }
    for (const file of working.slice(0, 200)) {
      addRow({
        path: file.path,
        marker: [file.code, tr('worktrees.en_attente')].filter(Boolean).join(' · '),
        enabled: true,
        onClick: (node) => showFileDiff(file.path, node),
      });
    }
    for (const path of untracked.slice(0, 200)) {
      addRow({ path, marker: tr('worktrees.non_suivi'), enabled: false });
    }
  }

  function renderPatch(inspect) {
    const ui = els();
    if (!ui.diff) return;
    const diff = inspect?.diff || {};
    const patch = typeof diff.patch === 'string' ? diff.patch : '';
    const workingPatch = typeof diff.workingPatch === 'string' ? diff.workingPatch : '';
    state.patch = patch;
    state.workingPatch = workingPatch;
    ui.diff.textContent = patch || workingPatch;
    ui.diff.hidden = !(patch || workingPatch);
    if (ui.diffNote) {
      const bits = [];
      if (patch) {
        if (diff.truncated) bits.push(tr('worktrees.apercu_tronque'));
      } else if (workingPatch) {
        bits.push(tr('worktrees.en_attente_note'));
        if (diff.workingTruncated) bits.push(tr('worktrees.apercu_tronque'));
      }
      ui.diffNote.textContent = bits.join(' ');
      ui.diffNote.hidden = bits.length === 0;
    }
    const label = document.querySelector('[data-wt="payload-label"]');
    if (label) label.textContent = workingPatch && !patch ? tr('worktrees.en_attente') : tr('worktrees.charge_utile');
  }

  function filterPatch(patch, path) {
    const sections = String(patch || '').split(/(?=^diff --git )/m);
    const kept = sections.filter((section) => {
      const first = section.split('\n', 1)[0] || '';
      return first.includes(`a/${path} `) || first.includes(`b/${path}`) || first.endsWith(`a/${path}`) || first.endsWith(`b/${path}`);
    });
    return kept.join('');
  }

  async function showFileDiff(path, button, committed) {
    const ui = els();
    if (!ui.diff || state.filePending) return;
    for (const active of ui.files.querySelectorAll('[aria-current="true"]')) {
      active.removeAttribute('aria-current');
    }
    button?.setAttribute('aria-current', 'true');
    if (committed === true) {
      const text = filterPatch(state.patch, path);
      ui.diff.hidden = false;
      ui.diff.textContent = text || state.patch;
      if (ui.diffNote) {
        ui.diffNote.textContent = '';
        ui.diffNote.hidden = true;
      }
      return;
    }
    const pending = filterPatch(state.workingPatch, path);
    if (pending) {
      ui.diff.hidden = false;
      ui.diff.textContent = pending;
      if (ui.diffNote) {
        ui.diffNote.textContent = tr('worktrees.en_attente_note');
        ui.diffNote.hidden = false;
      }
      return;
    }
    state.filePending = true;
    try {
      const taskPath = state.inspect?.task?.path || state.current?.path || '';
      const data = await api(
        `/api/project-files/diff?cwd=${encodeURIComponent(taskPath)}&path=${encodeURIComponent(path)}`,
      );
      const text = typeof data?.text === 'string' ? data.text : '';
      ui.diff.hidden = false;
      ui.diff.textContent = text || state.patch;
      if (ui.diffNote) {
        const note = typeof data?.message === 'string' && !text ? data.message : '';
        ui.diffNote.textContent = note;
        ui.diffNote.hidden = !note;
      }
    } catch (error) {
      ui.diff.hidden = false;
      ui.diff.textContent = state.patch;
      if (ui.diffNote) {
        ui.diffNote.textContent = '';
        ui.diffNote.hidden = true;
      }
      if (ui.taskStatus) {
        ui.taskStatus.textContent = translateKnown(error?.message || error);
        ui.taskStatus.classList.add('error');
      }
    } finally {
      state.filePending = false;
    }
  }

  function renderMutations(inspect, allowed) {
    const ui = els();
    const pending = state.mutatePending || state.inspectPending || state.preparePending;
    const taskClean = inspect ? inspect.task?.clean !== false : false;
    const mainClean = inspect ? inspect.main?.clean !== false : false;
    const revision = inspect?.worktree?.revision || '';
    if (ui.integrateButton) {
      ui.integrateButton.disabled =
        !allowed || pending || !inspect || !revision || !taskClean || !mainClean || !ui.integrateCheck?.checked;
    }
    if (ui.integrateBox) {
      const warn = !inspect || !mainClean ? tr('worktrees.cible_modifiee') : !taskClean ? tr('worktrees.tache_modifiee') : '';
      let note = ui.integrateBox.querySelector('[data-wt="integrate-warn"]');
      if (warn && !note) {
        note = document.createElement('p');
        note.className = 'wt-status error';
        note.dataset.wt = 'integrate-warn';
        ui.integrateBox.append(note);
      }
      if (note) {
        note.textContent = warn;
        note.hidden = !warn;
      }
    }
    const dirty = inspect ? taskClean === false : false;
    const unmerged = Number(inspect?.ahead || 0) > 0;
    if (ui.discardRow) ui.discardRow.hidden = !(dirty || unmerged);
    if (ui.removeButton) {
      const needDiscard = dirty || unmerged;
      const okDiscard = !needDiscard || ui.discardCheck?.checked === true;
      ui.removeButton.disabled =
        !allowed || pending || !inspect || !revision || !ui.removeCheck?.checked || !okDiscard;
    }
  }

  function linkedSessionId(inspect) {
    const fromList = state.list.find((item) => item?.id === state.inspectId);
    return (
      inspect?.worktree?.sessionId ||
      fromList?.sessionId ||
      state.current?.sessionId ||
      state.prepareSessionId ||
      ''
    );
  }

  function renderPrepare(inspect, allowed) {
    const ui = els();
    if (!ui.prepareBox) return;
    const taskClean = inspect ? inspect.task?.clean !== false : true;
    const behind = Number(inspect?.behind || 0);
    const needsPrepare = Boolean(inspect) && (taskClean === false || behind > 0);
    ui.prepareBox.hidden = !needsPrepare;
    if (!needsPrepare) return;
    const pending = state.preparePending || state.inspectPending || state.mutatePending;
    const taskPath = inspect?.task?.path || state.current?.path || '';
    const revision = inspect?.worktree?.revision || '';
    const mainHead = inspect?.main?.head || '';
    const taskHead = inspect?.task?.head || '';
    const ready = Boolean(revision) && /^[0-9a-f]{40}$/i.test(mainHead) && /^[0-9a-f]{40}$/i.test(taskHead);
    if (ui.prepareButton) {
      ui.prepareButton.disabled =
        !allowed || pending || !taskPath || !ready || ui.prepareCheck?.checked !== true;
    }
    if (ui.prepareOpen) {
      const sessionId = linkedSessionId(inspect);
      ui.prepareOpen.hidden = !sessionId;
      ui.prepareOpen.disabled = pending || !sessionId;
    }
  }

  async function submitPrepare() {
    const ui = els();
    if (state.preparePending || !mutationsAllowed() || !state.inspect) return;
    if (ui.prepareCheck?.checked !== true) return;
    const id = state.inspectId;
    const revision = state.inspect?.worktree?.revision || '';
    const mainHead = state.inspect?.main?.head || '';
    const taskHead = state.inspect?.task?.head || '';
    if (!revision || !/^[0-9a-f]{40}$/i.test(mainHead) || !/^[0-9a-f]{40}$/i.test(taskHead)) {
      showError(ui.taskError, tr('worktrees.etat_perime'));
      return;
    }
    const branch = state.inspect?.task?.branch || state.inspect?.worktree?.branch || '';
    const target = state.inspect?.main?.branch || state.inspect?.worktree?.sourceBranch || '';
    state.preparePending = true;
    renderTask();
    showError(ui.taskError, null);
    try {
      const sessionId = linkedSessionId(state.inspect);
      const model = context().mainModel || '';
      const result = await api(preparePath(id), {
        method: 'POST',
        body: {
          cwd: ownerCwd(),
          revision,
          confirm: true,
          expectedSourceHead: mainHead,
          expectedWorktreeHead: taskHead,
          ...(sessionId ? { sessionId } : {}),
          message: tr('worktrees.preparer_demande', { branch, target }),
          ...(model ? { model } : {}),
        },
      });
      if (result?.sessionId) state.prepareSessionId = result.sessionId;
      if (ui.prepareCheck) ui.prepareCheck.checked = false;
      toast(tr('worktrees.preparation_lancee'));
      await refreshOverview?.();
      await refreshInspect();
      await detect(ownerCwd());
    } catch (error) {
      const hint = guidanceFor(error);
      showError(
        ui.taskError,
        hint ? `${translateKnown(error?.message || error)} ${hint}` : error?.message ? error : String(error),
      );
    } finally {
      state.preparePending = false;
      renderTask();
    }
  }

  async function submitIntegrate() {
    const ui = els();
    if (state.mutatePending || !mutationsAllowed() || !state.inspect) return;
    const id = state.inspectId;
    const revision = state.inspect?.worktree?.revision || '';
    if (!ui.integrateCheck?.checked || !revision) return;
    state.mutatePending = true;
    renderTask();
    showError(ui.taskError, null);
    try {
      const result = await api(integratePath(id), {
        method: 'POST',
        body: {
          cwd: ownerCwd(),
          revision,
          confirm: true,
          expectedSourceHead: state.inspect?.main?.head || '',
          expectedWorktreeHead: state.inspect?.task?.head || '',
        },
      });
      toast(result?.alreadyUpToDate ? tr('worktrees.deja_integree') : tr('worktrees.integree'));
      if (ui.integrateCheck) ui.integrateCheck.checked = false;
      await refreshOverview?.();
      await refreshInspect();
      await detect(ownerCwd());
    } catch (error) {
      const hint = guidanceFor(error);
      showError(ui.taskError, hint ? `${translateKnown(error?.message || error)} ${hint}` : error?.message ? error : String(error));
    } finally {
      state.mutatePending = false;
      renderTask();
    }
  }

  async function submitRemove() {
    const ui = els();
    if (state.mutatePending || !mutationsAllowed() || !state.inspect) return;
    const id = state.inspectId;
    const revision = state.inspect?.worktree?.revision || '';
    if (!ui.removeCheck?.checked || !revision) return;
    state.mutatePending = true;
    renderTask();
    showError(ui.taskError, null);
    try {
      await api(removePath(id), {
        method: 'POST',
        body: {
          cwd: ownerCwd(),
          revision,
          confirm: true,
          discard: ui.discardCheck?.checked === true,
        },
      });
      toast(tr('worktrees.supprimee'));
      closeTask();
      await refreshOverview?.();
      await detect(ownerCwd());
    } catch (error) {
      const hint = guidanceFor(error);
      showError(ui.taskError, hint ? `${translateKnown(error?.message || error)} ${hint}` : error?.message ? error : String(error));
    } finally {
      state.mutatePending = false;
      renderTask();
    }
  }

  function bind() {
    const ui = els();
    if (ui.entry) ui.entry.addEventListener('click', (event) => openCreate(event.currentTarget));
    if (ui.form) {
      for (const radio of ui.form.querySelectorAll('input[name="worktree-mode"]')) {
        radio.addEventListener('change', syncNameField);
      }
    }
    if (ui.bannerCopy) {
      ui.bannerCopy.addEventListener('click', async () => {
        const text = els().bannerPath?.textContent || '';
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          toast(tr('worktrees.chemin_copie'));
        } catch {
          toast(tr('common.error'), true);
        }
      });
    }
    if (ui.form) ui.form.addEventListener('submit', (event) => void submitCreate(event));
    if (ui.bannerButton) {
      ui.bannerButton.addEventListener('click', (event) => {
        const id = state.current?.id || '';
        if (id) void openTask(id, event.currentTarget);
      });
    }
    if (ui.copyPath) {
      ui.copyPath.addEventListener('click', async () => {
        const text = ui.metaPath?.textContent || '';
        if (!text) return;
        try {
          await navigator.clipboard.writeText(text);
          toast(tr('worktrees.chemin_copie'));
        } catch {
          toast(tr('common.error'), true);
        }
      });
    }
    if (ui.refreshButton) ui.refreshButton.addEventListener('click', () => void refreshInspect());
    if (ui.prepareCheck) ui.prepareCheck.addEventListener('change', () => renderTask());
    if (ui.integrateCheck) ui.integrateCheck.addEventListener('change', () => renderTask());
    if (ui.removeCheck) ui.removeCheck.addEventListener('change', () => renderTask());
    if (ui.discardCheck) ui.discardCheck.addEventListener('change', () => renderTask());
    if (ui.prepareButton) ui.prepareButton.addEventListener('click', () => void submitPrepare());
    if (ui.prepareOpen) {
      ui.prepareOpen.addEventListener('click', () => {
        const sessionId = linkedSessionId(state.inspect);
        if (!sessionId) {
          toast(tr('worktrees.conversation_tache_inconnue'), true);
          return;
        }
        openTaskSession?.(sessionId, ownerCwd());
      });
    }
    if (ui.integrateButton) ui.integrateButton.addEventListener('click', () => void submitIntegrate());
    if (ui.removeButton) ui.removeButton.addEventListener('click', () => void submitRemove());
    if (ui.taskDialog) {
      ui.taskDialog.addEventListener('close', () => {
        if (state.opener?.focus) state.opener.focus({ preventScroll: true });
        state.opener = null;
      });
    }
    onLanguageChange(() => {
      renderEntry();
      renderBanner();
      if (ui.taskDialog?.open) renderTask();
    });
  }

  async function update() {
    const cwd = ownerCwd();
    renderEntry();
    if (cwd !== state.cwd) await detect(cwd);
    else {
      state.current = resolveCurrent(state.list);
      renderBanner();
    }
  }

  bind();
  return { openCreate, openTask, update, detect };
}
