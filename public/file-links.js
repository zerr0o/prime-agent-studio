import { t as tr, bindAttribute } from './i18n.js';
import { parentFolder } from './file-presentation.js';
// Any project looking path is linked, whatever its extension. Plain prose,
// code blocks and external URLs stay unchanged. The project file resolve API
// stays the source of truth for existence and access, so unknown, protected
// or binary targets open the viewer with a clear message instead of plain text.
export function isFileReference(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\x00-\x1f]/.test(value)) return false;
  const path = value.trim();
  if (!path || path.startsWith('#') || /^\/\//.test(path)) return false;
  if (/^[a-z][\w+.-]*:/i.test(path) && !/^(?:file:|[a-z]:[\\/])/i.test(path)) return false;
  const stripped = path.replace(/(?:#L?\d+(?:[-:]L?\d+)?|:\d+(?::\d+)?)$/, '');
  if (!stripped) return false;
  if (/^file:/i.test(stripped) || /^[a-z]:[\\/]/i.test(stripped)) return true;
  if (/[\\/]/.test(stripped)) return true;
  return /\.[A-Za-z0-9]{1,10}$/.test(stripped);
}

export function fileLinkRenderer(marked, references, images) {
  const renderer = new marked.Renderer();
  const original = renderer.link;
  if (images)
    renderer.image = function (token) {
      const id = images.push({ href: token.href, text: token.text }) - 1;
      return `<span data-studio-image="${id}"></span>`;
    };
  renderer.link = function (token) {
    if (!isFileReference(token.href)) return original.call(this, token);
    const id = references.push(token.href) - 1;
    return `<a href="#studio-file-${id}" data-studio-file="${id}">${this.parser.parseInline(token.tokens)}</a>`;
  };
  return renderer;
}

// Shared message file menu, one document level popover reused by every bound
// link. Long press on touch screens fires contextmenu in mobile browsers, so
// no separate gesture is needed. Keyboard access uses the ContextMenu key and
// Shift+F10, like the inspector file rows.
let linkMenu = null;
let linkMenuInstalled = false;
let linkMenuAnchor = null;
const linkMenuEntry = new WeakMap();

function ensureLinkMenu() {
  if (linkMenu) return linkMenu;
  linkMenu = document.createElement('div');
  linkMenu.className = 'popover-menu inspector-file-menu file-link-menu';
  linkMenu.setAttribute('role', 'menu');
  linkMenu.hidden = true;
  document.body.append(linkMenu);
  if (!linkMenuInstalled) {
    linkMenuInstalled = true;
    document.addEventListener('click', (event) => {
      if (linkMenu.hidden || event.target.closest('.inspector-file-menu')) return;
      closeLinkMenu();
    });
    document.addEventListener('scroll', () => closeLinkMenu(), true);
    window.addEventListener('resize', () => closeLinkMenu());
    document.addEventListener(
      'keydown',
      (event) => {
        if (linkMenu.hidden) return;
        if (event.key === 'Escape' || event.key === 'Tab') {
          event.preventDefault();
          event.stopPropagation();
          const anchor = linkMenuAnchor;
          closeLinkMenu();
          anchor?.focus({ preventScroll: true });
        } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
          event.preventDefault();
          event.stopPropagation();
          const items = [...linkMenu.querySelectorAll('button:not(:disabled)')];
          const index = items.indexOf(document.activeElement);
          const next =
            event.key === 'Home'
              ? 0
              : event.key === 'End'
                ? items.length - 1
                : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
          items[next]?.focus({ preventScroll: true });
        }
      },
      true,
    );
  }
  return linkMenu;
}

function closeLinkMenu() {
  if (!linkMenu || linkMenu.hidden) return;
  linkMenu.hidden = true;
  linkMenuAnchor = null;
}

function placeLinkMenu(menu, x, y) {
  menu.hidden = false;
  const viewport = window.visualViewport;
  const left = viewport?.offsetLeft || 0;
  const top = viewport?.offsetTop || 0;
  const width = viewport?.width || innerWidth;
  const height = viewport?.height || innerHeight;
  menu.style.maxHeight = `${Math.max(80, height - 24)}px`;
  menu.style.left = `${Math.max(left + 12, Math.min(left + width - menu.offsetWidth - 12, x))}px`;
  menu.style.top = `${Math.max(top + 12, Math.min(top + height - menu.offsetHeight - 12, y))}px`;
  menu.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
}

function openLinkMenu(anchor, x, y) {
  const entry = linkMenuEntry.get(anchor);
  if (!entry) return;
  const { reference, menu } = entry;
  const context = menu.context();
  const items = ensureLinkMenu();
  items.replaceChildren();
  items.setAttribute('aria-label', reference);
  const folderLabel = context.remote ? tr('ui.ouvrir_le_dossier_sur_le_pc') : tr('ui.ouvrir_le_dossier');
  const actions = [
    [
      () => tr('ui.ouvrir'),
      () => {
        const anchorNode = linkMenuAnchor;
        closeLinkMenu();
        anchorNode?.focus({ preventScroll: true });
        void entry.open(reference);
      },
      false,
    ],
    [
      () => folderLabel,
      () => {
        const anchorNode = linkMenuAnchor;
        closeLinkMenu();
        anchorNode?.focus({ preventScroll: true });
        void (async () => {
          try {
            const resolved = await menu.resolve(reference, menu.context());
            const folder = resolved.directory ? resolved.path : parentFolder(resolved.path);
            await menu.reveal(menu.context().cwd, folder);
            menu.toast(() => tr('ui.ouverture_demandee_sur_le_pc'));
          } catch (error) {
            menu.toast(error?.message || String(error), true);
          }
        })();
      },
      !context.cwd || context.readOnly || !context.nativeFileOpen || !context.online,
    ],
    [
      () => tr('ui.copier_le_chemin'),
      () => {
        const anchorNode = linkMenuAnchor;
        closeLinkMenu();
        anchorNode?.focus({ preventScroll: true });
        void (async () => {
          const current = menu.context();
          try {
            const resolved = await menu.resolve(reference, current);
            const separator = current.cwd.includes('\\') ? '\\' : '/';
            await menu.copy(
              current.cwd.replace(/[\\/]$/, '') + separator + resolved.path.replaceAll('/', separator),
            );
          } catch {
            await menu.copy(reference);
          }
        })();
      },
      false,
    ],
  ];
  for (const [label, run, disabled] of actions) {
    const item = document.createElement('button');
    item.type = 'button';
    item.setAttribute('role', 'menuitem');
    item.disabled = Boolean(disabled);
    const update = () => {
      item.textContent = typeof label === 'function' ? label() : label;
    };
    update();
    item.onclick = run;
    items.append(item);
  }
  linkMenuAnchor = anchor;
  placeLinkMenu(items, x, y);
}

export function bindFileLinks(root, references, open, menu = null) {
  function bind(anchor, reference) {
    anchor.classList.add('document-link');
    anchor.href = '#document';
    anchor.removeAttribute('target');
    bindAttribute(anchor, 'title', () => tr('ui.apercu_du_fichier', { value1: reference }));
    anchor.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void open(reference);
    };
    if (menu) {
      linkMenuEntry.set(anchor, { reference, open, menu });
      anchor.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openLinkMenu(anchor, event.clientX, event.clientY);
      });
      anchor.addEventListener('keydown', (event) => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) {
          event.preventDefault();
          const rect = anchor.getBoundingClientRect();
          openLinkMenu(anchor, rect.left + 16, rect.bottom + 4);
        }
      });
    }
  }
  root.querySelectorAll('a').forEach((anchor) => {
    const id = anchor.getAttribute('data-studio-file');
    const reference = id !== null && /^\d+$/.test(id) ? references[Number(id)] : anchor.getAttribute('href');
    anchor.removeAttribute('data-studio-file');
    if (isFileReference(reference)) bind(anchor, reference);
  });
  root.querySelectorAll('code').forEach((code) => {
    if (code.closest('pre, a') || !isFileReference(code.textContent)) return;
    const anchor = document.createElement('a');
    bind(anchor, code.textContent.trim());
    code.replaceWith(anchor);
    anchor.append(code);
  });
}
