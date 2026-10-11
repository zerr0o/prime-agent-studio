import { t as tr, bindText, bindAttribute, translateKnown } from './i18n.js';
const TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const MAX_FILE = 4 * 1024 * 1024,
  MAX_TOTAL = 8 * 1024 * 1024;
const source = (image) =>
  TYPES.includes(image?.mimeType) && typeof image.data === 'string'
    ? `data:${image.mimeType};base64,${image.data}`
    : null;
const node = (tag, className, text) => {
  const value = document.createElement(tag);
  value.className = className || '';
  if (text) bindText(value, () => text);
  return value;
};

export function renderImages(images) {
  const gallery = node('div', 'message-images');
  for (const [index, image] of images.entries()) {
    if (image.type === 'file') {
      const link = node('a', 'message-file', () => image.name || tr('ui.fichier_joint'));
      if (/^[a-f0-9-]{36}$/.test(image.id || '')) {
        link.href = `/api/files/${image.id}`;
        link.setAttribute('download', image.name || 'fichier');
      }
      gallery.append(link);
      continue;
    }
    const url = source(image);
    if (!url) {
      gallery.append(node('span', 'attachment-note', () => tr('ui.image_dans_la_session_native')));
      continue;
    }
    const button = node('button', 'message-image');
    button.type = 'button';
    bindAttribute(button, 'aria-label', () => tr('images.enlarge', { value1: index + 1 }));
    const img = node('img');
    img.src = url;
    bindAttribute(img, 'alt', () => tr('ui.image_jointe', { value1: index + 1 }));
    img.loading = 'lazy';
    button.append(img);
    button.onclick = () => {
      const dialog = node('dialog', 'image-viewer');
      const close = node('button', 'image-viewer-close', () => tr('ui.fermer'));
      close.type = 'button';
      const full = node('img');
      full.src = url;
      bindAttribute(full, 'alt', () => img.alt);
      bindAttribute(dialog, 'aria-label', () => img.alt);
      dialog.append(close, full);
      document.body.append(dialog);
      close.onclick = () => dialog.close();
      dialog.onclick = (event) => {
        if (event.target === dialog) dialog.close();
      };
      dialog.onclose = () => {
        dialog.remove();
        button.focus();
      };
      dialog.showModal();
    };
    gallery.append(button);
  }
  return gallery;
}

// Module-shared attachment store: every composer instance (primary + panes)
// reads and writes the SAME rows, so two trays on one draft key can never
// diverge and IndexedDB opens exactly once. Rendering stays per-instance via
// per-key listener sets; instances live as long as views (registry bounded).
const sharedDrafts = new Map();
const sharedKeyListeners = new Map();
let sharedDatabasePromise = null;
function sharedDatabase() {
  if (!sharedDatabasePromise) {
    sharedDatabasePromise = new Promise((done, reject) => {
      if (!globalThis.indexedDB) return reject(new Error('unavailable'));
      const req = indexedDB.open('prime-studio-images', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('drafts');
      req.onsuccess = () => done(req.result);
      req.onerror = () => reject(req.error);
    }).catch(() => null);
  }
  return sharedDatabasePromise;
}
function notifySharedKey(key) {
  const set = sharedKeyListeners.get(key);
  if (!set) return;
  for (const fn of [...set]) {
    try {
      fn();
    } catch {}
  }
}

export function createImageComposer({ getContext, onChange, onError, roots }) {
  // Per-pane instances pass roots { form, textarea }; the default binds the
  // primary composer IDs exactly as before. Built nodes keep classes in both
  // modes, carry data-cvw roles, and only carry IDs on the default path —
  // no duplicate IDs ever.
  const scoped = Boolean(roots?.form && roots?.textarea);
  const form = scoped ? roots.form : document.getElementById('composer-form');
  const textarea = scoped ? roots.textarea : document.getElementById('composer');
  const add = node('button', 'attach-image-button');
  add.setAttribute('data-cvw', 'attach-images');
  if (!scoped) add.id = 'attach-images';
  add.type = 'button';
  bindAttribute(add, 'title', () => tr('ui.ajouter_une_photo'));
  bindAttribute(add, 'aria-label', () => add.title);
  add.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1.5"/><path d="m3 17 6-6 4 4 3-3 5 5"/></svg>';
  const input = node('input');
  if (!scoped) input.id = 'image-files';
  input.type = 'file';
  input.multiple = true;
  input.hidden = true;
  input.accept = 'image/*';
  const attach = node('button', 'attach-image-button');
  attach.setAttribute('data-cvw', 'attach-files');
  if (!scoped) attach.id = 'attach-files';
  attach.type = 'button';
  bindAttribute(attach, 'title', () => tr('ui.ajouter_une_piece_jointe'));
  bindAttribute(attach, 'aria-label', () => attach.title);
  attach.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21 11-8.5 8.5a6 6 0 0 1-8.5-8.5l9-9a4 4 0 0 1 5.7 5.7l-9 9a2 2 0 0 1-2.9-2.9L15 6.5"/></svg>';
  const fileInput = node('input');
  if (!scoped) fileInput.id = 'attachment-files';
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  const controls = node('div', 'attachment-controls');
  controls.setAttribute('role', 'group');
  bindAttribute(controls, 'aria-label', () => tr('ui.pieces_jointes'));
  controls.setAttribute('data-cvw', 'attach-controls');
  controls.append(add, attach, input, fileInput);
  const tray = node('div', 'image-draft-tray');
  tray.setAttribute('data-cvw', 'tray');
  if (!scoped) tray.id = 'image-draft-tray';
  tray.hidden = true;
  const note = node('p', 'image-draft-note');
  note.setAttribute('role', 'status');
  note.hidden = true;
  const inputRow = node('div', 'composer-input-row');
  textarea.before(tray, inputRow);
  inputRow.append(textarea, controls);
  inputRow.after(note);
  let currentKey = '',
    signature = '';
  const notify = () => queueMicrotask(onChange);
  // Subscribe this instance's re-render to a draft key. Subscriptions are
  // idempotent per instance; instances live as long as views (registry
  // bounded), so no teardown bookkeeping is needed.
  const subscribedKeys = new Set();
  function subscribeKey(key) {
    if (subscribedKeys.has(key)) return;
    subscribedKeys.add(key);
    let set = sharedKeyListeners.get(key);
    if (!set) {
      set = new Set();
      sharedKeyListeners.set(key, set);
    }
    set.add(notify);
  }
  function entry(key = getContext().key) {
    subscribeKey(key);
    let value = sharedDrafts.get(key);
    if (!value) {
      value = { items: [], revision: 0, pending: 0, loading: true };
      sharedDrafts.set(key, value);
      // The IndexedDB load promise is exposed for one-time key migrations.
      // Uploads always target the live composer key, so migration (a boot-only
      // call) can never overlap a pending addition into the source key.
      // Load failure reports once, to the creating instance.
      const creatorError = onError;
      value.ready = (async () => {
        try {
          const db = await sharedDatabase();
          if (db) {
            const saved = await new Promise((done, reject) => {
              const req = db.transaction('drafts').objectStore('drafts').get(key);
              req.onsuccess = () => done(req.result);
              req.onerror = () => reject(translateKnown(req.error));
            });
            if (value.revision === 0 && Array.isArray(saved)) value.items = saved;
          }
        } catch {
          try {
            creatorError(new Error(tr('ui.impossible_de_relire_les_pieces_jointes_du_brouillon')));
          } catch {}
        } finally {
          value.loading = false;
          notifySharedKey(key);
        }
        return value;
      })();
    }
    const existing = sharedDrafts.get(key);
    if (!existing.ready) existing.ready = Promise.resolve(existing);
    return existing;
  }
  async function write(key, entryValue) {
    const db = await sharedDatabase();
    if (!db) {
      onError(new Error(tr('ui.les_pieces_jointes_restent_dans_cet_onglet_leur_sauvegarde_locale')));
      return;
    }
    const tx = db.transaction('drafts', 'readwrite');
    const store = tx.objectStore('drafts');
    if (entryValue.items.length) store.put(entryValue.items, key);
    else store.delete(key);
    tx.onerror = () => onError(new Error(tr('ui.impossible_de_sauvegarder_les_pieces_jointes_du_brouillon')));
    if (typeof tx.oncomplete !== 'undefined') {
      try {
        tx.oncomplete = () => notifySharedKey(key);
      } catch {}
    }
  }
  // A server-validated native imageModel id routes the image turn on the
  // engine side, so attachments stay allowed; otherwise the truthful
  // refusal stands. The gate is a single id-or-null value by design.
  const incompatible = () => {
    const context = getContext();
    if (!entry().items.some((item) => item.type === 'image')) return false;
    if (typeof context.imageModel === 'string' && context.imageModel) return false;
    return Array.isArray(context.input) && !context.input.includes('image');
  };
  function update() {
    const context = getContext(),
      value = entry(context.key);
    currentKey = context.key;
    add.disabled = attach.disabled = !!context.disabled || context.available === false || value.loading;
    bindAttribute(add, 'title', () =>
      context.available === false
        ? tr('ui.les_pieces_jointes_seront_disponibles_apres_la_mise_a_jour_du_ser')
        : tr('ui.ajouter_une_photo'),
    );
    bindAttribute(attach, 'title', () =>
      context.available === false ? add.title : tr('ui.ajouter_une_piece_jointe'),
    );
    const next = JSON.stringify([
      currentKey,
      value.items.map((image) => image.id),
      value.pending,
      value.loading,
      context.disabled,
      context.available,
      incompatible(),
    ]);
    if (signature === next) return;
    signature = next;
    tray.replaceChildren();
    tray.hidden = !value.items.length;
    for (const item of value.items) {
      const card = node('div', 'image-draft');
      const img = item.type === 'image' ? node('img') : node('span', 'file-draft-name', () => item.name);
      if (item.type === 'image') {
        img.src = source(item);
        bindAttribute(img, 'alt', () => item.name);
      }
      const remove = node('button', 'image-remove', () => '×');
      remove.type = 'button';
      bindAttribute(remove, 'aria-label', () => tr('common.removeName', { value1: item.name }));
      remove.disabled = !!context.disabled;
      remove.onclick = () => {
        value.items = value.items.filter((image) => image.id !== item.id);
        value.revision++;
        void write(context.key, value);
        update();
        notify();
      };
      bindAttribute(card, 'title', () => item.name);
      card.append(img, remove);
      tray.append(card);
    }
    bindText(note, () =>
      value.items.length && context.available === false
        ? tr('ui.brouillon_conserve_les_pieces_jointes_attendent_la_mise_a_jour_du')
        : incompatible()
          ? tr('ui.ce_modele_ne_prend_pas_en_charge_les_images_choisissez_un_modele')
          : value.pending
            ? tr('ui.preparation_des_pieces_jointes')
            : value.items.length
              ? tr('ui.8_pieces_jointes_images_4_mo_fichiers_10_mo', { value1: value.items.length })
              : '',
    );
    note.hidden = !note.textContent;
  }
  async function addFiles(files, photosOnly = false) {
    const context = getContext(),
      value = entry(context.key);
    if (context.disabled || context.available === false || value.loading) return;
    value.pending++;
    update();
    notify();
    try {
      for (const file of files) {
        const isImage = TYPES.includes(file.type),
          type = isImage ? 'image' : 'file';
        if (photosOnly && !isImage) {
          onError(
            new Error(
              tr('ui.choisissez_une_image_png_jpeg_gif_ou_webp_pour_les_autres_formats', {
                value1: file.name,
              }),
            ),
          );
          continue;
        }
        if (file.size > (isImage ? MAX_FILE : 10 * 1024 * 1024)) {
          onError(new Error(tr('ui.limite_de_mo', { value1: file.name, value2: isImage ? 4 : 10 })));
          continue;
        }
        const fits = () =>
          value.items.length < 8 &&
          (!isImage || value.items.filter((item) => item.type === 'image').length < 4) &&
          value.items.filter((item) => item.type === type).reduce((total, item) => total + item.size, 0) +
            file.size <=
            (isImage ? MAX_TOTAL : 20 * 1024 * 1024);
        if (!fits()) {
          onError(new Error(tr('ui.limite_8_pieces_jointes_dont_4_images_8_mo_d_images_et_20_mo_de_f')));
          break;
        }
        const dataUrl = await new Promise((done, reject) => {
          const reader = new FileReader();
          reader.onload = () => done(reader.result);
          reader.onerror = () => reject(new Error(tr('ui.impossible_de_lire_ce_fichier')));
          reader.readAsDataURL(file);
        });
        if (isImage) {
          const decoded = new Image();
          decoded.src = dataUrl;
          try {
            await decoded.decode();
          } catch {
            onError(new Error(tr('ui.image_illisible', { value1: file.name })));
            continue;
          }
        }
        // Recheck after asynchronous decoding, since another paste may have completed.
        if (!fits()) break;
        value.items.push({
          id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          name: file.name || tr('ui.image_collee'),
          size: file.size,
          type,
          mimeType: file.type,
          data: dataUrl.slice(dataUrl.indexOf(',') + 1),
        });
        value.revision++;
        void write(context.key, value);
      }
    } catch (error) {
      onError(error);
    } finally {
      value.pending--;
      update();
      notify();
    }
  }
  add.onclick = () => input.click();
  attach.onclick = () => fileInput.click();
  input.onchange = () => {
    const files = [...input.files];
    input.value = '';
    void addFiles(files, true);
  };
  fileInput.onchange = () => {
    const files = [...fileInput.files];
    fileInput.value = '';
    void addFiles(files);
  };
  const onPaste = (event) => {
    const files = [...(event.clipboardData?.files || [])];
    if (files.length) {
      event.preventDefault();
      void addFiles(files);
    }
  };
  const dropZone = form.closest('.conversation-column') || form;
  const onDragOver = (event) => {
    if (event.dataTransfer?.types.includes('Files')) {
      event.preventDefault();
      if (!getContext().disabled) form.classList.add('image-drop-target');
    }
  };
  const onDragLeave = (event) => {
    if (!dropZone.contains(event.relatedTarget)) form.classList.remove('image-drop-target');
  };
  const onDrop = (event) => {
    if (event.dataTransfer?.files.length) {
      event.preventDefault();
      form.classList.remove('image-drop-target');
      void addFiles([...event.dataTransfer.files]);
    }
  };
  textarea.addEventListener('paste', onPaste);
  dropZone.addEventListener('dragover', onDragOver);
  dropZone.addEventListener('dragleave', onDragLeave);
  dropZone.addEventListener('drop', onDrop);
  // Teardown restores the pre-assembly DOM (controls/tray/note/input-row
  // removed, textarea unwrapped to its original position) and detaches every
  // listener, so a rebuilt unit on the same nodes never double-handles.
  function destroy() {
    try {
      textarea.removeEventListener('paste', onPaste);
    } catch {}
    for (const [type, fn] of [
      ['dragover', onDragOver],
      ['dragleave', onDragLeave],
      ['drop', onDrop],
    ]) {
      try {
        dropZone.removeEventListener(type, fn);
      } catch {}
    }
    let removedSubs = 0;
    try {
      removedSubs = destroySubscriptions();
    } catch {}
    try {
      controls.remove();
    } catch {}
    try {
      tray.remove();
    } catch {}
    try {
      note.remove();
    } catch {}
    try {
      if (inputRow.parentNode) inputRow.replaceWith(textarea);
    } catch {}
    return removedSubs;
  }
  /** Read-only per-key inspection for background conversation views. Never writes. */
  function peek(key) {
    const value = sharedDrafts.get(key);
    if (!value) return { count: 0, pending: 0, loading: false };
    return { count: value.items.length, pending: value.pending, loading: value.loading };
  }
  /**
   * One-time key migration (e.g. legacy `session:`/`project:` rows into a
   * canonical view key). Both keys are captured by the caller up front and
   * never re-resolved, so a late focus switch cannot redirect the merge. The
   * existing IndexedDB loads are awaited directly (works in hidden tabs, no
   * frame or timer budget), then rows merge once with id dedupe.
   */
  async function migrateItems(fromKey, toKey) {
    if (!fromKey || !toKey || fromKey === toKey) return false;
    const [from, to] = await Promise.all([entry(fromKey).ready, entry(toKey).ready]);
    if (!from.items.length) return false;
    const known = new Set(to.items.map((item) => item.id));
    const moving = from.items.filter((item) => !known.has(item.id));
    from.items = [];
    from.revision++;
    if (moving.length) {
      to.items.push(...moving);
      to.revision++;
      void write(toKey, to);
    }
    void write(fromKey, from);
    update();
    notify();
    return moving.length > 0;
  }
  // Shared-store unsubscribe. Views are registry-bounded so units are normally
  // never discarded, but replacement flows must not leave ghost notifiers.
  // Returns the number of subscriptions removed (assertable in tests).
  function destroySubscriptions() {
    let removed = 0;
    for (const set of sharedKeyListeners.values()) {
      if (set.delete(notify)) removed += 1;
    }
    for (const [key, set] of [...sharedKeyListeners.entries()]) {
      if (!set.size) sharedKeyListeners.delete(key);
    }
    return removed;
  }
  return {
    update,
    peek,
    migrateItems,
    destroy,
    destroySubscriptions,
    hasImages: () => entry().items.length > 0,
    blocked: () => {
      const value = entry();
      return (
        value.loading ||
        value.pending > 0 ||
        (value.items.length > 0 && getContext().available === false) ||
        incompatible()
      );
    },
    snapshot: () => {
      const value = entry();
      return {
        key: getContext().key,
        ids: value.items.map((image) => image.id),
        images: value.items
          .filter((item) => item.type === 'image')
          .map(({ type, mimeType, data }) => ({ type, mimeType, data })),
        files: value.items.filter((item) => item.type === 'file').map(({ name, data }) => ({ name, data })),
      };
    },
    accepted(snapshot) {
      const value = entry(snapshot.key);
      value.items = value.items.filter((image) => !snapshot.ids.includes(image.id));
      value.revision++;
      void write(snapshot.key, value);
      update();
      notify();
    },
  };
}
