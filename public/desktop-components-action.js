import { t as tr } from './i18n.js';
export function isDesktopComponentsAvailable() {
  return window.__PRIME_STUDIO_DESKTOP__ === true && typeof window.__TAURI__?.core?.invoke === 'function';
}
export function isNewComponentsBridgeAvailable() {
  return (
    window.__PRIME_STUDIO_COMPONENTS__ === true &&
    window.__PRIME_STUDIO_DESKTOP__ === true &&
    typeof window.__TAURI__?.core?.invoke === 'function'
  );
}
let componentsOpening = false;
let updatesOpener = null;
export function registerDesktopComponentsOpener(fn) {
  updatesOpener = typeof fn === 'function' ? fn : null;
}
export function openUpdatesPane() {
  if (typeof updatesOpener === 'function') {
    try {
      const result = updatesOpener();
      if (result && typeof result.then === 'function') void result.catch(() => {});
      return true;
    } catch {
      return false;
    }
  }
  try {
    const dialog = document.getElementById('settings-dialog');
    const tab = document.getElementById('settings-tab-updates');
    if (!dialog || !tab) return false;
    if (!dialog.open) dialog.showModal();
    tab.click();
    tab.focus({ preventScroll: true });
    return true;
  } catch {
    return false;
  }
}
export async function openDesktopComponents(opts) {
  const toast = opts && opts.toast;
  if (isNewComponentsBridgeAvailable()) {
    const opened = openUpdatesPane();
    if (opened) return true;
    if (typeof toast === 'function') toast(tr('settings.components_note'));
    return false;
  }
  if (!isDesktopComponentsAvailable()) {
    if (typeof toast === 'function') toast(tr('settings.components_note'));
    return false;
  }
  if (componentsOpening) return false;
  componentsOpening = true;
  try {
    await window.__TAURI__.core.invoke('desktop_components_open');
    return true;
  } catch {
    if (typeof toast === 'function') toast(tr('settings.components_note'));
    return false;
  } finally {
    componentsOpening = false;
  }
}
