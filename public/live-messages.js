import { t as tr, bindText, bindAttribute, translateKnown } from './i18n.js';
import { composerText, setComposerText } from './composer.js';
import { queuedAgentMessage } from './agent-messages.js';
const icons = {
  edit: 'M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4Z',
  delete: 'M3 6h18M9 6V4h6v2M5 6l1 14h12l1-14M10 10v6M14 10v6',
  up: 'm6 14 6-6 6 6',
  down: 'm6 10 6 6 6-6',
  switch: 'M4 7h15m-4-4 4 4-4 4M20 17H5m4-4-4 4 4 4',
};
const node = (tag, className = '', text) => {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text != null) bindText(element, () => text);
  return element;
};
function action(label, icon, click) {
  const button = node('button', 'live-queue-action');
  button.type = 'button';
  bindAttribute(button, 'title', () => translateKnown(label));
  bindAttribute(button, 'aria-label', () => translateKnown(label));
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [key, value] of Object.entries({
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.6',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  }))
    svg.setAttribute(key, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', icons[icon]);
  svg.append(path);
  button.append(svg);
  button.addEventListener('click', click);
  return button;
}
function requestId() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) crypto.getRandomValues(bytes);
  else for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 15) | 64;
  bytes[8] = (bytes[8] & 63) | 128;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
const laneLabel = (lane) => (lane === 'steering' ? tr('ui.reorienter') : tr('ui.a_la_suite'));
function queuedText(text) {
  const marker = '\n\n<prime_studio_files>\n',
    start = text.lastIndexOf(marker);
  if (start < 0 || !text.endsWith('\n</prime_studio_files>')) return text;
  try {
    const files = JSON.parse(text.slice(start + marker.length, -'\n</prime_studio_files>'.length));
    return Array.isArray(files) && files.every((file) => typeof file.name === 'string')
      ? text.slice(0, start)
      : text;
  } catch {
    return text;
  }
}

/** Native queues stay authoritative; accepted messages are never copied into the transcript here. */
export function createLiveMessages({
  api,
  getContext,
  imageComposer,
  onAccepted = () => {},
  onSent = () => {},
  onError = () => {},
  onChange = () => {},
  // Per-pane instances pass roots { form, composer, send, stop } plus text
  // accessors for their own textarea. Defaults preserve the exact primary
  // behavior (document IDs + shared composer text + host image composer).
  roots,
  text,
}) {
  const form = roots?.form || document.getElementById('composer-form');
  const composer = roots?.composer || document.getElementById('composer');
  const send = roots?.send || document.getElementById('send-button');
  const stop = roots?.stop || document.getElementById('stop-button');
  const scoped = Boolean(roots?.form && roots?.composer && roots?.send && roots?.stop);
  const getText = text?.get || composerText;
  const setText = text?.set || setComposerText;
  const toolbar = form?.querySelector('.composer-toolbar');
  if (!form || !composer || !send || !stop || !toolbar)
    throw new Error(tr('ui.le_formulaire_de_conversation_est_introuvable'));

  const actions = node('div', 'live-message-actions');
  if (!scoped) actions.id = 'live-message-actions';
  else actions.setAttribute('data-cvw', 'actions');
  actions.append(stop, send);
  toolbar.append(actions);
  form.classList.add('has-live-messages');

  const modeRow = node('div', 'live-mode-row');
  if (!scoped) modeRow.id = 'live-mode-row';
  else modeRow.setAttribute('data-cvw', 'moderow');
  modeRow.hidden = true;
  modeRow.append(node('span', 'live-mode-label', () => tr('ui.ce_message')));
  const modes = node('div', 'live-mode-options');
  modes.setAttribute('role', 'group');
  bindAttribute(modes, 'aria-label', () => tr('ui.envoyer_pendant_l_execution'));
  const modeButtons = new Map();
  for (const [value, label] of [
    ['steer', tr('ui.reorienter')],
    ['follow_up', tr('ui.a_la_suite')],
  ]) {
    const button = node('button', 'live-mode-option', () =>
      laneLabel(value === 'steer' ? 'steering' : 'followUp'),
    );
    button.type = 'button';
    button.dataset.mode = value;
    bindAttribute(button, 'title', () =>
      value === 'steer'
        ? tr('ui.transmettre_une_nouvelle_consigne_a_l_agent_en_cours')
        : tr('ui.ajouter_un_message_apres_la_reponse_en_cours'),
    );
    button.addEventListener('click', () => {
      mode = value;
      try {
        sessionStorage.setItem('prime-studio-live-mode', mode);
      } catch {
        /* Optional local preference. */
      }
      update();
    });
    modes.append(button);
    modeButtons.set(value, button);
  }
  modeRow.append(modes);
  toolbar.before(modeRow);
  const status = node('p', 'live-message-status');
  if (!scoped) status.id = 'live-message-status';
  else status.setAttribute('data-cvw', 'status');
  status.hidden = true;
  status.setAttribute('role', 'status');
  form.append(status);

  const queue = node('details', 'live-queue');
  if (!scoped) queue.id = 'live-queue';
  else queue.setAttribute('data-cvw', 'queue');
  queue.hidden = true;
  const summary = node('summary', 'live-queue-summary');
  summary.append(node('span', '', () => tr('ui.messages_en_attente')));
  const countLabel = node('span', 'live-queue-count', () => '0');
  summary.append(
    countLabel,
    node('span', 'live-queue-chevron', () => '›'),
  );
  queue.append(summary);
  const queueList = node('div', 'live-queue-list');
  if (!scoped) queueList.id = 'live-queue-list';
  else queueList.setAttribute('data-cvw', 'queuelist');
  queue.append(queueList);
  const queueError = node('p', 'live-queue-error');
  queueError.hidden = true;
  queueError.setAttribute('role', 'alert');
  queue.append(queueError);

  const editor = node('form', 'live-queue-editor');
  if (!scoped) editor.id = 'live-queue-editor';
  else editor.setAttribute('data-cvw', 'editor');
  editor.hidden = true;
  const editorLabel = node('label', '', () => tr('ui.modifier_le_message_en_attente'));
  if (!scoped) editorLabel.htmlFor = 'live-queue-edit-text';
  const editorText = node('textarea');
  if (!scoped) editorText.id = 'live-queue-edit-text';
  else editorText.setAttribute('data-cvw', 'edittext');
  editorText.rows = 3;
  editorText.maxLength = 200000;
  const editorFooter = node('div', 'live-queue-editor-footer');
  const editorLane = node('select');
  bindAttribute(editorLane, 'aria-label', () => tr('ui.quand_transmettre_le_message_modifie'));
  for (const lane of ['steering', 'followUp']) {
    const option = node('option', '', () => laneLabel(lane));
    option.value = lane;
    editorLane.append(option);
  }
  const editorCancel = node('button', 'live-queue-cancel', () => tr('ui.annuler'));
  editorCancel.type = 'button';
  const editorSave = node('button', 'live-queue-save', () => tr('ui.enregistrer'));
  editorSave.type = 'submit';
  const editorNotice = node('p', 'live-queue-edit-notice');
  editorNotice.hidden = true;
  editorNotice.setAttribute('role', 'status');
  editorFooter.append(editorLane, editorCancel, editorSave);
  editor.append(editorLabel, editorText, editorNotice, editorFooter);
  queue.append(editor);
  form.before(queue);

  let contextKey = '',
    generation = 0,
    snapshot = null,
    snapshotError = '',
    queueSignature = '',
    mode = 'steer';
  let sending = false,
    mutating = false,
    edit = null,
    destroyed = false,
    pollTimer = null,
    inFlight = null,
    controller = null,
    retry = null;
  let wasOnline = false,
    draftRevision = 0;
  try {
    if (sessionStorage.getItem('prime-studio-live-mode') === 'follow_up') mode = 'follow_up';
  } catch {
    /* Optional local preference. */
  }
  const context = () => getContext() || {};
  const keyOf = (value) =>
    value.sessionId && value.cwd ? `${value.sessionId}\n${value.cwd}\n${value.runId || 'idle'}` : '';
  const path = (value) => `/api/live/sessions/${encodeURIComponent(value.sessionId)}`;
  const items = (lane) => (lane === 'steering' ? snapshot?.steering || [] : snapshot?.followUps || []);
  const count = () => items('steering').length + items('followUp').length;
  const editable = () =>
    snapshot?.available === true && !context().readOnly && context().online && !context().stopping;
  const matchesEdit = () => edit && items(edit.lane)[edit.index] === edit.expectedText;
  function updateEditor() {
    editor.hidden = !edit;
    if (!edit) return;
    const matched = matchesEdit();
    editorSave.disabled = !matched || !editorText.value.trim() || !editable() || mutating;
    editorCancel.disabled = mutating;
    editorLane.disabled = mutating;
    editorText.disabled = mutating;
    editorNotice.hidden = matched;
    bindText(editorNotice, () =>
      matched ? '' : tr('ui.la_file_a_change_votre_modification_reste_ici_ce_message_ne_peut'),
    );
  }
  function openEditor(item) {
    if (mutating) return;
    edit = item;
    editorText.value = queuedText(item.expectedText);
    editorLane.value = item.lane;
    queue.open = true;
    queueError.hidden = true;
    updateEditor();
    editorText.focus();
  }
  function renderQueue() {
    queue.hidden = count() === 0 && !edit;
    bindText(countLabel, () => String(count()));
    const signature = JSON.stringify([snapshot?.steering, snapshot?.followUps, editable(), mutating]);
    if (signature !== queueSignature) {
      queueSignature = signature;
      queueList.replaceChildren();
      for (const lane of ['steering', 'followUp']) {
        const messages = items(lane);
        if (!messages.length) continue;
        const section = node('section', 'live-queue-lane');
        section.dataset.lane = lane;
        section.append(node('h3', '', () => laneLabel(lane)));
        const list = node('ol');
        messages.forEach((text, index) => {
          const item = { lane, index, expectedText: text };
          const row = node('li', 'live-queue-item');
          row.dataset.lane = lane;
          row.dataset.index = String(index);
          const agent = queuedAgentMessage(text);
          if (agent) {
            row.classList.add('live-queue-agent');
            const heading = node('div', 'live-queue-agent-heading');
            heading.append(
              node('strong', '', () => agent.name || tr('agents.message_title')),
              node('span', 'agent-message-badge', () => tr('agents.protected')),
            );
            row.append(
              heading,
              node('p', 'live-queue-text', () => agent.text),
            );
            list.append(row);
            return;
          }
          row.append(node('p', 'live-queue-text', () => queuedText(text)));
          if (queuedText(text) !== text)
            row.append(node('small', 'live-queue-file-note', () => tr('ui.fichier_s_joint_s_conserve_s')));
          const buttons = node('div', 'live-queue-item-actions');
          const editButton = action(
            () => tr('ui.modifier_le_message'),
            'edit',
            () => openEditor(item),
          );
          const switchButton = action(
            () => (lane === 'steering' ? tr('ui.passer_a_la_suite') : tr('ui.reorienter_avec_ce_message')),
            'switch',
            () =>
              void mutate(item, {
                type: 'replace',
                text,
                lane: lane === 'steering' ? 'followUp' : 'steering',
              }),
          );
          const up = action(
            () => tr('ui.monter_le_message'),
            'up',
            () => void mutate(item, { type: 'move', direction: -1 }),
          );
          const down = action(
            () => tr('ui.descendre_le_message'),
            'down',
            () => void mutate(item, { type: 'move', direction: 1 }),
          );
          const remove = action(
            () => tr('ui.retirer_le_message'),
            'delete',
            () => void mutate(item, { type: 'delete' }),
          );
          for (const button of [editButton, switchButton, up, down, remove])
            button.disabled = !editable() || mutating;
          up.disabled ||= index === 0;
          down.disabled ||= index === messages.length - 1;
          buttons.append(editButton, switchButton, up, down, remove);
          row.append(buttons);
          list.append(row);
        });
        section.append(list);
        queueList.append(section);
      }
    }
    updateEditor();
  }
  function schedulePoll() {
    clearTimeout(pollTimer);
    pollTimer = null;
    const current = context();
    if (!destroyed && contextKey && current.online && (current.running || count() > 0))
      pollTimer = setTimeout(() => {
        pollTimer = null;
        void refresh();
      }, 1500);
  }
  async function refresh() {
    if (destroyed || !contextKey || !context().online) return null;
    if (inFlight) return inFlight;
    const current = { ...context() },
      token = generation;
    controller = new AbortController();
    const work = (async () => {
      try {
        const result = await api(`${path(current)}?cwd=${encodeURIComponent(current.cwd)}`, {
          signal: controller.signal,
        });
        if (destroyed || token !== generation) return null;
        snapshot = {
          ...result,
          steering: Array.isArray(result.steering) ? result.steering : [],
          followUps: Array.isArray(result.followUps) ? result.followUps : [],
        };
        snapshotError = '';
        onChange(snapshot, current);
        return snapshot;
      } catch (error) {
        if (destroyed || token !== generation || error.name === 'AbortError') return null;
        snapshot = { ...(snapshot || {}), available: false };
        snapshotError =
          error.status === 404
            ? tr('ui.l_envoi_pendant_l_execution_n_est_pas_disponible_pour_cette_sessi')
            : tr('ui.connexion_a_la_file_de_messages_interrompue_nouvelle_tentative_en');
        return null;
      } finally {
        if (token === generation && !destroyed) {
          inFlight = null;
          update();
          schedulePoll();
        }
      }
    })();
    inFlight = work;
    return work;
  }
  async function mutate(item, mutation) {
    if (mutating || !editable()) return false;
    const current = { ...context() },
      token = generation;
    mutating = true;
    queueError.hidden = true;
    renderQueue();
    try {
      await api(`${path(current)}/queue`, { method: 'POST', body: { cwd: current.cwd, ...item, mutation } });
      if (destroyed || token !== generation) return true;
      if (
        edit &&
        edit.lane === item.lane &&
        edit.index === item.index &&
        edit.expectedText === item.expectedText
      )
        edit = null;
      // Read the authoritative queue after the mutation, not an optimistic reordered copy.
      if (inFlight) await inFlight;
      await refresh();
      return true;
    } catch (error) {
      if (destroyed || token !== generation) return false;
      bindText(
        queueError,
        () => translateKnown(error.message) || tr('ui.le_message_n_a_pas_pu_etre_modifie'),
      );
      queueError.hidden = false;
      onError(error);
      if (error.status === 409) {
        if (inFlight) await inFlight;
        await refresh();
      }
      return false;
    } finally {
      if (token === generation && !destroyed) {
        mutating = false;
        renderQueue();
        update();
      }
    }
  }
  async function submitDraft() {
    const current = { ...context() };
    if (!current.running) return false;
    const imageDraft = imageComposer?.snapshot();
    const images = imageDraft?.images || [];
    const files = imageDraft?.files || [];
    const message =
      getText().trim() || (images.length || files.length ? tr('ui.analyse_les_pieces_jointes') : '');
    if (!message || sending || !editable() || current.stopping || imageComposer?.blocked()) return true;
    const originalDraft = getText(),
      originalRevision = draftRevision,
      selectedMode = mode,
      token = generation;
    const fingerprint = `${contextKey}\n${selectedMode}\n${message}\n${JSON.stringify([images, files])}`;
    if (!retry || retry.fingerprint !== fingerprint) retry = { fingerprint, requestId: requestId() };
    sending = true;
    update();
    try {
      const result = await api(`${path(current)}/messages`, {
        method: 'POST',
        body: {
          cwd: current.cwd,
          message,
          mode: selectedMode,
          requestId: retry.requestId,
          ...(images.length ? { images } : {}),
          ...(files.length ? { files } : {}),
        },
      });
      if (imageDraft) imageComposer.accepted(imageDraft);
      const draftUnchanged = getText() === originalDraft && draftRevision === originalRevision;
      onAccepted({ key: current.draftKey, text: originalDraft });
      if (destroyed || token !== generation) return true;
      retry = null;
      if (draftUnchanged) setText('');
      onSent(result, { context: current, message, mode: selectedMode, draftUnchanged });
      if (inFlight) await inFlight;
      await refresh();
      return true;
    } catch (error) {
      if (destroyed || token !== generation) return true;
      onError(error);
      if (error.status === 404 || error.status === 409) {
        if (inFlight) await inFlight;
        await refresh();
      }
      return true;
    } finally {
      if (token === generation && !destroyed) {
        sending = false;
        update();
      }
    }
  }
  function update() {
    if (destroyed) return;
    const current = context(),
      key = keyOf(current);
    if (key !== contextKey) {
      controller?.abort();
      clearTimeout(pollTimer);
      pollTimer = null;
      generation++;
      contextKey = key;
      snapshot = null;
      snapshotError = '';
      queueSignature = '';
      sending = false;
      mutating = false;
      edit = null;
      retry = null;
      inFlight = null;
      queueError.hidden = true;
      if (key && current.online) queueMicrotask(() => void refresh());
    }
    if (!current.online) {
      clearTimeout(pollTimer);
      pollTimer = null;
    } else if (!wasOnline && key) queueMicrotask(() => void refresh());
    wasOnline = Boolean(current.online);
    const active = Boolean(current.running),
      hasDraft = Boolean(getText().trim() || imageComposer?.hasImages());
    // Keep the controls still while the first click opens an attachment picker.
    // Revealing this row on focus moves the button between pointerdown and click.
    modeRow.hidden = !active || current.readOnly || !hasDraft;
    for (const [value, button] of modeButtons) {
      button.setAttribute('aria-pressed', String(mode === value));
      button.disabled = sending || current.stopping || current.readOnly;
    }
    if (active) {
      stop.hidden = false;
      stop.disabled = Boolean(current.stopping || current.readOnly || !current.online);
      send.hidden = !hasDraft;
      send.disabled = !hasDraft || sending || !editable() || imageComposer?.blocked();
      bindAttribute(send, 'title', () =>
        mode === 'steer' ? tr('ui.reorienter_l_agent') : tr('ui.envoyer_a_la_suite'),
      );
      bindAttribute(send, 'aria-label', () => send.title);
    } else {
      stop.hidden = true;
      send.hidden = false;
      bindAttribute(send, 'title', () => tr('ui.envoyer_le_message'));
      bindAttribute(send, 'aria-label', () => send.title);
    }
    actions.classList.toggle('has-two-actions', active && hasDraft);
    form.classList.toggle('has-live-draft', active && hasDraft);
    const showStatus = active && hasDraft && !sending && snapshot?.available !== true;
    status.hidden = !showStatus;
    bindText(status, () =>
      showStatus
        ? snapshotError ||
          (current.sessionId ? tr('ui.connexion_a_la_session') : tr('ui.preparation_de_la_session'))
        : '',
    );
    renderQueue();
    if (!pollTimer && !inFlight) schedulePoll();
  }
  const onInput = () => {
    draftRevision++;
    updateEditor();
    update();
  };
  const onFocus = () => update();
  const onBlur = () => queueMicrotask(update);
  composer.addEventListener('input', onInput);
  form.addEventListener('focusin', onFocus);
  form.addEventListener('focusout', onBlur);
  editorText.addEventListener('input', updateEditor);
  editorCancel.addEventListener('click', () => {
    edit = null;
    renderQueue();
  });
  editor.addEventListener('submit', (event) => {
    event.preventDefault();
    if (edit && !editorSave.disabled)
      void mutate(edit, { type: 'replace', text: editorText.value.trim(), lane: editorLane.value });
  });
  update();
  return {
    update,
    submitDraft,
    refresh,
    destroy() {
      destroyed = true;
      controller?.abort();
      clearTimeout(pollTimer);
      composer.removeEventListener('input', onInput);
      form.removeEventListener('focusin', onFocus);
      form.removeEventListener('focusout', onBlur);
      toolbar.append(stop, send);
      actions.remove();
      modeRow.remove();
      status.remove();
      queue.remove();
      form.classList.remove('has-live-messages', 'has-live-draft');
    },
  };
}
