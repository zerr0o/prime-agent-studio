import { t as tr, bindText, bindAttribute, translateKnown, onLanguageChange, getLanguage } from './i18n.js';
import { DEVICE_COLORS, normalizeDeviceColor } from './palettes.js';

// R2 conversation sync panel (Preferences > Synchronisation).
// Consultation hides the tab; full control manages sync via the gateway.
// Secrets are write only: the server never echoes them back and the
// inputs are cleared after every load and save.
//
// Shared monitor: one poller for the whole Studio (footer, badges, header
// and Preferences). GET /api/sync every 30 s, every 2 s while running.
// Paused when the document is hidden. app.js starts it once with
// initSyncMonitor({ api, getContext }); the panel subscribes to it.

let sharedApi = null;
let sharedGetContext = null;
let sharedData = null;
let sharedListeners = new Set();
let sharedTimer = 0;
let sharedInFlight = false;
let sharedStarted = false;

function sharedAllowed() {
  try {
    const ctx = sharedGetContext?.();
    if (!ctx) return true;
    return !ctx.readOnly;
  } catch {
    return true;
  }
}

function notifyShared() {
  for (const fn of [...sharedListeners]) {
    try {
      fn(sharedData);
    } catch {}
  }
}

function scheduleShared() {
  if (!sharedStarted) return;
  if (sharedTimer) clearTimeout(sharedTimer);
  sharedTimer = 0;
  if (typeof document !== 'undefined' && document.hidden) return;
  const delay = sharedData?.running ? 2000 : 30000;
  sharedTimer = setTimeout(() => void fetchShared(), delay);
}

async function fetchShared() {
  if (!sharedStarted) return;
  if (typeof document !== 'undefined' && document.hidden) {
    scheduleShared();
    return;
  }
  if (!sharedApi || !sharedAllowed()) {
    scheduleShared();
    return;
  }
  if (sharedInFlight) return;
  sharedInFlight = true;
  try {
    const next = await sharedApi('/api/sync');
    sharedData = next;
    notifyShared();
  } catch {
    // Keep the last known state; the next tick retries quietly.
  } finally {
    sharedInFlight = false;
    scheduleShared();
  }
}

export function getSyncSnapshot() {
  return sharedData;
}

export function subscribeSync(listener) {
  sharedListeners.add(listener);
  if (sharedData) {
    try {
      listener(sharedData);
    } catch {}
  }
  return () => sharedListeners.delete(listener);
}

export function initSyncMonitor({ api, getContext } = {}) {
  if (api) sharedApi = api;
  if (getContext) sharedGetContext = getContext;
  if (sharedStarted) {
    scheduleShared();
    return;
  }
  sharedStarted = true;
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) {
        if (sharedTimer) clearTimeout(sharedTimer);
        sharedTimer = 0;
      } else {
        void fetchShared();
      }
    });
  }
  void fetchShared();
}

export function refreshSyncNow() {
  return fetchShared();
}

export function setSyncSnapshot(data) {
  sharedData = data;
  notifyShared();
  scheduleShared();
}

export function patchSyncSession(id, syncState) {
  if (!sharedData || !id) return;
  const sessions = { ...(sharedData.sessions || {}) };
  if (syncState === 'synced' || syncState === 'pending') sessions[id] = syncState;
  else delete sessions[id];
  sharedData = { ...sharedData, sessions };
  notifyShared();
}

export function createSyncSettings({ api, getContext, toast }) {
  const $ = (id) => document.getElementById(id);
  const form = $('sync-form');
  const content = $('sync-content');
  if (!form || !content) return { refresh: async () => {} };
  initSyncMonitor({ api, getContext });
  let data = sharedData;
  let busy = false;
  let running = false;
  let generation = 0;

  // Full control may configure sync; consultation stays locked.
  const allowed = () => !getContext().readOnly;

  const showError = (message = '') => {
    const node = $('sync-error');
    node.hidden = !message;
    bindText(node, () => (message ? translateKnown(message) : ''));
  };

  function formatBytes(value) {
    const bytes = Number(value) || 0;
    if (bytes < 1024) return `${bytes} o`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} ko`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleString(getLanguage() === 'en' ? 'en-US' : 'fr-FR');
    } catch {
      return String(iso || '');
    }
  }

  function roadmapCounts(last) {
    if (!last || typeof last !== 'object') return null;
    if (last.roadmaps && typeof last.roadmaps === 'object') {
      const sent = Number(last.roadmaps.sent ?? last.roadmaps.pushed ?? 0);
      const received = Number(last.roadmaps.received ?? 0);
      if (!Number.isFinite(sent) || !Number.isFinite(received)) return null;
      if (sent === 0 && received === 0 && last.roadmapsSent === undefined && last.roadmapsReceived === undefined)
        return null;
      return { sent, received };
    }
    const sentRaw = last.roadmapsSent ?? last.roadmapsPushed ?? last.roadmapSent ?? null;
    const receivedRaw = last.roadmapsReceived ?? last.roadmapReceived ?? null;
    if (sentRaw === null && receivedRaw === null) return null;
    const sent = Number(sentRaw ?? 0);
    const received = Number(receivedRaw ?? 0);
    if (!Number.isFinite(sent) || !Number.isFinite(received)) return null;
    return { sent, received };
  }

  function roadmapConflictOf(last) {
    if (!last || typeof last !== 'object') return null;
    const value =
      last.roadmapConflict ?? (Array.isArray(last.roadmapConflicts) ? last.roadmapConflicts[0] : null);
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object' && typeof value.file === 'string' && value.file)
      return value.file;
    return null;
  }

  function roadmapConflictList(last) {
    if (!last || typeof last !== 'object') return [];
    const raw = Array.isArray(last.roadmapConflicts) ? last.roadmapConflicts : [];
    const out = [];
    for (const entry of raw) {
      if (typeof entry === 'string' && entry) out.push({ project: '', file: entry });
      else if (entry && typeof entry === 'object' && typeof entry.file === 'string' && entry.file)
        out.push({ project: typeof entry.project === 'string' ? entry.project : '', file: entry.file });
    }
    return out;
  }

  function conflictProjectName(syncId) {
    if (syncId) {
      const local = localProjects.find((entry) => entry?.syncId === syncId);
      if (local?.name) return local.name;
      const remote = Array.isArray(data?.remoteProjects)
        ? data.remoteProjects.find((entry) => entry?.id === syncId)
        : null;
      if (remote?.name) return remote.name;
      const links = data?.projectLinks && typeof data.projectLinks === 'object' ? data.projectLinks : {};
      for (const [cwd, link] of Object.entries(links)) {
        if (link?.id === syncId) return localNameOf(cwd);
      }
      return syncId;
    }
    return '';
  }

  const conflictFileName = (file) => String(file || '').split(/[\\/]/).filter(Boolean).pop() || String(file || '');

  async function copyConflictPath(file) {
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(String(file));
      else throw new Error('clipboard');
    } catch {
      toast(() => translateKnown(String(file)), false);
      return;
    }
    toast(() => tr('ui.copie'));
  }

  async function openConflictsFolder(button, file) {
    button.disabled = true;
    try {
      await api('/api/sync/open-conflicts', { method: 'POST', body: {} });
      toast(() => tr('sync.conflicts_opened'));
    } catch (error) {
      toast(() => translateKnown(error.message), true);
      void copyConflictPath(file);
    } finally {
      button.disabled = false;
    }
  }

  function renderConflicts() {
    const box = $('sync-roadmap-conflicts');
    if (!box) return;
    const conflicts = roadmapConflictList(data?.lastSync);
    box.replaceChildren();
    box.hidden = !conflicts.length;
    if (!conflicts.length) return;
    for (const conflict of conflicts) {
      const row = document.createElement('div');
      row.className = 'sync-roadmap-conflict';
      row.setAttribute('role', 'status');
      const project = conflictProjectName(conflict.project);
      const file = conflictFileName(conflict.file);
      const line = document.createElement('span');
      line.className = 'sync-roadmap-conflict-path';
      line.title = String(conflict.file);
      bindText(line, () => tr('sync.roadmap_unmerged', { project, file }));
      line.style.cursor = 'copy';
      line.onclick = () => void copyConflictPath(conflict.file);
      const open = document.createElement('button');
      open.type = 'button';
      open.className = 'secondary-button';
      bindText(open, () => tr('sync.open_conflicts'));
      open.onclick = () => void openConflictsFolder(open, conflict.file);
      row.append(line, open);
      box.append(row);
    }
  }

  function statusText() {
    if (!data) return tr('sync.loading');
    if (data.running) {
      const p = data.progress;
      return p?.total
        ? tr(p.phase === 'pull' ? 'sync.progress_pull' : 'sync.progress_push', {
            value1: String(p.done),
            value2: String(p.total),
          })
        : tr('sync.running');
    }
    const last = data.lastSync;
    if (!last) return data.configured ? tr('sync.never') : tr('sync.not_configured');
    const when = formatDate(last.at);
    if (last.ok) {
      const base = tr('sync.last_ok', {
        value1: when,
        value2: formatBytes(last.sent),
        value3: String(last.received ?? 0),
        value4: String(last.pushed ?? 0),
      });
      const rm = roadmapCounts(last);
      if (rm) return base + tr('sync.last_ok_roadmaps', { value1: String(rm.sent), value2: String(rm.received) });
      return base;
    }
    const conflict = roadmapConflictOf(last);
    if (conflict) return tr('sync.roadmap_conflict', { value1: conflict });
    return tr('sync.last_error', {
      value1: when,
      value2: translateKnown(last.error || ''),
    });
  }

  let localProjects = [];
  let localProjectsLoaded = false;

  async function loadLocalProjects() {
    try {
      const overview = await api('/api/overview');
      if (Array.isArray(overview?.projects)) {
        localProjects = overview.projects;
        localProjectsLoaded = true;
        renderProjects();
      }
    } catch {}
  }

  function localNameOf(cwd) {
    const found = localProjects.find((entry) => String(entry?.cwd) === String(cwd));
    if (found?.name) return found.name;
    return (
      String(cwd || '')
        .split(/[\\/]/)
        .filter(Boolean)
        .pop() || String(cwd || '')
    );
  }

  async function linkRemote(remote, cwd) {
    await api('/api/projects', {
      method: 'POST',
      body: { cwd, name: remote.name, sync: true, syncId: remote.id },
    });
    localProjectsLoaded = false;
    void loadLocalProjects();
    window.dispatchEvent(new CustomEvent('prime-studio:overview'));
    toast(() => tr('projects.sync_updated'));
    try {
      await api('/api/sync/run', { method: 'POST', body: {} });
    } catch (error) {
      toast(() => translateKnown(error.message), true);
      return;
    }
    await refreshSyncNow();
  }

  async function pickAndLink(remote, button) {
    button.disabled = true;
    try {
      const nativePicker =
        window.__PRIME_STUDIO_DESKTOP__ === true && typeof window.__TAURI__?.core?.invoke === 'function';
      let cwd = '';
      if (nativePicker) {
        cwd = await window.__TAURI__.core.invoke('desktop_pick_directory', {
          cwd: '',
          title: tr('sync.choose_folder'),
        });
      } else {
        const result = await api('/api/projects/pick-directory', {
          method: 'POST',
          body: { cwd: '' },
        });
        cwd = result?.cwd || '';
      }
      if (cwd) await linkRemote(remote, cwd);
    } catch (error) {
      toast(() => translateKnown(error.message || String(error)), true);
    } finally {
      button.disabled = false;
    }
  }

  function renderProjects() {
    const section = $('sync-projects');
    const list = $('sync-projects-list');
    const empty = $('sync-projects-empty');
    if (!section || !list || !empty) return;
    const show = Boolean(data?.configured) && allowed();
    section.hidden = !show;
    if (!show) return;
    if (!localProjectsLoaded) void loadLocalProjects();
    const remotes = Array.isArray(data?.remoteProjects) ? data.remoteProjects : [];
    const links = data?.projectLinks && typeof data.projectLinks === 'object' ? data.projectLinks : {};
    bindText(empty, () => tr('sync.projects_empty'));
    empty.hidden = remotes.length > 0;
    const kept = new Map();
    for (const input of list.querySelectorAll('input[data-remote-path]'))
      kept.set(input.dataset.remotePath, input.value);
    const focused = document.activeElement?.dataset?.remotePath;
    list.replaceChildren();
    const desktopPicker = typeof window !== 'undefined' && window.__PRIME_STUDIO_DESKTOP__ === true;
    for (const remote of remotes) {
      if (!remote || typeof remote.id !== 'string') continue;
      const row = document.createElement('div');
      row.className = 'sync-project-row';
      const main = document.createElement('div');
      main.className = 'sync-project-main';
      const name = document.createElement('span');
      name.className = 'sync-project-name';
      bindText(name, () => remote.name || remote.id);
      main.append(name);
      if (remote.git) {
        const git = document.createElement('span');
        git.className = 'sync-project-git';
        git.textContent = remote.git;
        main.append(git);
      }
      if (Array.isArray(remote.devices) && remote.devices.length) {
        const devices = document.createElement('span');
        devices.className = 'sync-project-devices';
        const names = remote.devices.join(', ');
        bindText(devices, () => tr('sync.projects_devices', { value1: names }));
        main.append(devices);
      }
      row.append(main);
      const state = document.createElement('div');
      state.className = 'sync-project-state';
      if (remote.local) {
        const via = links[remote.local]?.via;
        const suffix =
          via === 'git'
            ? ` (${tr('sync.project_via_git')})`
            : via === 'name'
              ? ` (${tr('sync.project_via_name')})`
              : via === 'manual' || via === 'id'
                ? ` (${tr('sync.project_via_manual')})`
                : '';
        const localName = localNameOf(remote.local);
        bindText(state, () => tr('sync.project_linked', { value1: localName }) + suffix);
      } else {
        bindText(state, () => tr('sync.project_unlinked'));
        const controls = document.createElement('div');
        controls.className = 'sync-project-link';
        if (desktopPicker) {
          const choose = document.createElement('button');
          choose.type = 'button';
          choose.className = 'secondary-button';
          bindText(choose, () => tr('sync.choose_folder'));
          choose.onclick = () => void pickAndLink(remote, choose);
          controls.append(choose);
        } else {
          const input = document.createElement('input');
          input.dataset.remotePath = remote.id;
          input.autocomplete = 'off';
          input.spellcheck = false;
          bindAttribute(input, 'placeholder', () => tr('sync.project_path'));
          bindAttribute(input, 'aria-label', () => tr('sync.project_path'));
          if (kept.has(remote.id)) input.value = kept.get(remote.id);
          const add = document.createElement('button');
          add.type = 'button';
          add.className = 'secondary-button';
          bindText(add, () => tr('sync.project_add'));
          add.onclick = async () => {
            const cwd = input.value.trim();
            if (!cwd) {
              input.focus();
              return;
            }
            add.disabled = true;
            try {
              await linkRemote(remote, cwd);
            } catch (error) {
              toast(() => translateKnown(error.message || String(error)), true);
            } finally {
              add.disabled = false;
            }
          };
          controls.append(input, add);
        }
        state.append(controls);
      }
      row.append(state);
      list.append(row);
    }
    if (focused) list.querySelector(`input[data-remote-path="${CSS.escape(focused)}"]`)?.focus();
    renderDevices();
    renderConflicts();
  }

  function currentDeviceColor() {
    const raw = typeof data?.color === 'string' ? data.color.toLowerCase() : '';
    if (DEVICE_COLORS.includes(raw)) return raw;
    if (normalizeDeviceColor(data?.color) === '') return 'transparent';
    return 'transparent';
  }

  function renderDeviceColors() {
    const group = $('sync-device-colors');
    if (!group) return;
    const current = currentDeviceColor();
    const disabled = busy || !allowed() || !data?.configured;
    for (const swatch of group.querySelectorAll('[data-sync-device-color]')) {
      const value = String(swatch.dataset.syncDeviceColor || '').toLowerCase();
      const active = value === current;
      swatch.setAttribute('aria-checked', String(active));
      swatch.classList.toggle('selected', active);
      swatch.disabled = disabled;
    }
  }

  async function setDeviceColor(color) {
    const value = String(color || '').toLowerCase();
    if (!DEVICE_COLORS.includes(value)) {
      toast(() => tr('server.valeur_invalide'), true);
      return;
    }
    if (!allowed() || busy || !data?.configured) return;
    if (value === currentDeviceColor()) return;
    const turn = ++generation;
    setBusy(true);
    showError();
    try {
      const next = await api('/api/sync', { method: 'PUT', body: { color: value } });
      if (turn !== generation) return;
      data = next;
      setSyncSnapshot(next);
      render();
      showError();
      toast(() => tr('sync.color_updated'));
    } catch (error) {
      if (turn !== generation) return;
      showError(error.message);
    } finally {
      if (turn === generation) setBusy(false);
    }
  }

  function renderDevices() {
    const list = $('sync-devices-list');
    const empty = $('sync-devices-empty');
    if (!list || !empty) return;
    const configured = Boolean(data?.configured);
    const devices = Array.isArray(data?.devices) ? data.devices : null;
    const rows =
      devices ??
      (configured
        ? [{ id: 'self', name: data?.device || '', color: data?.color || '', self: true }]
        : []);
    bindText(empty, () => tr('sync.devices_empty'));
    empty.hidden = rows.length > 0;
    list.replaceChildren();
    for (const device of rows) {
      if (!device || typeof device !== 'object') continue;
      const row = document.createElement('div');
      row.className = 'sync-device-row';
      const dot = document.createElement('span');
      dot.className = 'sync-device-dot';
      dot.setAttribute('aria-hidden', 'true');
      const raw = typeof device.color === 'string' ? device.color.toLowerCase() : '';
      const normalized = normalizeDeviceColor(device.color);
      if (normalized) dot.style.background = normalized;
      else if (DEVICE_COLORS.slice(1).includes(raw)) dot.style.background = raw;
      row.append(dot);
      const name = document.createElement('span');
      name.className = 'sync-device-name';
      const label = device.name || device.id || '';
      if (device.self) bindText(name, () => `${label} (${tr('sync.devices_self')})`);
      else name.textContent = label;
      row.append(name);
      if (device.self) {
        const tag = document.createElement('span');
        tag.className = 'sync-device-self';
        bindText(tag, () => tr('sync.devices_self'));
        tag.hidden = true;
        row.append(tag);
      }
      row.title = label;
      list.append(row);
    }
  }

  function renderStatus() {
    const node = $('sync-status');
    bindText(node, () => statusText());
    const last = data?.lastSync;
    node.dataset.state = data?.running ? 'running' : last && !last.ok ? 'error' : 'idle';
    renderConflicts();
  }

  function render() {
    if (!data) return;
    const active = document.activeElement;
    const typing = (id) => active && active.id === id;
    if (!typing('sync-url')) $('sync-url').value = data.url || '';
    if (!typing('sync-access-key')) $('sync-access-key').value = data.accessKeyId || '';
    // Never echo secrets back into the inputs.
    if (!typing('sync-secret')) $('sync-secret').value = '';
    if (!typing('sync-passphrase')) $('sync-passphrase').value = '';
    if (!typing('sync-device')) $('sync-device').value = data.device || '';
    $('sync-secret').placeholder = data.hasSecret ? tr('sync.secret_kept') : '';
    $('sync-passphrase').placeholder = data.hasPassphrase ? tr('sync.passphrase_kept') : '';
    $('sync-run').hidden = !data.configured;
    $('sync-forget').hidden = !data.configured;
    // Configuration stays folded once set up; it opens to guide a first setup.
    if (!data.configured) $('sync-config').open = true;
    renderStatus();
    renderProjects();
    renderDevices();
    renderDeviceColors();
  }

  function setBusy(value, mode) {
    busy = value;
    for (const id of ['sync-url', 'sync-access-key', 'sync-secret', 'sync-passphrase', 'sync-device'])
      $(id).disabled = value || !allowed();
    renderDeviceColors();
    $('sync-save').disabled = value || !allowed();
    $('sync-run').disabled = value || !allowed() || !data?.configured;
    $('sync-forget').disabled = value || !allowed() || !data?.configured;
    $('sync-refresh').disabled = value;
    if (mode === 'run' || data?.running) {
      $('sync-save').disabled = true;
      $('sync-run').disabled = true;
    }
    if (value && mode) {
      bindText($('sync-save'), () => (mode === 'save' ? tr('common.saving') : tr('sync.save_test')));
      bindText($('sync-run'), () => (mode === 'run' ? tr('sync.running') : tr('sync.run_now')));
    } else {
      bindText($('sync-save'), () => tr('sync.save_test'));
      bindText($('sync-run'), () => tr('sync.run_now'));
    }
    content.setAttribute('aria-busy', String(value));
    form.setAttribute('aria-busy', String(value));
  }

  function applyShared(next) {
    data = next;
    setSyncSnapshot(next);
    if (form.hidden) {
      content.hidden = true;
      form.hidden = false;
    }
    render();
    setBusy(false);
    if (data?.running) setBusy(false, 'run');
    showError();
  }

  const onShared = (next) => {
    if (!next) return;
    if (awaitingRun !== null && !next.running && (next.lastSync?.at || '') !== awaitingRun)
      reportRun(next.lastSync);
    // A save or run owns its generation; background ticks must not
    // overwrite its busy state, only refresh the displayed status.
    if (busy) {
      data = next;
      setSyncSnapshot(next);
      renderStatus();
      return;
    }
    data = next;
    if (!form.hidden) {
      render();
      if (data?.running) setBusy(false, 'run');
      else setBusy(false);
    }
  };
  subscribeSync(onShared);

  async function refresh() {
    if (!allowed()) return;
    const turn = ++generation;
    setBusy(true);
    showError();
    try {
      const next = await api('/api/sync');
      if (turn !== generation) return;
      data = next;
      setSyncSnapshot(next);
      content.hidden = true;
      form.hidden = false;
      render();
      showError();
      if (data.running) {
        running = true;
        setBusy(false, 'run');
      }
    } catch (error) {
      if (turn !== generation) return;
      content.hidden = false;
      form.hidden = true;
      bindText(content.querySelector('.settings-footnote'), () => translateKnown(error.message));
      showError(error.message);
    } finally {
      if (turn === generation && !data?.running) setBusy(false);
    }
  }

  async function save(event) {
    event?.preventDefault();
    if (busy || !allowed() || !form.reportValidity()) return;
    const turn = ++generation;
    setBusy(true, 'save');
    showError();
    try {
      const body = {
        url: $('sync-url').value.trim(),
        accessKeyId: $('sync-access-key').value.trim(),
        device: $('sync-device').value.trim(),
      };
      // Empty means keep the stored value.
      if ($('sync-secret').value) body.secretAccessKey = $('sync-secret').value;
      if ($('sync-passphrase').value) body.passphrase = $('sync-passphrase').value;
      const next = await api('/api/sync', { method: 'PUT', body });
      if (turn !== generation) return;
      data = next;
      setSyncSnapshot(next);
      render();
      showError();
      toast(() => tr('sync.saved'));
    } catch (error) {
      if (turn !== generation) return;
      showError(error.message);
    } finally {
      if (turn === generation) setBusy(false);
    }
  }

  // A manual run always ends with a visible result, even when nothing changed.
  let awaitingRun = null;
  function reportRun(last) {
    awaitingRun = null;
    if (!last) return;
    if (!last.ok) {
      const conflict = roadmapConflictOf(last);
      if (conflict) toast(() => tr('sync.roadmap_conflict', { value1: conflict }), true);
      else toast(() => translateKnown(last.error || ''), true);
      return;
    }
    const sent = Number(last.pushed || 0),
      received = Number(last.received || 0);
    const rm = roadmapCounts(last);
    if (rm && (rm.sent || rm.received)) {
      toast(() =>
        tr('sync.done_counts_roadmaps', {
          value1: String(sent),
          value2: String(received),
          value3: String(rm.sent),
          value4: String(rm.received),
        }),
      );
      return;
    }
    toast(() =>
      sent || received
        ? tr('sync.done_counts', { value1: String(sent), value2: String(received) })
        : tr('sync.done_uptodate'),
    );
    const conflict = roadmapConflictOf(last);
    if (conflict) toast(() => tr('sync.roadmap_conflict', { value1: conflict }), true);
  }
  async function runNow() {
    if (busy || running || !allowed() || !data?.configured) return;
    awaitingRun = data?.lastSync?.at || '';
    const turn = ++generation;
    running = true;
    setBusy(true, 'run');
    showError();
    try {
      // The server answers 202 immediately with running:true; the first
      // sync can take minutes, so the shared poller follows GET /api/sync.
      const next = await api('/api/sync/run', { method: 'POST', body: {} });
      if (turn !== generation) return;
      data = next;
      setSyncSnapshot(next);
      render();
      showError();
      if (!data.running) reportRun(data.lastSync);
    } catch (error) {
      if (turn !== generation) return;
      showError(error.message);
    } finally {
      running = false;
      if (turn === generation && !data?.running) setBusy(false);
      else if (turn === generation && data?.running) setBusy(false, 'run');
    }
  }

  async function forget() {
    if (busy || !allowed() || !data?.configured) return;
    const dialog = $('sync-forget-dialog');
    dialog.returnValue = '';
    dialog.showModal();
    await new Promise((resolve) => dialog.addEventListener('close', resolve, { once: true }));
    if (dialog.returnValue !== 'confirm') return;
    const turn = ++generation;
    setBusy(true, 'forget');
    showError();
    try {
      const next = await api('/api/sync', { method: 'DELETE' });
      if (turn !== generation) return;
      data = next;
      setSyncSnapshot(next);
      render();
      showError();
      toast(() => tr('sync.forgotten'));
    } catch (error) {
      if (turn !== generation) return;
      showError(error.message);
    } finally {
      if (turn === generation) setBusy(false);
    }
  }

  form.onsubmit = (event) => void save(event);
  $('sync-run').onclick = () => void runNow();
  $('sync-forget').onclick = () => void forget();
  $('sync-refresh').onclick = () => void refresh();
  for (const swatch of form.querySelectorAll('[data-sync-device-color]'))
    swatch.onclick = () => void setDeviceColor(swatch.dataset.syncDeviceColor);
  onLanguageChange(() => {
    if (!form.hidden && data) render();
  });

  return { refresh };
}
