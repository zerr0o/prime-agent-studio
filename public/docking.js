import { t as tr, bindText, bindAttribute, onLanguageChange } from './i18n.js';
import {
  PANEL_IDS,
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

const titles = {
  conversation: 'docking.conversation',
  roadmap: 'docking.roadmap',
  inspector: 'docking.inspector',
};
const zones = ['center', 'left', 'right', 'top', 'bottom'];
const zoneTitles = {
  center: 'docking.center',
  left: 'docking.left',
  right: 'docking.right',
  top: 'docking.top',
  bottom: 'docking.bottom',
};
const label = (id) => tr(titles[id]);
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

/** Owns layout chrome only. The three live Studio panels are moved, never rebuilt. */
export function createDocking({ panels, read, write, onChange, onResize, toast }) {
  const stored = read('docking.layout', null);
  let layout = validateLayout(stored) || createDefaultLayout();
  let enabled = !!validateLayout(stored) && stored.enabled === true;
  let active = false;
  let dragged = null;
  let resizing = null;
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
  const homes = new Map();
  const scroll = new Map();
  for (const id of PANEL_IDS) {
    const node = panels[id];
    const marker = document.createComment(`dock-home:${id}`);
    node.before(marker);
    homes.set(id, { marker, hidden: node.hidden });
  }
  if (stored !== null && !validateLayout(stored)) toast?.(() => tr('docking.recovered'), true);

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
  for (const id of PANEL_IDS) {
    const item = button(
      () => label(id),
      () => openPanel(id),
      'secondary-button',
    );
    item.dataset.dockOpen = id;
    bindAttribute(item, 'aria-label', () => tr('docking.show', { panel: label(id) }));
    openers.append(item);
  }
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
  dialog.append(heading, mode, help, fields);
  document.body.append(dialog);
  opener.onclick = () => showSettings();
  dialog.addEventListener('close', () => {
    opener.setAttribute('aria-expanded', 'false');
    (viewport.matches ? opener : document.getElementById('toggle-details')).focus({ preventScroll: true });
  });

  function showSettings(groupId) {
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
    panelChoice.replaceChildren(...PANEL_IDS.map((id) => new Option(label(id), id)));
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
    for (const panel of Object.values(panels)) {
      if (!panel.getClientRects().length) continue;
      for (const node of panel.querySelectorAll(
        '.conversation-scroll, .inspector-content, .rm-content, textarea',
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
    node.style.setProperty('--dock-first', `${ratio}fr`);
    node.style.setProperty('--dock-second', `${1 - ratio}fr`);
    node
      .querySelector(':scope > .dock-splitter')
      .setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  }
  function focusTab(panel) {
    host.querySelector(`[data-dock-tab="${panel}"]`)?.focus({ preventScroll: true });
  }
  function render(focusPanel, captureScroll = true) {
    if (!active) return;
    if (captureScroll) rememberScroll();
    const focused = document.activeElement;
    // Connected parking keeps panel ownership explicit while only chrome is replaced.
    const parking = el('div');
    parking.hidden = true;
    workspace.append(parking);
    for (const node of Object.values(panels)) parking.append(node);
    host.replaceChildren(build(layout.root));
    for (const id of PANEL_IDS) {
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
        ? model.panels.includes('conversation')
          ? 260
          : 220
        : model.panels.includes('conversation')
          ? 240
          : 200;
    const first = minimumSize(model.first, direction),
      second = minimumSize(model.second, direction);
    return model.dir === direction ? first + second + 6 : Math.max(first, second);
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
        const current = parseFloat(node.style.getPropertyValue('--dock-first'));
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
    const tabs = el('div', 'dock-tabs');
    tabs.setAttribute('role', 'tablist');
    bindAttribute(tabs, 'aria-label', () => tr('docking.panels'));
    const content = el('div', 'dock-content');
    for (const id of model.panels) {
      const tab = button(
        () => label(id),
        () => commit(activatePanel(layout, id), id),
        'dock-tab',
      );
      tab.dataset.dockTab = id;
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
    const options = button('⋯', () => showSettings(model.id), 'dock-chrome-button');
    bindAttribute(options, 'aria-label', () => tr('docking.title'));
    options.setAttribute('aria-haspopup', 'dialog');
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
          () => showSettings(model.id),
          'dock-empty secondary-button',
        ),
      );
    group.append(bar, content);
    group.ondragover = (event) => {
      if (!dragged) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      const { zone } = dropTarget(event, group);
      preview.dataset.zone = zone;
      previewText.textContent = tr(zoneTitles[zone]);
      preview.hidden = false;
      group.append(preview);
    };
    group.ondragleave = (event) => {
      if (!group.contains(event.relatedTarget)) preview.hidden = true;
    };
    group.ondrop = (event) => {
      if (!dragged) return;
      event.preventDefault();
      const id = dragged;
      const target = dropTarget(event, group);
      clearDrag();
      commit(movePanel(layout, { panel: id, targetGroupId: model.id, ...target }), id);
    };
    return group;
  }
  function dropTarget(event, group) {
    const tab = event.target.closest('[data-dock-tab]');
    if (tab && group.contains(tab)) {
      const groupModel = groupsOf(layout).find((row) => row.id === group.dataset.dockGroup);
      const rect = tab.getBoundingClientRect();
      let index =
        groupModel.panels.indexOf(tab.dataset.dockTab) + (event.clientX > rect.left + rect.width / 2 ? 1 : 0);
      const source = groupModel.panels.indexOf(dragged);
      if (source >= 0 && source < index) index--;
      if (source === index) return { zone: 'center' };
      return { zone: 'center', index };
    }
    const rect = group.getBoundingClientRect();
    const x = (event.clientX - rect.left) / rect.width;
    const y = (event.clientY - rect.top) / rect.height;
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
  function clearDrag() {
    dragged = null;
    preview.hidden = true;
    preview.remove();
    host.classList.remove('is-dragging');
  }
  function startResize(event, node, model, grip) {
    if (event.button !== 0 || resizing) return;
    event.preventDefault();
    grip.focus({ preventScroll: true });
    const rect = node.getBoundingClientRect();
    const initial = parseFloat(node.style.getPropertyValue('--dock-first'));
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
    resizing?.cancel();
    if (next !== layout) {
      layout = next;
      render(focusPanel);
      persist();
    } else if (focusPanel) focusTab(focusPanel);
  }
  function openPanel(id) {
    if (!active || !PANEL_IDS.includes(id)) return;
    const group = groupsOf(layout).find((group) => group.panels.includes(id));
    commit(
      group
        ? activatePanel(layout, id)
        : movePanel(layout, { panel: id, targetGroupId: groupsOf(layout)[0].id }),
      dialog.open ? null : id,
    );
  }
  function removePanel(id) {
    if (!active) return;
    const next = closePanel(layout, id);
    const fallback = groupsOf(next).find((group) => group.active)?.active;
    commit(next, fallback);
    if (!fallback) opener.focus({ preventScroll: true });
  }
  function updateViewport() {
    resizing?.cancel();
    clearDrag();
    const next = enabled && viewport.matches;
    if (next === active) return;
    rememberScroll();
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
    if (active && visiblePanels().includes('conversation')) onResize?.();
  });
  resizeObserver.observe(panels.conversation);
  onLanguageChange(refreshDialog);
  refreshDialog();
  return {
    get active() {
      return active;
    },
    openPanel,
    closePanel: removePanel,
    updateViewport,
    visiblePanels,
  };
}
