import { t as tr, bindText, bindAttribute, textNode, translateKnown } from './i18n.js';
import {
  composerText,
  setComposerText,
  composerCommand,
  selectComposerCommand,
  createCommandChip,
} from './composer.js';
import { COMMAND_ALIASES as aliases, immediateCommands } from './command-definitions.js';
const node = (tag, className = '', text = '') => {
  const element = document.createElement(tag);
  element.className = className;
  bindText(element, () => text);
  return element;
};
const labels = {
  studio: 'Studio',
  native: 'Prime Agent',
  get skill() {
    return tr('commands.skill');
  },
  get prompt() {
    return tr('commands.prompt');
  },
  get extension() {
    return tr('commands.extension');
  },
};
const normalize = (text) =>
  String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

function commandTitle(command, tag = 'span') {
  const title = node(tag, 'command-title');
  const dot = node('span', 'command-dot');
  dot.dataset.kind = command.source;
  dot.setAttribute('aria-hidden', 'true');
  title.append(
    dot,
    textNode(() => `/${command.name}`),
  );
  return title;
}

export function createCommands({ api, getContext, action, onChange, onError, hasAttachments }) {
  const input = document.getElementById('composer');
  const chip = createCommandChip();
  const button = node('button', 'attach-image-button command-launcher');
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true" focusable="false"><path d="M15 4 9 20"/></svg>';
  button.id = 'open-commands';
  button.type = 'button';
  bindAttribute(button, 'title', () => tr('ui.commandes_et_skills'));
  bindAttribute(button, 'aria-label', () => button.title);
  button.setAttribute('aria-haspopup', 'dialog');
  document.querySelector('.attachment-controls').prepend(button);
  const popup = node('div', 'command-suggestions');
  popup.id = 'command-suggestions';
  popup.hidden = true;
  popup.setAttribute('role', 'listbox');
  bindAttribute(popup, 'aria-label', () => tr('ui.commandes_proposees'));
  input.setAttribute('aria-controls', popup.id);
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  const dialog = node('dialog', 'modal command-dialog');
  dialog.id = 'commands-dialog';
  dialog.setAttribute('aria-labelledby', 'commands-title');
  const header = node('div', 'command-heading');
  const title = node('h2', '', () => tr('ui.commandes_et_skills'));
  title.id = 'commands-title';
  const close = node('button', 'secondary-button', () => tr('ui.termine'));
  close.type = 'button';
  close.onclick = () => dialog.close();
  header.append(title, close);
  const intro = node('p', 'command-intro', () =>
    tr('ui.choisissez_un_raccourci_ajoutez_vos_consignes_puis_envoyez_les_sk'),
  );
  const search = node('input', 'command-search');
  search.type = 'search';
  bindAttribute(search, 'placeholder', () => tr('ui.rechercher_un_nom_ou_une_description'));
  bindAttribute(search, 'aria-label', () => tr('ui.rechercher_une_commande_ou_un_skill'));
  const filters = node('div', 'command-filters');
  const folders = node('div', 'command-folders');
  folders.hidden = true;
  const folderScope = node('select');
  folderScope.id = 'command-folder-scope';
  bindAttribute(folderScope, 'aria-label', () => tr('folders.scope'));
  for (const [value, label] of [
    ['global', 'folders.global'],
    ['project', 'folders.project'],
  ]) {
    const option = node('option', '', () => tr(label));
    option.value = value;
    folderScope.append(option);
  }
  const openFolder = node('button', 'secondary-button', () =>
    tr(getContext().remote ? 'ui.ouvrir_le_dossier_sur_le_pc' : 'ui.ouvrir_le_dossier'),
  );
  openFolder.id = 'command-open-folder';
  openFolder.type = 'button';
  const folderStatus = node('span', 'command-folder-status');
  folderStatus.setAttribute('role', 'status');
  folders.append(folderScope, openFolder, folderStatus);
  const filterButtons = new Map();
  const list = node('div', 'command-list');
  const more = node('button', 'command-more', () => tr('ui.afficher_la_suite'));
  more.type = 'button';
  more.hidden = true;
  const refresh = node('button', 'command-refresh', () => tr('ui.actualiser'));
  refresh.type = 'button';
  const note = node('p', 'command-note');
  note.setAttribute('role', 'status');
  const help = node('details', 'command-help');
  help.append(
    node('summary', '', () => tr('ui.comment_utiliser_les_skills')),
    node('p', '', () => tr('ui.un_skill_regroupe_des_instructions_et_parfois_des_scripts_skill_n')),
  );
  dialog.append(header, intro, search, filters, folders, note, list, help);
  document.body.append(popup, dialog);
  const cache = new Map();
  let catalog = null,
    catalogKey = '',
    loadedAt = 0,
    pending,
    generation = 0,
    index = 0,
    matches = [],
    filter = 'all',
    dismissed = false,
    sending = false,
    loadError = '',
    prefetchKey = '',
    prefetchTimer,
    controller,
    pageSize = 30,
    currentList = [],
    suggestionQuery = '';
  const key = () => {
    const c = getContext();
    return `${c.cwd || ''}\0${c.sessionId || ''}\0${!!c.running}`;
  };
  function hide() {
    popup.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }
  function update() {
    const context = getContext();
    chip.update();
    button.disabled = context.readOnly || !context.cwd || context.loading;
    if (catalogKey && catalogKey !== key()) {
      generation++;
      controller?.abort();
      catalog = null;
      pending = null;
      catalogKey = '';
      hide();
      if (dialog.open) dialog.close();
    }
    if (context.cwd && !context.readOnly && !context.loading && prefetchKey !== key()) {
      prefetchKey = key();
      clearTimeout(prefetchTimer);
      prefetchTimer = setTimeout(() => void load().catch(() => {}), 100);
    }
  }
  async function load({ force = false } = {}) {
    update();
    const cached = cache.get(key());
    if (!catalog && cached) {
      catalog = cached.data;
      loadedAt = cached.at;
      catalogKey = key();
    }
    if (!force && catalog && Date.now() - loadedAt < 30000) return catalog;
    if (pending) return pending;
    const c = getContext(),
      token = generation,
      requestedKey = key();
    if (!c.cwd) throw new Error(tr('ui.choisissez_un_projet_pour_voir_ses_commandes'));
    catalogKey = requestedKey;
    controller = new AbortController();
    loadError = '';
    pending = api(
      `/api/commands?cwd=${encodeURIComponent(c.cwd)}${c.sessionId ? `&sessionId=${encodeURIComponent(c.sessionId)}` : ''}`,
      { signal: controller.signal },
    )
      .then((data) => {
        if (token !== generation || requestedKey !== key())
          throw new Error(tr('ui.le_projet_selectionne_a_change'));
        catalog = data;
        loadedAt = Date.now();
        if (cache.size >= 12) cache.delete(cache.keys().next().value);
        cache.set(requestedKey, { data, at: loadedAt });
        return data;
      })
      .catch((error) => {
        if (token === generation && error.name !== 'AbortError') loadError = error.message;
        throw error;
      })
      .finally(() => {
        if (token === generation) {
          pending = null;
          if (dialog.open) renderList();
          if (!popup.hidden) renderSuggestions();
        }
      });
    return pending;
  }
  function insert(command) {
    if (!command.supported) return;
    const text = composerText();
    const suffix = composerCommand()
      ? input.value
      : text.startsWith('/')
        ? text.replace(/^\/\S*\s*/, '')
        : text;
    selectComposerCommand(command, suffix);
    hide();
    dialog.close();
    dismissed = true;
    input.focus({ preventScroll: true });
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    onChange();
  }
  function available() {
    return catalog?.commands || cache.get(key())?.data.commands || immediateCommands;
  }
  function filtered(items, query) {
    const q = normalize(query).replace(/^\//, '');
    return items
      .filter((c) =>
        normalize(`${c.name} ${translateKnown(c.description)} ${c.sourceInfo?.scope || ''}`).includes(q),
      )
      .sort(
        (a, b) => Number(b.name.startsWith(q)) - Number(a.name.startsWith(q)) || a.name.localeCompare(b.name),
      );
  }
  function renderList({ keepPage = false } = {}) {
    folders.hidden = !['skill', 'prompt'].includes(filter) || getContext().readOnly;
    if (!keepPage) pageSize = 30;
    list.replaceChildren();
    const commands = available().filter((c) =>
      filter === 'terminal' ? !c.supported : c.supported && (filter === 'all' || c.source === filter),
    );
    const visible = filtered(commands, search.value);
    currentList = visible;
    bindText(note, () =>
      [
        translateKnown(loadError) ||
          (pending
            ? tr('ui.chargement_des_skills_et_prompts')
            : catalog?.live
              ? tr('ui.ressources_chargees_dans_cette_session')
              : tr('ui.ressources_du_projet_pour_les_nouvelles_sessions')),
        ...(catalog?.diagnostics || []).map((diagnostic) => translateKnown(diagnostic.message)),
      ]
        .filter(Boolean)
        .join(' · '),
    );
    note.setAttribute('aria-busy', String(!!pending));
    for (const command of visible.slice(0, pageSize)) {
      const row = node('button', 'command-item');
      row.type = 'button';
      row.disabled = !command.supported;
      const name = node('span', 'command-name');
      name.append(
        commandTitle(command),
        node('small', '', () => translateKnown(command.argumentHint) || labels[command.source]),
      );
      row.append(
        name,
        node(
          'span',
          'command-description',
          () => translateKnown(command.description) || labels[command.source],
        ),
      );
      if (command.sourceInfo?.path) {
        const path = node('span', 'command-source', () => command.sourceInfo.path);
        bindAttribute(path, 'title', () => command.sourceInfo.path);
        row.append(path);
      }
      if (command.explicitOnly)
        row.append(node('span', 'command-source', () => tr('ui.invocation_explicite_uniquement')));
      if (command.pythonPackage)
        row.append(node('span', 'command-source', () => tr('ui.inclut_un_module_python')));
      if (!command.supported)
        row.append(node('span', 'command-source', () => translateKnown(command.reason)));
      row.onclick = () => insert(command);
      list.append(row);
    }
    if (!visible.length && !pending)
      list.append(node('p', 'command-empty', () => tr('ui.aucun_resultat_pour_ce_filtre')));
    more.hidden = visible.length <= pageSize;
    bindText(more, () =>
      tr('ui.afficher_la_suite_sur', { value1: Math.min(pageSize, visible.length), value2: visible.length }),
    );
    list.append(more);
    for (const [value, b] of filterButtons) b.setAttribute('aria-pressed', String(value === filter));
  }
  more.onclick = () => {
    const top = list.scrollTop;
    const previousSize = pageSize,
      focused = document.activeElement === more;
    pageSize = Math.min(pageSize + 30, currentList.length);
    renderList({ keepPage: true });
    list.scrollTop = top;
    if (focused) list.querySelectorAll('.command-item')[previousSize]?.focus({ preventScroll: true });
  };
  if ('IntersectionObserver' in window)
    new IntersectionObserver(
      (entries) => {
        if (dialog.open && entries.some((entry) => entry.isIntersecting) && !more.hidden) more.click();
      },
      { root: list, rootMargin: '80px' },
    ).observe(more);
  refresh.onclick = () => {
    void load({ force: true }).catch(() => {});
    renderList();
  };
  openFolder.onclick = async () => {
    if (getContext().readOnly || !['skill', 'prompt'].includes(filter)) return;
    const source = filter,
      scope = folderScope.value,
      contextKey = key();
    openFolder.disabled = true;
    openFolder.setAttribute('aria-busy', 'true');
    bindText(folderStatus, '');
    try {
      await api('/api/commands/open-directory', {
        method: 'POST',
        body: { cwd: getContext().cwd, source, scope },
      });
      if (dialog.open && key() === contextKey && filter === source && folderScope.value === scope)
        bindText(folderStatus, () => tr('ui.dossier_ouvert_sur_le_pc'));
    } catch (error) {
      onError(error);
    } finally {
      openFolder.disabled = false;
      openFolder.removeAttribute('aria-busy');
    }
  };
  folderScope.onchange = () => bindText(folderStatus, '');
  for (const [value, label] of [
    ['all', tr('common.all')],
    ['skill', tr('commands.skills')],
    ['prompt', tr('commands.prompts')],
    ['terminal', tr('commands.terminal')],
  ]) {
    const b = node('button', '', () => (value === 'all' ? tr('common.all') : label));
    b.type = 'button';
    b.onclick = () => {
      filter = value;
      bindText(folderStatus, '');
      renderList();
    };
    filters.append(b);
    filterButtons.set(value, b);
  }
  filters.append(refresh);
  async function open(selected = 'all') {
    update();
    hide();
    filter = selected;
    bindText(folderStatus, '');
    search.value = '';
    dialog.showModal();
    search.focus();
    void load().catch(() => {});
    renderList();
  }
  function position() {
    if (popup.hidden) return;
    const rect = document.getElementById('composer-form').getBoundingClientRect();
    const top = window.visualViewport?.offsetTop || 0;
    popup.style.left = `${Math.max(8, rect.left)}px`;
    popup.style.width = `${Math.min(rect.width, innerWidth - 16)}px`;
    popup.style.maxHeight = `${Math.max(70, Math.min(310, rect.top - top - 12))}px`;
    popup.style.bottom = `${innerHeight - rect.top + 6}px`;
  }
  async function suggest() {
    if (
      dismissed ||
      document.activeElement !== input ||
      composerCommand() ||
      !/^\/[^\s]*$/.test(input.value) ||
      getContext().readOnly
    ) {
      hide();
      return;
    }
    suggestionQuery = input.value;
    void load().catch(() => {});
    renderSuggestions();
  }
  function renderSuggestions() {
    if (
      suggestionQuery !== input.value ||
      composerCommand() ||
      dismissed ||
      document.activeElement !== input
    ) {
      hide();
      return;
    }
    const selected = matches[index]?.name;
    matches = filtered(
      available().filter((c) => c.supported),
      suggestionQuery,
    ).slice(0, 12);
    index = Math.max(
      0,
      matches.findIndex((command) => command.name === selected),
    );
    popup.replaceChildren();
    matches.forEach((c, i) => {
      const row = node('div', 'command-suggestion');
      row.id = `command-option-${i}`;
      row.setAttribute('role', 'option');
      row.append(
        commandTitle(c, 'strong'),
        node('span', '', () => translateKnown(c.description) || labels[c.source]),
      );
      row.onpointerdown = (event) => event.preventDefault();
      row.onclick = () => insert(c);
      popup.append(row);
    });
    if (pending || loadError || !matches.length) {
      const status = node(
        'p',
        'command-loading',
        () =>
          loadError ||
          (pending ? tr('ui.chargement_des_skills_et_prompts') : tr('ui.aucune_commande_correspondante')),
      );
      status.setAttribute('role', 'status');
      popup.append(status);
    }
    if (loadError) {
      const retry = node('button', 'command-more', () => tr('ui.reessayer'));
      retry.type = 'button';
      retry.onpointerdown = (e) => e.preventDefault();
      retry.onclick = () => {
        void load({ force: true }).catch(() => {});
        renderSuggestions();
      };
      popup.append(retry);
    }
    popup.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    if (matches.length) selectIndex();
    else input.removeAttribute('aria-activedescendant');
    position();
  }
  function selectIndex() {
    [...popup.querySelectorAll('[role=option]')].forEach((row, i) =>
      row.setAttribute('aria-selected', String(i === index)),
    );
    const row = document.getElementById(`command-option-${index}`);
    input.setAttribute('aria-activedescendant', row.id);
    row.scrollIntoView({ block: 'nearest' });
  }
  input.addEventListener(
    'keydown',
    (event) => {
      if (popup.hidden || event.isComposing) return;
      if (!matches.length && ['Tab', 'Enter'].includes(event.key)) {
        hide();
        return;
      }
      if (['ArrowDown', 'ArrowUp', 'Tab', 'Enter', 'Escape'].includes(event.key)) {
        if (event.key === 'Enter' && (event.shiftKey || event.ctrlKey || event.metaKey)) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        if (event.key === 'Escape') {
          dismissed = true;
          hide();
        } else if (event.key === 'Tab' || event.key === 'Enter') {
          if (matches[index]) insert(matches[index]);
        } else if (matches.length) {
          index = (index + (event.key === 'ArrowDown' ? 1 : -1) + matches.length) % matches.length;
          selectIndex();
        }
      }
    },
    true,
  );
  input.addEventListener('input', () => {
    dismissed = false;
    void suggest();
  });
  input.addEventListener('focus', () => {
    dismissed = false;
    void suggest();
  });
  input.addEventListener('blur', hide);
  window.addEventListener('resize', position);
  window.visualViewport?.addEventListener('resize', position);
  window.visualViewport?.addEventListener('scroll', position);
  button.onclick = () => void open();
  search.oninput = renderList;
  return {
    open,
    update,
    restoreDraft() {
      const text = composerText(),
        requestedKey = key();
      const tokens = text.match(/^(\/skill:[A-Za-z0-9-]+(?:\s+\/skill:[A-Za-z0-9-]+)*)\s+([\s\S]*)$/);
      const single = !tokens && text.match(/^\/([^\s/]+) ([\s\S]*)$/);
      if (!tokens && !single) return;
      void load()
        .then((data) => {
          if (key() !== requestedKey || composerText() !== text) return;
          if (tokens) {
            const names = tokens[1].trim().split(/\s+/).map((token) => token.slice(1));
            const entries = [];
            for (const raw of names) {
              const name = Object.hasOwn(aliases, raw) ? aliases[raw] : raw;
              const command = data.commands.find((c) => c.name === name && c.supported);
              if (!command || command.source !== 'skill') return;
              entries.push({ ...command, name: raw });
            }
            if (input.selectionStart < tokens[1].length + 1) return;
            const offset = tokens[1].length + 1,
              start = input.selectionStart - offset,
              end = input.selectionEnd - offset;
            setComposerText('');
            for (const entry of entries) selectComposerCommand(entry, tokens[2]);
            input.setSelectionRange(start, end);
            onChange();
            return;
          }
          if (input.selectionStart < single[1].length + 2) return;
          const name = Object.hasOwn(aliases, single[1]) ? aliases[single[1]] : single[1];
          const command = data.commands.find((c) => c.name === name && c.supported);
          if (!command) return;
          const offset = single[1].length + 2,
            start = input.selectionStart - offset,
            end = input.selectionEnd - offset;
          selectComposerCommand({ ...command, name: single[1] }, single[2]);
          input.setSelectionRange(start, end);
          onChange();
        })
        .catch(() => {});
    },
    async intercept() {
      const draft = composerText();
      if (draft.trim() === '/') {
        void open();
        return true;
      }
      const parsed = draft.trim().match(/^\/([^\s/]+)(?:\s+([\s\S]*))?$/);
      if (!parsed) return false;
      if (sending || getContext().readOnly) return true;
      sending = true;
      const contextKey = key();
      try {
        const name = Object.hasOwn(aliases, parsed[1]) ? aliases[parsed[1]] : parsed[1],
          args = (parsed[2] || '').trim();
        const studio = immediateCommands.find((c) => c.name === name);
        const data = studio ? { commands: [studio] } : await load();
        if (composerText() !== draft || contextKey !== key()) return true;
        const command = data.commands.find((c) => c.name === name);
        if (!command)
          throw new Error(
            tr('ui.commande_inconnue_ouvrez_le_menu_pour_voir_les_commandes_du_proje', { value1: name }),
          );
        if (!command.supported) throw new Error(translateKnown(command.reason));
        hide();
        if (command.source !== 'studio') return false;
        if (hasAttachments())
          throw new Error(tr('ui.retirez_les_pieces_jointes_avant_d_utiliser_ce_raccourci_du_studi'));
        const token = composerCommand();
        setComposerText('');
        onChange();
        try {
          await action(command.action, args);
        } catch (error) {
          if (contextKey === key() && !composerText()) {
            if (token) selectComposerCommand(token, draft.slice(token.name.length + 2));
            else setComposerText(draft);
            onChange();
          }
          throw error;
        }
        return true;
      } catch (error) {
        onError(error);
        return true;
      } finally {
        sending = false;
      }
    },
  };
}
