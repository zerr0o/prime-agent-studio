import { t, bindAttribute, getLanguage } from './i18n.js';

const PAGE_SIZE = 5;
const pathKey = (value) =>
  String(value || '')
    .replaceAll('\\', '/')
    .replace(/\/$/, '')
    .toLowerCase();
const time = (value) => (typeof value === 'number' ? value : Date.parse(value)) || 0;

export const hasPendingQuestion = (run) =>
  run?.status === 'running' && run.interactions?.some((request) => request.status === 'pending');

// Disclosure and pagination are view preferences. They never change the selected
// conversation, its draft, or the lifetime of an agent.
export function createProjectNavigation({
  root,
  scroller,
  el,
  icon,
  activityDot,
  read,
  write,
  selectProject,
  selectSession,
  selectRun,
  openProjectMenu,
  openSessionMenu,
  addProject,
}) {
  const stored = read('project-disclosures', {});
  const expanded = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  const limits = new Map();
  let signature = '',
    current;
  const setExpanded = (cwd, value) => {
    expanded[pathKey(cwd)] = value;
    write('project-disclosures', expanded);
  };
  const text = (tag, className, key, params) => el(tag, className, () => t(key, params));
  function render(context = current) {
    if (!context) return;
    current = context;
    const { projects, projectCwd, sessionId, viewRunId, archived, query, readOnly, runs, unreadIds } =
      context;
    const needle = query.trim().toLocaleLowerCase(getLanguage());
    const activeRuns = runs.filter((run) => ['running', 'stopping'].includes(run.status));
    const nextSignature = JSON.stringify([
      projects,
      projectCwd,
      sessionId,
      viewRunId,
      archived,
      needle,
      readOnly,
      activeRuns.map((run) => [
        run.id,
        run.cwd,
        run.sessionId,
        run.prompt,
        run.startedAt,
        hasPendingQuestion(run),
      ]),
      unreadIds,
      expanded,
      [...limits],
      getLanguage(),
    ]);
    if (nextSignature === signature) return;
    signature = nextSignature;
    const scroll = scroller.scrollTop;
    const focused = root.contains(document.activeElement)
      ? document.activeElement.dataset.navigationKey
      : null;
    root.replaceChildren();
    const items = [...projects].sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
    let group = null,
      rendered = 0;
    for (const p of items) {
      const key = pathKey(p.cwd),
        name = p.name || p.cwd.split(/[\\/]/).pop();
      const projectRuns = activeRuns.filter((run) => pathKey(run.cwd) === key);
      // Server returns stable manual order (pinned first). Preserve it verbatim;
      // new activity/messages never reorder. Ephemeral runs (no id yet) join
      // the top of unpinned until persisted, then take a stable position.
      const stored = (p.sessions || []).map((s) => ({ ...s, cwd: s.cwd || p.cwd }));
      const sessions = stored;
      const ephemeral = [];
      for (const run of projectRuns) {
        if (!stored.some((s) => s.id && s.id === run.sessionId))
          ephemeral.push({
            id: run.sessionId,
            runId: run.id,
            cwd: p.cwd,
            title: run.prompt?.slice(0, 100) || t('ui.nouvelle_session'),
            updatedAt: run.startedAt,
          });
      }
      const ordered = [
        ...stored.filter((s) => s.pinned),
        ...ephemeral,
        ...stored.filter((s) => !s.pinned),
      ];
      const matchesProject = `${name} ${p.cwd}`.toLocaleLowerCase(getLanguage()).includes(needle);
      const visible = ordered.filter(
        (s) =>
          Boolean(s.archived) === archived &&
          (!needle ||
            matchesProject ||
            String(s.title || '')
              .toLocaleLowerCase(getLanguage())
              .includes(needle)),
      );
      if ((needle && !matchesProject && !visible.length) || (archived && !visible.length)) continue;
      const pinned = Boolean(p.pinned);
      if (group !== pinned) {
        root.append(text('h2', 'project-group-label', pinned ? 'navigation.pinned' : 'ui.projets'));
        group = pinned;
      }
      rendered++;
      const isOpen = Boolean(
        needle ||
        archived ||
        (expanded[key] ?? ((pinned && visible.length > 0) || key === pathKey(projectCwd))),
      );
      const entry = el('div', 'project-entry');
      entry.dataset.cwd = p.cwd;
      entry.dataset.pinned = String(pinned);
      const header = el('div', 'project-header');
      const children = el('div', 'project-conversations');
      children.id = `project-conversations-${items.indexOf(p)}`;
      children.hidden = !isOpen;
      const toggle = el('button', 'project-toggle');
      toggle.type = 'button';
      toggle.disabled = Boolean(needle || archived);
      toggle.dataset.navigationKey = `toggle:${key}`;
      toggle.setAttribute('aria-expanded', String(isOpen));
      toggle.setAttribute('aria-controls', children.id);
      bindAttribute(toggle, 'aria-label', () =>
        t(isOpen ? 'navigation.collapse' : 'navigation.expand', { name }),
      );
      toggle.append(icon('chevron'));
      toggle.onclick = () => {
        setExpanded(p.cwd, !isOpen);
        render();
      };
      const row = el('button', `project-row${key === pathKey(projectCwd) ? ' active' : ''}`);
      row.type = 'button';
      row.dataset.navigationKey = `project:${key}`;
      row.setAttribute('aria-pressed', String(key === pathKey(projectCwd)));
      bindAttribute(row, 'title', () => p.cwd);
      const status = projectRuns.some(hasPendingQuestion)
        ? 'question'
        : projectRuns.length
          ? 'running'
          : sessions.some((s) => unreadIds.includes(s.id))
            ? 'unread'
            : 'idle';
      row.dataset.activity = status;
      row.append(
        icon('folder'),
        el('span', 'project-label', () => name),
      );
      if (pinned) row.append(icon('pin', 'project-pin'));
      if (status !== 'idle') row.append(activityDot(status, true));
      const count = el('span', 'project-count', () => (p.exists === false ? '!' : String(visible.length)));
      if (p.exists === false) bindAttribute(count, 'title', () => t('ui.dossier_introuvable'));
      row.append(count);
      row.onclick = () => {
        // On phones, the project name is a larger disclosure target in the drawer.
        if (matchMedia('(max-width: 760px)').matches) return toggle.click();
        setExpanded(p.cwd, true);
        selectProject(p.cwd);
      };
      row.oncontextmenu = (event) => {
        event.preventDefault();
        openProjectMenu(p.cwd, row);
      };
      header.append(toggle, row);
      if (!readOnly && items.length > 1 && !needle && !archived) {
        const handle = el('button', 'project-drag-handle');
        handle.type = 'button';
        handle.dataset.navigationKey = `drag:${key}`;
        bindAttribute(handle, 'aria-label', () => t('projects.drag', { name }));
        bindAttribute(handle, 'title', () => t('projects.drag_hint'));
        handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown');
        handle.append(icon('grip'));
        header.append(handle);
      }
      const more = el('button', 'project-more');
      more.type = 'button';
      more.dataset.navigationKey = `menu:${key}`;
      more.setAttribute('aria-haspopup', 'menu');
      bindAttribute(more, 'aria-label', () => t('ui.options_du_projet', { value1: name }));
      more.append(icon('more'));
      more.onclick = () => openProjectMenu(p.cwd, more);
      header.append(more);
      entry.append(header, children);
      // Search and archives reveal every match. Outside those views, keep the
      // selected session present even if it is older than the first page.
      const limit = needle || archived ? visible.length : limits.get(key) || PAGE_SIZE;
      const shown = visible.slice(0, limit);
      const selected = visible.find((s) => (s.id ? s.id === sessionId : s.runId === viewRunId));
      if (selected && !shown.includes(selected)) shown.push(selected);
      if (isOpen) {
        for (const s of shown) {
          const active = s.id ? s.id === sessionId : s.runId === viewRunId;
          const item = el('div', `session-row${active ? ' active' : ''}`);
          item.dataset.sessionId = s.id || '';
          item.dataset.projectKey = key;
          item.dataset.pinned = String(Boolean(s.pinned));
          item.dataset.archived = String(Boolean(s.archived));
          const running = Boolean(s.runId || projectRuns.some((r) => r.sessionId === s.id));
          const waiting = projectRuns.some(
            (run) =>
              ((s.runId && run.id === s.runId) || (s.id && run.sessionId === s.id)) &&
              hasPendingQuestion(run),
          );
          const unread = unreadIds.includes(s.id);
          const status = waiting ? 'question' : running ? 'running' : unread ? 'unread' : 'idle';
          item.dataset.activity = status;
          const button = el('button', 'session-select');
          button.type = 'button';
          button.dataset.navigationKey = `session:${s.id || s.runId}`;
          button.setAttribute('aria-current', active ? 'page' : 'false');
          bindAttribute(button, 'title', () => s.title || t('ui.sans_titre'));
          button.append(el('span', 'session-title', () => s.title || t('ui.nouvelle_session')));
          if (status !== 'idle') button.append(activityDot(status));
          else if (s.pinned) button.append(icon('pin', 'session-pin'));
          button.onclick = () =>
            s.runId && !s.id
              ? selectRun(projectRuns.find((r) => r.id === s.runId))
              : selectSession(s.id, s.cwd);
          item.append(button);
          if (!readOnly && s.id && !needle && visible.length > 1) {
            const handle = el('button', 'session-drag-handle');
            handle.type = 'button';
            handle.dataset.navigationKey = `session-drag:${s.id}`;
            bindAttribute(handle, 'aria-label', () => t('projects.drag', { name: s.title || t('ui.nouvelle_session') }));
            bindAttribute(handle, 'title', () => t('sessions.drag_hint'));
            handle.setAttribute('aria-keyshortcuts', 'ArrowUp ArrowDown');
            handle.append(icon('grip'));
            item.append(handle);
          }
          if (!readOnly && s.id) {
            const menu = el('button', 'icon-button session-more');
            menu.type = 'button';
            menu.dataset.navigationKey = `session-menu:${s.id}`;
            menu.setAttribute('aria-haspopup', 'menu');
            bindAttribute(menu, 'aria-label', () =>
              t('common.options', { value1: s.title || t('ui.nouvelle_session') }),
            );
            menu.append(icon('more'));
            menu.onclick = () => openSessionMenu(s.id, menu);
            item.oncontextmenu = (event) => {
              event.preventDefault();
              openSessionMenu(s.id, menu);
            };
            item.append(menu);
          }
          children.append(item);
        }
        if (!visible.length) children.append(text('div', 'project-conversations-empty', 'navigation.empty'));
        if (visible.length > shown.length) {
          const more = text('button', 'project-show-more', 'navigation.show_more');
          more.type = 'button';
          more.dataset.navigationKey = `more:${key}`;
          bindAttribute(more, 'aria-label', () => t('navigation.show_more_project', { name }));
          more.onclick = () => {
            limits.set(key, limit + PAGE_SIZE);
            render();
          };
          children.append(more);
        }
        if (!needle && !archived && limit > PAGE_SIZE) {
          const less = text('button', 'project-show-more', 'navigation.show_less');
          less.type = 'button';
          less.dataset.navigationKey = `less:${key}`;
          less.onclick = () => {
            limits.delete(key);
            render();
          };
          children.append(less);
        }
      }
      root.append(entry);
    }
    if (!rendered) {
      const empty = text(
        'div',
        'sidebar-empty',
        needle
          ? 'ui.aucune_session_ne_correspond_a_votre_recherche'
          : archived
            ? 'ui.aucune_session_archivee'
            : 'ui.vos_projets_au_meme_endroit',
      );
      if (!projects.length && !readOnly) {
        const add = text('button', '', 'ui.ajouter_un_dossier');
        add.onclick = addProject;
        empty.append(add);
      }
      root.append(empty);
    }
    scroller.scrollTop = scroll;
    if (focused)
      [...root.querySelectorAll('[data-navigation-key]')]
        .find((node) => node.dataset.navigationKey === focused)
        ?.focus({ preventScroll: true });
  }
  return {
    render,
    invalidate() {
      signature = '';
    },
    reveal(cwd) {
      setExpanded(cwd, true);
    },
  };
}
