import { t as tr, bindText, bindAttribute } from './i18n.js';

// Two-step conversation chooser: project first, then sessions. One native
// modal built once by this module; local state only, no global renderer.
// Resolves { projectCwd, sessionId } (existing), { projectCwd, sessionId: null }
// (new empty conversation) or { projectCwd, viewId } (parked session-less
// view), and null on close/Escape. No server requests, no runs.
const PAGE = 20;

const normalize = (value) =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
const sameCwd = (a, b) =>
  String(a || '')
    .replaceAll('\\', '/')
    .replace(/\/$/, '')
    .toLowerCase() ===
  String(b || '')
    .replaceAll('\\', '/')
    .replace(/\/$/, '')
    .toLowerCase();

export function createConversationPicker({ getProjects, getViews, getCurrentProject, isReadOnly }) {
  const dialog = document.createElement('dialog');
  dialog.className = 'modal conv-picker';
  dialog.id = 'conversation-picker';
  dialog.setAttribute('aria-labelledby', 'conversation-picker-title');

  const heading = document.createElement('div');
  heading.className = 'modal-heading conv-picker-heading';
  const back = document.createElement('button');
  back.className = 'icon-button';
  back.type = 'button';
  back.hidden = true;
  bindAttribute(back, 'aria-label', () => tr('conversation_picker.back'));
  back.textContent = '‹';
  const title = document.createElement('h2');
  title.id = 'conversation-picker-title';
  const close = document.createElement('button');
  close.className = 'icon-button';
  close.type = 'button';
  bindAttribute(close, 'aria-label', () => tr('conversation_picker.close'));
  bindText(close, () => '×');
  close.onclick = () => dialog.close();
  heading.append(back, title, close);

  const search = document.createElement('input');
  search.className = 'conv-picker-search';
  search.type = 'search';
  search.autocomplete = 'off';
  search.spellcheck = false;

  const list = document.createElement('div');
  list.className = 'conv-picker-list';
  list.setAttribute('role', 'group');
  bindAttribute(list, 'aria-label', () => tr('conversation_picker.title'));

  const empty = document.createElement('p');
  empty.className = 'conv-picker-empty';
  empty.hidden = true;

  dialog.append(heading, search, list, empty);
  document.body.append(dialog);

  let pending = null;
  let expectClose = 0;
  let step = 'project';
  let projectCwd = null;
  let query = '';
  let shown = PAGE;

  const projects = () => getProjects?.() || [];
  const findProject = (cwd) => projects().find((p) => sameCwd(p.cwd, cwd));
  const projectName = (p) =>
    p?.name ||
    String(p?.cwd || '')
      .split(/[\\/]/)
      .pop() ||
    '';

  function settle(value) {
    if (!pending) return;
    const { resolve, opener } = pending;
    pending = null;
    resolve(value);
    if (dialog.open) {
      // A queued close must never cancel a rapid reopen: expect exactly it.
      expectClose++;
      dialog.close();
    }
    try {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    } catch {}
  }
  dialog.addEventListener('close', () => {
    if (expectClose > 0) {
      expectClose--;
      return;
    }
    if (!pending) return;
    const { resolve, opener } = pending;
    pending = null;
    resolve(null);
    try {
      if (opener?.isConnected) opener.focus({ preventScroll: true });
    } catch {}
  });

  function itemButton(label, note) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'conv-pick-row';
    const name = document.createElement('span');
    name.className = 'conv-pick-name';
    name.textContent = label;
    item.append(name);
    if (note) {
      const meta = document.createElement('span');
      meta.className = 'conv-pick-meta';
      meta.textContent = note;
      item.append(meta);
    }
    return item;
  }

  // Stable pinned-first partition (sidebar order); input is manual order.
  const pinnedFirst = (rows) => [...rows.filter((row) => row.pinned), ...rows.filter((row) => !row.pinned)];
  function moreButton(remaining) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'conv-pick-more';
    bindText(more, () => tr('conversation_picker.show_more', { count: remaining }));
    more.onclick = () => {
      // The old more button sits where the new rows begin; focus there after render.
      const firstNew = [...list.querySelectorAll('button:not(:disabled)')].indexOf(more);
      shown += PAGE;
      renderList();
      const next = [...list.querySelectorAll('button:not(:disabled)')];
      (next[firstNew] || next[next.length - 1] || search).focus({ preventScroll: true });
    };
    return more;
  }

  function renderList() {
    list.replaceChildren();
    empty.hidden = true;
    const needle = normalize(query.trim());
    if (step === 'project') {
      const current = getCurrentProject?.();
      const matches = pinnedFirst(
        projects().filter((p) => !needle || normalize(`${projectName(p)} ${p.cwd}`).includes(needle)),
      );
      for (const p of matches.slice(0, shown)) {
        const count = (p.sessions || []).filter((s) => !s.archived).length;
        const row = itemButton(projectName(p), tr('conversation_picker.count_sessions', { count }));
        if (current && sameCwd(p.cwd, current)) {
          row.classList.add('is-current');
          row.setAttribute('aria-current', 'true');
        }
        row.onclick = () => {
          projectCwd = p.cwd;
          step = 'session';
          query = '';
          search.value = '';
          shown = PAGE;
          renderListAndChrome();
          search.focus();
        };
        list.append(row);
      }
      if (!matches.length) {
        empty.textContent = tr(
          needle ? 'conversation_picker.no_match' : 'conversation_picker.empty_projects',
        );
        empty.hidden = false;
      } else if (matches.length > shown) list.append(moreButton(matches.length - shown));
      return;
    }
    const project = findProject(projectCwd);
    const views = (getViews?.() || []).filter((v) => !v.sessionId && sameCwd(v.projectCwd, projectCwd));
    const sessions = pinnedFirst((project?.sessions || []).filter((s) => !s.archived)).filter(
      (s) => !needle || normalize(s.title).includes(needle),
    );
    const fresh = itemButton('', '');
    fresh.querySelector('.conv-pick-name').textContent = tr('conversation_picker.new_conversation');
    if (isReadOnly?.()) {
      fresh.disabled = true;
      fresh.title = tr('conversation_picker.readonly_note');
    } else {
      fresh.onclick = () => settle({ projectCwd, sessionId: null });
    }
    fresh.classList.add('is-new');
    list.append(fresh);
    const seenViews = views.filter((v) => !needle || normalize(v.title).includes(needle));
    // Page views + sessions as one combined list: slicing each separately could
    // render up to 2×PAGE while promising PAGE.
    const combined = [
      ...seenViews.map((v) => ({ kind: 'view', entry: v })),
      ...sessions.map((s) => ({ kind: 'session', entry: s })),
    ];
    if (seenViews.length) {
      const label = document.createElement('p');
      label.className = 'conv-pick-group';
      bindText(label, () => tr('conversation_picker.open_views'));
      // Group labels are static per render; the bound text updates on language change.
      list.append(label);
    }
    for (const { kind, entry } of combined.slice(0, shown)) {
      if (kind === 'view') {
        const row = itemButton(entry.title || entry.id, tr('conversation_picker.parked'));
        row.onclick = () => settle({ projectCwd, viewId: entry.id });
        list.append(row);
      } else {
        const row = itemButton(entry.title || tr('conversation_picker.untitled'));
        row.onclick = () => settle({ projectCwd, sessionId: entry.id });
        list.append(row);
      }
    }
    const total = combined.length;
    if (!total && needle) {
      empty.textContent = tr('conversation_picker.no_match');
      empty.hidden = false;
    } else if (total > shown) list.append(moreButton(total - shown));
  }

  function renderChrome() {
    const project = step === 'session' ? findProject(projectCwd) : null;
    back.hidden = step !== 'session';
    bindText(title, () =>
      tr(step === 'session' ? 'conversation_picker.title_sessions' : 'conversation_picker.title', {
        name: project ? projectName(project) : '',
      }),
    );
    bindAttribute(search, 'placeholder', () =>
      tr(step === 'session' ? 'conversation_picker.search_sessions' : 'conversation_picker.search_projects'),
    );
    bindAttribute(search, 'aria-label', () =>
      tr(step === 'session' ? 'conversation_picker.search_sessions' : 'conversation_picker.search_projects'),
    );
  }

  function renderListAndChrome() {
    renderChrome();
    renderList();
  }

  back.onclick = () => {
    step = 'project';
    projectCwd = null;
    query = '';
    search.value = '';
    shown = PAGE;
    renderListAndChrome();
    search.focus();
  };
  search.oninput = () => {
    query = search.value;
    shown = PAGE;
    renderList();
  };
  search.onkeydown = (event) => {
    if (event.key !== 'ArrowDown') return;
    const first = list.querySelector('button:not(:disabled)');
    if (first) {
      event.preventDefault();
      first.focus();
    }
  };
  list.onkeydown = (event) => {
    if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    const items = [...list.querySelectorAll('button:not(:disabled)')];
    const current = items.indexOf(document.activeElement);
    event.preventDefault();
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : (current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
    items[next]?.focus({ preventScroll: true });
  };

  function open() {
    if (pending) return pending.promise;
    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    pending = { promise, resolve, opener: document.activeElement };
    step = 'project';
    projectCwd = null;
    query = '';
    search.value = '';
    shown = PAGE;
    renderListAndChrome();
    if (!dialog.open) dialog.showModal();
    search.focus();
    return promise;
  }

  return { open };
}
