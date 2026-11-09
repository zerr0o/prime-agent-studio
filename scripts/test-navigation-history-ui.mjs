// Navigation history UI: buttons, no reload, back/forward restore, truncation, missing safe.
// Bounded 90s, cleanup always. Headless only.
import { launchStudioBrowser } from './fixtures/browser.mjs';
import { createStabilityFixture } from './fixtures/session-stability.mjs';
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
  await page.waitForSelector('#nav-back', { timeout: 10000 });
  await page.waitForSelector('#nav-forward', { timeout: 10000 });
  checks.push('buttons present');
  // guard installed + no history spam on load (replaceState only, no push)
  const boot = await page.evaluate(() => ({
    guard: !!document.__primeNavGuardInstalled,
    backDisabled: document.getElementById('nav-back')?.disabled === true,
    fwdDisabled: document.getElementById('nav-forward')?.disabled === true,
    len: history.length,
  }));
  if (!boot.guard) throw new Error('guard missing');
  if (!boot.backDisabled || !boot.fwdDisabled) throw new Error('buttons must start disabled');
  checks.push('boot disabled len=' + boot.len);
  const noReload = await page.evaluate(async () => {
    const before = document.getElementById('composer');
    // internal helper exposure: nav buttons must not reload (same composer node)
    document.getElementById('nav-back')?.click();
    document.getElementById('nav-forward')?.click();
    await new Promise((r) => setTimeout(r, 300));
    return document.getElementById('composer') === before;
  });
  if (!noReload) throw new Error('nav buttons reloaded document');
  checks.push('no-reload ok');
  // history module pure checks in page (dedupe/truncate/bounds/content-free)
  const pure = await page.evaluate(async () => {
    const m = await import('/public/navigation-history.js');
    const h = m.createNavigationHistory({ max: 3 });
    h.replaceInitial({ kind: 'session', sessionId: 'a' });
    h.push({ kind: 'session', sessionId: 'b' });
    h.push({ kind: 'session', sessionId: 'b' });
    const dedupeLen = h.snapshot().entries.length;
    h.beginBack();
    h.push({ kind: 'session', sessionId: 'c' });
    const truncFwd = h.canForward();
    const contentFree = h.snapshot().entries.every((e) => !('text' in e) && !('draft' in e));
    return { dedupeLen, truncFwd, contentFree };
  });
  if (pure.dedupeLen !== 2) throw new Error('dedupe failed len=' + pure.dedupeLen);
  if (pure.truncFwd !== false) throw new Error('forward not truncated');
  if (!pure.contentFree) throw new Error('content leaked');
  checks.push('pure dedupe/truncate/content-free ok');
  if (errors.length) throw new Error('pageerrors: ' + errors.slice(0, 3).join(' | '));
  console.log(JSON.stringify({ passed: true, checks }));
} catch (e) {
  console.error(JSON.stringify({ passed: false, reason: String((e && e.message) || e), checks, errors: errors.slice(0, 5) }));
  process.exitCode = 1;
} finally {
  try { await browser?.close(); } catch {}
  try { await fixture?.cleanup?.(); } catch {}
  clearTimeout(timer);
}
