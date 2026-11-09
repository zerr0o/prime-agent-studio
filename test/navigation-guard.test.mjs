import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  isEditableTarget,
  isMacPlatform,
  shouldSuppressHistoryKey,
  shouldSuppressHistoryMouse,
  installNavigationGuard,
} from '../public/navigation-guard.js';
const MAC_NAV = { platform: 'MacIntel' };
const WIN_NAV = { platform: 'Win32' };

const key = (over = {}) => ({
  key: 'a',
  target: { nodeType: 1, tagName: 'DIV' },
  isComposing: false,
  ...over,
});
const el = (over = {}) => ({
  nodeType: 1,
  tagName: 'DIV',
  isContentEditable: false,
  disabled: false,
  readOnly: false,
  type: 'text',
  ...over,
});

test('editable targets keep Backspace/Delete editing', () => {
  assert.equal(isEditableTarget(el({ tagName: 'TEXTAREA' })), true);
  assert.equal(isEditableTarget(el({ tagName: 'TEXTAREA', readOnly: true })), false);
  assert.equal(isEditableTarget(el({ tagName: 'TEXTAREA', disabled: true })), false);
  assert.equal(isEditableTarget(el({ tagName: 'INPUT', type: 'text' })), true);
  assert.equal(isEditableTarget(el({ tagName: 'INPUT', type: 'search' })), true);
  assert.equal(isEditableTarget(el({ tagName: 'INPUT', type: 'checkbox' })), false);
  assert.equal(isEditableTarget(el({ tagName: 'INPUT', type: 'text', readOnly: true })), false);
  assert.equal(isEditableTarget(el({ tagName: 'DIV', isContentEditable: true })), true);
  assert.equal(isEditableTarget(el({ tagName: 'DIV' })), false);
  assert.equal(isEditableTarget(el({ tagName: 'SELECT' })), false);
  assert.equal(isEditableTarget(null), false);
});

test('Backspace suppressed only outside editable text', () => {
  assert.equal(shouldSuppressHistoryKey(key({ key: 'Backspace', target: el({ tagName: 'DIV' }) })), true);
  assert.equal(
    shouldSuppressHistoryKey(key({ key: 'Backspace', target: el({ tagName: 'TEXTAREA' }) })),
    false,
  );
  assert.equal(
    shouldSuppressHistoryKey(key({ key: 'Backspace', target: el({ tagName: 'INPUT', type: 'text' }) })),
    false,
  );
  assert.equal(
    shouldSuppressHistoryKey(key({ key: 'Backspace', target: el({ tagName: 'TEXTAREA', readOnly: true }) })),
    true,
  );
  assert.equal(shouldSuppressHistoryKey(key({ key: 'Delete', target: el({ tagName: 'DIV' }) })), false);
  assert.equal(
    shouldSuppressHistoryKey(key({ key: 'Backspace', target: el({ tagName: 'DIV' }), ctrlKey: true })),
    false,
  );
  assert.equal(
    shouldSuppressHistoryKey(key({ key: 'Backspace', target: el({ tagName: 'DIV' }), isComposing: true })),
    false,
  );
});

test('involuntary history shortcuts suppressed, normal keys kept', () => {
  const body = el({ tagName: 'DIV' });
  const area = el({ tagName: 'TEXTAREA' });
  assert.equal(shouldSuppressHistoryKey(key({ key: 'ArrowLeft', altKey: true, target: body })), true);
  assert.equal(shouldSuppressHistoryKey(key({ key: 'ArrowRight', altKey: true, target: body })), true);
  assert.equal(shouldSuppressHistoryKey(key({ key: 'ArrowLeft', altKey: true, target: area })), true);
  assert.equal(shouldSuppressHistoryKey(key({ key: 'BrowserBack', target: body })), true);
  assert.equal(shouldSuppressHistoryKey(key({ key: 'BrowserForward', target: area })), true);
  assert.equal(shouldSuppressHistoryKey(key({ key: 'a', target: body })), false);
  assert.equal(shouldSuppressHistoryKey(key({ key: 'Enter', target: area })), false);
  assert.equal(shouldSuppressHistoryKey(key({ key: 'ArrowLeft', target: body })), false);
  assert.equal(
    shouldSuppressHistoryKey(key({ key: 'ArrowLeft', altKey: true, ctrlKey: true, target: body })),
    false,
  );
});

test('mac Option+Left/Right word nav kept in editable text', () => {
  const area = {
    nodeType: 1,
    tagName: 'TEXTAREA',
    isContentEditable: false,
    disabled: false,
    readOnly: false,
  };
  const body = { nodeType: 1, tagName: 'DIV', isContentEditable: false };
  assert.equal(isMacPlatform(MAC_NAV), true);
  assert.equal(isMacPlatform(WIN_NAV), false);
  assert.equal(isMacPlatform(undefined), false);
  // macOS editable: Option+Arrow edits (word jump), never suppress.
  assert.equal(shouldSuppressHistoryKey({ key: 'ArrowLeft', altKey: true, target: area }, MAC_NAV), false);
  assert.equal(shouldSuppressHistoryKey({ key: 'ArrowRight', altKey: true, target: area }, MAC_NAV), false);
  // macOS non-editable: still guard involuntary back.
  assert.equal(shouldSuppressHistoryKey({ key: 'ArrowLeft', altKey: true, target: body }, MAC_NAV), true);
  // Windows editable: Alt+Arrow has no editing role, stays guarded.
  assert.equal(shouldSuppressHistoryKey({ key: 'ArrowLeft', altKey: true, target: area }, WIN_NAV), true);
  // AltGr (Ctrl+Alt) never suppressed.
  assert.equal(
    shouldSuppressHistoryKey({ key: 'ArrowLeft', altKey: true, ctrlKey: true, target: area }, MAC_NAV),
    false,
  );
});

test('mouse back/forward buttons suppressed, normal buttons kept', () => {
  assert.equal(shouldSuppressHistoryMouse({ button: 3 }), true);
  assert.equal(shouldSuppressHistoryMouse({ button: 4 }), true);
  assert.equal(shouldSuppressHistoryMouse({ button: 0 }), false);
  assert.equal(shouldSuppressHistoryMouse({ button: 1 }), false);
  assert.equal(shouldSuppressHistoryMouse({ button: 2 }), false);
});

test('installer is idempotent, removable, and adds no history entries', async () => {
  const calls = [];
  const fake = {
    __primeNavGuardInstalled: false,
    addEventListener: (t, fn, cap) => calls.push(['add', t, cap]),
    removeEventListener: (t, fn, cap) => calls.push(['remove', t, cap]),
  };
  const cleanup = installNavigationGuard(fake);
  assert.equal(fake.__primeNavGuardInstalled, true);
  for (const type of ['keydown', 'mousedown', 'auxclick', 'mouseup'])
    assert.ok(
      calls.some((c) => c[0] === 'add' && c[1] === type && c[2] === true),
      type + ' listener attached',
    );
  const n = calls.length;
  installNavigationGuard(fake);
  assert.equal(calls.length, n, 'second install must be a no-op');
  cleanup();
  assert.ok(calls.length > n, 'cleanup must detach listeners');
  const src = await readFile(new URL('../public/navigation-guard.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('pushState'), 'never trap back button with fake entries');
  assert.ok(!src.includes('history.go') && !src.includes('history.back'), 'never drive history');
});
