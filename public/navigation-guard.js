// Temporary back-navigation guard: disable involuntary history shortcuts.
// No router yet; never trap the real back button with fake entries.
export function isEditableTarget(target) {
  if (!target || target.nodeType !== 1) return false;
  if (target.isContentEditable) return true;
  const tag = (target.tagName || '').toUpperCase();
  if (tag === 'TEXTAREA') return !target.disabled && !target.readOnly;
  if (tag === 'INPUT') {
    if (target.disabled || target.readOnly) return false;
    const type = String(target.type || 'text').toLowerCase();
    return ![
      'checkbox',
      'radio',
      'button',
      'submit',
      'reset',
      'image',
      'file',
      'color',
      'range',
      'hidden',
    ].includes(type);
  }
  return false;
}
export function isMacPlatform(nav) {
  const n = nav ?? (typeof navigator !== 'undefined' ? navigator : undefined);
  const p = n?.userAgentData?.platform || n?.platform || n?.userAgent || '';
  return /mac|iphone|ipad|ipod/i.test(p);
}
export function shouldSuppressHistoryKey(event, nav) {
  if (!event || event.isComposing) return false;
  if (event.key === 'BrowserBack' || event.key === 'BrowserForward') return true;
  if (
    event.altKey &&
    !event.ctrlKey &&
    !event.metaKey &&
    (event.key === 'ArrowLeft' || event.key === 'ArrowRight')
  ) {
    // macOS Option+Left/Right moves by word in editable text; never steal it.
    // Windows/Linux Alt+Arrow has no editing role, so it stays guarded.
    if (isEditableTarget(event.target) && isMacPlatform(nav)) return false;
    return true;
  }
  if (event.key === 'Backspace' && !event.ctrlKey && !event.metaKey) return !isEditableTarget(event.target);
  return false;
}
export function shouldSuppressHistoryMouse(event) {
  return !!event && (event.button === 3 || event.button === 4);
}
export function historyDirectionForKey(event, nav) {
  if (!shouldSuppressHistoryKey(event, nav)) return null;
  if (event.key === 'BrowserBack') return 'back';
  if (event.key === 'BrowserForward') return 'forward';
  if (event.altKey && !event.ctrlKey && !event.metaKey) {
    if (event.key === 'ArrowLeft') return 'back';
    if (event.key === 'ArrowRight') return 'forward';
  }
  if (event.key === 'Backspace' && !event.ctrlKey && !event.metaKey) return 'back';
  return null;
}
export function historyDirectionForMouse(event) {
  if (!shouldSuppressHistoryMouse(event)) return null;
  if (event.button === 3) return 'back';
  if (event.button === 4) return 'forward';
  return null;
}
export function installNavigationGuard(root = document, hooks = {}) {
  if (!root || typeof root.addEventListener !== 'function') return () => {};
  if (root.__primeNavGuardInstalled) return () => {};
  const onBack = typeof hooks?.onBack === 'function' ? hooks.onBack : null;
  const onForward = typeof hooks?.onForward === 'function' ? hooks.onForward : null;
  const route = (dir, event) => {
    if (dir === 'back' && onBack) {
      try { onBack(event); } catch {}
      return true;
    }
    if (dir === 'forward' && onForward) {
      try { onForward(event); } catch {}
      return true;
    }
    return false;
  };
  const onKey = (event) => {
    const dir = historyDirectionForKey(event);
    if (!dir) return;
    event.preventDefault();
    route(dir, event);
  };
  const onMouse = (event) => {
    const dir = historyDirectionForMouse(event);
    if (!dir) return;
    event.preventDefault();
    route(dir, event);
  };
  root.addEventListener('keydown', onKey, true);
  root.addEventListener('mousedown', onMouse, true);
  root.addEventListener('auxclick', onMouse, true);
  root.addEventListener('mouseup', onMouse, true);
  root.__primeNavGuardInstalled = true;
  return () => {
    root.removeEventListener('keydown', onKey, true);
    root.removeEventListener('mousedown', onMouse, true);
    root.removeEventListener('auxclick', onMouse, true);
    root.removeEventListener('mouseup', onMouse, true);
    delete root.__primeNavGuardInstalled;
  };
}
