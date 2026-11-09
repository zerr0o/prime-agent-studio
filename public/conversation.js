import { t as tr, bindText, bindAttribute, textNode, translateKnown } from './i18n.js';
import {
  stopKindOf,
  resolveContinueTarget,
  buildStopNotice,
} from './response-status.js';
import {
  WINDOW_DEFAULTS,
  buildBlocks,
  computeWindow,
  tailWindow,
  shouldAutoLoad,
} from './conversation-window.js';
// Presentation only: native messages and streaming events remain unchanged.
const technicalTypes = new Set([
  'agent_message',
  'async_bash_completion',
  'harness_digest',
  'ipython_state',
  'ipython_state_restored',
  'refinement_notice',
  'refinement_outcome',
  'git_state',
  // Subagent end notices (completed, no-reply, cancelled): routine, often several
  // in a row after an answer. They join the activity group instead of one card each.
  'rlm_child_terminal_notice',
  'rlm_child_completion_context',
]);
export function isTechnicalMessage(message) {
  if (message.role !== 'system' || message.error || message.isError) return false;
  return Boolean(
    message.agentMessage ||
    technicalTypes.has(message.customType) ||
    (message.customType === 'goal_context' &&
      (message.contextKind === 'continuation' ||
        (!message.contextKind && /^\[goal: continuation\](?:\r?\n|$)/.test(message.text || '')))) ||
    (!message.customType && message.text === 'RLM quiescence wait cancelled'),
  );
}
export function isEmptyCompletedAssistant(message) {
  return (
    message.role === 'assistant' &&
    message.stopReason === 'stop' &&
    !message.streaming &&
    !message.text?.trim() &&
    !message.thinking?.trim() &&
    !message.tools?.length &&
    !message.attachments?.length &&
    !message.error
  );
}

export function createConversationRenderer({
  el,
  icon,
  markdown,
  renderTool,
  makeDetails,
  dateLabel,
  copyText,
  reasoningMode,
  renderMessage,
  renderInteractions = () => [],
  windowed = false,
  window: windowOpts = {},
  codeHighlight = () => true,
}) {
  const turns = new Map();
  // Open-state carryover across same-turn prepend merges (new activity key
  // differs, but overlapping open messages keep the merged turn open so an
  // interior visible step stays mounted for exact <3px anchoring).
  let carryOpenMsgIds = null;
  let reasoningPreference = reasoningMode();
  let highlightPreference = codeHighlight();
  let resetReasoning = false;
  let previewFrame;
  const followReasoningTail = () => {
    cancelAnimationFrame(previewFrame);
    previewFrame = requestAnimationFrame(() => {
      for (const turn of turns.values())
        for (const part of turn.parts.values()) {
          if (part.preview && !part.preview.hidden && !part.node.open)
            part.preview.scrollTop = part.preview.scrollHeight;
        }
    });
  };
  const resizeObserver = new ResizeObserver(followReasoningTail);
  let observedRoot;
  const idOf = (message, index) => message.id || `history-${index}`;
  function reconcile(parent, nodes) {
    nodes.forEach((node, index) => {
      if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] || null);
    });
    while (parent.children.length > nodes.length) parent.lastElementChild.remove();
  }
  function buildActivitySteps(part, turn, messages) {
    const keep = new Set();
    const steps = messages.map((m, index) => {
      const signature = JSON.stringify(m);
      let step = part.steps.get(m.id);
      if (m.role !== 'assistant') {
        step = { node: renderMessage(m, index), signature };
        part.steps.set(m.id, step);
      } else if (!step || step.signature !== signature) {
        const node = el('div', 'activity-step');
        node.dataset.messageId = m.id;
        node.append(el('div', 'activity-step-label', () => tr('ui.etape', { value1: index + 1 })));
        if (m.thinking && reasoningPreference !== 'hidden') {
          const thinking = makeDetails(
            'thinking-block',
            `thinking:${m.id}`,
            reasoningPreference === 'expanded',
          );
          if (resetReasoning) thinking.open = reasoningPreference === 'expanded';
          const summary = el('summary');
          summary.append(
            icon('brain'),
            el('span', '', () => tr('ui.raisonnement')),
            icon('chevron', 'chevron'),
          );
          const content = el('div', 'thinking-content reasoning-markdown');
          content.append(markdown(m.thinking, { streaming: m.streaming }));
          thinking.append(summary, content);
          node.append(thinking);
        }
        for (const tool of m.tools || []) node.append(renderTool(tool, m.id));
        if (translateKnown(m.error)) node.append(el('div', 'message-error', () => translateKnown(m.error)));
        if (!m.text && m.attachments?.length)
          node.append(
            el('div', 'attachment-note', () => tr('count.attachments', { count: m.attachments.length })),
          );
        if (!m.thinking && !m.tools?.length && m.streaming)
          node.append(el('span', 'activity-waiting', () => tr('ui.l_agent_prepare_la_prochaine_etape')));
        step = { node, signature };
        part.steps.set(m.id, step);
      }
      keep.add(m.id);
      return step.node;
    });
    reconcile(part.content, steps);
    for (const id of part.steps.keys()) if (!keep.has(id)) part.steps.delete(id);
  }
  function activityPart(turn, messages) {
    const key = `activity:${messages[0].id}`;
    let part = turn.parts.get(key);
    if (!part) {
      const node = makeDetails('activity-stack', `${turn.key}:${key}`, reasoningPreference === 'expanded');
      if (resetReasoning) node.open = reasoningPreference === 'expanded';
      else if (carryOpenMsgIds && messages.some((m) => carryOpenMsgIds.has(m.id))) node.open = true;
      const summary = el('summary');
      const titles = el('span', 'activity-titles');
      const label = el('span', 'activity-label', () => tr('ui.activite_de_l_agent'));
      const count = el('span', 'activity-count');
      const status = el('span', 'activity-state');
      const symbol = el('span', 'activity-symbol');
      titles.append(label, count);
      const preview = el('div', 'activity-reasoning-preview reasoning-markdown');
      preview.setAttribute('aria-hidden', 'true');
      preview.hidden = true;
      summary.append(symbol, titles, status, icon('chevron', 'activity-chevron'), preview);
      const content = el('div', 'activity-content');
      node.append(summary, content);
      part = { node, label, count, status, symbol, content, preview, steps: new Map(), pending: null };
      node.addEventListener('toggle', () => {
        if (node.open && part.pending) {
          const pending = part.pending;
          part.pending = null;
          buildActivitySteps(part, turn, pending);
        }
      });
      turn.parts.set(key, part);
    }
    const tools = messages.flatMap((m) => m.tools || []);
    const errors =
      tools.filter((t) => t.isError).length + messages.filter((m) => translateKnown(m.error)).length;
    const running =
      messages.some((m) => m.streaming) || tools.some((t) => ['running', 'pending'].includes(t.status));
    const events = messages.filter((m) => m.role !== 'assistant').length;
    const reasoning = messages.filter((m) => m.thinking).length;
    const latest = messages.findLast((m) => m.thinking?.trim())?.thinking || '';
    part.preview.hidden = reasoningPreference !== 'preview' || !latest;
    if (!part.preview.hidden && part.latest !== latest) {
      part.preview.replaceChildren(markdown(latest));
      // The summary stays one accessible toggle; preview links are available in the full reflection.
      part.preview.querySelectorAll('a, button, input, video, audio').forEach((n) => {
        n.replaceWith(...n.childNodes);
      });
      part.preview.querySelectorAll('img').forEach((n) => n.remove());
      part.latest = latest;
    }
    bindText(
      part.count,
      () =>
        [
          tools.length ? tr('count.tools', { count: tools.length }) : '',
          reasoning ? tr('count.reflections', { count: reasoning }) : '',
          events ? tr('count.events', { count: events }) : '',
        ]
          .filter(Boolean)
          .join(' · ') || tr('ui.preparation_2'),
    );
    bindText(part.status, () =>
      errors ? tr('count.errors', { count: errors }) : running ? tr('ui.en_cours') : tr('ui.termine'),
    );
    part.node.classList.toggle('has-errors', errors > 0);
    part.node.classList.toggle('is-running', running);
    const symbolState = running ? 'running' : errors ? 'error' : 'done';
    if (part.symbol.dataset.state !== symbolState) {
      part.symbol.dataset.state = symbolState;
      part.symbol.replaceChildren(running ? el('span', 'spinner') : icon(errors ? 'alert' : 'terminal'));
    }
    // Lazy closed bodies: collapsed activity keeps summary/counts/state only.
    // Heavy step bodies (renderMessage/renderTool/markdown per grouped message)
    // build only when opened; all data stays intact in part.pending.
    part.lastMessages = messages;
    if (part.node.open) {
      part.pending = null;
      buildActivitySteps(part, turn, messages);
    } else {
      part.pending = messages;
      if (part.content.childNodes.length) part.content.replaceChildren();
    }
    return { key, node: part.node };
  }
  // Owner-scoped Continue context for one render list (or null): the gate
  // comes from render opts (root revalidates read-only / run / binding).
  // Notices render regardless; only the trailing failure may offer a CTA.
  const stopCtxFor = (messages, opts) => {
    const gate = opts?.stopContinue;
    if (!gate || typeof gate.onContinue !== 'function') return null;
    return { gate, target: resolveContinueTarget(messages, gate) };
  };
  const stopNoticeFor = (m, stopCtx) => {
    const kind = stopKindOf(m);
    if (!kind) return null;
    return buildStopNotice({ el, icon, tr }, m, kind, {
      showContinue: Boolean(stopCtx && stopCtx.target && stopCtx.target.messageId === m.id),
      onContinue: stopCtx?.gate.onContinue,
      canContinue: stopCtx?.gate.canContinue,
    });
  };
  function textPart(turn, m, stopCtx) {
    const key = `text:${m.id}`;
    const stopKind = stopKindOf(m);
    const showContinue = Boolean(stopCtx?.target && stopCtx.target.messageId === m.id);
    const signature = JSON.stringify([
      m.text,
      translateKnown(m.error),
      m.attachments,
      m.streaming,
      m.stopReason,
      stopKind,
      showContinue,
    ]);
    let part = turn.parts.get(key);
    if (!part || part.signature !== signature) {
      const node = el('div', 'assistant-text');
      node.dataset.messageId = m.id;
      if (m.text) node.append(markdown(m.text, { imageRoot: part?.node, streaming: m.streaming }));
      if (translateKnown(m.error)) node.append(el('div', 'message-error', () => translateKnown(m.error)));
      // Explicit stop notice stays OUTSIDE the collapsed activity block so
      // a thinking-only length stop remains visible when reasoning is
      // hidden or collapsed. Never auto-retries; owner-gated Continue only.
      const stopNotice = stopNoticeFor(m, stopCtx);
      if (stopNotice) node.append(stopNotice);
      if (m.attachments?.length)
        node.append(
          el('div', 'attachment-note', () => tr('count.attachments', { count: m.attachments.length })),
        );
      if (m.streaming) node.append(el('span', 'stream-caret'));
      if (m.text) {
        const actions = el('div', 'message-actions');
        const copy = el('button', '');
        copy.type = 'button';
        copy.append(
          icon('copy'),
          textNode(() => tr('ui.copier')),
        );
        copy.onclick = () => copyText(m.text, () => tr('ui.message_copie'));
        actions.append(copy);
        node.append(actions);
      }
      if (!node.childNodes.length)
        node.append(
          el('span', '', () =>
            m.stopReason === 'aborted' ? tr('ui.reponse_interrompue') : tr('ui.aucun_contenu_textuel'),
          ),
        );
      part = { node, signature };
      turn.parts.set(key, part);
    }
    return { key, node: part.node };
  }
  function assistantTurn(messages, stopCtx) {
    const key = messages[0].id;
    let turn = turns.get(key);
    if (!turn) {
      const node = el('article', 'message assistant assistant-turn');
      node.dataset.messageId = key;
      const heading = el('div', 'message-heading');
      const avatar = el('span', 'message-avatar');
      avatar.append(icon('model'));
      const model = el('span', 'message-model');
      const time = el('span', 'message-time');
      heading.append(
        avatar,
        el('span', 'message-author', () => 'Prime Agent'),
        model,
        time,
      );
      const body = el('div', 'message-body assistant-turn-body');
      node.append(heading, body);
      turn = { key, node, model, time, body, parts: new Map() };
      turns.set(key, turn);
    }
    const model = messages.find((m) => m.model)?.model;
    turn.model.hidden = !model;
    bindText(turn.model, () => (model ? String(model).split('/').pop() : ''));
    bindAttribute(turn.model, 'title', () => model || '');
    bindText(turn.time, () => dateLabel(messages[0].timestamp));
    const parts = [];
    let activity = [];
    const flush = () => {
      if (activity.length) parts.push(activityPart(turn, activity));
      activity = [];
    };
    for (const m of messages) {
      const hasTools = m.tools?.length > 0;
      if (m.role !== 'assistant') activity.push(m);
      else if (stopKindOf(m)) {
        flush();
        parts.push(textPart(turn, m, stopCtx));
        if (m.thinking || hasTools)
          activity.push({ ...m, text: '', error: undefined, attachments: [], streaming: false });
      } else if (m.text && hasTools) {
        flush();
        parts.push(textPart(turn, { ...m, error: undefined, streaming: false }, stopCtx));
        activity.push(m);
      } else if (m.text) {
        if (m.thinking) activity.push({ ...m, error: undefined, streaming: false });
        flush();
        parts.push(textPart(turn, m, stopCtx));
      } else if (m.thinking || hasTools || m.streaming) activity.push(m);
      else {
        flush();
        parts.push(textPart(turn, m, stopCtx));
      }
      // Keep the native dialog beside its tool call. Later streamed messages
      // belong after this point, including while the answer is being confirmed.
      const interactions = renderInteractions(m);
      if (interactions.length) {
        flush();
        parts.push(...interactions);
      }
    }
    flush();
    reconcile(
      turn.body,
      parts.map((p) => p.node),
    );
    const keep = new Set(parts.map((p) => p.key));
    for (const id of turn.parts.keys()) if (!keep.has(id)) turn.parts.delete(id);
    return turn.node;
  }
  function legacyRender(root, messages, opts = {}) {
    const stopCtx = stopCtxFor(messages, opts);
    if (observedRoot !== root) {
      resizeObserver.disconnect();
      resizeObserver.observe(root);
      observedRoot = root;
    }
    if (reasoningPreference !== reasoningMode()) {
      reasoningPreference = reasoningMode();
      resetReasoning = true;
      turns.clear();
    }
    if (highlightPreference !== codeHighlight()) {
      highlightPreference = codeHighlight();
      turns.clear();
    }
    const nodes = [],
      activeTurns = new Set();
    let assistant = [];
    const flush = () => {
      if (assistant.length) {
        nodes.push(assistantTurn(assistant, stopCtx));
        activeTurns.add(assistant[0].id);
        assistant = [];
      }
    };
    messages.forEach((m, index) => {
      if (isEmptyCompletedAssistant(m)) return;
      if (m.role === 'assistant' || isTechnicalMessage(m)) assistant.push({ ...m, id: idOf(m, index) });
      else {
        flush();
        nodes.push(renderMessage(m, index));
      }
    });
    flush();
    reconcile(root, nodes);
    {
      carryOpenMsgIds = null;
      const openIds = new Set();
      for (const tn of turns.values()) {
        for (const pt of tn.parts.values()) {
          if (pt.node?.open && Array.isArray(pt.lastMessages)) {
            for (const m of pt.lastMessages) if (m?.id) openIds.add(m.id);
          }
        }
      }
      if (openIds.size) carryOpenMsgIds = openIds;
      for (const key of [...turns.keys()]) if (!activeTurns.has(key)) turns.delete(key);
    }
    resetReasoning = false;
    followReasoningTail();
  }
  // ------------------------------------------------------------------
  // Windowed (bounded-DOM) mode. Opt-in via createConversationRenderer({ windowed: true }).
  // Full history stays accessible in data; only the mounted DOM window is bounded.
  // Browser find covers mounted text only (explicit limitation for parent decision).
  const wOpts = { ...WINDOW_DEFAULTS, ...(windowOpts || {}) };
  const bindingHeights = new Map();
  const rootStates = new Map();
  const heightsFor = (key) => {
    let entry = bindingHeights.get(key);
    if (!entry) {
      entry = { heights: new Map(), avg: 0 };
      bindingHeights.set(key, entry);
    }
    return entry;
  };
  // Shared windowed helpers (trim duplication; single source for tail windows,
  // spacer sums and render finish). Windowed mode runs in real browsers only.
  const estList = (blocks, entry) => {
    const avg = entry.avg || wOpts.estimateHeight;
    return blocks.map((b) => entry.heights.get(b.key) ?? avg);
  };
  const spacerFor = (est, start, end, total) => {
    let topHeight = 0;
    for (let i = 0; i < start; i += 1) topHeight += est[i] || 0;
    let bottomHeight = 0;
    for (let i = end; i < total; i += 1) bottomHeight += est[i] || 0;
    return { topHeight, bottomHeight };
  };
  const tailWinFor = (blocks, entry) => {
    const tw = tailWindow(blocks, wOpts.maxMounted);
    const est = estList(blocks, entry);
    const { topHeight } = spacerFor(est, tw.start, tw.end, blocks.length);
    return { start: tw.start, end: tw.end, topHeight, bottomHeight: 0, total: 0 };
  };
  const finishInfo = (state, win, anchorPreserved) => {
    const sc = state.scroller;
    state.prevScrollTop = sc ? sc.scrollTop : null;
    resetReasoning = false;
    followReasoningTail();
    return {
      anchorPreserved,
      scrollTop: sc ? sc.scrollTop || 0 : 0,
      start: win.start,
      end: win.end,
      total: (state.blocks || []).length,
    };
  };
  const findScroller = (root) => {
    const found = root?.closest?.('.conversation-scroll, .cvw-scroller');
    if (found) return found;
    return root?.parentElement || null;
  };
  // Full occupied height including inter-row margins (real .message
  // margin-bottom:30px). Windowed mode runs in real browsers only.
  const measureNode = (node) => {
    let h = node.getBoundingClientRect().height;
    if (!h) return 0;
    const cs = getComputedStyle(node);
    h += (parseFloat(cs.marginTop) || 0) + (parseFloat(cs.marginBottom) || 0);
    return h;
  };
  const collectPinnedKeys = (state) => {
    const pinned = new Set();
    const active = document.activeElement;
    if (active && state.root.contains(active)) {
      const holder = active.closest?.('[data-message-id]');
      const id = holder?.dataset?.messageId || holder?.getAttribute?.('data-message-id');
      if (id) {
        for (const b of state.blocks || []) {
          if (b.ids.includes(id)) pinned.add(b.key);
        }
      }
    }
    const sel = window.getSelection?.();
    const anchor = sel?.anchorNode;
    if (anchor && sel.rangeCount && !sel.isCollapsed) {
      const element = anchor.nodeType === 1 ? anchor : anchor.parentElement;
      if (element && state.root.contains(element)) {
        const holder = element.closest?.('[data-message-id]');
        const id = holder?.dataset?.messageId;
        if (id) {
          for (const b of state.blocks || []) {
            if (b.ids.includes(id)) pinned.add(b.key);
          }
        }
      }
    }
    return pinned;
  };
  const updateTopBar = (state) => {
    const bar = state.topBar;
    const opts = state.lastOpts || {};
    bar.replaceChildren();
    const done = () => {
      bar.hidden = true;
    };
    if (opts.loadingOlder) {
      bar.hidden = false;
      const status = el('div', 'conv-window-loading');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      bindText(status, () => tr('conversation_window.loading_older'));
      bar.append(status);
      return;
    }
    if (opts.olderError) {
      bar.hidden = false;
      const wrap = el('div', 'conv-window-older-error');
      const msg = el('div', 'conv-window-error-text');
      msg.textContent = String(opts.olderError);
      msg.setAttribute('role', 'alert');
      const retry = el('button', 'conv-window-retry');
      retry.type = 'button';
      bindText(retry, () => tr('conversation_window.retry_older'));
      retry.setAttribute('aria-label', String(tr('conversation_window.retry_older')));
      retry.onclick = () => triggerLoadOlder(state);
      wrap.append(msg, retry);
      bar.append(wrap);
      return;
    }
    if (opts.hasOlder) {
      bar.hidden = false;
      const btn = el('button', 'conv-window-load-older');
      btn.type = 'button';
      bindText(btn, () => tr('conversation_window.load_older'));
      btn.setAttribute('aria-label', String(tr('conversation_window.load_older')));
      if (state.inFlight) btn.disabled = true;
      btn.onclick = () => triggerLoadOlder(state);
      bar.append(btn);
      return;
    }
    done();
  };
  const triggerLoadOlder = (state) => {
    const opts = state.lastOpts || {};
    if (opts.loadingOlder || state.inFlight || typeof opts.loadOlder !== 'function') return;
    state.inFlight = true;
    updateTopBar(state);
    let result;
    try {
      result = opts.loadOlder();
    } catch {
      state.inFlight = false;
      updateTopBar(state);
      return;
    }
    Promise.resolve(result).then(
      () => {
        state.inFlight = false;
        updateTopBar(state);
      },
      () => {
        state.inFlight = false;
        updateTopBar(state);
      },
    );
  };
  const scheduleWindowUpdate = (state) => {
    if (state.rafId) return;
    state.rafId = requestAnimationFrame(() => {
      state.rafId = 0;
      applyWindowFromScroll(state);
    });
  };
  const blockNodeFor = (blocks, filtered, block, stopCtx) => {
    if (block.kind === 'single') {
      const f = filtered[block.start];
      return renderMessage(f.msg, f.origIndex);
    }
    const slice = filtered.slice(block.start, block.end).map((f) => ({ ...f.msg, id: f.id }));
    return assistantTurn(slice, stopCtx);
  };
  // Windowed mode runs in real browsers only: document/Elements/ResizeObserver
  // are guaranteed, so mount/scroll/style errors must surface, never hide.
  const mountWindow = (state, win) => {
    const { filtered, blocks } = state;
    const nextKeys = [];
    const nextNodes = [];
    for (let i = win.start; i < win.end; i += 1) {
      const block = blocks[i];
      nextKeys.push(block.key);
      nextNodes.push(blockNodeFor(blocks, filtered, block, state.stopCtx));
    }
    const oldNodes = state.mountedNodes || [];
    const oldKeys = state.mountedKeys || [];
    const nextSet = new Set(nextKeys);
    for (let i = 0; i < oldNodes.length; i += 1) {
      if (!nextSet.has(oldKeys[i])) oldNodes[i].remove();
    }
    const root = state.root;
    const topSpacer = state.topSpacer;
    const bottomSpacer = state.bottomSpacer;
    // Root order: [topBar, topSpacer, ...windowNodes, bottomSpacer].
    for (let i = 0; i < nextNodes.length; i += 1) {
      const want = nextNodes[i];
      let current = topSpacer.nextSibling;
      for (let k = 0; k < i; k += 1) current = current ? current.nextSibling : null;
      if (current !== want) root.insertBefore(want, current || bottomSpacer);
    }
    const wanted = new Set(nextNodes);
    let cursor = topSpacer.nextSibling;
    while (cursor && cursor !== bottomSpacer) {
      const next = cursor.nextSibling;
      if (!wanted.has(cursor)) cursor.remove();
      cursor = next;
    }
    state.mountedNodes = nextNodes;
    state.mountedKeys = nextKeys;
    state.winStart = win.start;
    state.winEnd = win.end;
    // Spacers keep scroller.scrollHeight truthful for atBottom/scrollBottom.
    state.topSpacer.style.height = `${Math.max(0, Math.round(win.topHeight))}px`;
    state.bottomSpacer.style.height = `${Math.max(0, Math.round(win.bottomHeight))}px`;
    state.topSpacer.setAttribute('aria-hidden', 'true');
    state.bottomSpacer.setAttribute('aria-hidden', 'true');
  };
  const refreshHeights = (state) => {
    const entry = heightsFor(state.bindingKey);
    let changed = false;
    for (let i = 0; i < (state.mountedNodes || []).length; i += 1) {
      const key = (state.mountedKeys || [])[i];
      const h = measureNode(state.mountedNodes[i]);
      if (h > 0 && entry.heights.get(key) !== h) {
        entry.heights.set(key, h);
        changed = true;
      }
    }
    if (changed || !entry.avg) {
      let sum = 0;
      let count = 0;
      for (const h of entry.heights.values()) {
        sum += h;
        count += 1;
      }
      entry.avg = count ? sum / count : wOpts.estimateHeight;
    }
    return entry;
  };
  const recomputeSpacers = (state) => {
    const entry = heightsFor(state.bindingKey);
    const est = estList(state.blocks || [], entry);
    const { topHeight, bottomHeight } = spacerFor(
      est,
      state.winStart || 0,
      state.winEnd || 0,
      (state.blocks || []).length,
    );
    state.topSpacer.style.height = `${Math.max(0, Math.round(topHeight))}px`;
    state.bottomSpacer.style.height = `${Math.max(0, Math.round(bottomHeight))}px`;
    return { topHeight, bottomHeight };
  };
  const getOrCreateRootState = (root) => {
    let state = rootStates.get(root);
    if (state) return state;
    const topBar = document.createElement('div');
    topBar.className = 'conv-window-topbar';
    topBar.hidden = true;
    const topSpacer = document.createElement('div');
    topSpacer.className = 'conv-window-top-spacer';
    topSpacer.setAttribute('aria-hidden', 'true');
    const bottomSpacer = document.createElement('div');
    bottomSpacer.className = 'conv-window-bottom-spacer';
    bottomSpacer.setAttribute('aria-hidden', 'true');
    topSpacer.style.height = '0px';
    bottomSpacer.style.height = '0px';
    const initialScroller = findScroller(root);
    // Single anchoring owner (manual virtualizer): disable native
    // overflow-anchor on the owned scroller to prevent delayed double shifts.
    // Preserve the inline value; restore on destroy. Legacy non-windowed mode
    // never touches it (native behavior unchanged there).
    let prevOverflowAnchor = null;
    if (initialScroller) {
      prevOverflowAnchor = initialScroller.style.getPropertyValue('overflow-anchor');
      initialScroller.style.setProperty('overflow-anchor', 'none');
    }
    state = {
      root,
      scroller: initialScroller,
      prevOverflowAnchor,
      topBar,
      topSpacer,
      bottomSpacer,
      bindingKey: null,
      blocks: [],
      filtered: [],
      mountedNodes: [],
      mountedKeys: [],
      winStart: 0,
      winEnd: 0,
      prevScrollTop: null,
      inFlight: false,
      rafId: 0,
      ro: null,
      lastOpts: {},
      needBottomSnap: true,
      scrollHandler: null,
    };
    const onScroll = () => {
      const scroller = state.scroller;
      if (!scroller) return;
      const top = scroller.scrollTop;
      const prev = state.prevScrollTop;
      if (
        shouldAutoLoad({
          scrollTop: top,
          prevScrollTop: prev,
          hasOlder: Boolean(state.lastOpts.hasOlder),
          loadingOlder: Boolean(state.lastOpts.loadingOlder),
          inFlight: state.inFlight,
          topThreshold: wOpts.topThreshold,
        })
      ) {
        triggerLoadOlder(state);
      }
      state.prevScrollTop = top;
      scheduleWindowUpdate(state);
    };
    state.scrollHandler = onScroll;
    state.scroller?.addEventListener('scroll', onScroll, { passive: true });
    const ro = new ResizeObserver(() => scheduleWindowUpdate(state));
    if (state.scroller) ro.observe(state.scroller);
    ro.observe(root);
    state.ro = ro;
    rootStates.set(root, state);
    return state;
  };
  const applyWindowFromScroll = (state) => {
    if (!state.blocks || !state.blocks.length) return;
    const scroller = state.scroller;
    if (!scroller) return;
    const scrollTop = scroller.scrollTop;
    const viewportHeight = scroller.clientHeight || 0;
    if (!viewportHeight) return;
    const entry = heightsFor(state.bindingKey);
    const pinned = collectPinnedKeys(state);
    const win = computeWindow(state.blocks, {
      scrollTop,
      viewportHeight,
      heights: entry.heights,
      avgHeight: entry.avg,
      estimateHeight: wOpts.estimateHeight,
      overscanPx: wOpts.overscanPx,
      maxMounted: wOpts.maxMounted,
      pinnedKeys: pinned,
    });
    if (win.start === state.winStart && win.end === state.winEnd) {
      // Same window: only spacer estimates refined (measured heights, avg).
      // Preserve detached reading by the top-spacer delta; bottom follow
      // still snaps. User-scroll slides change the window below, not here.
      const topBefore = parseFloat(state.topSpacer.style.height) || 0;
      const scrollBefore = scroller.scrollTop;
      const wasBottomSame = scroller.scrollHeight - scrollBefore - viewportHeight < 3;
      recomputeSpacers(state);
      const topAfter = parseFloat(state.topSpacer.style.height) || 0;
      if (!wasBottomSame && topAfter !== topBefore) {
        scroller.scrollTop = Math.max(0, scrollBefore + (topAfter - topBefore));
      }
      state.prevScrollTop = scroller.scrollTop;
      return;
    }
    const oldTop = scroller.scrollHeight;
    const oldScrollTop = scroller.scrollTop;
    const wasAtBottom = oldTop - oldScrollTop - viewportHeight < 3;
    mountWindow(state, win);
    refreshHeights(state);
    recomputeSpacers(state);
    // Scroll-driven windowing must not yank reading position; keep scrollTop
    // unless we were pinned to the bottom (follow owned by parent).
    if (wasAtBottom) scroller.scrollTop = scroller.scrollHeight;
    state.prevScrollTop = scroller.scrollTop;
  };
  const windowedRender = (root, messages, opts = {}) => {
    const bindingKey = opts.key ?? '__default__';
    const reset = Boolean(opts.reset);
    const state = getOrCreateRootState(root);
    // Re-discover scroller if the root moved panes.
    const liveScroller = findScroller(root);
    if (liveScroller && liveScroller !== state.scroller) {
      state.scroller?.removeEventListener('scroll', state.scrollHandler);
      if (state.scroller && state.prevOverflowAnchor !== null && state.prevOverflowAnchor !== undefined) {
        if (state.prevOverflowAnchor)
          state.scroller.style.setProperty('overflow-anchor', state.prevOverflowAnchor);
        else state.scroller.style.removeProperty('overflow-anchor');
      }
      state.scroller = liveScroller;
      state.prevOverflowAnchor = state.scroller.style.getPropertyValue('overflow-anchor');
      state.scroller.style.setProperty('overflow-anchor', 'none');
      state.scroller?.addEventListener('scroll', state.scrollHandler, { passive: true });
      state.ro?.disconnect();
      const ro = new ResizeObserver(() => scheduleWindowUpdate(state));
      ro.observe(state.scroller);
      ro.observe(root);
      state.ro = ro;
    }
    const isNewBinding = state.bindingKey !== bindingKey;
    if (isNewBinding || reset) {
      state.bindingKey = bindingKey;
      // Reviewer: bindingHeights must not grow per visited key. Retain only
      // live bindings referenced by existing roots (+ current). Parking does
      // NOT destroy state; a new key already resets cached DOM below.
      {
        const live = new Set([bindingKey]);
        for (const s of rootStates.values()) if (s.bindingKey) live.add(s.bindingKey);
        for (const k of [...bindingHeights.keys()]) if (!live.has(k)) bindingHeights.delete(k);
      }
      if (reset) {
        const entry = heightsFor(bindingKey);
        entry.heights.clear();
        entry.avg = 0;
      }
      state.prevScrollTop = null;
      state.inFlight = false;
      state.needBottomSnap = true;
      // Fresh scaffolding: [topBar, topSpacer, bottomSpacer]; window nodes follow.
      root.replaceChildren(state.topBar, state.topSpacer, state.bottomSpacer);
      state.mountedNodes = [];
      state.mountedKeys = [];
      state.winStart = 0;
      state.winEnd = 0;
    } else if (!state.topBar.isConnected) {
      // First windowed render on this root (legacy children present): reset scaffolding once.
      root.replaceChildren(state.topBar, state.topSpacer, state.bottomSpacer);
      state.mountedNodes = [];
      state.mountedKeys = [];
    }
    // Ensure scaffolding order even if parent touched the root.
    if (root.firstChild !== state.topBar) root.prepend(state.topBar);
    if (state.topBar.nextSibling !== state.topSpacer)
      root.insertBefore(state.topSpacer, state.topBar.nextSibling);
    if (root.lastChild !== state.bottomSpacer) root.append(state.bottomSpacer);
    state.lastOpts = {
      hasOlder: Boolean(opts.hasOlder),
      loadOlder: opts.loadOlder,
      loadingOlder: Boolean(opts.loadingOlder),
      olderError: opts.olderError ?? null,
    };
    if (observedRoot !== root) {
      resizeObserver.disconnect();
      resizeObserver.observe(root);
      observedRoot = root;
    }
    if (reasoningPreference !== reasoningMode()) {
      reasoningPreference = reasoningMode();
      resetReasoning = true;
      turns.clear();
      const entry = heightsFor(state.bindingKey);
      entry.heights.clear();
      entry.avg = 0;
    }
    if (highlightPreference !== codeHighlight()) {
      highlightPreference = codeHighlight();
      turns.clear();
    }
    const { filtered, blocks } = buildBlocks(messages, {
      isEmpty: isEmptyCompletedAssistant,
      isTechnical: isTechnicalMessage,
      idOf,
    });
    const scroller = state.scroller;
    const viewportHeight = scroller ? scroller.clientHeight || 0 : 0;
    const oldScrollHeight = scroller ? scroller.scrollHeight || 0 : 0;
    const oldScrollTop = scroller ? scroller.scrollTop || 0 : 0;
    let wasAtBottom = !scroller || oldScrollHeight - oldScrollTop - viewportHeight < 3;
    // Reviewer: estimated totals can fake bottom. Trust explicit parent
    // detach/attach intent for renders (parent owns outer follow).
    if (opts.follow === false) wasAtBottom = false;
    else if (opts.follow === true) wasAtBottom = true;
    // Capture previous binding state BEFORE overwriting: later growth math
    // must compare old vs new. Assigning state.blocks first makes old/new
    // identical and prepend growth reads as zero (real-app prepend bug).
    const prevBlocks = state.blocks || [];
    const prevFiltered = state.filtered || [];
    // Message-level prepend detection: block count alone misses prepends that
    // merge into the same first assistant turn (same block count, more
    // messages, earlier first id). Appends below keep the first id stable.
    const grewAtFront = (() => {
      if (!prevFiltered.length || filtered.length <= prevFiltered.length) return false;
      const oldFirst = prevFiltered[0]?.id;
      const newFirst = filtered[0]?.id;
      if (oldFirst && newFirst && oldFirst !== newFirst) return true;
      return blocks.length > prevBlocks.length && blocks[0]?.key !== prevBlocks[0]?.key;
    })();
    state.blocks = blocks;
    state.filtered = filtered;
    // Owner-scoped Continue context for the windowed path (notices need no
    // gate; the CTA needs onContinue + trailing-failure eligibility).
    state.stopCtx = stopCtxFor(messages, opts);
    {
      carryOpenMsgIds = null;
      const openIds = new Set();
      for (const tn of turns.values()) {
        for (const pt of tn.parts.values()) {
          if (pt.node?.open && Array.isArray(pt.lastMessages)) {
            for (const m of pt.lastMessages) if (m?.id) openIds.add(m.id);
          }
        }
      }
      if (openIds.size) carryOpenMsgIds = openIds;
      const keepTurns = new Set();
      for (const b of blocks) if (b.kind === 'turn') keepTurns.add(b.key);
      for (const k of [...turns.keys()]) if (!keepTurns.has(k)) turns.delete(k);
    }
    updateTopBar(state);
    const entry = heightsFor(state.bindingKey);
    const pinned = collectPinnedKeys(state);
    let win;
    let anchorPreserved = false;
    if (!blocks.length) {
      // Empty transcript (e.g. new conversation): original CSS uses
      // .messages:empty{display:none} to collapse its padding (71px). Keep
      // scaffold divs mounted only when the top bar must show (hasOlder /
      // loading / error, including filtered-empty pages with hasOlder true).
      // Otherwise clear root children; stored scaffold reinserts next render
      // via the !topBar.isConnected path below.
      const needBar = Boolean(
        state.lastOpts.hasOlder || state.lastOpts.loadingOlder || state.lastOpts.olderError,
      );
      win = { start: 0, end: 0, topHeight: 0, bottomHeight: 0, total: 0 };
      if (!needBar) {
        root.replaceChildren();
        state.mountedNodes = [];
        state.mountedKeys = [];
        state.winStart = 0;
        state.winEnd = 0;
        state.topSpacer.style.height = '0px';
        state.bottomSpacer.style.height = '0px';
        if (scroller) scroller.scrollTop = 0;
        state.needBottomSnap = false;
        return finishInfo(state, win, false);
      }
      mountWindow(state, win);
      if (scroller) scroller.scrollTop = 0;
      state.needBottomSnap = false;
      return finishInfo(state, win, false);
    }
    if (isNewBinding || reset || state.needBottomSnap) {
      const followOpt = opts.follow;
      const savedTop = Number(opts.scrollTop);
      const wantsSaved = followOpt === false && Number.isFinite(savedTop);
      if (wantsSaved && scroller && viewportHeight) {
        const at = Math.max(0, savedTop);
        const barH = state.topBar && !state.topBar.hidden ? measureNode(state.topBar) : 0;
        const base = computeWindow(blocks, {
          scrollTop: at - barH,
          viewportHeight,
          heights: entry.heights,
          avgHeight: entry.avg,
          estimateHeight: wOpts.estimateHeight,
          overscanPx: wOpts.overscanPx,
          maxMounted: wOpts.maxMounted,
          pinnedKeys: pinned,
        });
        win = base;
        mountWindow(state, win);
        refreshHeights(state);
        recomputeSpacers(state);
        scroller.scrollTop = at;
        state.needBottomSnap = false;
        return finishInfo(state, win, false);
      }
      // Tail-anchored: mount the last N blocks, spacers for the rest.
      win = tailWinFor(blocks, entry);
      mountWindow(state, win);
      refreshHeights(state);
      recomputeSpacers(state);
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
      state.needBottomSnap = false;
      return finishInfo(state, win, false);
    }
    if (!viewportHeight) {
      win = tailWinFor(blocks, entry);
      mountWindow(state, win);
      refreshHeights(state);
      recomputeSpacers(state);
      return finishInfo(state, win, false);
    }
    // Interior-leaf anchor for same-binding prepend preservation (parent:
    // block-top alone jumps within a giant expanded turn; count-based
    // grewAtFront misses same-turn merges). Records the topmost visible
    // message/step at any depth (deepest leaf preferred over outer turn),
    // robust to offsetParent/margins/gaps/topBar via rect viewport offsets.
    // prev* snapshots are pre-overwrite state.
    let anchorMsgId = null;
    let anchorOldOff = 0;
    let anchorOldBlockIdx = -1;
    let anchorNewIdx = -1;
    if (!wasAtBottom && scroller && root.isConnected) {
      {
        const sRect = scroller.getBoundingClientRect();
        const all = root.querySelectorAll('[data-message-id]');
        const visible = [];
        for (const el of all) {
          if (!el.isConnected) continue;
          const r = el.getBoundingClientRect();
          if (r.bottom > sRect.top + 1 && r.top < sRect.bottom - 1) visible.push({ el, r });
        }
        // Deepest visible first: drop ancestors with a visible descendant message.
        const leaves = visible.filter((v) => !visible.some((w) => w.el !== v.el && v.el.contains(w.el)));
        const best = leaves[0] || visible[0] || null;
        if (best) {
          anchorMsgId = best.el.dataset?.messageId || best.el.getAttribute?.('data-message-id') || null;
          anchorOldOff = best.r.top - sRect.top;
          if (anchorMsgId) {
            anchorOldBlockIdx = prevBlocks.findIndex((b) => (b.ids || []).includes(anchorMsgId));
            anchorNewIdx = blocks.findIndex((b) => (b.ids || []).includes(anchorMsgId));
            if (anchorNewIdx < 0) {
              // Saving a live answer replaces its transient id. Bridge only
              // unique same-role content; repeated answers must not be guessed.
              const previous = prevFiltered.find((f) => f.id === anchorMsgId)?.msg;
              const matches = previous?.text
                ? filtered.filter((f) => f.msg.role === previous.role && f.msg.text === previous.text)
                : [];
              if (matches.length === 1) {
                anchorMsgId = matches[0].id;
                anchorNewIdx = blocks.findIndex((b) => b.ids.includes(anchorMsgId));
              }
            }
          }
        }
      }
    }
    // Adjusted scroll position so the anchor block stays inside the new window.
    // Block-level above sums (full heights incl. margins); interior growth
    // inside the same merged turn is restored exactly via rects after mount.
    let winScrollTop = oldScrollTop;
    if (anchorMsgId && anchorNewIdx >= 0 && anchorOldBlockIdx >= 0) {
      {
        const avg = entry.avg || wOpts.estimateHeight;
        const estOld = prevBlocks.map((b) => entry.heights.get(b.key) ?? avg);
        const estNew = blocks.map((b) => entry.heights.get(b.key) ?? avg);
        let oldAbove = 0;
        for (let i = 0; i < anchorOldBlockIdx; i += 1) oldAbove += estOld[i] || 0;
        let newAbove = 0;
        for (let i = 0; i < anchorNewIdx; i += 1) newAbove += estNew[i] || 0;
        winScrollTop = oldScrollTop + (newAbove - oldAbove);
      }
    }
    const barH = state.topBar && !state.topBar.hidden ? measureNode(state.topBar) : 0;
    win = computeWindow(blocks, {
      scrollTop: winScrollTop - barH,
      viewportHeight,
      heights: entry.heights,
      avgHeight: entry.avg,
      estimateHeight: wOpts.estimateHeight,
      overscanPx: wOpts.overscanPx,
      maxMounted: wOpts.maxMounted,
      pinnedKeys: pinned,
    });
    // Guarantee the anchor block stays mounted (prepend stability, incl. merges).
    if (anchorMsgId && anchorNewIdx >= 0 && (anchorNewIdx < win.start || anchorNewIdx >= win.end)) {
      let start = Math.min(win.start, anchorNewIdx);
      let end = Math.max(win.end, anchorNewIdx + 1);
      if (end - start > wOpts.maxMounted) {
        if (anchorNewIdx < win.start) end = start + wOpts.maxMounted;
        else start = Math.max(0, end - wOpts.maxMounted);
      }
      const est = estList(blocks, entry);
      const { topHeight, bottomHeight } = spacerFor(est, start, end, blocks.length);
      win = { start, end, topHeight, bottomHeight, total: 0 };
    }
    if (wasAtBottom) {
      let start = win.start;
      const end = blocks.length;
      if (end - start > wOpts.maxMounted) start = end - wOpts.maxMounted;
      const est = estList(blocks, entry);
      const { topHeight } = spacerFor(est, start, end, blocks.length);
      win = { start, end, topHeight, bottomHeight: 0, total: 0 };
    }
    mountWindow(state, win);
    refreshHeights(state);
    recomputeSpacers(state);
    const newScrollHeight = scroller ? scroller.scrollHeight || 0 : 0;
    // Interior-leaf rect restore: the new viewport offset measures growth
    // above the anchor even when layout clamped scrollTop (margins,
    // gaps, topBar and interior steps inside a merged giant turn included).
    // Deepest visible leaf preferred; duplicates (turn+step same id) resolve
    // to the interior step. Exact to real layout (<3px).
    if (!wasAtBottom && anchorMsgId && anchorNewIdx >= 0) {
      {
        const esc = CSS.escape(anchorMsgId);
        const cands = [...root.querySelectorAll(`[data-message-id="${esc}"]`)].filter((n) => n.isConnected);
        // Deepest last: outer turn precedes its interior step in DOM order.
        let targetNode = null;
        for (let ci = cands.length - 1; ci >= 0; ci -= 1) {
          const r = cands[ci].getBoundingClientRect();
          const s0 = scroller.getBoundingClientRect();
          if (r.bottom > s0.top - 4000 && r.top < s0.bottom + 4000) {
            targetNode = cands[ci];
            break;
          }
        }
        targetNode = targetNode || cands[0] || null;
        if (targetNode) {
          const sRect = scroller.getBoundingClientRect();
          const nRect = targetNode.getBoundingClientRect();
          const newOff = nRect.top - sRect.top;
          const delta = newOff - anchorOldOff;
          if (Number.isFinite(delta)) {
            // A shorter interim window can clamp scrollTop during layout.
            // Rect deltas refer to the current viewport, not the old pixel value.
            if (Math.abs(delta) > 0.5) scroller.scrollTop = Math.max(0, scroller.scrollTop + delta);
            anchorPreserved = true;
          }
        }
      }
    }
    if (!anchorPreserved && !wasAtBottom && grewAtFront) {
      // Fallback only for prepends whose anchor message itself vanished.
      // Appends below while detached must never shift reading position.
      const delta = newScrollHeight - oldScrollHeight;
      if (delta !== 0 && scroller) {
        scroller.scrollTop = Math.max(0, oldScrollTop + delta);
        anchorPreserved = true;
      }
    } else if (wasAtBottom) {
      if (scroller) scroller.scrollTop = scroller.scrollHeight;
    }
    state.prevScrollTop = scroller ? scroller.scrollTop : null;
    resetReasoning = false;
    followReasoningTail();
    return {
      anchorPreserved,
      scrollTop: scroller ? scroller.scrollTop || 0 : 0,
      start: win.start,
      end: win.end,
      total: blocks.length,
    };
  };
  // Parking, not disposal: view panels PARK (hidden) rather than deleting the
  // registry, so do NOT call destroy on close/park — state (window, heights,
  // listeners) persists for unpark and a new key already resets cached DOM.
  // Destroy only for permanent teardown (host teardown, test cleanup).
  const destroyWindowed = (target) => {
    const restoreAnchor = (state) => {
      if (state.scroller && state.prevOverflowAnchor !== null && state.prevOverflowAnchor !== undefined) {
        if (state.prevOverflowAnchor)
          state.scroller.style.setProperty('overflow-anchor', state.prevOverflowAnchor);
        else state.scroller.style.removeProperty('overflow-anchor');
      }
    };
    if (!target) {
      for (const state of rootStates.values()) {
        state.scroller?.removeEventListener('scroll', state.scrollHandler);
        state.ro?.disconnect();
        if (state.rafId) cancelAnimationFrame(state.rafId);
        restoreAnchor(state);
      }
      rootStates.clear();
      return;
    }
    const state = rootStates.get(target);
    if (!state) return;
    state.scroller?.removeEventListener('scroll', state.scrollHandler);
    state.ro?.disconnect();
    if (state.rafId) cancelAnimationFrame(state.rafId);
    restoreAnchor(state);
    rootStates.delete(target);
  };
  return {
    render(root, messages, opts) {
      if (!windowed) {
        legacyRender(root, messages, opts || {});
        return undefined;
      }
      return windowedRender(root, messages, opts || {});
    },
    reveal(root, messageId) {
      const state = rootStates.get(root);
      if (state) {
        const index = state.blocks.findIndex((b) => b.ids.includes(messageId));
        if (index < 0) return null;
        const start = Math.max(0, index - Math.floor(wOpts.maxMounted / 2));
        const end = Math.min(state.blocks.length, start + wOpts.maxMounted);
        mountWindow(state, {
          start,
          end,
          ...spacerFor(estList(state.blocks, heightsFor(state.bindingKey)), start, end, state.blocks.length),
        });
        const turn = turns.get(state.blocks[index].key);
        for (const part of turn?.parts.values() || []) {
          if (!part.lastMessages?.some((m) => m.id === messageId)) continue;
          part.node.open = true;
          if (part.pending) {
            const messages = part.pending;
            part.pending = null;
            buildActivitySteps(part, turn, messages);
          }
        }
      }
      const node = [...root.querySelectorAll('[data-message-id]')].findLast(
        (n) => n.dataset.messageId === messageId,
      );
      if (!node) return null;
      for (let n = node; n && n !== root; n = n.parentElement) if (n.tagName === 'DETAILS') n.open = true;
      if (state) {
        refreshHeights(state);
        recomputeSpacers(state);
      }
      node.scrollIntoView({ block: 'start', behavior: 'instant' });
      node.setAttribute('tabindex', '-1');
      node.focus({ preventScroll: true });
      if (state) state.prevScrollTop = state.scroller.scrollTop;
      return node;
    },
    destroy(target) {
      destroyWindowed(target);
    },
  };
}
