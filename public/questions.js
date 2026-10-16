import { t as tr, bindText, bindAttribute } from './i18n.js';

// Bridge questions have no native tool id. Keep their resolved form beside
// the assistant message that was current when the question was asked.
export function questionAnchorMessageId(run, request) {
  const messages = run?.messages;
  if (!Array.isArray(messages) || !request) return null;
  if (request.toolId) {
    const owner = messages.findLast((message) => message.tools?.some((tool) => tool.id === request.toolId));
    return owner?.id || null;
  }
  if (request.status === 'pending') return null;
  const askedAt = typeof request.createdAt === 'number' ? request.createdAt : Date.parse(request.createdAt);
  if (!Number.isFinite(askedAt)) return null;
  let anchor = null;
  for (const message of messages) {
    if (message.role !== 'assistant' || !message.id) continue;
    const messageAt =
      typeof message.timestamp === 'number' ? message.timestamp : Date.parse(message.timestamp);
    if (Number.isFinite(messageAt) && messageAt <= askedAt) anchor = message.id;
  }
  return anchor;
}

export function createQuestions({ root, api, getContext, icon }) {
  const nodes = new Map();
  const prefix = `question-${Math.random().toString(36).slice(2)}`;
  let currentRun;
  const node = (tag, className, text) => {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text) el.textContent = text;
    return el;
  };
  function update() {
    const { run, readOnly, hidden } = getContext();
    root.hidden = !!hidden;
    if (currentRun !== run?.id) {
      for (const entry of nodes.values()) entry.form.remove();
      root.replaceChildren();
      nodes.clear();
      currentRun = run?.id;
    }
    for (const request of run?.interactions || []) {
      let entry = nodes.get(request.id);
      if (!entry) {
        const form = node('form', 'agent-question');
        const label = node('div', 'question-label');
        bindText(label, () => tr('questions.title'));
        const batch = request.kind === 'questions';
        const questions = batch ? request.questions : [{
          question: request.title,
          options: (request.method === 'confirm' ? [tr('questions.yes'), tr('questions.no')] : request.options || [])
            .map((value, index) => ({ value, ...request.optionDetails?.[index] })),
        }];
        const title = node('h3', '', request.title);
        title.id = `${prefix}-${request.id}`;
        form.setAttribute('aria-labelledby', title.id);
        const fields = node('fieldset', 'question-fields');
        fields.append(node('legend', 'sr-only', request.title));
        const cards = [], drafts = questions.map(() => null);
        const multi = questions.length > 1;
        let current = 0,
          open = true;
        // Several questions: one line across the text column, ← Question 2/3 →.
        // The title itself shows the position, so there is no separate header.
        const navigation = node('div', 'question-navigation');
        navigation.setAttribute('role', 'group');
        bindAttribute(navigation, 'aria-label', () => tr('questions.navigation'));
        const arrowButton = (name, glyph, key) => {
          const button = node('button', 'question-nav-button');
          button.type = 'button';
          button.append(typeof icon === 'function' ? icon(name) : document.createTextNode(glyph));
          bindAttribute(button, 'aria-label', () => tr(key));
          return button;
        };
        const previous = arrowButton('arrow-left', '←', 'questions.previous');
        const next = arrowButton('arrow-right', '→', 'questions.next');
        if (multi) {
          title.classList.add('question-position');
          title.setAttribute('aria-live', 'polite');
          navigation.append(previous, title, next);
        }
        const progress = node('p', 'question-progress');
        progress.setAttribute('aria-live', 'polite');
        const refresh = () => {
          cards.forEach((card, index) => {
            card.fields.hidden = index !== current;
            if (!card.skip) return;
            const skipped = drafts[index]?.skipped === true;
            card.skip.setAttribute('aria-pressed', String(skipped));
            card.fields.classList.toggle('is-skipped', skipped);
            bindText(card.skipLabel, () => tr(skipped ? 'questions.skipped' : 'questions.skipQuestion'));
          });
          if (drafts.every(Boolean)) error.hidden = true;
          previous.disabled = current === 0;
          next.disabled = current === questions.length - 1;
          // Resolved: the line keeps the batch title, without arrows.
          if (multi)
            bindText(title, () =>
              open ? tr('questions.position', { current: current + 1, total: questions.length }) : request.title,
            );
          bindText(progress, () => tr('questions.progress', {
            answered: drafts.filter((answer) => answer && !answer.skipped).length,
            skipped: drafts.filter((answer) => answer?.skipped).length,
            total: questions.length,
          }));
        };
        const navigate = (index) => {
          current = Math.max(0, Math.min(questions.length - 1, index));
          refresh();
          cards[current].heading.focus({ preventScroll: true });
        };
        previous.onclick = () => navigate(current - 1);
        next.onclick = () => navigate(current + 1);
        navigation.onkeydown = (event) => {
          if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
          event.preventDefault();
          navigate(current + (event.key === 'ArrowLeft' ? -1 : 1));
        };
        questions.forEach((question, questionIndex) => {
          const card = node('fieldset', 'question-fields question-card');
          const heading = batch ? node('h3', '', question.question) : title;
          heading.tabIndex = -1;
          if (batch) {
            heading.id = `${title.id}-q${questionIndex}`;
            card.append(heading);
          }
          card.setAttribute('aria-labelledby', heading.id);
          const inputs = [];
          let input;
          question.options.forEach((option, index) => {
            if (!batch && request.allowCustom && option.value === 'Autre réponse / Other answer') return;
            const choice = node('div', 'question-choice');
            const row = node('label', 'question-option');
            const radio = node('input');
            radio.type = 'radio';
            radio.name = `${title.id}-q${questionIndex}`;
            radio.value = batch ? String(index) : option.value;
            radio.onchange = () => {
              drafts[questionIndex] = batch ? { option: index } :
                { value: request.method === 'confirm' ? index === 0 : option.value };
              if (input) input.value = '';
              refresh();
            };
            row.append(radio, node('span', '', option.label || option.value));
            choice.append(row);
            if (option.description) {
              const details = node('details', 'question-option-details');
              const summary = node('summary');
              const descriptionLabel = () =>
                tr(details.open ? 'questions.hideDescription' : 'questions.showDescription');
              bindText(summary, descriptionLabel);
              bindAttribute(summary, 'aria-label', () => `${descriptionLabel()} : ${option.label}`);
              details.ontoggle = () => {
                bindText(summary, descriptionLabel);
                bindAttribute(summary, 'aria-label', () => `${descriptionLabel()} : ${option.label}`);
              };
              details.append(summary, node('p', '', option.description));
              choice.append(details);
            }
            card.append(choice);
            inputs.push(radio);
          });
          const textAllowed = batch || request.allowCustom || ['input', 'editor'].includes(request.method);
          if (textAllowed) {
            input = node('textarea', 'question-input');
            input.rows = request.method === 'editor' ? 4 : 2;
            input.maxLength = batch ? 1000 : 10000;
            input.placeholder = batch || request.allowCustom
              ? tr('questions.other') : request.placeholder || tr('questions.answer');
            input.setAttribute('aria-label', input.placeholder);
            input.value = batch ? '' : request.prefill || '';
            if (input.value.trim()) drafts[questionIndex] = { text: input.value.trim() };
            input.oninput = () => {
              drafts[questionIndex] = input.value.trim() ? { text: input.value.trim() } : null;
              inputs.forEach((radio) => (radio.checked = false));
              refresh();
            };
            card.append(input);
          }
          let skip, skipLabel;
          if (batch) {
            // A toggle: pressed, it reads "Question skipped" with a check and the
            // choices fade. Press again, pick an option or type to answer after all.
            skip = node('button', 'question-cancel question-skip');
            skip.type = 'button';
            skipLabel = node('span');
            if (typeof icon === 'function') skip.append(icon('check', 'question-skip-icon'));
            skip.append(skipLabel);
            skip.onclick = () => {
              const skipped = drafts[questionIndex]?.skipped === true;
              drafts[questionIndex] = skipped ? null : { skipped: true };
              if (!skipped) {
                input.value = '';
                inputs.forEach((radio) => (radio.checked = false));
              }
              refresh();
            };
            card.append(skip);
          }
          cards.push({ fields: card, heading, skip, skipLabel });
          fields.append(card);
        });
        if (request.message) fields.prepend(node('p', '', request.message));
        const actions = node('div', 'question-actions');
        const submit = node('button', 'primary-button');
        submit.type = 'submit';
        bindText(submit, () => tr(batch ? 'questions.sendAnswers' : 'questions.send'));
        const cancel = node('button', 'question-cancel');
        cancel.type = 'button';
        bindText(cancel, () => tr(batch ? 'questions.skipAll' : 'questions.skip'));
        const status = node('p', 'question-status');
        status.setAttribute('role', 'status');
        const error = node('p', 'question-error');
        error.setAttribute('role', 'alert');
        error.hidden = true;
        actions.append(submit, cancel);
        form.append(label, multi ? navigation : title);
        if (batch) form.append(progress);
        form.append(fields, actions, status, error);
        const setOpen = (value) => {
          if (value === open) return;
          open = value;
          refresh();
        };
        entry = { form, fields, actions, navigation, progress, status, error, pending: false, statusKey: null };
        Object.assign(entry, { multi, previous, next, setOpen });
        refresh();
        const reply = async (response) => {
          if (entry.pending || entry.statusKey !== 'pending' || getContext().readOnly) return;
          entry.pending = true;
          fields.disabled = true;
          submit.disabled = cancel.disabled = true;
          error.hidden = true;
          try {
            await api(`/api/runs/${run.id}/interactions`, {
              method: 'POST',
              body: { id: request.id, response },
            });
          } catch (cause) {
            error.textContent = cause.message;
            error.hidden = false;
          } finally {
            entry.pending = false;
            update();
          }
        };
        form.onsubmit = (event) => {
          event.preventDefault();
          const undecided = drafts.findIndex((answer) => answer === null);
          if (undecided >= 0) {
            error.textContent = tr(batch ? 'questions.requiredAll' : 'questions.required');
            error.hidden = false;
            navigate(undecided);
            return;
          }
          if (batch) void reply({ values: drafts });
          else {
            const answer = drafts[0].text ?? drafts[0].value;
            void reply(request.method === 'confirm' ? { confirmed: answer } : { value: answer });
          }
        };
        cancel.onclick = () => void reply({ cancelled: true });
        root.append(form);
        nodes.set(request.id, entry);
      }
      const pending = request.status === 'pending' && run.status === 'running';
      entry.anchorMessageId = questionAnchorMessageId(run, request);
      entry.form.hidden = !!hidden;
      entry.statusKey = pending ? 'pending' : request.status;
      entry.form.classList.toggle('question-resolved', !pending);
      entry.fields.hidden = entry.actions.hidden = !pending;
      entry.progress.hidden = !pending;
      if (entry.multi) {
        entry.previous.hidden = entry.next.hidden = !pending;
        entry.navigation.classList.toggle('is-resolved', !pending);
        entry.setOpen(pending);
      }
      entry.fields.disabled = !!readOnly || entry.pending;
      entry.actions
        .querySelectorAll('button')
        .forEach((button) => (button.disabled = !!readOnly || entry.pending));
      if (pending)
        bindText(entry.status, () => (readOnly ? tr('questions.readOnly') : tr('questions.waiting')));
      else
        bindText(entry.status, () =>
          request.answers
            ? request.answers.map((answer) =>
                `${answer.question} — ${answer.skipped ? tr('questions.skipped') : answer.answer}`).join('\n')
            : request.status === 'answered'
              ? `${tr('questions.answered')} ${typeof request.answer === 'boolean' ? tr(request.answer ? 'questions.yes' : 'questions.no') : request.answer || ''}`
              : tr('questions.closed'),
        );
      // The transcript may be windowed, with this message offscreen.
      // Remove a resolved question from the live bottom until it mounts there.
      if (!pending && entry.form.parentNode === root && entry.anchorMessageId) entry.form.remove();
    }
  }
  function partsFor(message) {
    const run = getContext().run;
    const toolIds = new Set((message.tools || []).map((tool) => tool.id));
    return (run?.interactions || [])
      .filter(
        (request) =>
          nodes.has(request.id) &&
          ((request.toolId && toolIds.has(request.toolId)) ||
            (request.status !== 'pending' && nodes.get(request.id).anchorMessageId === message.id)),
      )
      .map((request) => ({ key: `question:${request.id}`, node: nodes.get(request.id).form }));
  }
  return { update, partsFor };
}
