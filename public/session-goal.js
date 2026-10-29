const MAX_OBJECTIVE = 4000;

export function createSessionGoal({ api, t, onResumed }) {
  const $ = (id) => document.getElementById(id);
  const button = $('session-goal-button');
  const dialog = $('session-goal-dialog');
  const form = $('session-goal-form');
  const objective = $('session-goal-objective');
  const input = $('session-goal-input');
  const edit = $('session-goal-edit');
  const stop = $('session-goal-stop');
  const clear = $('session-goal-clear');
  const resume = $('session-goal-resume');
  const resumeHint = $('session-goal-resume-hint');
  const save = $('session-goal-save');
  const reload = $('session-goal-reload');
  const error = $('session-goal-error');
  const drafts = new Map();
  const cache = new Map();
  const pendingActions = new Map();
  const epochs = new Map();
  let selected = null;
  let opened = null;
  let editing = false;
  let request = null;
  let lastRead = 0;
  let dialogGeneration = 0;
  let expectedObjective = '';
  let expectedGoalId = '';
  let awaitingFreshState = false;

  function resumeEligible(current) {
    const goal = current?.goal;
    return (
      goal &&
      ['error', 'paused', 'budget_limited'].includes(goal.status) &&
      (goal.tokenBudget == null || Number(goal.tokensUsed) < Number(goal.tokenBudget))
    );
  }

  function resumeBlocked(current) {
    return ['running', 'stopping', 'busy'].includes(current?.resumeBlocked) ? current.resumeBlocked : null;
  }

  function resumable(current) {
    return resumeEligible(current) && current?.resumable === true && !resumeBlocked(current);
  }

  function goalStatus(status) {
    switch (status) {
      case 'active':
        return t('goal.status.active');
      case 'paused':
        return t('goal.status.paused');
      case 'budget_limited':
        return t('goal.status.budget_limited');
      case 'complete':
        return t('goal.status.complete');
      case 'error':
        return t('goal.status.error');
      default:
        return String(status || '');
    }
  }

  function formatTime(seconds) {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    return n < 60
      ? `${n}s`
      : n < 3600
        ? `${Math.floor(n / 60)}m ${n % 60}s`
        : `${Math.floor(n / 3600)}h ${Math.floor((n % 3600) / 60)}m`;
  }

  function setError(message = '', conflict = false) {
    error.textContent = message;
    error.hidden = !message;
    reload.hidden = !conflict;
  }

  function renderHeader() {
    const data = selected && cache.get(selected.id);
    const goal = data?.goal;
    button.hidden = !goal;
    document.documentElement.classList.toggle('has-session-goal', Boolean(goal));
    if (goal) {
      const status = String(goal.status || (goal.active ? 'active' : 'idle'));
      $('session-goal-button-status').textContent = goalStatus(status);
      button.title = `${t('goal.title')}: ${goalStatus(status)}`;
      button.setAttribute('aria-label', button.title);
    }
  }

  function render() {
    renderHeader();
    if (!dialog.open || !opened) return;
    const current = cache.get(opened.id);
    const shown = current?.goal;
    if (!shown) {
      dialog.close();
      return;
    }
    objective.textContent = String(shown.objective || '');
    $('session-goal-status').textContent = goalStatus(shown.status || (shown.active ? 'active' : 'idle'));
    const usage = [
      `${t('goal.tokens')}: ${new Intl.NumberFormat().format(Number(shown.tokensUsed) || 0)}${shown.tokenBudget == null ? '' : ` / ${new Intl.NumberFormat().format(Number(shown.tokenBudget) || 0)}`}`,
      `${t('goal.time')}: ${formatTime(shown.timeUsedSeconds)}`,
      `${t('goal.continuations')}: ${Number(shown.continuationsUsed) || 0}`,
    ];
    $('session-goal-usage').textContent = usage.join(' · ');
    const readOnly = opened.readOnly || selected?.readOnly;
    const pending = pendingActions.has(opened.id);
    const canEdit = Boolean(current.editable) && !readOnly;
    const canControl = Boolean(current.controllable) && !readOnly;
    const blocked = resumeBlocked(current);
    const canShowResume = Boolean(resumeEligible(current) && (resumable(current) || blocked) && !readOnly);
    edit.hidden = editing || !canEdit;
    edit.disabled = pending || awaitingFreshState;
    stop.hidden = editing || !canControl || !shown.active;
    stop.textContent = t('goal.stop');
    clear.hidden = editing || !canControl;
    resume.hidden = editing || !canShowResume;
    stop.disabled = pending || awaitingFreshState;
    clear.disabled = pending || awaitingFreshState;
    resume.disabled = pending || awaitingFreshState || !resumable(current);
    resume.textContent = t(shown.status === 'error' ? 'goal.retry' : 'goal.resume');
    if (resumeHint) {
      resumeHint.hidden = editing || !canShowResume;
      resumeHint.textContent = t(
        blocked
          ? `goal.resumeBlocked${blocked[0].toUpperCase()}${blocked.slice(1)}`
          : shown.status === 'error'
            ? 'goal.retryHint'
            : 'goal.resumeHint',
      );
    }
    reload.disabled = pending;
    input.hidden = !editing;
    $('session-goal-editor').hidden = !editing;
    save.hidden = !editing;
    save.disabled = !canEdit || pending || awaitingFreshState;
  }

  async function refresh({ force = false } = {}) {
    if (!selected?.id) return;
    const target = selected.id;
    if (request?.id === target && !force) return request.promise;
    if (!force && cache.has(target) && Date.now() - lastRead < 10000) return;
    request?.controller.abort();
    const controller = new AbortController();
    const epoch = epochs.get(target) || 0;
    const promise = api(`/api/sessions/${encodeURIComponent(target)}/goal`, { signal: controller.signal })
      .then((data) => {
        if (request?.promise !== promise || (epochs.get(target) || 0) !== epoch) return false;
        cache.set(target, data);
        if (selected?.id === target) lastRead = Date.now();
        if (dialog.open && opened?.id === target && awaitingFreshState) {
          awaitingFreshState = false;
          setError();
        }
        if (selected?.id === target || opened?.id === target) render();
        return true;
      })
      .catch((e) => {
        if (request?.promise === promise && e.name !== 'AbortError' && opened?.id === target)
          setError(e.message, awaitingFreshState);
        return false;
      })
      .finally(() => {
        if (request?.promise === promise) request = null;
      });
    request = { id: target, controller, promise };
    return promise;
  }

  function setSelection(next) {
    const id = next?.id || null;
    const changed = id !== selected?.id;
    if (changed) {
      if (dialog.open) {
        stashDraft();
        dialog.close();
      }
      awaitingFreshState = false;
      request?.controller.abort();
      request = null;
      lastRead = 0;
    }
    selected = id ? { id, cwd: next.cwd, readOnly: Boolean(next.readOnly) } : null;
    render();
    if (selected) void refresh();
  }

  button.addEventListener('click', () => {
    if (!selected || !cache.get(selected.id)?.goal) return;
    opened = { ...selected };
    dialogGeneration++;
    editing = false;
    setError();
    dialog.showModal();
    awaitingFreshState = true;
    render();
    void refresh({ force: true });
  });
  edit.addEventListener('click', () => {
    const current = opened && cache.get(opened.id);
    if (
      !current?.goal ||
      !current.editable ||
      opened.readOnly ||
      selected?.readOnly ||
      pendingActions.has(opened.id) ||
      awaitingFreshState
    )
      return;
    editing = true;
    expectedObjective = String(current.goal.objective || '');
    expectedGoalId = current.goal.goalId;
    input.value = drafts.get(opened.id) ?? String(current.goal.objective || '');
    setError();
    render();
    input.focus();
  });
  input.addEventListener('input', () => {
    if (opened) drafts.set(opened.id, input.value);
    if (Array.from(input.value).length <= MAX_OBJECTIVE) setError();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const context = opened && { ...opened };
    const current = context && cache.get(context.id);
    if (
      !context ||
      !editing ||
      !current?.goal ||
      !current.editable ||
      context.readOnly ||
      selected?.readOnly ||
      pendingActions.has(context.id) ||
      awaitingFreshState
    )
      return;
    const next = input.value;
    const length = Array.from(next).length;
    if (!next.trim() || length > MAX_OBJECTIVE) {
      setError(t('goal.length'));
      return;
    }
    if (next === expectedObjective) {
      drafts.delete(context.id);
      editing = false;
      render();
      return;
    }
    const generation = dialogGeneration;
    const submittedDraft = next;
    const saveToken = Symbol(context.id);
    pendingActions.set(context.id, saveToken);
    epochs.set(context.id, (epochs.get(context.id) || 0) + 1);
    if (request?.id === context.id) {
      request.controller.abort();
      request = null;
    }
    render();
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(context.id)}/goal`, {
        method: 'PATCH',
        body: {
          cwd: context.cwd,
          goalId: expectedGoalId,
          expectedObjective,
          objective: next,
        },
      });
      epochs.set(context.id, (epochs.get(context.id) || 0) + 1);
      cache.set(context.id, data);
      if (opened?.id === context.id && dialog.open) awaitingFreshState = false;
      if (drafts.get(context.id) === submittedDraft) drafts.delete(context.id);
      if (opened?.id === context.id && dialog.open && dialogGeneration === generation) {
        editing = false;
        setError();
        render();
      }
    } catch (e) {
      if (!drafts.has(context.id)) drafts.set(context.id, submittedDraft);
      if (opened?.id === context.id && dialog.open && dialogGeneration === generation)
        setError(e.status === 409 ? t('goal.conflict') : e.message, e.status === 409);
    } finally {
      if (pendingActions.get(context.id) === saveToken) pendingActions.delete(context.id);
      if (opened?.id === context.id && dialog.open) render();
    }
  });
  async function controlGoal(action) {
    const context = opened && { ...opened };
    const current = context && cache.get(context.id);
    if (
      !context ||
      !dialog.open ||
      selected?.id !== context.id ||
      editing ||
      !current?.goal ||
      (action === 'resume' ? !resumable(current) : !current.controllable) ||
      (action === 'stop' && !current.goal.active) ||
      awaitingFreshState ||
      context.readOnly ||
      selected.readOnly ||
      pendingActions.has(context.id)
    )
      return;
    const generation = dialogGeneration;
    const actionToken = Symbol(context.id);
    pendingActions.set(context.id, actionToken);
    epochs.set(context.id, (epochs.get(context.id) || 0) + 1);
    if (request?.id === context.id) {
      request.controller.abort();
      request = null;
    }
    setError();
    render();
    try {
      const data = await api(`/api/sessions/${encodeURIComponent(context.id)}/goal/${action}`, {
        method: 'POST',
        body: {
          cwd: context.cwd,
          goalId: current.goal.goalId,
          expectedObjective: String(current.goal.objective || ''),
        },
      });
      epochs.set(context.id, (epochs.get(context.id) || 0) + 1);
      cache.set(context.id, data);
      if (opened?.id === context.id && dialog.open) awaitingFreshState = false;
      if (action === 'clear') drafts.delete(context.id);
      if (opened?.id === context.id && dialog.open && dialogGeneration === generation) {
        setError();
        if (action === 'resume') {
          dialog.close();
          // The run was accepted once. Navigation failures never repeat the POST.
          if (selected?.id === context.id && data.run)
            try {
              void Promise.resolve(onResumed?.(data.run, context)).catch(() => {});
            } catch {}
          renderHeader();
        } else render();
      } else if (opened?.id === context.id && dialog.open) {
        render();
      } else if (selected?.id === context.id) {
        renderHeader();
      }
    } catch (e) {
      if (opened?.id === context.id && dialog.open && dialogGeneration === generation)
        setError(e.status === 409 ? t('goal.controlConflict') : e.message, e.status === 409);
    } finally {
      if (pendingActions.get(context.id) === actionToken) pendingActions.delete(context.id);
      if (opened?.id === context.id && dialog.open && dialogGeneration === generation) render();
    }
  }
  stop.addEventListener('click', () => void controlGoal('stop'));
  clear.addEventListener('click', () => void controlGoal('clear'));
  resume.addEventListener('click', () => void controlGoal('resume'));
  reload.addEventListener('click', async () => {
    if (!opened || selected?.id !== opened.id) return;
    const id = opened.id;
    if ((await refresh({ force: true })) && dialog.open && opened?.id === id) {
      awaitingFreshState = false;
      expectedObjective = String(cache.get(id)?.goal?.objective || '');
      expectedGoalId = cache.get(id)?.goal?.goalId;
      setError();
    }
  });
  function stashDraft() {
    if (opened && editing) drafts.set(opened.id, input.value);
  }
  dialog.addEventListener('cancel', stashDraft);
  dialog.addEventListener('click', (event) => {
    if (event.target.closest('[data-close-dialog]')) stashDraft();
  });
  dialog.addEventListener('close', () => {
    if (dialog.open) return;
    stashDraft();
    opened = null;
    awaitingFreshState = false;
    dialogGeneration++;
    editing = false;
    setError();
  });

  return { setSelection, refresh, render };
}
