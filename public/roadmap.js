import { rt } from './roadmap-i18n.js';
import { onLanguageChange } from './i18n.js';

const node = (tag, cls, text) => {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (text != null) el.textContent = text;
  return el;
};
const button = (label, fn, cls = '') => {
  const el = node('button', cls, label);
  el.type = 'button';
  el.onclick = fn;
  return el;
};
const query = (cwd) => new URLSearchParams({ cwd });
const failureMessage = (error) =>
  /^(Failed to fetch|Load failed|NetworkError when attempting to fetch resource\.?)$/i.test(
    error?.message || '',
  )
    ? rt('offline')
    : error.message;

/** A document view only: polling never starts or resumes an agent. */
export function createRoadmap({
  api,
  getContext,
  onOpenSession,
  onWork,
  onKnowledge,
  toast,
  onSummary = () => {},
}) {
  const css = node('link');
  css.rel = 'stylesheet';
  css.href = '/public/roadmap.css';
  document.head.append(css);
  const panel = node('aside', 'roadmap-panel');
  panel.id = 'roadmap-panel';
  panel.hidden = true;
  panel.setAttribute('aria-labelledby', 'roadmap-title');
  const header = node('header', 'rm-header'),
    heading = node('div');
  heading.append(node('h2', '', rt('title')));
  heading.firstChild.id = 'roadmap-title';
  const projectName = node('p', 'rm-project-name');
  heading.append(projectName);
  const close = button('×', () => hide(), 'rm-close');
  close.setAttribute('aria-label', rt('close'));
  const enlarge = button('', () => setEnlarged(!enlarged), 'rm-expand'),
    headerActions = node('div', 'rm-header-actions');
  headerActions.append(enlarge, close);
  header.append(heading, headerActions);
  const progress = node('div', 'rm-overall'),
    tabs = node('nav', 'rm-tabs');
  tabs.setAttribute('aria-label', rt('title'));
  const status = node('div', 'rm-status');
  status.setAttribute('role', 'status');
  const content = node('div', 'rm-content'),
    footer = node('footer', 'rm-footer');
  panel.append(header, progress, tabs, status, content, footer);
  document.body.append(panel);
  const editor = node('dialog', 'rm-editor');
  document.body.append(editor);
  let opened = false,
    cwd = '',
    doc = null,
    tab = 'project',
    generation = 0,
    pending = false,
    refreshPending = false,
    enlarged = false;
  let requestSequence = 0,
    lastSummaryRefresh = 0,
    appliedSequence = 0,
    activityEpoch = '',
    activityRevision = -1;
  let opener,
    error = '',
    drag = null,
    editorState = null,
    contextSession = '',
    contextAccess = '',
    workRequest = null;
  let showRemainingOnly = false;
  const expanded = new Set(),
    selected = new Set(),
    foldedMilestones = new Set(),
    foldedSteps = new Set(),
    foldedGroups = new Set(),
    visibleDescriptions = new Set(),
    expandedActivities = new Set();
  const canEdit = () => !getContext().readOnly && getContext().online !== false && !pending;
  const activityFor = (kind, id, stepId) =>
    (doc?.activity || []).filter((entry) =>
      entry.targets?.some(
        (target) =>
          target.kind === kind &&
          (kind === 'plan'
            ? target.planId === id && (stepId ? target.stepId === stepId : true)
            : kind === 'milestone'
              ? target.milestoneId === id
              : target.number === id),
      ),
    );
  function accept(next, sequence) {
    if (next.cwd !== cwd || (doc && next.revision < doc.revision)) return;
    if (sequence < appliedSequence && next.revision === doc?.revision) return;
    if (next.instanceId === activityEpoch && next.activityRevision < activityRevision)
      next = { ...next, activity: doc?.activity || [] };
    activityEpoch = next.instanceId;
    activityRevision = next.activityRevision ?? 0;
    appliedSequence = sequence;
    const changed = JSON.stringify(next) !== JSON.stringify(doc);
    doc = next;
    onSummary(doc);
    const backlogNumbers = new Set([...next.backlog.items, ...next.backlog.notes].map((item) => item.number));
    for (const number of selected) if (!backlogNumbers.has(number)) selected.delete(number);
    if (showRemainingOnly) {
      const hiddenDone = new Set(next.backlog.items.filter((item) => item.done).map((item) => item.number));
      for (const number of [...selected]) if (hiddenDone.has(number)) selected.delete(number);
    }
    if (changed && !pending) render();
  }
  async function refresh() {
    if (!cwd || getContext().online === false || refreshPending || pending || document.hidden) return;
    if (!opened && Date.now() - lastSummaryRefresh < 10000) return;
    lastSummaryRefresh = Date.now();
    const version = generation,
      sequence = ++requestSequence;
    refreshPending = true;
    try {
      const next = await api(`/api/roadmap?${query(cwd)}`);
      if (version !== generation) return;
      error = '';
      accept(next, sequence);
      renderStatus();
      return true;
    } catch (e) {
      if (version === generation) {
        error = failureMessage(e);
        onSummary(null);
        renderStatus();
      }
    } finally {
      refreshPending = false;
    }
  }
  async function mutate(action, params = {}, revision = doc?.revision) {
    if (!canEdit()) return;
    const version = generation,
      sequence = ++requestSequence,
      targetCwd = cwd;
    pending = true;
    try {
      const next = await api('/api/roadmap', {
        method: 'POST',
        body: { cwd: targetCwd, action, expectedRevision: revision, ...params },
      });
      if (version === generation) {
        error = '';
        accept(next, sequence);
      }
      return next;
    } catch (e) {
      if (version === generation) {
        error = e.status === 409 ? rt('conflict') : failureMessage(e);
        renderStatus();
      }
      throw e;
    } finally {
      pending = false;
      if (version === generation) render();
    }
  }
  function act(action, params) {
    return mutate(action, params).catch(() => {});
  }
  function renderStatus() {
    status.replaceChildren();
    const text =
      error ||
      (doc?.linkWarnings?.length ? rt('linkWarning') : '') ||
      (getContext().online === false ? rt('offline') : getContext().readOnly ? rt('readonly') : '');
    status.hidden = !text;
    status.append(node('span', '', text));
    if (error) status.append(button(rt('retry'), () => refresh()));
    if (doc?.linkWarnings?.length && canEdit())
      status.append(
        button(rt('repairLinks'), async () => {
          const version = generation,
            sequence = ++requestSequence;
          try {
            const next = await api('/api/roadmap/retry-links', { method: 'POST', body: { cwd } });
            if (version === generation) {
              error = '';
              accept(next, sequence);
              renderStatus();
            }
          } catch (e) {
            if (version === generation) {
              error = failureMessage(e);
              renderStatus();
            }
          }
        }),
      );
  }
  function counts(value, overall = false) {
    const p = value || { done: 0, total: 0, percent: 0 },
      box = node('div', overall ? 'rm-counts rm-counts-overall' : 'rm-counts');
    const caption = node('span', '', p.total ? `${p.done}/${p.total} ${rt('progress')}` : rt('noSteps'));
    if (overall) {
      const row = node('div', 'rm-progress-label');
      row.append(caption, node('strong', '', `${p.percent || 0}%`));
      box.append(row);
      const track = node('progress');
      track.max = p.total || 1;
      track.value = p.done;
      track.setAttribute('aria-label', caption.textContent);
      box.append(track);
    } else box.append(caption);
    return box;
  }
  function inlineCount(value) {
    const { done = 0, total = 0 } = value || {},
      count = node('span', 'rm-inline-count', `${done}/${total}`),
      label = total ? `${done}/${total} ${rt('progress')}` : rt('noSteps');
    count.setAttribute('aria-label', label);
    count.title = label;
    return count;
  }
  // Parent checkboxes summarize descendants; counting them again would inflate progress.
  function leafProgress(steps) {
    return steps.reduce(
      (value, step) => {
        const child = step.children?.length
          ? leafProgress(step.children)
          : { done: step.done ? 1 : 0, total: 1 };
        value.done += child.done;
        value.total += child.total;
        return value;
      },
      { done: 0, total: 0 },
    );
  }
  function plansProgress(plans) {
    return plans
      .filter((plan) => plan.status !== 'abandoned' && !plan.archived)
      .reduce(
        (value, plan) => ({
          done: value.done + plan.progress.done,
          total: value.total + plan.progress.total,
        }),
        { done: 0, total: 0 },
      );
  }
  function planPercent(value) {
    const { percent = 0, total = 0 } = value || {};
    const el = node('span', 'rm-plan-percent', total ? `${percent}%` : '');
    if (total) {
      el.setAttribute('aria-label', `${percent}%`);
      el.title = `${value.done}/${value.total} ${rt('progress')} · ${percent}%`;
    } else el.hidden = true;
    return el;
  }
  function hasRemaining(step) {
    if (!step.done) return true;
    return (step.children || []).some(hasRemaining);
  }
  function remainingToggle(key) {
    const btn = button(
      rt('remainingOnly'),
      () => {
        showRemainingOnly = !showRemainingOnly;
        if (showRemainingOnly && doc) {
          const hiddenDone = new Set(
            doc.backlog.items.filter((item) => item.done).map((item) => item.number),
          );
          for (const number of [...selected]) if (hiddenDone.has(number)) selected.delete(number);
        }
        render();
      },
      'rm-text-button rm-filter-toggle',
    );
    btn.setAttribute('aria-pressed', String(showRemainingOnly));
    btn.dataset.rmFocus = `remaining:${key}`;
    return btn;
  }
  function description(key, text) {
    const box = node('div', 'rm-description-disclosure'),
      copy = node('p', 'rm-description', text),
      toggle = button(
        '',
        () => {
          visibleDescriptions.has(key) ? visibleDescriptions.delete(key) : visibleDescriptions.add(key);
          sync();
        },
        'rm-description-toggle',
      );
    box.dataset.descriptionKey = key;
    toggle.dataset.rmFocus = `description:${key}`;
    copy.id = `rm-description-${key}`;
    toggle.setAttribute('aria-controls', copy.id);
    function sync() {
      const visible = visibleDescriptions.has(key);
      copy.hidden = !visible;
      toggle.textContent = rt(visible ? 'hideDescription' : 'showDescription');
      toggle.setAttribute('aria-expanded', String(visible));
    }
    sync();
    box.append(toggle, copy);
    return box;
  }
  function groupHead(key, title, value) {
    const head = node('div', 'rm-section-head'),
      heading = node('h3'),
      toggle = button(
        title,
        () => {
          foldedGroups.has(key) ? foldedGroups.delete(key) : foldedGroups.add(key);
          render();
        },
        'rm-group-toggle',
      );
    toggle.setAttribute('aria-label', title);
    toggle.dataset.rmFocus = `group:${key}`;
    toggle.setAttribute('aria-expanded', String(!foldedGroups.has(key)));
    toggle.setAttribute('aria-controls', `rm-group-${key}`);
    heading.append(toggle);
    head.append(
      heading,
      typeof value === 'number' ? node('span', 'rm-inline-count', String(value)) : inlineCount(value),
    );
    return head;
  }
  function menu(actions, label = rt('actions')) {
    const details = node('details', 'rm-menu'),
      summary = node('summary', '', '···');
    summary.setAttribute('aria-label', label);
    const list = node('div', 'rm-menu-list');
    for (const [text, callback, disabled] of actions) {
      const b = button(text, () => {
        details.open = false;
        callback();
      });
      b.disabled = !!disabled;
      list.append(b);
    }
    details.append(summary, list);
    details.addEventListener('toggle', () => {
      if (details.open)
        for (const other of panel.querySelectorAll('.rm-menu[open]'))
          if (other !== details) other.open = false;
    });
    details.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        details.open = false;
        summary.focus();
      }
    });
    return details;
  }
  function bindDrag(row, kind, id, planId) {
    row.dataset.dragKind = kind;
    row.dataset.dragId = String(id);
    row.dataset.dragPlan = planId || '';
    const handle = button('⠿', () => {}, 'rm-drag');
    handle.setAttribute('aria-label', rt('drag'));
    handle.title = rt('drag');
    handle.draggable = canEdit();
    handle.disabled = !canEdit();
    handle.ondragstart = (event) => {
      drag = { kind, id, planId };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', `roadmap:${kind}:${id}`);
      row.classList.add('rm-dragging');
    };
    handle.ondragend = () => {
      drag = null;
      panel
        .querySelectorAll('.rm-drop,.rm-dragging')
        .forEach((el) => el.classList.remove('rm-drop', 'rm-dragging'));
    };
    let touchDrag = null;
    handle.onpointerdown = (event) => {
      if (event.pointerType === 'mouse' || !canEdit()) return;
      touchDrag = { x: event.clientX, y: event.clientY, target: null, active: false };
      handle.setPointerCapture(event.pointerId);
    };
    handle.onpointermove = (event) => {
      if (!touchDrag) return;
      if (!touchDrag.active && Math.hypot(event.clientX - touchDrag.x, event.clientY - touchDrag.y) < 7)
        return;
      touchDrag.active = true;
      event.preventDefault();
      panel.querySelectorAll('.rm-drop').forEach((el) => el.classList.remove('rm-drop'));
      const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('[data-drag-kind]');
      touchDrag.target =
        target &&
        target !== row &&
        target.dataset.dragKind === kind &&
        target.dataset.dragPlan === (planId || '')
          ? target
          : null;
      touchDrag.target?.classList.add('rm-drop');
      const bounds = content.getBoundingClientRect();
      if (event.clientY < bounds.top + 45) content.scrollTop -= 12;
      else if (event.clientY > bounds.bottom - 45) content.scrollTop += 12;
    };
    handle.onpointerup = (event) => {
      const target = touchDrag?.active && touchDrag.target;
      touchDrag = null;
      panel.querySelectorAll('.rm-drop').forEach((el) => el.classList.remove('rm-drop'));
      if (!target) return;
      const targetId = target.dataset.dragId;
      const position =
        event.clientY > target.getBoundingClientRect().top + target.getBoundingClientRect().height / 2
          ? 'after'
          : 'before';
      if (kind === 'step') void act('step.move', { planId, stepId: id, targetId, position });
      else if (kind === 'milestone') void act('milestone.move', { milestoneId: id, targetId, position });
      else void act('backlog.move', { number: id, targetNumber: Number(targetId), position });
    };
    handle.onpointercancel = () => {
      touchDrag = null;
      panel.querySelectorAll('.rm-drop').forEach((el) => el.classList.remove('rm-drop'));
    };
    row.ondragover = (event) => {
      if (drag?.kind === kind && drag.id !== id && drag.planId === planId && canEdit()) {
        event.preventDefault();
        event.stopPropagation();
        row.classList.add('rm-drop');
      }
    };
    row.ondragleave = () => row.classList.remove('rm-drop');
    row.ondrop = (event) => {
      if (!drag || drag.kind !== kind || drag.id === id || drag.planId !== planId || !canEdit()) return;
      event.preventDefault();
      event.stopPropagation();
      const source = drag;
      drag = null;
      row.classList.remove('rm-drop');
      const position =
        event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2
          ? 'after'
          : 'before';
      if (kind === 'step') void act('step.move', { planId, stepId: source.id, targetId: id, position });
      else if (kind === 'milestone')
        void act('milestone.move', { milestoneId: source.id, targetId: id, position });
      else void act('backlog.move', { number: source.id, targetNumber: id, position });
    };
    return handle;
  }
  function activityName(entry) {
    const known = getContext().sessions?.find((item) => item.id === entry.sessionId);
    if (known?.title) return known.title;
    if (entry.name) return entry.name;
    return sessionLabel(entry.sessionId);
  }
  function activities(kind, id, stepId) {
    const box = node('div', 'rm-activities');
    const list = activityFor(kind, id, stepId);
    if (!list.length) return box;
    const key = `${kind}:${id}${stepId ? `:${stepId}` : ''}`;
    const isOpen = expandedActivities.has(key);
    const visible = isOpen ? list : list.slice(0, 1);
    for (const item of visible) {
      const label = `${rt('working')} · ${activityName(item)}`;
      const link = button(label, () => openLink(item), 'rm-activity-link');
      link.title = rt('openConversation');
      link.setAttribute('aria-label', `${label} — ${rt('openConversation')}`);
      box.append(link);
    }
    if (list.length > 1) {
      const toggle = button(
        isOpen ? `− ${list.length}` : `+${list.length - 1}`,
        () => {
          if (isOpen) expandedActivities.delete(key);
          else expandedActivities.add(key);
          render();
        },
        'rm-activity-more',
      );
      toggle.setAttribute('aria-expanded', String(isOpen));
      toggle.setAttribute('aria-label', rt(isOpen ? 'hideMoreActivity' : 'showMoreActivity'));
      toggle.title = rt(isOpen ? 'hideMoreActivity' : 'showMoreActivity');
      toggle.dataset.rmFocus = `activity:${key}`;
      box.append(toggle);
    }
    return box;
  }
  async function openLink(link) {
    try {
      if (enlarged && innerWidth >= 900) setEnlarged(false);
      await onOpenSession({ cwd, ...link });
      if (innerWidth < 900) hide();
    } catch (e) {
      error = failureMessage(e);
      renderStatus();
    }
  }
  function confirmRemove(action, params) {
    form({
      key: `${action}:${JSON.stringify(params)}`,
      title: rt('confirmDelete'),
      hint: rt('deleteHint'),
      fields: [],
      submit: rt('remove'),
      danger: true,
      save: (_, revision) => mutate(action, params, revision),
    });
  }
  function planForm(plan) {
    form({
      key: `plan:${plan?.id || 'new'}`,
      title: plan ? rt('edit') : rt('addPlan'),
      fields: [
        { name: 'title', label: rt('name'), value: plan?.title || '', required: true, max: 300 },
        { name: 'summary', label: rt('summary'), value: plan?.summary || '', multiline: true },
        {
          name: 'status',
          label: rt('status'),
          value: plan?.status || 'active',
          options: ['active', 'done', 'paused', 'abandoned'].map((x) => [x, rt(x)]),
        },
        {
          name: 'milestone',
          label: rt('milestone'),
          value: plan?.milestone || '',
          options: [['', rt('none')], ...doc.overview.milestones.map((m) => [m.id, m.title])],
        },
        ...(!plan ? [{ name: 'steps', label: rt('initialSteps'), value: '', multiline: true }] : []),
      ],
      save: (values, revision) => {
        const params = {
          title: values.title,
          summary: values.summary,
          status: values.status,
          milestone: values.milestone || null,
        };
        if (plan) return mutate('plan.patch', { planId: plan.id, ...params }, revision);
        return mutate(
          'plan.create',
          {
            ...params,
            steps: values.steps
              .split('\n')
              .map((s) => s.trim())
              .filter(Boolean)
              .map((text) => ({ text })),
          },
          revision,
        );
      },
    });
  }
  function milestoneForm(milestone) {
    form({
      key: `milestone:${milestone?.id || 'new'}`,
      title: milestone ? rt('edit') : rt('addMilestone'),
      fields: [
        { name: 'title', label: rt('name'), value: milestone?.title || '', required: true, max: 300 },
        { name: 'summary', label: rt('summary'), value: milestone?.summary || '', multiline: true },
        {
          name: 'status',
          label: rt('status'),
          value: milestone?.status || 'planned',
          options: ['planned', 'active', 'done'].map((x) => [x, rt(x)]),
        },
      ],
      save: (values, revision) =>
        mutate(
          milestone ? 'milestone.patch' : 'milestone.create',
          { ...(milestone ? { milestoneId: milestone.id } : {}), ...values },
          revision,
        ),
    });
  }
  function stepForm(plan, step, parentId) {
    form({
      key: `step:${plan.id}:${step?.id || parentId || 'new'}`,
      title: step ? rt('edit') : rt('addStep'),
      fields: [
        { name: 'text', label: rt('text'), value: step?.text || '', required: true, multiline: true },
        { name: 'note', label: rt('note'), value: step?.note || '', multiline: true },
      ],
      save: (values, revision) =>
        mutate(
          step ? 'step.edit' : 'step.add',
          { planId: plan.id, ...(step ? { stepId: step.id } : parentId ? { parentId } : {}), ...values },
          revision,
        ),
    });
  }
  function backlogForm(item, kind = 'item') {
    form({
      key: `backlog:${item?.number || 'new'}`,
      title: item ? rt('edit') : rt('addItem'),
      fields: [
        { name: 'text', label: rt('text'), value: item?.text || '', required: true, multiline: true },
        { name: 'note', label: rt('note'), value: item?.note || '', multiline: true },
        ...(!item
          ? [
              {
                name: 'kind',
                label: rt('kind'),
                value: kind,
                options: [
                  ['item', rt('item')],
                  ['note', rt('intention')],
                ],
              },
            ]
          : []),
      ],
      save: (values, revision) =>
        item
          ? mutate('backlog.edit', { number: item.number, text: values.text, note: values.note }, revision)
          : mutate(
              'backlog.add',
              { [values.kind === 'item' ? 'items' : 'notes']: [{ text: values.text, note: values.note }] },
              revision,
            ),
    });
  }
  function renderStep(plan, step, depth, index, siblings) {
    if (showRemainingOnly && !hasRemaining(step)) return null;
    const li = node('li', 'rm-step'),
      row = node('div', 'rm-step-row'),
      key = `${plan.id}:${step.id}`,
      hasChildren = !!step.children?.length,
      visibleChildren = showRemainingOnly ? (step.children || []).filter(hasRemaining) : step.children || [],
      hasVisibleChildren = visibleChildren.length > 0,
      main = node('div', 'rm-step-main');
    li.dataset.stepId = step.id;
    const check = node('input');
    check.type = 'checkbox';
    check.checked = step.done;
    check.indeterminate = !!step.partial;
    check.disabled = !canEdit() || !!plan.archived;
    check.setAttribute('aria-label', step.text);
    check.onchange = () => act('step.check', { planId: plan.id, stepId: step.id, done: check.checked });
    const title = node('span', `rm-step-title${step.done ? ' rm-checked' : ''}`, step.text);
    main.append(check);
    if (hasVisibleChildren) {
      const toggle = button(
        '',
        () => {
          foldedSteps.has(key) ? foldedSteps.delete(key) : foldedSteps.add(key);
          render();
        },
        'rm-step-toggle',
      );
      toggle.append(node('span', 'rm-chevron', '›'), title);
      toggle.setAttribute(
        'aria-label',
        `${rt(foldedSteps.has(key) ? 'expandSubtasks' : 'collapseSubtasks')} · ${step.text}`,
      );
      toggle.dataset.rmFocus = `step:${key}`;
      toggle.setAttribute('aria-expanded', String(!foldedSteps.has(key)));
      toggle.setAttribute('aria-controls', `rm-step-children-${plan.id}-${step.id}`);
      main.append(toggle);
    } else main.append(title);
    const text = node('div', 'rm-step-copy');
    if (hasChildren) main.append(inlineCount(leafProgress(step.children)));
    text.append(main);
    if (step.note) text.append(description(`step:${key}`, step.note));
    text.append(activities('plan', plan.id, step.id));
    row.append(text);
    if (canEdit() && !plan.archived)
      row.append(
        menu(
          [
            [rt('edit'), () => stepForm(plan, step)],
            [rt('work'), () => work([{ kind: 'plan', planId: plan.id, stepId: step.id }])],
            [rt('addChild'), () => stepForm(plan, null, step.id), depth >= 3],
            [
              rt('up'),
              () => act('step.move', { planId: plan.id, stepId: step.id, direction: 'up' }),
              index === 0,
            ],
            [
              rt('down'),
              () => act('step.move', { planId: plan.id, stepId: step.id, direction: 'down' }),
              index === siblings.length - 1,
            ],
            [
              rt('indent'),
              () => act('step.move', { planId: plan.id, stepId: step.id, direction: 'indent' }),
              index === 0 || depth >= 3,
            ],
            [
              rt('outdent'),
              () => act('step.move', { planId: plan.id, stepId: step.id, direction: 'outdent' }),
              depth === 1,
            ],
            [rt('remove'), () => confirmRemove('step.remove', { planId: plan.id, stepId: step.id })],
          ],
          `${rt('actions')} · ${step.text}`,
        ),
      );
    if (!plan.archived) row.prepend(bindDrag(row, 'step', step.id, plan.id));
    li.append(row);
    if (hasVisibleChildren) {
      const list = node('ul', 'rm-steps');
      list.id = `rm-step-children-${plan.id}-${step.id}`;
      list.hidden = foldedSteps.has(key);
      (step.children || []).forEach((child, i) => {
        const el = renderStep(plan, child, depth + 1, i, step.children);
        if (el) list.append(el);
      });
      li.append(list);
    }
    return li;
  }
  function renderPlan(plan) {
    const section = node('section', 'rm-plan');
    section.dataset.planId = plan.id;
    const head = node('div', 'rm-plan-head'),
      toggle = button(
        plan.title,
        () => {
          expanded.has(plan.id) ? expanded.delete(plan.id) : expanded.add(plan.id);
          render();
        },
        'rm-plan-toggle',
      );
    toggle.setAttribute('aria-label', plan.title);
    toggle.setAttribute('aria-expanded', expanded.has(plan.id) ? 'true' : 'false');
    toggle.setAttribute('aria-controls', `rm-plan-${plan.id}`);
    head.append(toggle, inlineCount(plan.progress), planPercent(plan.progress));
    if (canEdit()) {
      if (plan.archived)
        head.append(
          menu([
            [rt('restore'), () => act('plan.unarchive', { planId: plan.id })],
            [rt('remove'), () => confirmRemove('plan.delete', { planId: plan.id })],
          ]),
        );
      else
        head.append(
          menu([
            [rt('edit'), () => planForm(plan)],
            [rt('archive'), () => act('plan.archive', { planId: plan.id })],
            [rt('remove'), () => confirmRemove('plan.delete', { planId: plan.id })],
          ]),
        );
    }
    section.append(head);
    const meta = node('div', 'rm-plan-meta');
    meta.append(node('span', '', rt(plan.status)));
    if (plan.status === 'abandoned') meta.append(node('span', '', rt('excluded')));
    if (plan.archived) meta.append(node('span', '', rt('archivedBadge')));
    section.append(meta, activities('plan', plan.id));
    const body = node('div', 'rm-plan-body');
    body.id = `rm-plan-${plan.id}`;
    body.hidden = !expanded.has(plan.id);
    if (plan.summary) body.append(description(`plan:${plan.id}`, plan.summary));
    const parents = [];
    const visit = (steps) => {
      for (const step of steps)
        if (step.children?.length) {
          parents.push(`${plan.id}:${step.id}`);
          visit(step.children);
        }
    };
    visit(plan.steps);
    if (parents.length) {
      const collapsed = parents.every((key) => foldedSteps.has(key));
      const tools = node('div', 'rm-task-tools');
      const fold = button(
        rt(collapsed ? 'expandAllTasks' : 'collapseAllTasks'),
        () => {
          for (const key of parents) collapsed ? foldedSteps.delete(key) : foldedSteps.add(key);
          render();
        },
        'rm-text-button',
      );
      fold.dataset.rmFocus = `tasks:${plan.id}`;
      tools.append(fold);
      body.append(tools);
    }
    const list = node('ul', 'rm-steps');
    plan.steps.forEach((s, i) => {
      const el = renderStep(plan, s, 1, i, plan.steps);
      if (el) list.append(el);
    });
    body.append(list);
    if (showRemainingOnly && plan.steps.length && !plan.steps.some(hasRemaining))
      body.append(node('p', 'rm-note', rt('noRemaining')));
    const actions = node('div', 'rm-inline-actions');
    if (canEdit() && !plan.archived)
      actions.append(
        button(rt('addStep'), () => stepForm(plan), 'rm-text-button'),
        button(rt('work'), () => work([{ kind: 'plan', planId: plan.id }]), 'rm-work-button'),
      );
    body.append(actions);
    const links = node('details', 'rm-secondary');
    links.append(node('summary', '', `${rt('conversations')} · ${plan.sessions.length}`));
    for (const sessionId of plan.sessions)
      links.append(button(sessionLabel(sessionId), () => openLink({ sessionId }), 'rm-session-link'));
    if (getContext().sessionId && !plan.sessions.includes(getContext().sessionId) && canEdit() && !plan.archived)
      links.append(
        button(
          rt('attach'),
          () => act('plan.attach', { planId: plan.id, sessionId: getContext().sessionId }),
          'rm-text-button',
        ),
      );
    body.append(links);
    const journal = node('details', 'rm-secondary');
    journal.append(node('summary', '', `${rt('journal')} · ${plan.journal.length}`));
    for (const entry of [...plan.journal].reverse()) {
      const row = node('article', 'rm-journal-entry');
      row.append(node('p', '', entry.text));
      const by = `${entry.by === 'user' ? rt('user') : entry.name || 'Agent'} · ${new Date(entry.at).toLocaleString()}`;
      if (entry.sessionId)
        row.append(
          button(
            by,
            () => openLink({ sessionId: entry.sessionId, rootSessionId: entry.rootSessionId }),
            'rm-session-link',
          ),
        );
      else row.append(node('small', '', by));
      journal.append(row);
    }
    if (canEdit() && !plan.archived)
      journal.append(
        button(
          rt('addEntry'),
          () =>
            form({
              key: `journal:${plan.id}`,
              title: rt('addEntry'),
              fields: [{ name: 'text', label: rt('note'), value: '', multiline: true, required: true }],
              save: (values, revision) => mutate('journal.add', { planId: plan.id, ...values }, revision),
            }),
          'rm-text-button',
        ),
      );
    body.append(journal);
    section.append(body);
    return section;
  }
  function sessionLabel(id) {
    return getContext().sessions?.find((s) => s.id === id)?.title || `${rt('session')} · ${id.slice(0, 12)}`;
  }
  function renderProject() {
    const vision = node('section', 'rm-vision'),
      head = node('div', 'rm-section-head');
    head.append(node('h3', '', rt('vision')));
    if (canEdit())
      head.append(
        button(
          rt('edit'),
          () =>
            form({
              key: 'vision',
              title: rt('vision'),
              fields: [
                { name: 'text', label: rt('visionHint'), value: doc.overview.vision || '', multiline: true },
              ],
              save: (values, revision) => mutate('vision', values, revision),
            }),
          'rm-text-button',
        ),
      );
    vision.append(
      head,
      node('p', doc.overview.vision ? 'rm-description' : 'rm-note', doc.overview.vision || rt('visionHint')),
    );
    content.append(vision);
    if (doc.plans.some((p) => !p.archived && p.steps.length)) {
      const viewTools = node('div', 'rm-view-tools');
      viewTools.append(remainingToggle('project'));
      content.append(viewTools);
    }
    for (const [index, milestone] of doc.overview.milestones.entries()) {
      const group = node('section', 'rm-milestone');
      group.dataset.milestoneId = milestone.id;
      const head = node('div', 'rm-section-head'),
        heading = node('h3');
      const toggle = button(
        milestone.title,
        () => {
          foldedMilestones.has(milestone.id)
            ? foldedMilestones.delete(milestone.id)
            : foldedMilestones.add(milestone.id);
          render();
        },
        'rm-milestone-toggle',
      );
      toggle.setAttribute('aria-label', milestone.title);
      toggle.setAttribute('aria-expanded', foldedMilestones.has(milestone.id) ? 'false' : 'true');
      toggle.setAttribute('aria-controls', `rm-milestone-${milestone.id}`);
      heading.append(toggle);
      head.append(bindDrag(head, 'milestone', milestone.id), heading, inlineCount(milestone.progress));
      if (canEdit())
        head.append(
          menu([
            [rt('edit'), () => milestoneForm(milestone)],
            [rt('work'), () => work([{ kind: 'milestone', milestoneId: milestone.id }])],
            [
              rt('up'),
              () =>
                act('milestone.move', {
                  milestoneId: milestone.id,
                  targetId: doc.overview.milestones[index - 1].id,
                  position: 'before',
                }),
              index === 0,
            ],
            [
              rt('down'),
              () =>
                act('milestone.move', {
                  milestoneId: milestone.id,
                  targetId: doc.overview.milestones[index + 1].id,
                  position: 'after',
                }),
              index === doc.overview.milestones.length - 1,
            ],
            [rt('remove'), () => confirmRemove('milestone.delete', { milestoneId: milestone.id })],
          ]),
        );
      group.append(head, activities('milestone', milestone.id));
      const body = node('div');
      body.id = `rm-milestone-${milestone.id}`;
      body.hidden = foldedMilestones.has(milestone.id);
      if (milestone.summary) body.append(description(`milestone:${milestone.id}`, milestone.summary));
      for (const plan of doc.plans.filter((p) => !p.archived && p.milestone === milestone.id))
        body.append(renderPlan(plan));
      group.append(body);
      content.append(group);
    }
    const ungrouped = doc.plans.filter((p) => !p.archived && !p.milestone);
    if (ungrouped.length && doc.overview.milestones.length) {
      const group = node('section', 'rm-ungrouped-group'),
        body = node('div');
      body.id = 'rm-group-ungrouped';
      body.hidden = foldedGroups.has('ungrouped');
      for (const plan of ungrouped) body.append(renderPlan(plan));
      group.append(groupHead('ungrouped', rt('ungrouped'), plansProgress(ungrouped)), body);
      content.append(group);
    } else for (const plan of ungrouped) content.append(renderPlan(plan));
    if (!doc.plans.some((p) => !p.archived)) content.append(node('p', 'rm-note', rt('noPlans')));
    if (canEdit()) {
      const actions = node('div', 'rm-add-actions');
      actions.append(
        button(rt('addPlan'), () => planForm(), 'rm-primary'),
        button(rt('addMilestone'), () => milestoneForm()),
      );
      content.append(actions);
    }
  }
  function renderArchived() {
    content.append(node('p', 'rm-note', rt('archivedHint')));
    const archived = doc.plans.filter((p) => p.archived);
    if (!archived.length) content.append(node('p', 'rm-note', rt('noArchived')));
    for (const plan of archived) content.append(renderPlan(plan));
  }
  function renderBacklog() {
    content.append(node('p', 'rm-note', rt('backlogHint')));
    if (canEdit()) content.append(button(rt('addItem'), () => backlogForm(), 'rm-primary'));
    if (doc.backlog.items.length) {
      const viewTools = node('div', 'rm-view-tools');
      viewTools.append(remainingToggle('backlog'));
      content.append(viewTools);
    }
    if (selected.size && canEdit()) {
      const selection = node('div', 'rm-selection');
      selection.append(
        node('span', '', `${selected.size} ${rt('selection')}`),
        button(
          rt('work'),
          () => work([...selected].map((number) => ({ kind: 'backlog', number }))),
          'rm-work-button',
        ),
      );
      content.append(selection);
    }
    for (const [kind, rows, label] of [
      ['item', doc.backlog.items, 'tasks'],
      ['note', doc.backlog.notes, 'intentions'],
    ]) {
      const section = node('section', 'rm-backlog-group'),
        list = node('div', 'rm-backlog-items'),
        groupKey = `backlog-${kind}`;
      section.dataset.backlogKind = kind;
      list.id = `rm-group-${groupKey}`;
      list.hidden = foldedGroups.has(groupKey);
      section.append(
        groupHead(
          groupKey,
          rt(label),
          kind === 'item'
            ? { done: rows.filter((item) => item.done).length, total: rows.length }
            : rows.length,
        ),
      );
      const visibleRows = showRemainingOnly && kind === 'item' ? rows.filter((item) => !item.done) : rows;
      if (!rows.length) list.append(node('p', 'rm-note', rt('noBacklog')));
      else if (!visibleRows.length)
        list.append(node('p', 'rm-note', rt(kind === 'item' ? 'noPending' : 'noBacklog')));
      rows.forEach((item, i) => {
        if (showRemainingOnly && kind === 'item' && item.done) return;
        const row = node('article', 'rm-backlog-row');
        row.dataset.backlogNumber = String(item.number);
        row.append(bindDrag(row, 'backlog', item.number));
        const copy = node('div', 'rm-backlog-copy'),
          text = node('p', item.done ? 'rm-checked' : '', item.text);
        const title = node('div', 'rm-backlog-title');
        if (kind === 'item') {
          const check = node('input');
          check.type = 'checkbox';
          check.checked = item.done;
          check.disabled = !canEdit();
          check.setAttribute('aria-label', item.text);
          check.onchange = () => act('backlog.set', { numbers: [item.number], done: check.checked });
          title.append(check);
        }
        title.append(node('small', 'rm-number', `#${item.number}`), text);
        copy.append(title);
        if (item.note) copy.append(description(`backlog:${item.number}`, item.note));
        copy.append(activities('backlog', item.number));
        for (const sessionId of item.sessions || [])
          copy.append(button(sessionLabel(sessionId), () => openLink({ sessionId }), 'rm-session-link'));
        if (canEdit()) {
          const select = button(
            selected.has(item.number) ? `✓ ${rt('selected')}` : rt('select'),
            () => {
              selected.has(item.number) ? selected.delete(item.number) : selected.add(item.number);
              render();
            },
            'rm-backlog-select',
          );
          select.setAttribute('aria-pressed', selected.has(item.number) ? 'true' : 'false');
          copy.append(select);
        }
        row.append(copy);
        if (canEdit())
          row.append(
            menu([
              [rt('edit'), () => backlogForm(item, kind)],
              [
                rt(kind === 'item' ? 'convertNote' : 'convertItem'),
                () =>
                  act('backlog.convert', { number: item.number, kind: kind === 'item' ? 'note' : 'item' }),
              ],
              [
                rt('up'),
                () =>
                  act('backlog.move', {
                    number: item.number,
                    targetNumber: rows[i - 1].number,
                    position: 'before',
                  }),
                i === 0,
              ],
              [
                rt('down'),
                () =>
                  act('backlog.move', {
                    number: item.number,
                    targetNumber: rows[i + 1].number,
                    position: 'after',
                  }),
                i === rows.length - 1,
              ],
              [rt('remove'), () => confirmRemove('backlog.remove', { numbers: [item.number] })],
            ]),
          );
        list.append(row);
      });
      section.append(list);
      content.append(section);
    }
  }
  function render() {
    if (!opened) return;
    const scroll = content.scrollTop;
    const focus = panel.contains(document.activeElement) ? document.activeElement : null;
    const focusKey = focus && (focus.getAttribute('aria-label') || focus.textContent);
    const stableFocus = focus?.dataset.rmFocus;
    const focusKind = focus?.tagName;
    const openDetails = [...content.querySelectorAll('details[open]')].map((d) => ({
      plan: d.closest('[data-plan-id]')?.dataset.planId,
      label: d.querySelector('summary')?.textContent,
    }));
    projectName.textContent = getContext().name || doc?.name || cwd;
    close.setAttribute('aria-label', rt('close'));
    updatePresentation();
    progress.replaceChildren();
    tabs.replaceChildren();
    content.replaceChildren();
    footer.replaceChildren();
    renderStatus();
    for (const key of ['project', 'session', 'backlog', 'archived']) {
      const archivedCount =
        key === 'archived' ? doc?.plans.filter((p) => p.archived).length || 0 : 0;
      const label = key === 'archived' ? `${rt(key)} (${archivedCount})` : rt(key);
      const b = button(label, () => {
        tab = key;
        selected.clear();
        render();
      });
      b.setAttribute('aria-current', key === tab ? 'page' : 'false');
      tabs.append(b);
    }
    if (!doc) {
      content.append(node('p', 'rm-note', error || rt('loading')));
      return;
    }
    progress.append(
      counts(tab === 'session' ? sessionProgress() : doc.progress || doc.overview.progress, true),
    );
    if (!doc.initialized) {
      const empty = node('div', 'rm-empty');
      empty.append(node('h3', '', rt('empty')), node('p', '', rt('intro')));
      if (canEdit()) empty.append(button(rt('create'), () => act('init'), 'rm-primary'));
      content.append(empty);
    } else if (tab === 'project') renderProject();
    else if (tab === 'backlog') renderBacklog();
    else if (tab === 'archived') renderArchived();
    else {
      const plans = doc.plans.filter(
        (p) => !p.archived && p.sessions.includes(getContext().sessionId),
      );
      if (!plans.length)
        content.append(node('p', 'rm-note', rt(getContext().sessionId ? 'noSession' : 'chooseSession')));
      if (plans.some((p) => p.steps.length)) {
        const viewTools = node('div', 'rm-view-tools');
        viewTools.append(remainingToggle('session'));
        content.append(viewTools);
      }
      for (const plan of plans) content.append(renderPlan(plan));
    }
    footer.append(
      button(
        rt('knowledge'),
        () => {
          if (enlarged && innerWidth >= 900) setEnlarged(false);
          onKnowledge();
        },
        'rm-text-button',
      ),
      menu(
        [
          [rt('refresh'), () => refresh()],
          [rt('export'), () => exportDocument(), !doc.initialized],
        ],
        rt('more'),
      ),
    );
    for (const d of content.querySelectorAll('details'))
      if (
        openDetails.some(
          (x) =>
            x.plan === d.closest('[data-plan-id]')?.dataset.planId &&
            x.label === d.querySelector('summary')?.textContent,
        )
      )
        d.open = true;
    content.scrollTop = scroll;
    if (focusKey && !panel.contains(focus))
      [...panel.querySelectorAll('button,input,summary')]
        .find(
          (el) =>
            el.tagName === focusKind &&
            (stableFocus
              ? el.dataset.rmFocus === stableFocus
              : (el.getAttribute('aria-label') || el.textContent) === focusKey),
        )
        ?.focus({ preventScroll: true });
  }
  function sessionProgress() {
    const value = { done: 0, total: 0, percent: 0 };
    for (const plan of doc.plans.filter(
      (p) => p.sessions.includes(getContext().sessionId) && p.status !== 'abandoned' && !p.archived,
    )) {
      value.done += plan.progress.done;
      value.total += plan.progress.total;
    }
    value.percent = value.total ? Math.round((value.done * 100) / value.total) : 0;
    return value;
  }
  async function exportDocument() {
    try {
      const response = await fetch(`/api/roadmap/export?${query(cwd)}`);
      if (!response.ok) throw new Error((await response.json()).error);
      const url = URL.createObjectURL(await response.blob()),
        a = node('a');
      a.href = url;
      a.download = 'roadmap.md';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      error = failureMessage(e);
      renderStatus();
    }
  }
  function form(spec) {
    if (!canEdit()) return;
    const trigger = document.activeElement,
      draftKey = `studio.roadmap.draft:${cwd}:${spec.key}`;
    let revision = doc.revision,
      draft;
    try {
      if (!spec.noDraft) draft = JSON.parse(localStorage.getItem(draftKey));
    } catch {}
    const draftValues = draft?.values || draft;
    const staleDraft = !!draft && draft.revision !== doc.revision;
    if (Number.isSafeInteger(draft?.revision)) revision = draft.revision;
    editor.replaceChildren();
    editor.setAttribute('aria-labelledby', 'rm-editor-title');
    const form = node('form'),
      title = node('h2', '', spec.title);
    title.id = 'rm-editor-title';
    form.append(title);
    if (spec.hint) form.append(node('p', 'rm-note', spec.hint));
    const fields = new Map();
    for (const field of spec.fields) {
      const label = node('label', 'rm-field');
      label.append(node('span', '', field.label));
      const input = node(field.options ? 'select' : field.multiline ? 'textarea' : 'input');
      input.name = field.name;
      input.setAttribute('aria-label', field.label);
      if (field.options)
        for (const [value, text] of field.options) {
          const option = node('option', '', text);
          option.value = value;
          input.append(option);
        }
      input.value = draftValues?.[field.name] ?? field.value;
      input.required = !!field.required;
      if (!field.options) input.maxLength = field.max || 12000;
      if (field.multiline) input.rows = field.name === 'text' || field.name === 'steps' ? 4 : 3;
      label.append(input);
      form.append(label);
      fields.set(field.name, input);
    }
    const notice = node('p', 'rm-form-notice', staleDraft ? rt('conflict') : draft ? rt('restored') : '');
    notice.setAttribute('role', 'status');
    form.append(notice);
    const rebase = button(rt('reloadDraft'), async () => {
      if (await refresh()) {
        revision = doc.revision;
        spec.onRebase?.();
        persist();
        notice.textContent = '';
        rebase.hidden = true;
        submit.disabled = false;
      }
    });
    rebase.hidden = !staleDraft;
    form.append(rebase);
    const buttons = node('div', 'rm-form-actions'),
      cancel = button(rt('cancel'), () => editor.close()),
      submit = node('button', spec.danger ? 'rm-danger' : 'rm-primary', spec.submit || rt('save'));
    submit.type = 'submit';
    buttons.append(cancel, submit);
    form.append(buttons);
    editor.append(form);
    submit.disabled = staleDraft;
    const values = () => Object.fromEntries([...fields].map(([key, input]) => [key, input.value]));
    const persist = () => {
      if (!spec.noDraft)
        try {
          localStorage.setItem(draftKey, JSON.stringify({ revision, values: values() }));
        } catch {}
    };
    form.addEventListener('input', persist);
    form.addEventListener('change', persist);
    let busy = false,
      completed = false;
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (busy || !rebase.hidden || !canEdit()) return;
      busy = true;
      submit.disabled = cancel.disabled = true;
      editor.setAttribute('aria-busy', 'true');
      persist();
      try {
        await spec.save(values(), revision);
        completed = true;
        try {
          localStorage.removeItem(draftKey);
        } catch {}
        editor.close();
      } catch (e) {
        notice.textContent = e.status === 409 ? rt('conflict') : failureMessage(e);
        rebase.hidden = e.status !== 409;
      } finally {
        busy = false;
        cancel.disabled = false;
        submit.disabled = !rebase.hidden;
        editor.removeAttribute('aria-busy');
      }
    };
    editor.oncancel = (event) => {
      if (busy) event.preventDefault();
      event.stopPropagation();
    };
    editor.onclose = () => {
      if (!completed) persist();
      editorState = null;
      if (trigger?.isConnected) trigger.focus({ preventScroll: true });
      else close.focus();
    };
    editorState = { persist, busy: () => busy };
    editor.showModal();
    requestAnimationFrame(() => (fields.values().next().value || cancel).focus());
  }
  function work(targets) {
    if (!targets.length) return;
    workRequest = crypto.randomUUID();
    const context = getContext();
    form({
      key: 'work',
      title: rt('workTitle'),
      hint: rt('workHint'),
      noDraft: true,
      submit: rt('work'),
      onRebase: () => {
        workRequest = crypto.randomUUID();
      },
      fields: [
        {
          name: 'sessionId',
          label: rt('destination'),
          value: context.sessionId || '',
          options: [
            ...(context.sessionId ? [[context.sessionId, rt('current')]] : []),
            ['', rt('newSession')],
          ],
        },
        {
          name: 'instructions',
          label: rt('workInstructions'),
          value: '',
          multiline: true,
          max: 4000,
        },
      ],
      save: async (values, revision) => {
        const instructions = String(values.instructions ?? '').trim();
        const result = await api('/api/roadmap/work', {
          method: 'POST',
          body: {
            cwd,
            targets,
            expectedRevision: revision,
            sessionId: values.sessionId || undefined,
            model: context.model,
            thinking: context.thinking,
            requestId: workRequest,
            ...(instructions ? { instructions } : {}),
          },
        });
        selected.clear();
        await onWork(result);
        toast?.(rt('sent'));
        await refresh();
      },
    });
  }
  let inertShell = null,
    previousInert = false;
  function updatePresentation() {
    const modal = opened && (enlarged || innerWidth < 900);
    document.body.classList.toggle('roadmap-expanded', opened && enlarged);
    enlarge.hidden = innerWidth < 900;
    enlarge.setAttribute('aria-label', rt(enlarged ? 'reduce' : 'expand'));
    enlarge.setAttribute('aria-pressed', String(enlarged));
    enlarge.title = rt(enlarged ? 'reduce' : 'expand');
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg'),
      path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    path.setAttribute(
      'd',
      enlarged ? 'M4 9h5V4m11 5h-5V4M4 15h5v5m11-5h-5v5' : 'M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5',
    );
    svg.append(path);
    enlarge.replaceChildren(svg);
    if (modal) {
      panel.setAttribute('role', 'dialog');
      panel.setAttribute('aria-modal', 'true');
      if (!inertShell) {
        inertShell = document.querySelector('.app-shell');
        if (inertShell) {
          previousInert = inertShell.inert;
          inertShell.inert = true;
        }
      }
    } else {
      panel.removeAttribute('role');
      panel.removeAttribute('aria-modal');
      if (inertShell) {
        inertShell.inert = previousInert;
        inertShell = null;
      }
    }
  }
  function setEnlarged(value) {
    const scroll = content.scrollTop;
    enlarged = value;
    updatePresentation();
    content.scrollTop = scroll;
    enlarge.focus({ preventScroll: true });
  }
  function show(trigger, nextTab = 'project') {
    if (!getContext().cwd) return;
    opener = trigger || document.activeElement;
    tab = nextTab;
    if (cwd !== getContext().cwd) {
      cwd = getContext().cwd;
      doc = null;
      generation++;
      expanded.clear();
      selected.clear();
      foldedMilestones.clear();
      foldedSteps.clear();
      foldedGroups.clear();
      visibleDescriptions.clear();
      expandedActivities.clear();
      appliedSequence = 0;
      error = '';
    }
    opened = true;
    panel.hidden = false;
    document.body.classList.add('roadmap-open');
    updatePresentation();
    render();
    close.focus();
    void refresh();
  }
  function hide() {
    if (editorState?.busy()) return;
    if (editor.open) editor.close();
    opened = false;
    panel.hidden = true;
    generation++;
    document.body.classList.remove('roadmap-open');
    enlarged = false;
    updatePresentation();
    opener?.isConnected && opener.focus({ preventScroll: true });
  }
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !event.defaultPrevented) {
      event.preventDefault();
      event.stopPropagation();
      if (enlarged && innerWidth >= 900) setEnlarged(false);
      else hide();
    }
    if (event.key === 'Tab' && (enlarged || innerWidth < 900)) {
      const nodes = [...panel.querySelectorAll('button,summary,input,a,select,textarea')].filter((el) => {
        if (el.disabled || el.tabIndex < 0 || !el.getClientRects().length || el.closest('[hidden]'))
          return false;
        // Closed details can still report rectangles for their content in Chromium.
        for (let parent = el.parentElement; parent && parent !== panel; parent = parent.parentElement)
          if (
            parent.tagName === 'DETAILS' &&
            !parent.open &&
            !parent.querySelector(':scope > summary')?.contains(el)
          )
            return false;
        return true;
      });
      if (event.shiftKey && document.activeElement === nodes[0]) {
        event.preventDefault();
        nodes.at(-1)?.focus();
      } else if (!event.shiftKey && document.activeElement === nodes.at(-1)) {
        event.preventDefault();
        nodes[0]?.focus();
      }
    }
  });
  document.addEventListener('pointerdown', (event) => {
    for (const menu of panel.querySelectorAll('.rm-menu[open]'))
      if (!menu.contains(event.target)) menu.open = false;
  });
  function update() {
    const context = getContext();
    if (context.cwd !== cwd) {
      editorState?.persist();
      if (opened) hide();
      if (editorState?.busy()) return;
      cwd = context.cwd || '';
      doc = null;
      generation++;
      appliedSequence = 0;
      activityEpoch = '';
      activityRevision = -1;
      lastSummaryRefresh = 0;
      expanded.clear();
      selected.clear();
      foldedMilestones.clear();
      foldedSteps.clear();
      foldedGroups.clear();
      visibleDescriptions.clear();
      expandedActivities.clear();
      error = '';
      onSummary(null);
    }
    if (!opened) {
      void refresh();
      return;
    }
    const access = `${context.readOnly}:${context.online}`;
    if (contextSession !== context.sessionId || access !== contextAccess) {
      contextSession = context.sessionId;
      contextAccess = access;
      render();
    }
    void refresh();
  }
  const timer = setInterval(update, 2200);
  document.addEventListener('visibilitychange', update);
  window.addEventListener('resize', () => {
    if (!opened) return;
    updatePresentation();
  });
  onLanguageChange(() => {
    if (opened) render();
  });
  return {
    open: show,
    close: hide,
    update,
    destroy: () => {
      clearInterval(timer);
      opened = false;
      document.body.classList.remove('roadmap-open');
      updatePresentation();
      panel.remove();
      editor.remove();
    },
  };
}
