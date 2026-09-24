import { t as tr, bindText, bindAttribute, translateKnown } from './i18n.js';
// The textarea edits ordinary arguments. Selected commands are separate,
// removable tokens; serialization remains plain text for drafts and Prime Agent.
// Several skill chips can stack (multi-skill). Other sources stay single.
let commands = [];
let wrap, chip, label, remove;
let extraChips = [];
let selectedAll = false;
const input = () => document.getElementById('composer');
const prefix = () => commands.map((entry) => `/${entry.name} `).join('');

export const composerCommand = () => commands[0] || null;
export const composerText = () => prefix() + input().value;

function render() {
  if (!chip) return;
  const active = commands[0] || null;
  chip.hidden = !active;
  if (wrap) wrap.hidden = commands.length === 0;
  input().closest('.composer-input-row')?.classList.toggle('has-command-chip', commands.length > 0);
  if (active) {
    chip.dataset.kind =
      active.source === 'skill' ? 'skill' : active.source === 'prompt' ? 'prompt' : 'command';
    bindText(label, () => `/${active.name}`);
    bindAttribute(chip, 'title', () => `${label.textContent} · ${translateKnown(active.description) || ''}`);
    bindAttribute(remove, 'aria-label', () => tr('ui.retirer_la_commande', { value1: active.name }));
    input().setAttribute('aria-describedby', 'composer-command-label');
  } else input().removeAttribute('aria-describedby');
  chip.classList.toggle('is-selected', selectedAll);
  for (const extra of extraChips) extra.node.classList.toggle('is-selected', selectedAll);
}

function syncExtras() {
  if (!wrap) return;
  for (const extra of extraChips) extra.node.remove();
  extraChips = [];
  commands.slice(1).forEach((entry, index) => {
    const node = document.createElement('span');
    node.className = 'composer-command composer-command-extra';
    node.dataset.kind = entry.source === 'skill' ? 'skill' : entry.source === 'prompt' ? 'prompt' : 'command';
    const name = document.createElement('span');
    name.className = 'composer-command-label';
    bindText(name, () => `/${entry.name}`);
    const del = document.createElement('button');
    del.type = 'button';
    bindText(del, () => '×');
    bindAttribute(del, 'aria-label', () => tr('ui.retirer_la_commande', { value1: entry.name }));
    bindAttribute(node, 'title', () => `/${entry.name} · ${translateKnown(entry.description) || ''}`);
    del.onclick = () => clearAt(index + 1);
    node.append(name, del);
    wrap.append(node);
    extraChips.push({ node, remove: del });
  });
}

function clearAt(index) {
  const textarea = input();
  if (!commands[index] || textarea.disabled) return;
  commands.splice(index, 1);
  selectedAll = false;
  syncExtras();
  render();
  textarea.focus({ preventScroll: true });
  textarea.setSelectionRange(0, 0);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
}

export function setComposerText(text, { retainCommand = true } = {}) {
  text = String(text || '');
  if (commands.length && retainCommand && text.startsWith(prefix()))
    input().value = text.slice(prefix().length);
  else {
    commands = [];
    input().value = text;
    syncExtras();
  }
  selectedAll = false;
  render();
}

export function selectComposerCommand(value, args = '') {
  const entry = { name: value.name, source: value.source, description: value.description };
  const allSkills = commands.length === 0 || commands.every((item) => item.source === 'skill');
  if (entry.source === 'skill' && allSkills) {
    if (!commands.some((item) => item.name === entry.name)) commands.push(entry);
    input().value = args;
  } else {
    commands = [entry];
    input().value = args;
  }
  selectedAll = false;
  syncExtras();
  render();
}

export function createCommandChip() {
  const textarea = input();
  wrap = document.createElement('span');
  wrap.id = 'composer-commands';
  wrap.className = 'composer-commands';
  wrap.hidden = true;
  chip = document.createElement('span');
  chip.id = 'composer-command';
  chip.className = 'composer-command';
  chip.hidden = true;
  label = document.createElement('span');
  label.id = 'composer-command-label';
  label.className = 'composer-command-label';
  remove = document.createElement('button');
  remove.id = 'remove-command';
  remove.type = 'button';
  bindText(remove, () => '×');
  chip.append(label, remove);
  wrap.append(chip);
  textarea.before(wrap);
  const changed = () => textarea.dispatchEvent(new Event('input', { bubbles: true }));
  function clear() {
    if (!commands.length || textarea.disabled) return;
    // Backspace at the textarea start removes the last stacked chip.
    commands.pop();
    selectedAll = false;
    syncExtras();
    render();
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(0, 0);
    changed();
  }
  function clearFirst() {
    if (!commands.length || textarea.disabled) return;
    commands.shift();
    selectedAll = false;
    // After removing the first chip, the next chip keeps the stable ids.
    syncExtras();
    render();
    textarea.focus({ preventScroll: true });
    textarea.setSelectionRange(0, 0);
    changed();
  }
  remove.onclick = clearFirst;
  remove.onkeydown = (event) => {
    if (['Backspace', 'Delete'].includes(event.key)) {
      event.preventDefault();
      clearFirst();
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault();
      textarea.focus();
      textarea.setSelectionRange(0, 0);
    }
  };
  function atStart() {
    return commands.length > 0 && !textarea.selectionStart && !textarea.selectionEnd;
  }
  textarea.addEventListener(
    'keydown',
    (event) => {
      if (!commands.length || event.isComposing || textarea.disabled) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'a') {
        event.preventDefault();
        selectedAll = true;
        textarea.select();
        render();
      } else if (event.key === 'Backspace' && !event.ctrlKey && !event.metaKey && atStart()) {
        event.preventDefault();
        clear();
      } else if (event.key === 'ArrowLeft' && !event.shiftKey && atStart()) {
        event.preventDefault();
        remove.focus();
      } else if (
        !['Control', 'Meta', 'Shift', 'c', 'x'].includes(event.key) &&
        !event.ctrlKey &&
        !event.metaKey
      ) {
        // beforeinput performs replacement of a select-all, including the chip.
        if (event.key.startsWith('Arrow') || event.key === 'Escape') {
          selectedAll = false;
          render();
        }
      }
    },
    true,
  );
  textarea.addEventListener('beforeinput', (event) => {
    if (!commands.length || textarea.disabled) return;
    if (selectedAll && textarea.selectionStart === 0 && textarea.selectionEnd === textarea.value.length) {
      commands = [];
      selectedAll = false;
      syncExtras();
      render();
    } else if (event.inputType === 'deleteContentBackward' && atStart()) {
      event.preventDefault();
      clear();
    }
  });
  for (const type of ['copy', 'cut'])
    textarea.addEventListener(type, (event) => {
      if (
        !commands.length ||
        !selectedAll ||
        textarea.selectionStart !== 0 ||
        textarea.selectionEnd !== textarea.value.length ||
        !event.clipboardData
      )
        return;
      event.preventDefault();
      event.clipboardData.setData('text/plain', composerText());
      if (type === 'cut' && !textarea.disabled) {
        setComposerText('');
        changed();
      }
    });
  textarea.addEventListener('pointerdown', () => {
    selectedAll = false;
    render();
  });
  textarea.addEventListener('input', () => {
    selectedAll = false;
    render();
  });
  return {
    update() {
      remove.disabled = textarea.disabled;
      for (const extra of extraChips) extra.remove.disabled = textarea.disabled;
    },
  };
}
