import { t, bindText, onLanguageChange } from './i18n.js';
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';
import { createDesktopComponentsPanel } from './desktop-components.js';

export function createDesktopUpdates({ api, getContext }) {
  const $ = (id) => document.getElementById('studio-update-' + id);
  const componentsPanel = createDesktopComponentsPanel({ getContext });
  const core = window.__PRIME_STUDIO_DESKTOP__ === true && window.__TAURI__?.core;
  let busy = false,
    snapshot,
    version,
    statusKey = 'updates.idle',
    statusParams;
  const status = (key, params) => {
    statusKey = key;
    statusParams = params;
    bindText($('status'), () => t(statusKey, statusParams));
  };
  const failure = (error) => {
    $('error').hidden = !error;
    const key = [
      'components_required',
      'server_not_managed',
      'server_port_occupied',
      'server_version_mismatch',
      'download_failed',
      'install_failed',
      'check_failed',
      'update_busy',
    ].includes(String(error))
      ? String(error)
      : 'failed';
    const message = `updates.${key}`;
    bindText($('error'), () => (error ? t(message) : ''));
  };
  function controls() {
    $('check').disabled = $('install').disabled = $('restart-after').disabled = busy;
    $('restart').disabled = busy || !snapshot?.managed;
    $('native').setAttribute('aria-busy', String(busy));
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
      $('remote-installed').textContent = meta.installed || '—';
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
  async function refresh() {
    const remote = getContext().remote === true;
    const native = Boolean(core) && !remote;
    clearRemoteTimer();
    $('browser').hidden = native || remote;
    $('remote').hidden = !remote;
    $('native').hidden = !native;
    if (!native) {
      if (getContext().remote) await refreshRemote();
      else void componentsPanel.refresh().catch(() => {});
      return;
    }
    void componentsPanel.refresh().catch(() => {});
    try {
      snapshot = await core.invoke('desktop_update_status');
      $('app-version').textContent = snapshot.appVersion;
      $('server-version').textContent = snapshot.version || t('updates.stopped');
      const key = !snapshot.managed
        ? 'updates.unmanaged'
        : !snapshot.running
          ? 'updates.stopped_note'
          : snapshot.version !== snapshot.appVersion
            ? 'updates.pending'
            : 'updates.server_current';
      bindText($('server-note'), () => t(key));
      const count = snapshot.activeRuns;
      bindText($('agents'), () => t(count ? 'updates.agents' : 'updates.no_agents', { count }));
      controls();
      return snapshot;
    } catch (error) {
      snapshot = undefined;
      controls();
      failure(error);
      throw error;
    }
  }
  function confirm(kind, count) {
    const dialog = $('confirm');
    bindText($('confirm-title'), () =>
      t(kind === 'interrupt' ? 'updates.interrupt_title' : 'updates.install_busy_title'),
    );
    bindText($('confirm-note'), () =>
      t(kind === 'interrupt' ? 'updates.interrupt_note' : 'updates.install_busy_note', { count }),
    );
    bindText($('proceed'), () => t(kind === 'interrupt' ? 'updates.interrupt' : 'updates.install'));
    return new Promise((resolve) => {
      dialog.returnValue = '';
      $('cancel').onclick = () => dialog.close('cancel');
      $('proceed').onclick = () => dialog.close('proceed');
      dialog.addEventListener('close', () => resolve(dialog.returnValue === 'proceed'), { once: true });
      dialog.showModal();
      $('cancel').focus();
    });
  }
  $('check').onclick = async () => {
    if (busy) return;
    busy = true;
    controls();
    failure();
    version = undefined;
    $('install').hidden = $('options').hidden = $('notes').hidden = true;
    status('updates.checking');
    try {
      const update = await core.invoke('desktop_update_check');
      version = update.available ? update.version : undefined;
      status(version ? 'updates.available' : 'updates.current', { version });
      $('install').hidden = $('options').hidden = !version;
      renderNotesInto($('notes-body'), update.notes || '');
      $('notes').hidden = !version || !update.notes;
      await refresh();
    } catch (error) {
      status('updates.idle');
      failure(error);
    } finally {
      busy = false;
      controls();
    }
  };
  $('install').onclick = async () => {
    if (busy || !version) return;
    busy = true;
    controls();
    failure();
    try {
      const current = await refresh();
      if (current.activeRuns && !(await confirm('install_busy', current.activeRuns))) return;
      $('progress').hidden = false;
      $('progress').removeAttribute('value');
      status('updates.downloading');
      const onEvent = new core.Channel();
      onEvent.onmessage = ({ stage, percent }) => {
        status(
          'updates.' +
            (stage === 'downloading' ? 'downloading' : stage === 'verifying' ? 'verifying' : 'installing'),
        );
        if (stage === 'downloading' && percent != null) $('progress').value = percent;
        else $('progress').removeAttribute('value');
      };
      await core.invoke('desktop_update_install', {
        version,
        onEvent,
        restartServer: $('restart-after').checked,
      });
    } catch (error) {
      $('progress').hidden = true;
      failure(error);
    } finally {
      busy = false;
      controls();
    }
  };
  $('restart').onclick = async () => {
    if (busy) return;
    busy = true;
    controls();
    failure();
    try {
      const current = await refresh();
      if (!current.managed) return;
      let force = false;
      if (current.activeRuns) {
        if (!(await confirm('interrupt', current.activeRuns))) return;
        force = true;
      }
      status('updates.restarting');
      const result = await core.invoke('desktop_server_restart', { force });
      if (result.reason === 'components_required' || result.activationError === 'components_required') {
        status('updates.components_required');
        failure('components_required');
        void componentsPanel.refresh().catch(() => {});
        await refresh();
      } else if (result.reason === 'agents_running') {
        status('updates.agents_changed');
        await refresh();
      } else if (result.restarted) status('updates.restarted');
    } catch (error) {
      const code = String(error?.message || error);
      if (code === 'components_required') {
        status('updates.components_required');
        failure('components_required');
        void componentsPanel.refresh().catch(() => {});
        await refresh().catch(() => {});
      } else {
        failure(error);
        status('updates.idle');
      }
    } finally {
      busy = false;
      controls();
    }
  };
  $('remote-request').onclick = () => {
    void requestRemote();
  };
  $('remote-check').onclick = () => void refreshRemote({ force: true });
  status('updates.idle');
  onLanguageChange(() => {
    if (!$('native').hidden) void refresh().catch(() => {});
    else if (!$('remote').hidden) void refreshRemote().catch(() => {});
  });
  return {
    refresh: () => {
      void refresh().catch(() => {});
      void componentsPanel.refresh().catch(() => {});
    },
    components: componentsPanel,
  };
}
