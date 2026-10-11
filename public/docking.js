import { t as tr, bindText, bindAttribute, onLanguageChange } from './i18n.js';
import {
  isPanelId,
  isConversationPanel,
  MAX_CONVERSATIONS,
  MIN_RATIO,
  MAX_RATIO,
  createDefaultLayout,
  validateLayout,
  groupsOf,
  movePanel,
  activatePanel,
  closePanel,
  resizeSplit,
} from './docking-layout.js';
import { placeViewportMenu } from './file-links.js';
import {
  MAX_PRESETS,
  MAX_PRESET_NAME,
  validatePresets,
  createPresetLayout,
  presetConversationCount,
  applyPresetLayout,
} from './docking-presets.js';

const titles = {
  conversation: 'docking.conversation',
  roadmap: 'docking.roadmap',
  session: 'docking.session',
  agents: 'docking.agents',
  files: 'docking.files',
  preferences: 'docking.preferences',
};
const tabPaths = {
  conversation: 'M21 4H3v13h5l4 4 4-4h5V4Z',
  roadmap: 'M3 6l6-3 6 3 6-3v15l-6 3-6-3-6 3V6Zm6-3v15m6-12v15',
  session: 'M5 3h10l4 4v14H5V3Zm10 0v5h4M8 12h8M8 16h6',
  agents:
    'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  files: 'M3 7V5a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7Z',
  preferences:
    'm10 3-.5 2-2 .9-1.8-.6-2 3.4L5.2 10v2l-1.5 1.3 2 3.4 1.8-.6 2 .9.5 2h4l.5-2 2-.9 1.8.6 2-3.4-1.5-1.3v-2l1.5-1.3-2-3.4-1.8.6-2-.9L14 3h-4ZM15 11a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
};
function tabIcon(id) {
  const type = isConversationPanel(id) ? 'conversation' : id;
  const icon = el('span', 'dock-tab-icon');
  icon.setAttribute('aria-hidden', 'true');
  icon.dataset.dockType = type;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.5',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  }))
    svg.setAttribute(key, value);
  const path = document.createElementNS(svg.namespaceURI, 'path');
  path.setAttribute('d', tabPaths[type]);
  svg.append(path);
  icon.append(svg);
  return icon;
}
const zones = ['center', 'left', 'right', 'top', 'bottom'];
const zoneTitles = {
  center: 'docking.center',
  left: 'docking.left',
  right: 'docking.right',
  top: 'docking.top',
  bottom: 'docking.bottom',
};
const el = (tag, cls = '', text) => {
  const node = document.createElement(tag);
  node.className = cls;
  if (text !== undefined) bindText(node, text);
  return node;
};
const button = (text, action, cls = '') => {
  const node = el('button', cls, text);
  node.type = 'button';
  node.onclick = action;
  return node;
};

/** Owns layout chrome only. Live panel nodes are moved, never rebuilt. */
export function createDocking({
  panels,
  read,
  write,
  onChange,
  onResize,
  toast,
  titleOf,
  onActivatePanel,
  onCreateConversation,
  onChooseConversation,
  onDropConversation,
  isFocusedPanel,
  projectColorOf,
  onBeforeModeChange,
  onBeforeMove,
}) {
  panels = Object.assign(Object.create(null), panels);
  const panelIds = () => Object.keys(panels);
  const label = (id) => titleOf?.(id) || tr(titles[id] || 'docking.conversation');
  const stored = read('docking.layout', null);
  const restored = validateLayout(stored);
  let layout = restored || createDefaultLayout();
  let enabled = !!restored && stored.enabled === true;
  // A stale sidecar must not leave an undefined panel in the DOM. No session is deleted.
  for (const id of groupsOf(layout).flatMap((group) => group.panels))
    if (!panels[id]) layout = closePanel(layout, id);
  let active = false;
  let dragged = null;
  let resizing = null;
  // Drop-preview fast path (beta.3): dragover only records the latest point;
  // one rAF does the measuring + DOM placement, skipped when target unchanged.
  let previewKey = null;
  let previewGroup = null;
  let pendingPreview = null;
  let previewRaf = 0;
  const viewport = matchMedia('(min-width: 1081px)');
  const workspace = document.querySelector('.workspace-body');
  const opener = document.getElementById('open-docking');
  const host = el('div', 'dock-workspace');
  host.id = 'dock-workspace';
  const preview = el('div', 'dock-drop-preview');
  preview.hidden = true;
  preview.setAttribute('aria-hidden', 'true');
  const previewText = el('span');
  preview.append(previewText);
  const tabInsertion = el('div', 'dock-tab-insertion');
  tabInsertion.hidden = true;
  tabInsertion.setAttribute('aria-hidden', 'true');
  const homes = new Map();
  const scroll = new Map();
  const homeParking = el('div');
  homeParking.hidden = true;
  document.body.append(homeParking);
  function rememberHome(id, node) {
    const marker = document.createComment(`dock-home:${id}`);
    if (node.parentNode) node.before(marker);
    else homeParking.append(marker, node);
    homes.set(id, { marker, hidden: node.hidden });
  }
  for (const id of panelIds()) rememberHome(id, panels[id]);
  if (stored !== null && !restored) toast?.(() => tr('docking.recovered'), true);

  const dialog = el('dialog', 'modal docking-settings');
  dialog.id = 'docking-settings';
  dialog.setAttribute('aria-labelledby', 'docking-title');
  const heading = el('header', 'docking-heading');
  const title = el('h2', '', () => tr('docking.title'));
  title.id = 'docking-title';
  const done = button(
    () => tr('ui.fermer'),
    () => dialog.close(),
    'secondary-button',
  );
  done.id = 'docking-close-settings';
  heading.append(title, done);
  const mode = el('label', 'docking-mode');
  const toggle = el('input');
  toggle.type = 'checkbox';
  toggle.id = 'docking-toggle';
  toggle.onchange = () => {
    enabled = toggle.checked;
    updateViewport();
    persist();
    refreshDialog();
  };
  mode.append(
    toggle,
    el('span', '', () => tr('docking.enable')),
  );
  const help = el('p', 'docking-help', () => tr('docking.help'));
  const fields = el('fieldset', 'docking-controls');
  fields.append(el('legend', '', () => tr('docking.panels')));
  const openers = el('div', 'docking-openers');
  const newConversation = button(
    () => tr('docking.new_conversation'),
    () => addConversation(targetChoice.value),
    'secondary-button',
  );
  newConversation.id = 'docking-new-conversation';
  fields.append(openers);
  const movement = el('div', 'docking-movement');
  function select(id, key) {
    const row = el('label');
    row.append(el('span', '', () => tr(key)));
    const input = el('select');
    input.id = id;
    row.append(input);
    movement.append(row);
    return input;
  }
  const panelChoice = select('docking-panel', 'docking.panel');
  const targetChoice = select('docking-target', 'docking.target');
  const zoneChoice = select('docking-zone', 'docking.position');
  const move = button(
    () => tr('docking.move'),
    () => {
      commit(
        movePanel(layout, {
          panel: panelChoice.value,
          targetGroupId: targetChoice.value,
          zone: zoneChoice.value,
        }),
        panelChoice.value,
      );
    },
    'primary-button',
  );
  move.id = 'docking-move';
  movement.append(move);
  fields.append(movement);
  const footer = el('footer', 'docking-footer');
  const reset = button(
    () => tr('docking.reset'),
    () => commit(createDefaultLayout()),
    'secondary-button',
  );
  reset.id = 'docking-reset';
  footer.append(
    reset,
    el('span', 'docking-help', () => tr('docking.local')),
  );
  fields.append(footer);
  // Named layouts contain geometry and anonymous conversation slots, never session data.
  let presets = validatePresets(read('docking.presets', null)) || { version: 1, items: [] };
  let pendingPreset = null;
  const presetBox = el('section', 'docking-presets');
  presetBox.append(
    el('h3', '', () => tr('docking.presets')),
    el('p', 'docking-help', () => tr('docking.presets_help')),
  );
  const saveRow = el('div', 'docking-preset-row');
  const nameLabel = el('label', '', () => tr('docking.preset_name'));
  const presetName = el('input');
  presetName.id = 'docking-preset-name';
  presetName.type = 'text';
  presetName.maxLength = MAX_PRESET_NAME;
  nameLabel.htmlFor = presetName.id;
  const savePresetButton = button(() => tr('docking.save_layout'), savePreset, 'secondary-button');
  savePresetButton.id = 'docking-save-layout';
  saveRow.append(presetName, savePresetButton);
  const loadRow = el('div', 'docking-preset-row');
  const savedLabel = el('label', '', () => tr('docking.saved_layouts'));
  const presetChoice = el('select');
  presetChoice.id = 'docking-preset-choice';
  savedLabel.htmlFor = presetChoice.id;
  const loadPresetButton = button(() => tr('docking.load_layout'), loadPreset, 'secondary-button');
  loadPresetButton.id = 'docking-load-layout';
  const deletePresetButton = button(
    () => tr('docking.delete_layout'),
    () => {
      const item = presets.items.find((item) => item.name === presetChoice.value);
      if (item) askPreset('delete', item);
    },
    'secondary-button',
  );
  deletePresetButton.id = 'docking-delete-layout';
  loadRow.append(presetChoice, loadPresetButton, deletePresetButton);
  const confirmation = el('div', 'docking-preset-confirmation');
  confirmation.hidden = true;
  const confirmationText = el('p');
  const confirmPreset = button(
    () => tr(pendingPreset?.kind === 'delete' ? 'docking.delete_layout' : 'docking.overwrite'),
    () => {
      const pending = pendingPreset;
      cancelPreset();
      if (!pending) return;
      const items = presets.items.filter(
        (item) => item.name.toLowerCase() !== pending.item.name.toLowerCase(),
      );
      if (pending.kind === 'save') items.push(pending.item);
      storePresets(items, pending.kind === 'save' ? 'docking.saved' : 'docking.deleted', pending.item.name);
      presetChoice.focus();
    },
    'primary-button',
  );
  confirmPreset.id = 'docking-preset-confirm';
  const cancelPresetButton = button(
    () => tr('ui.annuler'),
    () => {
      cancelPreset();
      presetName.focus();
    },
    'secondary-button',
  );
  cancelPresetButton.id = 'docking-preset-cancel';
  confirmation.append(confirmationText, confirmPreset, cancelPresetButton);
  const presetStatus = el('p', 'docking-help docking-preset-status');
  presetStatus.id = 'docking-preset-status';
  presetStatus.setAttribute('role', 'status');
  presetBox.append(nameLabel, saveRow, savedLabel, loadRow, confirmation, presetStatus);
  fields.append(presetBox);
  presetChoice.onchange = () => {
    cancelPreset();
    presetName.value = presetChoice.value;
    refreshPresets();
  };
  presetName.oninput = cancelPreset;

  function presetMessage(key, name = '', error = false) {
    bindText(presetStatus, () => tr(key, { name }));
    presetStatus.classList.toggle('is-error', error);
  }
  function refreshPresets() {
    const chosen = presetChoice.value;
    presetChoice.replaceChildren(
      new Option(tr('docking.choose_layout'), ''),
      ...presets.items.map((item) => new Option(item.name, item.name)),
    );
    if (presets.items.some((item) => item.name === chosen)) presetChoice.value = chosen;
    loadPresetButton.disabled = deletePresetButton.disabled = !presetChoice.value;
  }
  function cancelPreset() {
    pendingPreset = null;
    confirmation.hidden = true;
  }
  function askPreset(kind, item) {
    pendingPreset = { kind, item };
    bindText(confirmationText, () =>
      tr(kind === 'save' ? 'docking.confirm_overwrite' : 'docking.confirm_delete', { name: item.name }),
    );
    confirmPreset.textContent = tr(kind === 'save' ? 'docking.overwrite' : 'docking.delete_layout');
    confirmation.hidden = false;
    confirmPreset.focus();
  }
  function storePresets(items, message, name) {
    const next = validatePresets({ version: 1, items });
    if (!next || write('docking.presets', next) === false) {
      presetMessage('docking.save_failed', '', true);
      return;
    }
    presets = next;
    refreshPresets();
    if (presets.items.some((item) => item.name === name)) presetChoice.value = name;
    refreshPresets();
    presetMessage(message, name);
  }
  function savePreset() {
    const name = presetName.value.trim();
    if (!name) {
      presetMessage('docking.name_required', '', true);
      presetName.focus();
      return;
    }
    const item = { name, layout: createPresetLayout(layout) };
    const existing = presets.items.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (existing) {
      askPreset('save', item);
      return;
    }
    if (presets.items.length >= MAX_PRESETS) {
      presetMessage('docking.preset_limit', '', true);
      return;
    }
    storePresets([...presets.items, item], 'docking.saved', name);
  }
  function loadPreset() {
    const item = presets.items.find((item) => item.name === presetChoice.value);
    if (!item) return;
    cancelPreset();
    const composer = document.getElementById('composer');
    const focused = panelIds().find((id) => isConversationPanel(id) && panels[id].contains(composer));
    const visible = groupsOf(layout)
      .flatMap((group) => group.panels)
      .filter(isConversationPanel);
    const ids = [
      ...new Set([focused, ...visible, ...panelIds().filter(isConversationPanel)].filter(Boolean)),
    ];
    const needed = presetConversationCount(item.layout);
    while (ids.length < needed) {
      const id = onCreateConversation?.({ activate: false });
      if (!id || !panels[id] || ids.includes(id)) {
        presetMessage('docking.load_failed', '', true);
        return;
      }
      ids.push(id);
    }
    const next = applyPresetLayout(item.layout, ids);
    if (!next) {
      presetMessage('docking.load_failed', '', true);
      return;
    }
    applyLayout(next);
    const focusedPanel = groupsOf(layout)
      .map((group) => group.active)
      .find(isConversationPanel);
    if (focusedPanel) commit(layout, focusedPanel);
    presetMessage('docking.loaded', item.name);
  }
  dialog.append(heading, mode, help, fields);
  document.body.append(dialog);
  opener.onclick = () => showSettings();
  dialog.addEventListener('close', () => {
    cancelPreset();
    opener.setAttribute('aria-expanded', 'false');
    (viewport.matches ? opener : document.getElementById('toggle-details')).focus({ preventScroll: true });
  });

  const menu = el('div', 'dock-menu');
  menu.id = 'docking-context-menu';
  menu.setAttribute('role', 'menu');
  bindAttribute(menu, 'aria-label', () => tr('docking.tab_menu'));
  const addMenu = el('div', 'dock-menu');
  addMenu.id = 'docking-add-menu';
  addMenu.setAttribute('role', 'menu');
  bindAttribute(addMenu, 'aria-label', () => tr('docking.add_tab'));
  menu.hidden = addMenu.hidden = true;
  document.body.append(menu, addMenu);
  let menuOrigin = null;
  let addMenuButton = null;
  const closeMenu = (restoreFocus = false) => {
    menu.hidden = addMenu.hidden = true;
    addMenuButton?.setAttribute('aria-expanded', 'false');
    if (restoreFocus && menuOrigin?.isConnected) menuOrigin.focus({ preventScroll: true });
  };
  function menuItem(text, action, disabled = false) {
    const item = button(text, action);
    item.setAttribute('role', 'menuitem');
    item.tabIndex = -1;
    item.disabled = disabled;
    return item;
  }
  function openContextMenu(event, groupId, origin, id) {
    event.preventDefault();
    event.stopPropagation();
    if (!active || resizing || dragged) return;
    closeMenu();
    menuOrigin = origin;
    menu.replaceChildren();
    addMenu.replaceChildren();
    const finish = (action) => () => {
      closeMenu();
      action();
    };
    const openAdd = (focus = true) => {
      addMenu.hidden = false;
      addMenuButton.setAttribute('aria-expanded', 'true');
      const rect = addMenuButton.getBoundingClientRect();
      const x =
        rect.right + addMenu.offsetWidth + 4 > innerWidth - 12
          ? rect.left - addMenu.offsetWidth - 4
          : rect.right + 4;
      placeViewportMenu(addMenu, x, rect.top);
      if (focus) addMenu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
    };
    addMenuButton = menuItem(
      () => tr('docking.add_tab'),
      () => openAdd(),
    );
    addMenuButton.classList.add('dock-menu-submenu');
    addMenuButton.setAttribute('aria-haspopup', 'menu');
    addMenuButton.setAttribute('aria-expanded', 'false');
    addMenuButton.setAttribute('aria-controls', addMenu.id);
    addMenuButton.onpointerenter = () => openAdd(false);
    addMenuButton.onkeydown = (key) => {
      if (key.key === 'ArrowRight') {
        key.preventDefault();
        key.stopPropagation();
        openAdd();
      }
    };
    const create = menuItem(
      () => tr('docking.new_conversation'),
      finish(() => addConversation(groupId)),
      !onChooseConversation,
    );
    create.dataset.dockAdd = 'new-conversation';
    addMenu.append(create);
    const separator = el('hr');
    separator.setAttribute('role', 'separator');
    addMenu.append(separator);
    const ids = panelIds().filter((id) => !isConversationPanel(id));
    for (const panel of ids) {
      const item = menuItem(
        () => label(panel),
        finish(() => openPanel(panel, groupId)),
        !canOpenPanel(panel),
      );
      item.dataset.dockAdd = panel;
      bindAttribute(item, 'title', () => label(panel));
      addMenu.append(item);
    }
    const group = groupsOf(layout).find((group) => group.id === groupId);
    const closeOthers = menuItem(
      () => tr('docking.close_others'),
      finish(() => removeOtherPanels(groupId, id)),
      !group?.panels.includes(id) || group.panels.length < 2,
    );
    closeOthers.dataset.dockCloseOthers = groupId;
    menu.append(
      addMenuButton,
      menuItem(
        () => tr('docking.close', { panel: label(id) }),
        finish(() => removePanel(id)),
        !id,
      ),
      closeOthers,
      menuItem(
        () => tr('docking.title'),
        finish(() => showSettings(groupId)),
      ),
      menuItem(
        () => tr('docking.save_layout'),
        finish(() => {
          showSettings(groupId);
          presetName.focus();
        }),
      ),
    );
    menu.hidden = false;
    const rect = origin.getBoundingClientRect();
    placeViewportMenu(
      menu,
      event.type === 'contextmenu' ? event.clientX : rect.left,
      event.type === 'contextmenu' ? event.clientY : rect.bottom,
    );
    addMenuButton.focus({ preventScroll: true });
  }
  for (const popup of [menu, addMenu])
    popup.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft' && popup === addMenu) {
        event.preventDefault();
        addMenu.hidden = true;
        addMenuButton.setAttribute('aria-expanded', 'false');
        addMenuButton.focus();
        return;
      }
      if (event.key === 'Tab') {
        closeMenu(true);
        return;
      }
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const items = [...popup.querySelectorAll('button:not(:disabled)')];
      const current = items.indexOf(document.activeElement);
      const index =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (current + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      items[index]?.focus({ preventScroll: true });
    });
  document.addEventListener('pointerdown', (event) => {
    if (!menu.hidden && !menu.contains(event.target) && !addMenu.contains(event.target)) closeMenu();
  });
  window.addEventListener('resize', () => closeMenu());

  function conversationCount() {
    return groupsOf(layout)
      .flatMap((group) => group.panels)
      .filter(isConversationPanel).length;
  }
  function canOpenPanel(id) {
    return (
      !isConversationPanel(id) ||
      groupsOf(layout).some((group) => group.panels.includes(id)) ||
      conversationCount() < MAX_CONVERSATIONS
    );
  }
  async function addConversation(groupId) {
    if (!active || !onChooseConversation) return;
    const id = await onChooseConversation();
    if (active && id && panels[id]) openPanel(id, groupId);
  }
  function showSettings(groupId) {
    closeMenu();
    refreshDialog();
    if (groupId) {
      targetChoice.value = groupId;
      const group = groupsOf(layout).find((group) => group.id === groupId);
      if (group?.active) panelChoice.value = group.active;
    }
    if (!dialog.open) dialog.showModal();
    opener.setAttribute('aria-expanded', 'true');
  }
  function refreshDialog() {
    toggle.checked = enabled;
    toggle.disabled = !viewport.matches;
    fields.disabled = !active;
    const chosen = [panelChoice.value, targetChoice.value, zoneChoice.value];
    openers.replaceChildren(
      newConversation,
      ...panelIds().map((id) => {
        const item = button(
          () => label(id),
          () => openPanel(id),
          'secondary-button',
        );
        item.dataset.dockOpen = id;
        bindAttribute(item, 'aria-label', () => tr('docking.show', { panel: label(id) }));
        item.disabled = !canOpenPanel(id);
        return item;
      }),
    );
    newConversation.disabled = !onChooseConversation;
    bindAttribute(newConversation, 'title', () =>
      tr(newConversation.disabled ? 'docking.conversation_limit' : 'docking.new_conversation'),
    );
    panelChoice.replaceChildren(...panelIds().map((id) => new Option(label(id), id)));
    targetChoice.replaceChildren(
      ...groupsOf(layout).map(
        (group) => new Option(group.panels.map(label).join(' · ') || tr('docking.empty'), group.id),
      ),
    );
    zoneChoice.replaceChildren(...zones.map((zone) => new Option(tr(zoneTitles[zone]), zone)));
    for (const [input, value] of [
      [panelChoice, chosen[0]],
      [targetChoice, chosen[1]],
      [zoneChoice, chosen[2]],
    ])
      if ([...input.options].some((option) => option.value === value)) input.value = value;
    opener.classList.toggle('is-active', active);
    refreshPresets();
  }
  function persist() {
    write('docking.layout', { ...layout, enabled });
  }
  function visiblePanels() {
    return active
      ? groupsOf(layout)
          .map((group) => group.active)
          .filter(Boolean)
      : [];
  }
  function notify() {
    onChange({ active, visiblePanels: visiblePanels() });
  }
  function rememberScroll() {
    for (const node of scroll.keys()) if (!node.isConnected) scroll.delete(node);
    for (const panel of new Set([...Object.values(panels), document.querySelector('.conversation-column')])) {
      if (!panel?.getClientRects().length) continue;
      for (const node of panel.querySelectorAll(
        '.conversation-scroll, .inspector-content, .rm-content, .settings-panels, .settings-nav, textarea',
      ))
        if (node.getClientRects().length) scroll.set(node, [node.scrollLeft, node.scrollTop]);
    }
  }
  function restoreScroll() {
    for (const [node, [left, top]] of scroll)
      if (node.getClientRects().length) {
        node.scrollLeft = left;
        node.scrollTop = top;
      }
  }
  function setSplitStyle(node, ratio) {
    // Sub-unit fr weights leave unused space when the other track hits its minimum.
    // Percentage weights keep each remaining flexible track above 1fr.
    node.style.setProperty('--dock-first', `${ratio * 100}fr`);
    node.style.setProperty('--dock-second', `${(1 - ratio) * 100}fr`);
    node
      .querySelector(':scope > .dock-splitter')
      .setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }
  function focusTab(panel) {
    const tab = host.querySelector(`[data-dock-tab="${panel}"]`);
    tab?.focus({ preventScroll: true });
    tab?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function render(focusPanel, captureScroll = true) {
    if (!active) return;
    if (captureScroll) rememberScroll();
    const focused = document.activeElement;
    // Connected parking keeps panel ownership explicit while only chrome is replaced.
    const parking = el('div');
    parking.hidden = true;
    workspace.append(parking);
    for (const [id, node] of Object.entries(panels)) {
      onBeforeMove?.(id, node);
      if (node.matches('dialog:modal')) node.close();
      parking.append(node);
    }
    host.replaceChildren(build(layout.root));
    for (const id of panelIds()) {
      const node = panels[id];
      node.classList.add('dock-panel');
      node.hidden = !visiblePanels().includes(id);
      if (node.parentElement === parking) host.append(node);
    }
    parking.remove();
    notify();
    restoreScroll();
    if (focusPanel) focusTab(focusPanel);
    else if (focused?.isConnected && !focused.closest('[hidden]')) focused.focus({ preventScroll: true });
    refreshDialog();
  }
  function minimumSize(model, direction) {
    if (model.kind === 'group')
      return direction === 'row'
        ? model.panels.some(isConversationPanel)
          ? 260
          : 220
        : model.panels.some(isConversationPanel)
          ? 240
          : 200;
    const first = minimumSize(model.first, direction),
      second = minimumSize(model.second, direction);
    return model.dir === direction ? first + second + 1 : Math.max(first, second);
  }
  function build(model) {
    if (model.kind === 'split') {
      const node = el('div', 'dock-split');
      node.dataset.direction = model.dir;
      node.id = `dock-node-${model.id}`;
      node.style.minWidth = `${minimumSize(model, 'row')}px`;
      node.style.minHeight = `${minimumSize(model, 'column')}px`;
      node.style.setProperty('--dock-min-first', `${minimumSize(model.first, model.dir)}px`);
      node.style.setProperty('--dock-min-second', `${minimumSize(model.second, model.dir)}px`);
      const grip = el('div', 'dock-splitter');
      grip.dataset.dockSplit = model.id;
      grip.tabIndex = 0;
      grip.setAttribute('role', 'separator');
      grip.setAttribute('aria-orientation', model.dir === 'row' ? 'vertical' : 'horizontal');
      grip.setAttribute('aria-valuemin', String(MIN_RATIO * 100));
      grip.setAttribute('aria-valuemax', String(MAX_RATIO * 100));
      grip.setAttribute('aria-controls', `dock-node-${model.first.id} dock-node-${model.second.id}`);
      bindAttribute(grip, 'aria-label', () => tr('docking.resize'));
      grip.onpointerdown = (event) => startResize(event, node, model, grip);
      grip.onkeydown = (event) => {
        const keys = model.dir === 'row' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
        if (![...keys, 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const current = parseFloat(node.style.getPropertyValue('--dock-first')) / 100;
        const ratio =
          event.key === 'Home'
            ? MIN_RATIO
            : event.key === 'End'
              ? MAX_RATIO
              : current + (event.key === keys[0] ? -1 : 1) * (event.shiftKey ? 0.1 : 0.02);
        layout = resizeSplit(layout, model.id, ratio);
        const adjusted = Math.max(MIN_RATIO, Math.min(MAX_RATIO, ratio));
        setSplitStyle(node, adjusted);
        persist();
      };
      node.append(build(model.first), grip, build(model.second));
      setSplitStyle(node, model.ratio);
      return node;
    }
    const group = el('section', 'dock-group');
    group.dataset.dockGroup = model.id;
    group.id = `dock-node-${model.id}`;
    group.style.minWidth = `${minimumSize(model, 'row')}px`;
    group.style.minHeight = `${minimumSize(model, 'column')}px`;
    const bar = el('div', 'dock-bar');
    bar.oncontextmenu = (event) => {
      const tab = event.target.closest('[data-dock-tab]');
      openContextMenu(
        event,
        model.id,
        tab || bar.querySelector('button'),
        tab?.dataset.dockTab || model.active,
      );
    };
    bar.onkeydown = (event) => {
      if (event.key !== 'ContextMenu' && !(event.key === 'F10' && event.shiftKey)) return;
      const tab = event.target.closest('[data-dock-tab]');
      openContextMenu(event, model.id, tab || event.target, tab?.dataset.dockTab || model.active);
    };
    const tabs = el('div', 'dock-tabs');
    tabs.setAttribute('role', 'tablist');
    bindAttribute(tabs, 'aria-label', () => tr('docking.panels'));
    const content = el('div', 'dock-content');
    for (const id of model.panels) {
      const tab = button(undefined, () => commit(activatePanel(layout, id), id), 'dock-tab');
      const glyph = tabIcon(id);
      if (isConversationPanel(id)) glyph.style.color = projectColorOf?.(id) || '';
      tab.append(
        glyph,
        el('span', 'dock-tab-label', () => label(id)),
      );
      tab.dataset.dockTab = id;
      tab.classList.toggle('is-conversation', isConversationPanel(id));
      tab.classList.toggle('is-focused', isConversationPanel(id) && !!isFocusedPanel?.(id));
      tab.id = `dock-tab-${id}`;
      tab.draggable = true;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(id === model.active));
      tab.tabIndex = id === model.active ? 0 : -1;
      bindAttribute(tab, 'title', () => tr('docking.drag', { panel: label(id) }));
      const frame = el('div', 'dock-panel-frame');
      frame.id = `dock-view-${id}`;
      frame.setAttribute('role', 'tabpanel');
      frame.setAttribute('aria-labelledby', tab.id);
      frame.hidden = id !== model.active;
      tab.setAttribute('aria-controls', frame.id);
      frame.append(panels[id]);
      content.append(frame);
      tab.ondragstart = (event) => {
        if (resizing) {
          event.preventDefault();
          return;
        }
        dragged = id;
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/x-studio-dock-panel', id);
        host.classList.add('is-dragging');
      };
      tab.ondragend = clearDrag;
      tab.onkeydown = (event) => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const index =
          event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? model.panels.length - 1
              : (model.panels.indexOf(id) + (event.key === 'ArrowLeft' ? -1 : 1) + model.panels.length) %
                model.panels.length;
        const panel = model.panels[index];
        commit(activatePanel(layout, panel), panel);
      };
      tabs.append(tab);
    }
    bar.append(tabs);
    const options = button(
      '⋯',
      (event) => openContextMenu(event, model.id, event.currentTarget, model.active),
      'dock-chrome-button',
    );
    bindAttribute(options, 'aria-label', () => tr('docking.tab_menu'));
    options.setAttribute('aria-haspopup', 'menu');
    bar.append(options);
    if (model.active) {
      const close = button('×', () => removePanel(model.active), 'dock-chrome-button');
      close.dataset.dockClose = model.active;
      bindAttribute(close, 'aria-label', () => tr('docking.close', { panel: label(model.active) }));
      bar.append(close);
    } else
      content.append(
        button(
          () => tr('docking.add'),
          (event) => openContextMenu(event, model.id, event.currentTarget, null),
          'dock-empty secondary-button',
        ),
      );
    group.append(bar, content);
    group.ondragover = (event) => {
      if (!dragged) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      // Coalesce to the latest point: measuring + DOM work run once per frame.
      schedulePreview(group, event.clientX, event.clientY, dragged);
    };
    group.ondragleave = (event) => {
      if (group.contains(event.relatedTarget)) return;
      if (pendingPreview?.group === group) cancelPendingPreview();
      if (previewGroup === group) hideDropPreview();
    };
    group.ondrop = (event) => {
      if (!dragged) return;
      event.preventDefault();
      // The commit derives from this event, never from a queued rAF point.
      cancelPendingPreview();
      const id = dragged;
      const target = dropTarget(event, group, id);
      commit(movePanel(layout, { panel: id, targetGroupId: model.id, ...target }), id);
    };
    return group;
  }
  // A tab bar is always an insertion target, including its empty trailing space.
  // Index is measured AFTER removing the source, matching the pure layout model.
  function dropTarget({ clientX, clientY }, group, sourceId) {
    const bar = group.querySelector(':scope > .dock-bar');
    const barRect = bar.getBoundingClientRect();
    if (clientY >= barRect.top && clientY <= barRect.bottom) {
      const tabs = [...bar.querySelectorAll('[data-dock-tab]')];
      let raw = tabs.findIndex((tab) => {
        const rect = tab.getBoundingClientRect();
        return clientX < rect.left + rect.width / 2;
      });
      if (raw < 0) raw = tabs.length;
      const source = tabs.findIndex((tab) => tab.dataset.dockTab === sourceId);
      const index = raw - (source >= 0 && source < raw ? 1 : 0);
      const bounds = bar.querySelector('.dock-tabs').getBoundingClientRect();
      const edge =
        tabs[raw]?.getBoundingClientRect().left ?? tabs.at(-1)?.getBoundingClientRect().right ?? bounds.left;
      const tabX =
        Math.min(Math.max(edge, bounds.left + 2), bounds.right - 2) - group.getBoundingClientRect().left;
      return { zone: 'center', index, tabX };
    }
    const rect = group.getBoundingClientRect();
    const x = (clientX - rect.left) / rect.width;
    const y = (clientY - rect.top) / rect.height;
    const distance = Math.min(x, 1 - x, y, 1 - y);
    const zone =
      distance > 0.24
        ? 'center'
        : distance === x
          ? 'left'
          : distance === 1 - x
            ? 'right'
            : distance === y
              ? 'top'
              : 'bottom';
    return { zone };
  }
  function previewKeyOf(group, target) {
    const tabX = Number.isFinite(target.tabX) ? Math.round(target.tabX) : '';
    return `${group.dataset.dockGroup}|${target.zone}|${target.index ?? ''}|${tabX}`;
  }
  function hideDropPreview() {
    preview.hidden = tabInsertion.hidden = true;
    preview.remove();
    tabInsertion.remove();
    previewKey = null;
    previewGroup = null;
  }
  function showDropPreview(group, target) {
    const key = previewKeyOf(group, target);
    if (key === previewKey && previewGroup === group) {
      // Same target: the expected node is already placed with current text.
      const node = Number.isFinite(target.tabX) ? tabInsertion : preview;
      if (node.parentNode === group && node.isConnected && !node.hidden) return;
    }
    hideDropPreview();
    if (Number.isFinite(target.tabX)) {
      tabInsertion.style.left = `${target.tabX}px`;
      tabInsertion.hidden = false;
      group.append(tabInsertion);
    } else {
      preview.dataset.zone = target.zone;
      previewText.textContent = tr(zoneTitles[target.zone]);
      preview.hidden = false;
      group.append(preview);
    }
    previewKey = key;
    previewGroup = group;
  }
  function cancelPendingPreview() {
    if (previewRaf) cancelAnimationFrame(previewRaf);
    previewRaf = 0;
    pendingPreview = null;
  }
  function schedulePreview(group, clientX, clientY, sourceId) {
    pendingPreview = { group, clientX, clientY, sourceId };
    if (!previewRaf) previewRaf = requestAnimationFrame(runPendingPreview);
  }
  function runPendingPreview() {
    previewRaf = 0;
    const pending = pendingPreview;
    pendingPreview = null;
    if (!pending || dragged !== pending.sourceId) return;
    if (!pending.group.isConnected || !host.contains(pending.group)) return;
    showDropPreview(
      pending.group,
      dropTarget({ clientX: pending.clientX, clientY: pending.clientY }, pending.group, pending.sourceId),
    );
  }
  function groupAtPoint({ clientX, clientY }) {
    if (!active || document.querySelector('dialog:modal')) return null;
    const group = document.elementFromPoint(clientX, clientY)?.closest('[data-dock-group]');
    return group && host.contains(group) ? group : null;
  }
  function previewConversationDrop(point) {
    const group = groupAtPoint(point);
    if (!group || !onDropConversation) {
      clearDrag();
      return false;
    }
    // Pointer path stays synchronous (the caller needs an immediate boolean);
    // same-target DOM churn is still skipped inside showDropPreview.
    cancelPendingPreview();
    // classList.add re-serializes the attribute (and fires observers) even
    // when the token is already present, so guard it on repeats of one gesture.
    if (!host.classList.contains('is-dragging')) host.classList.add('is-dragging');
    showDropPreview(group, dropTarget(point, group));
    return true;
  }
  async function dropConversation({ sessionId, projectCwd, clientX, clientY }) {
    const point = { clientX, clientY };
    const group = groupAtPoint(point);
    if (!group || !onDropConversation || typeof sessionId !== 'string' || !sessionId) {
      clearDrag();
      return false;
    }
    const targetGroupId = group.dataset.dockGroup;
    clearDrag();
    const id = await onDropConversation({ sessionId, projectCwd });
    if (!active || !id || !panels[id] || !canOpenPanel(id)) {
      if (id && !canOpenPanel(id)) toast?.(() => tr('docking.conversation_limit'), true);
      return false;
    }
    // Resolve again after the callback: deduplication may return an existing tab.
    const liveGroup = [...host.querySelectorAll('[data-dock-group]')].find(
      (node) => node.dataset.dockGroup === targetGroupId,
    );
    if (!liveGroup) return false;
    commit(movePanel(layout, { panel: id, targetGroupId, ...dropTarget(point, liveGroup, id) }), id);
    return true;
  }
  function clearDrag() {
    dragged = null;
    cancelPendingPreview();
    hideDropPreview();
    host.classList.remove('is-dragging');
  }
  function startResize(event, node, model, grip) {
    if (event.button !== 0 || resizing) return;
    event.preventDefault();
    grip.focus({ preventScroll: true });
    const rect = node.getBoundingClientRect();
    const initial = parseFloat(node.style.getPropertyValue('--dock-first')) / 100;
    let ratio = initial;
    const stop = (commitChange) => {
      resizing = null;
      grip.onpointermove = grip.onpointerup = grip.onpointercancel = grip.onlostpointercapture = null;
      if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
      host.classList.remove('is-resizing');
      if (commitChange) {
        layout = resizeSplit(layout, model.id, ratio);
        persist();
      } else setSplitStyle(node, initial);
    };
    resizing = { cancel: () => stop(false) };
    host.classList.add('is-resizing');
    grip.setPointerCapture(event.pointerId);
    grip.onpointermove = (move) => {
      if (move.pointerId !== event.pointerId) return;
      const value =
        model.dir === 'row'
          ? (move.clientX - rect.left) / rect.width
          : (move.clientY - rect.top) / rect.height;
      ratio = Math.max(MIN_RATIO, Math.min(MAX_RATIO, value));
      setSplitStyle(node, ratio);
    };
    grip.onpointerup = () => stop(true);
    grip.onpointercancel = grip.onlostpointercapture = () => stop(false);
  }
  function commit(next, focusPanel) {
    clearDrag();
    closeMenu();
    resizing?.cancel();
    if (next !== layout) {
      layout = next;
      render();
      persist();
    }
    // Activate only for a user action, after chrome/scroll restoration. Background
    // title and stream updates never change the shared conversation context.
    if (focusPanel) {
      onActivatePanel?.(focusPanel);
      if (!dialog.open) focusTab(focusPanel);
    }
  }
  function openPanel(id, groupId) {
    if (!active || !isPanelId(id) || !panels[id]) return;
    if (!canOpenPanel(id)) {
      toast?.(() => tr('docking.conversation_limit'), true);
      return;
    }
    const group = groupsOf(layout).find((group) => group.panels.includes(id));
    const target = groupsOf(layout).find((group) => group.id === groupId);
    commit(
      target && target !== group
        ? movePanel(layout, { panel: id, targetGroupId: target.id })
        : group
          ? activatePanel(layout, id)
          : movePanel(layout, { panel: id, targetGroupId: groupsOf(layout)[0].id }),
      id,
    );
  }
  function registerPanel(id, node) {
    if (!isPanelId(id) || !(node instanceof Element)) return false;
    if (panels[id]) return panels[id] === node;
    if (Object.values(panels).includes(node)) return false;
    panels[id] = node;
    rememberHome(id, node);
    if (isConversationPanel(id)) resizeObserver.observe(node);
    refreshDialog();
    return true;
  }
  function refreshTitles() {
    for (const tab of host.querySelectorAll('[data-dock-tab]')) {
      tab.querySelector('.dock-tab-label').textContent = label(tab.dataset.dockTab);
      const glyph = tab.querySelector('.dock-tab-icon');
      if (isConversationPanel(tab.dataset.dockTab))
        glyph.style.color = projectColorOf?.(tab.dataset.dockTab) || '';
      tab.title = tr('docking.drag', { panel: label(tab.dataset.dockTab) });
      tab.classList.toggle(
        'is-focused',
        isConversationPanel(tab.dataset.dockTab) && !!isFocusedPanel?.(tab.dataset.dockTab),
      );
    }
    if (dialog.open) refreshDialog();
  }
  function applyLayout(value) {
    let next = validateLayout(value);
    if (!next) return false;
    for (const id of groupsOf(next).flatMap((group) => group.panels))
      if (!panels[id]) next = closePanel(next, id);
    commit(next);
    return true;
  }
  function removeOtherPanels(groupId, keepId) {
    const group = groupsOf(layout).find((group) => group.id === groupId);
    if (!active || !group?.panels.includes(keepId) || group.panels.length < 2) return;
    let next = activatePanel(layout, keepId);
    for (const id of group.panels) if (id !== keepId) next = closePanel(next, id);
    // If the focused conversation was parked while keeping a tool, retain a
    // visible conversation context, but return keyboard focus to the kept tab.
    const closedFocus = group.panels.some((id) => id !== keepId && isFocusedPanel?.(id));
    const fallback =
      !isConversationPanel(keepId) && closedFocus
        ? groupsOf(next)
            .map((group) => group.active)
            .find(isConversationPanel)
        : null;
    // One structural commit parks the siblings without destroying live panels.
    commit(next, fallback || keepId);
    if (fallback) focusTab(keepId);
  }
  function removePanel(id) {
    if (!active) return;
    const next = closePanel(layout, id);
    const remaining = groupsOf(next)
      .map((group) => group.active)
      .filter(Boolean);
    const fallback = remaining.find(isConversationPanel) || remaining[0];
    commit(next, fallback);
    if (!fallback) opener.focus({ preventScroll: true });
  }
  function updateViewport() {
    resizing?.cancel();
    clearDrag();
    closeMenu();
    const next = enabled && viewport.matches;
    if (next === active) return;
    rememberScroll();
    onBeforeModeChange?.(next);
    active = next;
    workspace.classList.toggle('is-docked', active);
    if (active) {
      for (const [id, home] of homes) home.hidden = panels[id].hidden;
      workspace.append(host);
      // updateViewport captured the classic scrollers before adding the new flex
      // sibling. Measuring again here would capture transient scroll anchoring.
      render(undefined, false);
    } else {
      for (const [id, home] of homes) {
        const panel = panels[id];
        onBeforeMove?.(id, panel);
        if (panel.matches('dialog:modal')) panel.close();
        home.marker.after(panel);
        panel.classList.remove('dock-panel');
        panel.hidden = home.hidden;
      }
      host.replaceChildren();
      host.remove();
      notify();
      restoreScroll();
      refreshDialog();
    }
  }
  const escape = (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key !== 'Escape' || (!dragged && !resizing)) return;
    event.preventDefault();
    event.stopPropagation();
    clearDrag();
    resizing?.cancel();
  };
  document.addEventListener('keydown', escape, true);
  viewport.addEventListener('change', updateViewport);
  // The composer can become narrow without a window resize.
  const resizeObserver = new ResizeObserver(() => {
    if (active && visiblePanels().some(isConversationPanel)) onResize?.();
  });
  for (const id of panelIds().filter(isConversationPanel)) resizeObserver.observe(panels[id]);
  onLanguageChange(() => {
    closeMenu();
    refreshDialog();
    refreshTitles();
  });
  refreshDialog();
  return {
    get active() {
      return active;
    },
    openPanel,
    registerPanel,
    refreshTitles,
    getLayout: () => layout,
    applyLayout,
    closePanel: removePanel,
    updateViewport,
    visiblePanels,
    previewConversationDrop,
    dropConversation,
    cancelConversationDrop: clearDrag,
  };
}
