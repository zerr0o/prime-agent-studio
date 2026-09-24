import { t as tr, translateKnown, translateDOM, onLanguageChange, bindText } from './i18n.js';
import { createDesktopUpdates } from './desktop-updates.js';
import { createInteractionSettings } from './interaction-settings.js';
import { createEngineSettings } from './engine-settings.js';
import { createComputerPreferences } from './computer-preferences.js';
import {
  isDesktopComponentsAvailable,
  isNewComponentsBridgeAvailable,
  openDesktopComponents,
  registerDesktopComponentsOpener,
} from './desktop-components-action.js';

export function createSettings({
  api,
  getContext,
  openResources,
  copyText,
  toast,
  onStudioPreferences = () => {},
  onEngineSettings = () => {},
  getModels,
  openModelPicker,
  icon,
}) {
  const updates = createDesktopUpdates({ api, getContext });
  const interactions = createInteractionSettings({ api, getContext, onStudioPreferences });
  const engineSettings = createEngineSettings({
    api,
    getContext,
    getModels,
    openModelPicker,
    icon,
    onChanged: onEngineSettings,
  });
  const computerPreferences = createComputerPreferences({ api, getContext, getModels, openModelPicker });
  computerPreferences.start();
  const $ = (id) => document.getElementById(id);
  const showLegacyComponentsRow = isDesktopComponentsAvailable() && !isNewComponentsBridgeAvailable();
  if (showLegacyComponentsRow) {
    $('settings-components-row').hidden = false;
    $('settings-components').onclick = () => void openDesktopComponents({ toast });
  }
  const dialog = $('settings-dialog'),
    tabs = [...dialog.querySelectorAll('[data-settings-tab]')];
  if (window.__PRIME_STUDIO_DESKTOP__ === true) {
    const scope = dialog.querySelector('[data-i18n="settings.scope_browser"]');
    scope.dataset.i18n = 'settings.scope_desktop';
    bindText(scope, () => tr('settings.scope_desktop'));
  }
  let selected = 'appearance',
    network,
    busy = false,
    loading = false,
    generation = 0,
    system,
    setupUrl,
    httpsBusy = false,
    returnFrom,
    returnButton;
  const node = (tag, className, message) => {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (message) bindText(element, () => tr(message));
    return element;
  };
  const button = (message, action, className = 'secondary-button') => {
    const element = node('button', className, message);
    element.type = 'button';
    element.onclick = action;
    return element;
  };
  const error = (id, value) => {
    $(id).hidden = !value;
    bindText($(id), () => translateKnown(value || ''));
  };
  function select(id, focus = false) {
    selected = id;
    for (const tab of tabs) {
      const active = tab.dataset.settingsTab === id;
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
      $('settings-panel-' + tab.dataset.settingsTab).hidden = !active;
      if (active && focus) tab.focus();
      if (active && matchMedia('(max-width: 700px)').matches)
        tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
    if (id === 'remote' && !getContext().remote) void refreshNetwork();
    if (id === 'system') {
      void refreshSystem();
      void refreshAutostart();
    }
    if (id === 'updates') void updates.refresh();
    if (id === 'models') {
      void interactions.refreshDefault();
      engineSettings.update();
    }
    if (id === 'tools') {
      computerPreferences.update();
      void computerPreferences.refresh().catch(() => {});
    }
    if (id === 'notifications') void interactions.refreshNotifications();
  }
  for (const tab of tabs) tab.onclick = () => select(tab.dataset.settingsTab);
  const narrow = matchMedia('(max-width: 700px)');
  const orientation = () =>
    dialog
      .querySelector('.settings-nav')
      .setAttribute('aria-orientation', narrow.matches ? 'horizontal' : 'vertical');
  narrow.addEventListener('change', orientation);
  orientation();
  dialog.querySelector('.settings-nav').addEventListener('keydown', (event) => {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const visible = tabs.filter((tab) => !tab.hidden),
      index = visible.indexOf(document.activeElement);
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? visible.length - 1
          : (index + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + visible.length) %
            visible.length;
    select(visible[next].dataset.settingsTab, true);
  });
  function opened() {
    if (!dialog.open) return;
    const context = getContext();
    for (const tab of tabs)
      tab.hidden =
        (context.remote && tab.dataset.settingsTab === 'models') ||
        (context.readOnly && tab.dataset.settingsTab === 'tools');
    if (tabs.find((tab) => tab.dataset.settingsTab === selected)?.hidden) selected = 'appearance';
    const unavailable = !context.projectCwd || context.readOnly;
    $('settings-skills').disabled = $('settings-prompts').disabled = unavailable;
    bindText($('settings-resource-note'), () =>
      tr(unavailable ? 'settings.choose_project' : 'settings.resources_scope'),
    );
    $('settings-logs-row').hidden = context.remote;
    select(selected);
  }
  new MutationObserver(opened).observe(dialog, { attributes: true, attributeFilter: ['open'] });
  dialog.addEventListener('close', () => {
    generation++;
  });
  // Return to the category only when this panel launched the child manager.
  const managers = {
    'open-model-config': 'model-config-dialog',
    'open-provider-settings': 'providers-dialog',
    'open-mcp-settings': 'mcp-dialog',
    'open-remote-access': 'remote-access-dialog',
    'settings-skills': 'commands-dialog',
    'settings-prompts': 'commands-dialog',
  };
  dialog.addEventListener(
    'click',
    (event) => {
      const manager = managers[event.target.closest('button')?.id];
      if (manager) {
        returnFrom = manager;
        returnButton = event.target.closest('button');
      }
    },
    true,
  );
  for (const id of new Set(Object.values(managers)))
    $(id)?.addEventListener('close', () => {
      if (returnFrom !== id) return;
      returnFrom = undefined;
      dialog.showModal();
      returnButton?.focus();
    });
  for (const [id, source] of [
    ['settings-skills', 'skill'],
    ['settings-prompts', 'prompt'],
  ])
    $(id).onclick = () => {
      dialog.close();
      void openResources(source);
    };

  function controlsDisabled(value) {
    $('network-refresh').disabled = value;
    for (const input of $('network-content').querySelectorAll('input, select, button'))
      input.disabled = value || input.dataset.unavailable === 'true';
    $('network-read-only').disabled = value;
    $('open-remote-access').disabled = busy;
    $('network-content').setAttribute('aria-busy', String(value));
  }
  function renderNetwork() {
    if (!network) return;
    const expanded = new Set(
      [...$('network-content').querySelectorAll('details[open]')].map((item) => item.dataset.channel),
    );
    const content = document.createDocumentFragment();
    for (const channel of network.channels) {
      const card = node('div', 'network-card'),
        heading = node('div', 'network-heading'),
        title = node('div');
      const label = node('label', '', 'settings.' + channel.kind);
      label.htmlFor = 'network-' + channel.kind;
      title.append(label, node('p', 'network-description', 'settings.' + channel.kind + '_note'));
      heading.append(title);
      const state = node('span', 'network-state', 'settings.status_' + channel.status);
      state.dataset.status = channel.status;
      if (channel.kind !== 'https') {
        const toggle = node('input', 'switch');
        toggle.id = label.htmlFor;
        toggle.type = 'checkbox';
        toggle.setAttribute('role', 'switch');
        toggle.checked = channel.enabled;
        toggle.dataset.unavailable = String(!channel.addresses.length && !channel.enabled);
        toggle.disabled = toggle.dataset.unavailable === 'true';
        const control = node('div', 'network-toggle');
        control.append(state, toggle);
        heading.append(control);
        card.append(heading);
        const details = node('details', 'network-advanced');
        details.dataset.channel = channel.kind;
        details.open = expanded.has(channel.kind);
        details.append(node('summary', '', 'settings.connection_options'));
        const fields = node('div', 'network-fields');
        const addressLabel = node('label', '', 'settings.interface'),
          address = node('select');
        address.id = 'network-address-' + channel.kind;
        addressLabel.htmlFor = address.id;
        for (const item of channel.addresses)
          address.add(new Option(`${item.name} · ${item.address}`, item.address));
        if (channel.addresses.some((item) => item.address === channel.host)) address.value = channel.host;
        address.disabled = !channel.addresses.length;
        address.dataset.unavailable = String(address.disabled);
        const portLabel = node('label', '', 'settings.port'),
          port = node('input');
        port.id = 'network-port-' + channel.kind;
        portLabel.htmlFor = port.id;
        port.type = 'number';
        port.required = true;
        port.min = '1024';
        port.max = '65535';
        port.step = '1';
        port.value = channel.port;
        const save = (enabled) => {
          toggle.checked = channel.enabled;
          if (enabled && !port.reportValidity()) return;
          void changeNetwork({
            channel: channel.kind,
            enabled,
            host: address.value,
            port: Number(port.value),
          });
        };
        toggle.onchange = () => save(toggle.checked);
        const apply = button('settings.apply', () => save(true));
        apply.dataset.unavailable = String(!channel.addresses.length);
        apply.disabled = !channel.addresses.length;
        const addressGroup = node('div'),
          portGroup = node('div');
        addressGroup.append(addressLabel, address);
        portGroup.append(portLabel, port);
        fields.append(addressGroup, portGroup, apply);
        details.append(fields, node('p', 'settings-footnote', 'settings.port_note'));
        if (!channel.addresses.length)
          card.append(node('p', 'network-hint', 'settings.' + channel.kind + '_missing'));
        if (channel.error) {
          const problem = node('p', 'network-problem');
          bindText(problem, () => translateKnown(channel.error));
          card.append(problem);
        }
        if (channel.url) card.append(connection(channel));
        card.append(details);
      } else {
        const toggle = node('input', 'switch');
        toggle.id = 'network-https';
        toggle.type = 'checkbox';
        toggle.setAttribute('role', 'switch');
        toggle.checked = channel.enabled;
        const control = node('div', 'network-toggle');
        control.append(state, toggle);
        heading.append(control);
        card.append(heading);
        const details = node('details', 'network-advanced');
        details.dataset.channel = 'https';
        details.open = expanded.has('https');
        details.append(node('summary', '', 'settings.connection_options'));
        const fields = node('div', 'network-fields https-fields');
        const portGroup = node('div'),
          portLabel = node('label', '', 'https.local_port'),
          port = node('input');
        port.id = 'network-port-https';
        portLabel.htmlFor = port.id;
        port.type = 'number';
        port.required = true;
        port.min = '1024';
        port.max = '65535';
        port.value = channel.port || 3090;
        const apply = (enabled = true) => {
          toggle.checked = channel.enabled;
          if (enabled && !port.reportValidity()) return;
          void changeNetwork({ channel: 'https', enabled, port: Number(port.value) });
        };
        toggle.onchange = () => apply(toggle.checked);
        portGroup.append(portLabel, port);
        fields.append(
          portGroup,
          button('settings.apply', () => apply()),
        );
        details.append(fields, node('p', 'settings-footnote', 'https.port_note'));
        if (httpsBusy) card.append(node('p', 'https-progress', 'https.activating'));
        if (setupUrl) {
          const guidance = node('div', 'https-guidance');
          guidance.setAttribute('role', 'status');
          guidance.append(node('p', '', 'https.approval_note'));
          const actions = node('div', 'network-link-actions'),
            link = node('a', 'secondary-button', 'https.open_tailscale');
          link.href = setupUrl;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          actions.append(
            link,
            button('https.retry', () => apply()),
          );
          guidance.append(actions);
          card.append(guidance);
        } else if (!channel.enabled) card.append(node('p', 'network-hint', 'https.intro'));
        if (channel.url) card.append(connection(channel));
        if (channel.error) {
          const p = node('p', 'network-problem');
          bindText(p, () => translateKnown(channel.error));
          card.append(p);
        }
        if (channel.enabled && channel.status === 'error') card.append(button('https.retry', () => apply()));
        card.append(details);
      }
      content.append(card);
    }
    $('network-content').replaceChildren(content);
    $('network-security').hidden = !network.configured;
    $('network-read-only').value = String(network.readOnly);
    controlsDisabled(busy);
  }
  function connection(channel) {
    const row = node('div', 'network-connection'),
      address = node('code', 'network-url');
    address.textContent = channel.url;
    const actions = node('div', 'network-link-actions');
    actions.append(
      button('settings.copy_link', () => void copyText(channel.url)),
      button('settings.qr', () => void showQr(channel)),
    );
    row.append(address, actions);
    return row;
  }
  async function refreshNetwork({ silent = false } = {}) {
    if (getContext().remote) return;
    if (getContext().remote || busy || loading) return;
    loading = true;
    const turn = generation;
    if (!silent) {
      error('network-error');
      controlsDisabled(true);
    }
    try {
      const next = await api('/api/remote-access/network');
      if (turn !== generation) return;
      const changed = JSON.stringify(network) !== JSON.stringify(next);
      network = next;
      if (changed || !silent) renderNetwork();
      error('network-error');
    } catch (e) {
      if (turn === generation) {
        if (!network) $('network-content').replaceChildren();
        error('network-error', e.message);
      }
    } finally {
      loading = false;
      if (turn === generation) controlsDisabled(busy);
      else if (dialog.open && selected === 'remote') void refreshNetwork();
    }
  }
  async function changeNetwork(body) {
    if (busy || !network || getContext().remote) return;
    busy = true;
    httpsBusy = body.channel === 'https' && body.enabled;
    if (body.channel === 'https') setupUrl = undefined;
    // Keep the form values while displaying progress for the potentially slower Serve setup.
    if (httpsBusy) {
      const progress = node('p', 'https-progress', 'https.activating');
      progress.setAttribute('role', 'status');
      $('network-https')?.closest('.network-card').append(progress);
    }
    controlsDisabled(true);
    error('network-error');
    try {
      const next = await api('/api/remote-access/network', {
        method: 'POST',
        body: { ...body, revision: network.revision },
      });
      const { generatedCode, ...state } = next;
      network = state;
      httpsBusy = false;
      if (generatedCode) {
        $('network-generated-code').textContent = generatedCode;
        $('network-new-code').hidden = false;
      }
      renderNetwork();
      if (generatedCode && dialog.open && selected === 'remote') $('network-copy-code').focus();
      toast(() =>
        tr(
          body.channel === 'permissions'
            ? 'settings.permissions_saved'
            : body.channel === 'https' && body.enabled
              ? 'https.saved'
              : 'settings.network_saved',
        ),
      );
    } catch (e) {
      httpsBusy = false;
      try {
        const link = new URL(e.setupUrl);
        if (
          link.protocol === 'https:' &&
          link.hostname === 'login.tailscale.com' &&
          !link.port &&
          !link.username &&
          !link.password
        )
          setupUrl = link.href;
      } catch {}
      // Keep the last working controls; refresh a conflict so the next action is deliberate.
      try {
        network = await api('/api/remote-access/network');
      } catch {}
      renderNetwork();
      error('network-error', e.message);
    } finally {
      busy = false;
      httpsBusy = false;
      controlsDisabled(false);
    }
  }
  $('network-refresh').onclick = () => void refreshNetwork();
  $('network-read-only').onchange = () => {
    const readOnly = $('network-read-only').value === 'true';
    $('network-read-only').value = String(network.readOnly);
    void changeNetwork({ channel: 'permissions', readOnly });
  };
  $('network-copy-code').onclick = () => void copyText($('network-generated-code').textContent);
  $('network-dismiss-code').onclick = () => {
    $('network-generated-code').textContent = '';
    $('network-new-code').hidden = true;
  };
  setInterval(() => {
    if (
      dialog.open &&
      selected === 'remote' &&
      document.visibilityState === 'visible' &&
      !$('network-content').contains(document.activeElement)
    )
      void refreshNetwork({ silent: true });
  }, 8000);

  const qrDialog = node('dialog', 'modal settings-qr');
  qrDialog.id = 'settings-qr-dialog';
  qrDialog.setAttribute('aria-labelledby', 'settings-qr-title');
  const qrHeading = node('div', 'modal-heading'),
    qrTitle = node('h2', '', 'settings.qr_title');
  qrTitle.id = 'settings-qr-title';
  const qrClose = button('ui.fermer', () => qrDialog.close(), 'secondary-button');
  qrHeading.append(qrTitle, qrClose);
  const qrStatus = node('p'),
    qrImage = node('img'),
    qrUrl = node('code', 'network-url');
  qrImage.width = qrImage.height = 256;
  qrImage.alt = '';
  qrDialog.append(qrHeading, qrStatus, qrImage, qrUrl, node('p', 'settings-footnote', 'settings.qr_note'));
  document.body.append(qrDialog);
  let qrGeneration = 0;
  qrDialog.addEventListener('close', () => {
    qrGeneration++;
    qrImage.removeAttribute('src');
  });
  async function showQr(channel) {
    const turn = ++qrGeneration;
    qrImage.hidden = true;
    qrUrl.textContent = '';
    bindText(qrStatus, () => tr('settings.loading'));
    qrDialog.showModal();
    try {
      const result = await api('/api/remote-access/qr?channel=' + channel.kind);
      if (turn !== qrGeneration) return;
      qrImage.src = result.image;
      qrImage.hidden = false;
      qrUrl.textContent = result.url;
      bindText(qrStatus, () =>
        tr(channel.kind === 'lan' ? 'settings.qr_scan_lan' : 'settings.qr_scan_tailscale'),
      );
    } catch (e) {
      if (turn === qrGeneration) bindText(qrStatus, () => translateKnown(e.message));
    }
  }
  async function refreshSystem() {
    const turn = generation;
    error('settings-system-error');
    system = undefined;
    try {
      const context = getContext();
      system = context.remote ? { runtime: context.version, remote: true } : await api('/api/system');
      if (turn !== generation) return;
      const list = $('settings-system-info');
      list.replaceChildren();
      const values = [
        ['settings.studio_version', system.studio],
        [
          'settings.engine',
          system.runtime?.available ? tr('settings.available') : tr('settings.unavailable'),
        ],
        ['settings.engine_version', system.runtime?.version],
        ['settings.running', system.activeRuns],
        ['settings.node', system.node],
      ];
      for (const [label, value] of values)
        if (value !== undefined && value !== null) {
          const dt = node('dt', '', label),
            dd = node('dd');
          dd.textContent = String(value);
          list.append(dt, dd);
        }
    } catch (e) {
      if (turn === generation) error('settings-system-error', e.message);
    }
  }
  function isAutostartAvailable() {
    try {
      const context = getContext();
      if (context?.remote === true || context?.readOnly === true) return false;
    } catch {
      return false;
    }
    return isNewComponentsBridgeAvailable();
  }
  async function refreshAutostart() {
    const row = $('settings-autostart-row');
    const input = $('settings-autostart');
    if (!row || !input) return;
    if (!isAutostartAvailable()) {
      row.hidden = true;
      return;
    }
    row.hidden = false;
    input.disabled = true;
    try {
      const state = await window.__TAURI__.core.invoke('desktop_state');
      if (typeof state?.autostart === 'boolean') input.checked = state.autostart;
      error('settings-system-error');
    } catch {
      // Keep last value; a dedicated message appears only on explicit change failure.
    } finally {
      input.disabled = false;
    }
  }
  const autostartInput = $('settings-autostart');
  if (autostartInput) {
    autostartInput.onchange = async () => {
      if (!isAutostartAvailable()) {
        $('settings-autostart').checked = !$('settings-autostart').checked;
        return;
      }
      const input = $('settings-autostart');
      const wanted = input.checked;
      input.disabled = true;
      error('settings-system-error');
      try {
        await window.__TAURI__.core.invoke('desktop_autostart', { enabled: wanted });
        error('settings-system-error');
      } catch (e) {
        input.checked = !wanted;
        error('settings-system-error', e?.message || 'settings.autostart_error');
      } finally {
        input.disabled = false;
      }
    };
  }
  $('settings-copy-diagnostics').onclick = async () => {
    await refreshSystem();
    if (system)
      void copyText(
        JSON.stringify(
          {
            studio: system.studio,
            node: system.node,
            platform: system.platform,
            engine: { available: system.runtime?.available, version: system.runtime?.version },
            activeRuns: system.activeRuns,
          },
          null,
          2,
        ),
      );
  };
  $('settings-open-logs').onclick = async () => {
    const control = $('settings-open-logs');
    control.disabled = true;
    try {
      await api('/api/system/logs', { method: 'POST', body: {} });
    } catch (e) {
      error('settings-system-error', e.message);
    } finally {
      control.disabled = false;
    }
  };
  // Text bindings update in place, preserving open connection options and unsaved fields.
  onLanguageChange(() => {
    if (dialog.open && selected === 'system') void refreshSystem();
  });
  translateDOM(dialog);
  const openUpdatesPane = (focus) => {
    if (!dialog.open) dialog.showModal();
    select('updates', Boolean(focus));
  };
  const openComponentPanel = () => {
    openUpdatesPane(false);
    const reveal = () => {
      try {
        const panel = document.getElementById('studio-update-components');
        const heading = document.getElementById('studio-update-components-heading');
        if (panel && !panel.hidden) panel.scrollIntoView({ block: 'start' });
        if (heading) heading.focus({ preventScroll: true });
      } catch {}
    };
    // One layout frame after revealing the tab; never steal focus again later.
    requestAnimationFrame(() => {
      if (dialog.open && selected === 'updates') reveal();
    });
  };
  registerDesktopComponentsOpener(() => openComponentPanel());
  try {
    window.__PRIME_STUDIO_OPEN_UPDATES__ = () => openComponentPanel();
  } catch {}
  if (new URLSearchParams(location.search).get('settings') === 'updates') {
    selected = 'updates';
    dialog.showModal();
    const url = new URL(location.href);
    url.searchParams.delete('settings');
    history.replaceState(null, '', url);
  }
  // Refresh autostart visibility once context is known, without overriding the system tab state.
  void refreshAutostart().catch(() => {});
  return {
    open: () => dialog.showModal(),
    openUpdates: () => openUpdatesPane(false),
    updates,
    getComputerBackend: () => computerPreferences.getBackend(),
    getComputerModel: () => computerPreferences.getModel(),
    getComputerThinking: () => computerPreferences.getThinking(),
    refreshComputerPreferences: () => computerPreferences.refresh(),
  };
}
