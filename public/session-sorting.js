// Stable conversation drag/drop, mirroring project-sorting UX.
// Scoped to one project + pinned + archived bucket; conversations never move
// projects. Touch uses the handle only so list scrolling stays available.
export function createSessionSorting({ root, scroller, canSort, move, refresh, render, reportError }) {
  let gesture = null,
    saving = false,
    frame = 0,
    suppressClickUntil = 0;
  const entries = () => [...root.querySelectorAll('.session-row[data-session-id]')];
  const groupOf = (entry) =>
    entries().filter(
      (other) =>
        other.dataset.projectKey === entry.dataset.projectKey &&
        other.dataset.pinned === entry.dataset.pinned &&
        other.dataset.archived === entry.dataset.archived,
    );
  const clearTargets = () => {
    for (const entry of entries()) delete entry.dataset.drop;
  };
  async function commit(body, focusHandle = false) {
    saving = true;
    root.setAttribute('aria-busy', 'true');
    try {
      await move(body);
      await refresh();
    } catch (error) {
      reportError(error);
    } finally {
      saving = false;
      root.removeAttribute('aria-busy');
      render();
      if (focusHandle)
        entries()
          .find((entry) => entry.dataset.sessionId === body.id)
          ?.querySelector('.session-drag-handle')
          ?.focus({ preventScroll: true });
    }
  }
  function targetAtPointer() {
    clearTargets();
    gesture.target = null;
    const scrollerBounds = (scroller || root).getBoundingClientRect();
    if (
      gesture.x < scrollerBounds.left ||
      gesture.x > scrollerBounds.right ||
      gesture.y < scrollerBounds.top - 20 ||
      gesture.y > scrollerBounds.bottom + 20
    )
      return;
    const group = groupOf(gesture.entry);
    const first = group[0]?.getBoundingClientRect(),
      last = group.at(-1)?.getBoundingClientRect();
    if (!first || !last) return;
    if (gesture.y < first.top - 8 || gesture.y > last.bottom + 8) return;
    const candidates = group.filter((entry) => entry !== gesture.entry);
    const target =
      candidates.find((entry) => {
        const rect = entry.getBoundingClientRect();
        return gesture.y < rect.top + rect.height / 2;
      }) || candidates.at(-1);
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const position = gesture.y < rect.top + rect.height / 2 ? 'before' : 'after';
    const from = group.indexOf(gesture.entry),
      to = group.indexOf(target);
    if ((position === 'before' && to === from + 1) || (position === 'after' && to === from - 1)) return;
    target.dataset.drop = position;
    gesture.target = { targetId: target.dataset.sessionId, position };
  }
  function autoScroll() {
    if (!gesture?.dragging) return;
    const scrollerEl = scroller || root;
    const bounds = scrollerEl.getBoundingClientRect();
    if (gesture.x >= bounds.left && gesture.x <= bounds.right) {
      const edge = 32;
      const speed = gesture.y < bounds.top + edge ? -8 : gesture.y > bounds.bottom - edge ? 8 : 0;
      if (speed) {
        scrollerEl.scrollTop += speed;
        targetAtPointer();
      }
    }
    frame = requestAnimationFrame(autoScroll);
  }
  function finish(cancelled = false) {
    if (!gesture) return;
    const current = gesture;
    gesture = null;
    cancelAnimationFrame(frame);
    if (root.hasPointerCapture(current.pointerId)) root.releasePointerCapture(current.pointerId);
    clearTargets();
    current.entry.classList.remove('session-dragging');
    (scroller || root).classList.remove('session-sorting');
    root.classList.remove('session-sorting');
    if (!current.dragging) return;
    suppressClickUntil = performance.now() + 350;
    if (!cancelled && current.target && canSort())
      void commit({ id: current.entry.dataset.sessionId, ...current.target });
    else render();
  }
  root.addEventListener('pointerdown', (event) => {
    if (!canSort() || saving || gesture || event.button !== 0 || !event.isPrimary) return;
    const entry = event.target.closest('.session-row[data-session-id]');
    const handle = event.target.closest('.session-drag-handle');
    if (!entry?.dataset.sessionId || event.target.closest('.session-more') || (event.pointerType === 'touch' && !handle))
      return;
    if (!handle && !event.target.closest('.session-select')) return;
    gesture = {
      entry,
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      dragging: false,
      target: null,
    };
    // Prevent the project drag handler on the outer list from stealing rows.
    event.stopPropagation();
  });
  window.addEventListener(
    'pointermove',
    (event) => {
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      gesture.x = event.clientX;
      gesture.y = event.clientY;
      if (!gesture.dragging) {
        if (Math.hypot(event.clientX - gesture.startX, event.clientY - gesture.startY) < 6) return;
        gesture.dragging = true;
        try {
          root.setPointerCapture(event.pointerId);
        } catch {}
        gesture.entry.classList.add('session-dragging');
        (scroller || root).classList.add('session-sorting');
        root.classList.add('session-sorting');
        autoScroll();
      }
      event.preventDefault();
      targetAtPointer();
    },
    { passive: false },
  );
  window.addEventListener('pointerup', (event) => {
    if (gesture?.pointerId === event.pointerId) finish();
  });
  root.addEventListener('lostpointercapture', (event) => {
    if (event.target === root) finish(true);
  });
  window.addEventListener('pointercancel', () => finish(true));
  window.addEventListener('blur', () => finish(true));
  document.addEventListener('keydown', (event) => {
    if (gesture && event.key === 'Escape') {
      event.preventDefault();
      finish(true);
    }
  });
  root.addEventListener(
    'click',
    (event) => {
      if (performance.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    },
    true,
  );
  root.addEventListener('dragstart', (event) => event.preventDefault());
  root.addEventListener('keydown', (event) => {
    const handle = event.target.closest('.session-drag-handle');
    if (!handle || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault();
    event.stopPropagation();
    if (saving || gesture || !canSort()) return;
    const entry = handle.closest('.session-row[data-session-id]');
    if (!entry?.dataset.sessionId) return;
    const group = groupOf(entry);
    const direction = event.key === 'ArrowUp' ? -1 : 1;
    const next = group[group.indexOf(entry) + direction];
    if (!next) return;
    void commit({ id: entry.dataset.sessionId, direction }, true);
  });
  return {
    get active() {
      return !!gesture || saving;
    },
  };
}
