// Regression: involuntary history shortcuts disabled, editing kept, no history trap.
// Bounded 90s, cleanup always. Headless only; physical WebView2 accel out of scope.
import { launchStudioBrowser } from '../scripts/fixtures/browser.mjs';
import { createStabilityFixture } from '../scripts/fixtures/session-stability.mjs';
const timer = setTimeout(() => {
  console.error(JSON.stringify({ passed: false, reason: 'deadline' }));
  process.exit(2);
}, 90000);
timer.unref?.();
let browser, fixture;
const checks = [];
const errors = [];
try {
  fixture = await createStabilityFixture();
  browser = await launchStudioBrowser({ channel: 'chrome' });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(String((e && e.message) || e)));
  await page.goto(fixture.url + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer', { timeout: 20000 });
  const installed = await page.evaluate(() => !!document.__primeNavGuardInstalled);
  checks.push('guard installed=' + installed);
  if (!installed) throw new Error('guard not installed');
  const h0 = await page.evaluate(() => history.length);
  const res = await page.evaluate(() => {
    const out = {};
    const disp = (target, init) => {
      const ev = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
      (target || document).dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    out.altLeftBody = disp(document, { key: 'ArrowLeft', altKey: true });
    out.altRightBody = disp(document, { key: 'ArrowRight', altKey: true });
    out.browserBack = disp(document, { key: 'BrowserBack' });
    out.browserFwd = disp(document, { key: 'BrowserForward' });
    out.bsBody = disp(document, { key: 'Backspace' });
    out.aBody = disp(document, { key: 'a' });
    out.arrowBody = disp(document, { key: 'ArrowLeft' });
    const ta = document.querySelector('#composer');
    out.bsTextarea = disp(ta, { key: 'Backspace' });
    out.altLeftTextarea = disp(ta, { key: 'ArrowLeft', altKey: true });
    const m = (type, button) => {
      const ev = new MouseEvent(type, { bubbles: true, cancelable: true, button });
      document.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    out.mouse3 = m('mousedown', 3) && m('auxclick', 3) && m('mouseup', 3);
    out.mouse4 = m('mousedown', 4) && m('auxclick', 4) && m('mouseup', 4);
    out.mouse0 = m('mousedown', 0) || m('auxclick', 0) || m('mouseup', 0);
    // dynamic panes mounted AFTER install (delegation check)
    const dynTa = document.createElement('textarea');
    document.body.appendChild(dynTa);
    const dynDiv = document.createElement('div');
    dynDiv.contentEditable = 'true';
    document.body.appendChild(dynDiv);
    out.dynBsTa = disp(dynTa, { key: 'Backspace' });
    out.dynBsDiv = disp(dynDiv, { key: 'Backspace' });
    out.dynAltLeft = disp(dynTa, { key: 'ArrowLeft', altKey: true });
    dynTa.remove();
    dynDiv.remove();
    out.hLen = history.length;
    return out;
  });
  console.log('MATRIX ' + JSON.stringify(res));
  const expect = (name, got, want) => {
    if (got !== want) throw new Error(name + ' got=' + got + ' want=' + want);
    checks.push(name + '=' + got);
  };
  expect('altLeftBody', res.altLeftBody, true);
  expect('altRightBody', res.altRightBody, true);
  expect('browserBack', res.browserBack, true);
  expect('browserFwd', res.browserFwd, true);
  expect('bsBody', res.bsBody, true);
  expect('aBody', res.aBody, false);
  expect('arrowBody', res.arrowBody, false);
  expect('bsTextarea', res.bsTextarea, false);
  expect('altLeftTextarea', res.altLeftTextarea, true);
  expect('mouse3', res.mouse3, true);
  expect('mouse4', res.mouse4, true);
  expect('mouse0', res.mouse0, false);
  expect('dynBsTa', res.dynBsTa, false);
  expect('dynBsDiv', res.dynBsDiv, false);
  expect('dynAltLeft', res.dynAltLeft, true);
  if (res.hLen !== h0) throw new Error('history spam h0=' + h0 + ' h1=' + res.hLen);
  checks.push('no-history-spam len=' + res.hLen);
  // macOS Option+Arrow word nav kept in editable text (page module, fake nav override)
  const mac = await page.evaluate(async () => {
    const g = await import('/public/navigation-guard.js');
    const ta = document.querySelector('#composer');
    return {
      macEditable: g.shouldSuppressHistoryKey(
        { key: 'ArrowLeft', altKey: true, target: ta },
        { platform: 'MacIntel' },
      ),
      winEditable: g.shouldSuppressHistoryKey(
        { key: 'ArrowLeft', altKey: true, target: ta },
        { platform: 'Win32' },
      ),
      macBody: g.shouldSuppressHistoryKey(
        { key: 'ArrowLeft', altKey: true, target: document.body },
        { platform: 'MacIntel' },
      ),
    };
  });
  if (mac.macEditable !== false) throw new Error('mac editable Option+Left must edit');
  if (mac.winEditable !== true) throw new Error('win editable Alt+Left stays guarded');
  if (mac.macBody !== true) throw new Error('mac body Alt+Left stays guarded');
  checks.push('mac-word-nav-kept');
  // location.replace swaps in place: no bootstrap entry left behind (native boot path analogue)
  const hBefore = await page.evaluate(() => history.length);
  await Promise.all([
    page.waitForURL(/replace-sim/, { timeout: 20000 }),
    page.evaluate(() => {
      const u = new URL(location.href);
      u.searchParams.set('replace-sim', '1');
      location.replace(u.toString());
    }),
  ]);
  await page.waitForSelector('#composer', { timeout: 20000 });
  const hAfter = await page.evaluate(() => history.length);
  if (hAfter !== hBefore) throw new Error('replace pushed entry hBefore=' + hBefore + ' hAfter=' + hAfter);
  if (!page.url().includes('replace-sim')) throw new Error('replace did not land');
  checks.push('replace-leaves-no-entry len=' + hAfter);
  // editing preserved in real composer
  await page.locator('#composer').fill('abc');
  await page.locator('#composer').press('Backspace');
  const v = await page.locator('#composer').inputValue();
  if (v !== 'ab') throw new Error('composer edit broken got=' + JSON.stringify(v));
  checks.push('composer-backspace-edits=' + JSON.stringify(v));
  // real back button NOT trapped (no fake history loop): chain then goBack still navigates
  await page.goto(fixture.url + '/?sim-launcher', { waitUntil: 'domcontentloaded' });
  await page.goto(fixture.url + '/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#composer', { timeout: 20000 });
  const u0 = await page.evaluate(() => location.href);
  await page.goBack();
  await page.waitForTimeout(600);
  const u1 = await page.evaluate(() => location.href);
  if (u1 === u0) throw new Error('back button trapped (must not)');
  checks.push('real-back-not-trapped');
  if (errors.length) throw new Error('pageerrors: ' + errors.join(' | ').slice(0, 500));
  console.log(JSON.stringify({ passed: true, checks }));
} catch (e) {
  console.error(JSON.stringify({ passed: false, error: String((e && e.message) || e), checks, errors }));
  process.exitCode = 1;
} finally {
  clearTimeout(timer);
  await browser?.close().catch(() => {});
  await fixture?.close().catch(() => {});
}
