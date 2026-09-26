import { t as tr, bindText, bindAttribute, textNode, translateKnown } from './i18n.js';
// Presentation only: native messages and streaming events remain unchanged.
const technicalTypes = new Set([
  'agent_message', 'async_bash_completion', 'harness_digest',
  'ipython_state', 'ipython_state_restored', 'refinement_notice', 'refinement_outcome',
  'git_state',
]);
function isTechnicalMessage(message) {
  if (message.role !== 'system' || message.error || message.isError) return false;
  return Boolean(
    message.agentMessage || technicalTypes.has(message.customType) ||
    (message.customType === 'rlm_child_terminal_notice' &&
      /^\[child-exited: cancelled child:/.test(message.text || '')) ||
    (!message.customType && message.text === 'RLM quiescence wait cancelled')
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
}) {
  const turns = new Map();
  let reasoningPreference = reasoningMode();
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
  function activityPart(turn, messages) {
    const key = `activity:${messages[0].id}`;
    let part = turn.parts.get(key);
    if (!part) {
      const node = makeDetails('activity-stack', `${turn.key}:${key}`, reasoningPreference === 'expanded');
      if (resetReasoning) node.open = reasoningPreference === 'expanded';
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
      part = { node, label, count, status, symbol, content, preview, steps: new Map() };
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
    part.preview.hidden = reasoningPreference !== 'preview' || !latest || !running;
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
          content.append(markdown(m.thinking));
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
    return { key, node: part.node };
  }
  function textPart(turn, m) {
    const key = `text:${m.id}`;
    const signature = JSON.stringify([
      m.text,
      translateKnown(m.error),
      m.attachments,
      m.streaming,
      m.stopReason,
    ]);
    let part = turn.parts.get(key);
    if (!part || part.signature !== signature) {
      const node = el('div', 'assistant-text');
      node.dataset.messageId = m.id;
      if (m.text) node.append(markdown(m.text, { imageRoot: part?.node }));
      if (translateKnown(m.error)) node.append(el('div', 'message-error', () => translateKnown(m.error)));
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
  function assistantTurn(messages) {
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
      else if (m.error || m.stopReason === 'aborted' || m.stopReason === 'error') {
        flush();
        parts.push(textPart(turn, m));
        if (m.thinking || hasTools)
          activity.push({ ...m, text: '', error: undefined, attachments: [], streaming: false });
      } else if (m.text && hasTools) {
        flush();
        parts.push(textPart(turn, { ...m, error: undefined, streaming: false }));
        activity.push(m);
      } else if (m.text) {
        if (m.thinking) activity.push({ ...m, error: undefined, streaming: false });
        flush();
        parts.push(textPart(turn, m));
      } else if (m.thinking || hasTools || m.streaming) activity.push(m);
      else {
        flush();
        parts.push(textPart(turn, m));
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
  return {
    render(root, messages) {
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
      const nodes = [],
        activeTurns = new Set();
      let assistant = [];
      const flush = () => {
        if (assistant.length) {
          nodes.push(assistantTurn(assistant));
          activeTurns.add(assistant[0].id);
          assistant = [];
        }
      };
      messages.forEach((m, index) => {
        if (isEmptyCompletedAssistant(m)) return;
        if (m.role === 'assistant' || isTechnicalMessage(m))
          assistant.push({ ...m, id: idOf(m, index) });
        else {
          flush();
          nodes.push(renderMessage(m, index));
        }
      });
      flush();
      reconcile(root, nodes);
      for (const key of turns.keys()) if (!activeTurns.has(key)) turns.delete(key);
      resetReasoning = false;
      followReasoningTail();
    },
  };
}
