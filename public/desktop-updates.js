import { t, bindText, onLanguageChange } from './i18n.js';
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { createDesktopComponentsPanel, componentsErrorKey, describeProgress } from './desktop-components.js';
import { openUpdatesPane } from './desktop-components-action.js';
import { updateView, operationActive, progressNumbers } from './desktop-update-state.js';

export function createDesktopUpdates({ api, getContext }) {
  const $ = (id) => document.getElementById('studio-update-' + id);
  const core = window.__PRIME_STUDIO_DESKTOP__ === true && window.__TAURI__?.core;
  let snapshot,
    components,
    operation,
    version,
    checked = false;
  let localKind = null,
    localStartedAt = 0,
    localEpoch = 0,
    actionFlight = false,
    errorCode = '',
    notice = '';
  let pollTimer,
    pollFlight = false,
    refreshFlight = null;
  const allowed = () => Boolean(core) && !getContext().remote && !getContext().readOnly;
  const message = (id, key, params) => bindText($(id), () => (key ? t(key, params) : ''));
  const view = () =>
    updateView({ server: snapshot, components, operation, available: version, checked, localKind });
  const errors = new Set([
    'operation_interrupted',
    'components_required',
    'server_not_managed',
    'server_port_occupied',
    'server_version_mismatch',
    'download_failed',
    'install_failed',
    'check_failed',
    'update_busy',
    'download_timed_out',
    'download_cancelled',
    'install_noncancellable',
    'cancel_timeout',
    'cancel_not_supported',
    'server_stop_failed',
    'server_start_failed',
    'agents_running',
    'setup_busy',
  ]);
  const codeOf = (error) =>
    String(error?.message || error || '')
      .split(':')[0]
      .trim();
  function failure(error) {
    errorCode = codeOf(error);
    if (errorCode === 'components_required') components = { ...components, ready: false, needsUpdate: true };
    render();
  }
  const componentsPanel = createDesktopComponentsPanel({
    getContext,
    onChange: (value) => {
      components = value;
      render();
    },
    onProgress: (value) => {
      if (localKind !== 'prepare') return;
      operation = {
        id: 'local-prepare',
        kind: 'prepare',
        stage: 'working',
        startedAt: localStartedAt,
        updatedAt: Date.now(),
        receivedBytes: value.bytes ?? value.received ?? 0,
        totalBytes: value.total,
        percent: value.percent,
        detail: describeProgress(value),
        cancellable: true,
      };
      render();
    },
  });
  function stageKey(op) {
    const stage = op?.stage;
    if (stage === 'cancelled') return 'updates.operation_cancelled';
    if (stage === 'error') return 'updates.operation_failed';
    if (stage === 'done') return 'updates.operation_done';
    if (['checking', 'downloading', 'verifying', 'installing'].includes(stage)) return 'updates.' + stage;
    if (['stopping', 'starting', 'ready'].includes(stage)) return 'updates.phase_' + stage;
    if (['stopping', 'starting', 'ready', 'checking'].includes(op?.detail))
      return 'updates.phase_' + op.detail;
    if (['restart', 'quit', 'prepare', 'components', 'start'].includes(op?.kind))
      return 'updates.operation_' + op.kind;
    return 'updates.working';
  }
  function render() {
    const v = view();
    $('native').setAttribute('aria-busy', String(v.busy));
    $('check').disabled = v.busy || !allowed();
    $('install').disabled = v.busy || !allowed();
    $('repair').disabled = v.busy || !allowed();
    $('install').hidden = !version;
    $('repair').hidden = !v.repair || Boolean(version);
    $('restart').disabled = v.restartDisabled || !allowed();
    message('restart', snapshot?.running === false ? 'updates.start_now' : 'updates.restart_now');
    const currentError =
      errorCode || (operation?.stage === 'error' ? codeOf(operation.code || operation.error) : '');
    $('error').hidden = !currentError;
    if (currentError) {
      const componentKey = componentsErrorKey(currentError);
      message(
        'error',
        errors.has(currentError)
          ? 'updates.' + currentError
          : componentKey !== 'components.error_preparation'
            ? componentKey
            : 'updates.failed',
      );
    } else message('error', '');
    const statusKey = v.active
      ? stageKey(operation)
      : localKind
        ? 'updates.operation_' + localKind
        : notice || v.status;
    message('status', statusKey, { version });
    $('app-version').textContent = snapshot?.appVersion || '?';
    $('server-version').textContent = snapshot?.running ? snapshot.version || '?' : t('updates.stopped');
    message(
      'server-note',
      !snapshot
        ? 'updates.state_unknown'
        : !v.canControl
          ? 'updates.identity_unverified'
          : snapshot.ownership === 'recoverable'
            ? 'updates.identity_recoverable'
            : v.needsRestart
              ? 'updates.restart_versions'
              : 'updates.restart_scope',
    );
    message('agents', snapshot?.activeRuns ? 'updates.agents' : 'updates.no_agents', {
      count: snapshot?.activeRuns || 0,
    });
    bindText($('action-note'), () =>
      [
        !v.busy && version ? t('updates.available', { version }) : '',
        t(
          v.locked
            ? 'updates.install_noncancellable'
            : v.busy
              ? 'updates.busy_restart_available'
              : 'updates.action_note',
        ),
      ]
        .filter(Boolean)
        .join(' '),
    );
    $('provenance').textContent = snapshot
      ? [snapshot.ownership, snapshot.source, snapshot.pid ? 'PID ' + snapshot.pid : '']
          .filter(Boolean)
          .join(' · ')
      : '';
    $('operation').hidden = !operation && !localKind;
    $('progress').hidden = !v.active && !localKind;
    const numbers = progressNumbers(operation);
    if (numbers.percent === null) $('progress').removeAttribute('value');
    else $('progress').value = numbers.percent;
    const number = (value) => Math.round(value).toLocaleString(document.documentElement.lang || 'fr');
    const detail = [];
    if (numbers.total)
      detail.push(
        t('updates.bytes_total', { received: number(numbers.received), total: number(numbers.total) }),
      );
    else if (numbers.received)
      detail.push(t('updates.bytes_received', { received: number(numbers.received) }));
    if (numbers.percent !== null) detail.push(Math.floor(numbers.percent) + ' %');
    if (operation?.startedAt && v.active) detail.push(t('updates.elapsed', { seconds: numbers.seconds }));
    if (operation?.stage === 'cancelled') detail.push(t('updates.operation_cancelled'));
    if (operation?.detail === 'cancel_requested') detail.push(t('updates.cancelling'));
    $('progress-detail').textContent = detail.join(' · ');
    message('progress-wait', numbers.stalled ? 'updates.progress_wait' : '');
    $('stop-operation').hidden = !v.cancellable;
    $('stop-operation').disabled = operation?.detail === 'cancel_requested';
    $('operation-detail').hidden = !operation;
    $('operation-detail').textContent = operation ? JSON.stringify(operation, null, 2) : '';
  }
  // Release notes are GitHub markdown. Render with the shared marked + DOMPurify
  // stack (same family as the transcript renderer), never raw HTML. No file-link
  // context here: plain links only, hardened like the transcript.
  function renderNotesInto(body, raw) {
    body.replaceChildren();
    const holder = document.createElement('div');
    holder.className = 'markdown update-notes-md';
    holder.dataset.i18nIgnore = 'true';
    let html = '';
    try {
      html = marked.parse(String(raw || ''));
    } catch {
      html = '';
    }
    holder.innerHTML = DOMPurify.sanitize(html, {
      USE_PROFILES: { html: true },
      FORBID_TAGS: [
        'style',
        'img',
        'picture',
        'source',
        'form',
        'input',
        'button',
        'textarea',
        'select',
        'iframe',
        'video',
        'audio',
        'object',
        'embed',
        'svg',
        'math',
      ],
      FORBID_ATTR: ['style', 'id', 'name', 'target'],
      ALLOW_DATA_ATTR: false,
    });
    holder.querySelectorAll('a').forEach((anchor) => {
      const href = anchor.getAttribute('href') || '';
      if (!/^(https?:|mailto:|#|\/)/i.test(href)) anchor.removeAttribute('href');
      else if (/^https?:/i.test(href)) {
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
      }
    });
    body.append(holder);
  }
  let remoteTimer = 0;
  let remoteBusy = false;
  let remoteRequestBusy = false;
  async function remoteApi(path, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      return await api(path, { ...options, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
    }
  }
  const clearRemoteTimer = () => {
    if (remoteTimer) clearTimeout(remoteTimer);
    remoteTimer = 0;
  };
  function remoteStage(request) {
    if (!request) return null;
    const map = {
      pending: 'updates.queued',
      checking: 'updates.stage_checking',
      downloading: 'updates.stage_downloading',
      verifying: 'updates.stage_verifying',
      installing: 'updates.stage_installing',
      installed: 'updates.stage_installed',
      installed_pending_restart: 'updates.stage_pending_restart',
      refused: 'updates.stage_refused',
      failed: 'updates.stage_failed',
      expired: 'updates.stage_expired',
    };
    return map[request.status] || null;
  }
  async function refreshRemote({ force = false } = {}) {
    if (remoteBusy) return;
    remoteBusy = true;
    $('remote-check').disabled = true;
    $('remote').setAttribute('aria-busy', 'true');
    if (force) bindText($('remote-status'), () => t('updates.checking'));
    const context = getContext();
    clearRemoteTimer();
    $('remote-request').hidden = true;
    $('remote-notes').hidden = true;
    bindText($('remote-hint'), () => '');
    try {
      const meta = await remoteApi(`/api/updates/metadata${force ? '?refresh=1' : ''}`);
      $('remote-installed').textContent = meta.installed || '?';
      $('remote-published').textContent = meta.published
        ? meta.published.version
        : t('updates.meta_unavailable');
      const request = meta.request;
      const live =
        request && ['pending', 'checking', 'downloading', 'verifying', 'installing'].includes(request.status);
      const stage =
        live || (!force && request?.version === meta.published?.version) ? remoteStage(request) : null;
      if (stage && ['updates.stage_refused', 'updates.stage_failed'].includes(stage))
        bindText($('remote-status'), () => t(stage, { detail: request.detail || request.status }));
      else if (stage) bindText($('remote-status'), () => t(stage));
      else if (meta.metaError) bindText($('remote-status'), () => meta.metaError);
      else if (!meta.published) bindText($('remote-status'), () => t('updates.meta_unavailable'));
      else if (meta.published.version === meta.installed)
        bindText($('remote-status'), () => t('updates.current'));
      else bindText($('remote-status'), () => t('updates.available', { version: meta.published.version }));
      if (meta.published?.notes) {
        renderNotesInto($('remote-notes-body'), meta.published.notes);
        $('remote-notes').hidden = false;
      }
      const canRequest =
        !context.readOnly &&
        !live &&
        meta.published &&
        meta.published.version !== meta.installed &&
        meta.desktop?.alive;
      $('remote-request').hidden = !canRequest;
      $('remote-request').disabled = remoteRequestBusy;
      if (context.readOnly) bindText($('remote-hint'), () => t('updates.remote_read_only'));
      else if (!meta.desktop?.alive) bindText($('remote-hint'), () => t('updates.desktop_offline'));
      if (live) remoteTimer = setTimeout(() => void refreshRemote().catch(() => {}), 5000);
    } catch (error) {
      bindText($('remote-status'), () => (error?.message ? String(error.message) : t('updates.failed')));
    } finally {
      remoteBusy = false;
      $('remote-check').disabled = false;
      $('remote').setAttribute('aria-busy', 'false');
    }
  }
  async function requestRemote() {
    const context = getContext();
    if (context.readOnly || remoteRequestBusy) return;
    remoteRequestBusy = true;
    clearRemoteTimer();
    const button = $('remote-request');
    button.disabled = true;
    try {
      const meta = await remoteApi('/api/updates/metadata');
      if (!meta.published || meta.published.version === meta.installed || !meta.desktop?.alive) {
        await refreshRemote();
        return;
      }
      const dialog = $('confirm');
      bindText($('confirm-title'), () => t('updates.request_confirm_title'));
      bindText($('confirm-note'), () =>
        t('updates.request_confirm_note', { version: meta.published.version }),
      );
      bindText($('proceed'), () => t('updates.request_confirm'));
      const accepted = await new Promise((resolve) => {
        dialog.returnValue = '';
        $('cancel').onclick = () => dialog.close('cancel');
        $('proceed').onclick = () => dialog.close('proceed');
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'proceed'), { once: true });
        dialog.showModal();
        $('cancel').focus();
      });
      if (!accepted) return;
      await remoteApi('/api/updates/request', {
        method: 'POST',
        body: { version: meta.published.version, restartServer: true, confirmed: true },
      });
      await refreshRemote();
    } catch (error) {
      // Server messages arrive pre-translated; show them verbatim as plain text.
      bindText($('remote-status'), () => (error?.message ? String(error.message) : t('updates.failed')));
    } finally {
      remoteRequestBusy = false;
      button.disabled = false;
    }
  }
  async function readOperation() {
    if (!core || pollFlight) return;
    pollFlight = true;
    try {
      const result = await core.invoke('desktop_update_operation');
      const next = result?.operation || null;
      if (!localKind || !next || next.updatedAt >= localStartedAt) operation = next;
      render();
    } finally {
      pollFlight = false;
    }
  }
  function schedulePoll() {
    if (pollTimer) return;
    pollTimer = setTimeout(async () => {
      pollTimer = null;
      const visible = document.getElementById('settings-dialog')?.open && !$('native').hidden;
      if (!visible && !localKind && !operationActive(operation)) return;
      try {
        await readOperation();
      } catch {
        /* The action/status retry owns user-visible errors. */
      }
      schedulePoll();
    }, 1000);
  }
  async function refresh() {
    const remote = getContext().remote === true;
    const native = Boolean(core) && !remote;
    clearRemoteTimer();
    $('browser').hidden = native || remote;
    $('remote').hidden = !remote;
    $('native').hidden = !native;
    if (!native) {
      if (remote) await refreshRemote();
      return;
    }
    schedulePoll();
    if (refreshFlight) return refreshFlight;
    refreshFlight = (async () => {
      await readOperation();
      snapshot = await core.invoke('desktop_update_status');
      if (!operationActive(operation) && !localKind) {
        try {
          await componentsPanel.refresh();
        } catch (error) {
          if (!['update_busy', 'setup_busy'].includes(codeOf(error))) failure(error);
        }
      }
      render();
      return snapshot;
    })().finally(() => {
      refreshFlight = null;
    });
    return refreshFlight;
  }
  function confirmAction(kind, count, pending) {
    const dialog = $('confirm');
    if (dialog.open) return Promise.resolve(false);
    message('confirm-title', 'updates.confirm_' + kind + '_title');
    bindText($('confirm-note'), () =>
      [
        t(`updates.confirm_${kind}_note`),
        count ? t('updates.confirm_agents', { count }) : t('updates.no_agents'),
        pending ? t('updates.confirm_pending') : '',
      ]
        .filter(Boolean)
        .join(' '),
    );
    message(
      'proceed',
      kind === 'quit'
        ? 'updates.quit_confirm'
        : kind === 'install'
          ? 'updates.update_studio'
          : 'updates.restart_now',
    );
    return new Promise((resolve) => {
      dialog.returnValue = '';
      $('cancel').onclick = () => dialog.close('cancel');
      $('proceed').onclick = () => dialog.close('proceed');
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'proceed'), { once: true });
      dialog.showModal();
      $('cancel').focus();
    });
  }
  function beginLocal(kind) {
    localKind = kind;
    localStartedAt = Date.now();
    errorCode = '';
    notice = '';
    if (!operationActive(operation)) operation = null;
    render();
    schedulePoll();
    return ++localEpoch;
  }
  async function endLocal(epoch) {
    // An interrupted download must not clear a later restart's state.
    if (epoch === undefined || epoch !== localEpoch) return;
    localKind = null;
    try {
      await readOperation();
    } catch {
      /* Preserve the real action outcome. */
    }
    render();
  }
  $('check').onclick = async () => {
    if (view().busy || !allowed()) return;
    const epoch = beginLocal('check');
    try {
      const update = await core.invoke('desktop_update_check');
      if (epoch !== localEpoch) return;
      checked = true;
      version = update.available ? update.version : undefined;
      renderNotesInto($('notes-body'), update.notes || '');
      $('notes').hidden = !update.notes;
    } catch (error) {
      if (epoch === localEpoch) failure(error);
    } finally {
      await endLocal(epoch);
    }
    if (epoch === localEpoch)
      try {
        await refresh();
      } catch (error) {
        failure(error);
      }
  };
  $('install').onclick = async () => {
    if (view().busy || actionFlight || !version || !allowed()) return;
    const gate = {};
    actionFlight = gate;
    let epoch;
    try {
      await refresh();
      if (!(await confirmAction('install', snapshot?.activeRuns || 0, false))) return;
      epoch = beginLocal('install');
      actionFlight = false; // Explicit restart remains available during the download.
      const onEvent = new core.Channel();
      onEvent.onmessage = (event) => {
        if (epoch !== localEpoch) return;
        operation = {
          ...operation,
          id: operation?.id || 'local-install',
          kind: 'install',
          startedAt: operation?.startedAt || localStartedAt,
          updatedAt: Date.now(),
          ...event,
          terminal: false,
          done: false,
          cancellable: event.stage === 'downloading',
        };
        render();
      };
      await core.invoke('desktop_update_install', { version, onEvent, restartServer: true });
    } catch (error) {
      if (epoch === undefined || epoch === localEpoch) failure(error);
    } finally {
      if (actionFlight === gate) actionFlight = false;
      await endLocal(epoch);
    }
  };
  $('repair').onclick = async () => {
    if (view().busy || !allowed()) return;
    const epoch = beginLocal('prepare');
    try {
      const result = await componentsPanel.prepare();
      if (epoch !== localEpoch) return;
      if (result?.failure) failure(result.failure.error);
      else if (result?.cancelled) notice = 'updates.operation_cancelled';
      else if (result?.ready) notice = 'updates.repair_ready';
    } catch (error) {
      if (epoch === localEpoch) failure(error);
    } finally {
      await endLocal(epoch);
    }
    if (epoch === localEpoch)
      try {
        await refresh();
      } catch (error) {
        failure(error);
      }
  };
  async function control(kind) {
    if (actionFlight || !allowed()) return;
    const gate = {};
    actionFlight = gate;
    let epoch;
    try {
      openUpdatesPane();
      errorCode = '';
      notice = '';
      await refresh();
      const v = view();
      if (v.locked) {
        failure('install_noncancellable');
        return;
      }
      const canControl =
        kind === 'quit'
          ? snapshot?.running === false ||
            snapshot?.canStop === true ||
            (snapshot?.canStop === undefined && v.canControl)
          : v.canControl;
      if (!canControl) {
        failure(snapshot?.restartReason || 'server_not_managed');
        return;
      }
      const pending = operationActive(operation) || Boolean(localKind);
      if (
        (kind !== 'quit' || pending || snapshot?.activeRuns) &&
        !(await confirmAction(kind, snapshot?.activeRuns || 0, pending))
      )
        return;
      epoch = beginLocal(kind);
      const command = kind === 'quit' ? 'desktop_quit' : 'desktop_server_restart';
      const result = await core.invoke(command, {
        force: Boolean(snapshot?.activeRuns),
        cancelCurrent: pending,
      });
      if (result?.restarted) {
        notice = 'updates.restarted';
        components = null;
      } else if (kind === 'quit' && (result?.stopped || result?.reason === 'already-stopped'))
        notice = 'updates.quitting';
      else if (result?.reason) failure(result.reason);
      else failure('server_start_failed');
    } catch (error) {
      failure(error);
    } finally {
      if (actionFlight === gate) actionFlight = false;
      await endLocal(epoch);
    }
    try {
      await refresh();
    } catch {
      /* Native main switches to the local shell if the server is down. */
    }
  }
  $('restart').onclick = () => void control('restart');
  window.addEventListener('studio:quit-request', () => void control('quit'));
  window.__PRIME_STUDIO_QUIT_READY__ = true;
  $('stop-operation').onclick = async () => {
    try {
      if (['components', 'prepare'].includes(operation?.kind)) await core.invoke('desktop_components_cancel');
      else await core.invoke('desktop_update_cancel');
      if (operation) operation = { ...operation, detail: 'cancel_requested' };
      render();
      schedulePoll();
    } catch (error) {
      failure(error);
    }
  };
  $('remote-request').onclick = () => void requestRemote();
  $('remote-check').onclick = () => void refreshRemote({ force: true });
  onLanguageChange(() => {
    render();
    if (!$('remote').hidden) void refreshRemote();
  });
  render();
  return {
    refresh: () => {
      void refresh().catch(failure);
    },
    components: componentsPanel,
  };
}
