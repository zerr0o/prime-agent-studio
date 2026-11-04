import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { chromium } from '@playwright/test';

const root = new URL('../', import.meta.url);
const index = await readFile(new URL('index.html', root), 'utf8');
const dialog = index.match(/<dialog id="session-goal-dialog"[\s\S]*?<\/dialog>/)?.[0];
const headerButton = index.match(/<button\s+[^>]*id="session-goal-button"[\s\S]*?<\/button>/)?.[0];
assert.ok(dialog && headerButton, 'Goal dialog and header button exist in index.html');

const server = createServer(async (req, res) => {
  if (req.url === '/public/session-goal.js') {
    res.setHeader('Content-Type', 'text/javascript');
    res.end(await readFile(new URL('public/session-goal.js', root)));
    return;
  }
  if (req.url === '/public/styles.css') {
    res.setHeader('Content-Type', 'text/css');
    res.end(await readFile(new URL('public/styles.css', root)));
    return;
  }
  res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/public/styles.css"></head><body>${headerButton}${dialog}<script type="module">
    import { createSessionGoal } from '/public/session-goal.js';
    window.requests = [];
    window.resumedRuns = [];
    const translations = {
      'goal.title': 'Goal', 'goal.tokens': 'Tokens', 'goal.time': 'Time',
      'goal.continuations': 'Continuations', 'goal.length': 'Invalid objective',
      'goal.conflict': 'This goal changed elsewhere. Your draft is preserved.',
      'goal.controlConflict': 'This goal changed elsewhere. Reload the latest goal before trying again.',
      'goal.status.active': 'active', 'goal.status.paused': 'paused',
    };
    window.goalUI = createSessionGoal({
      t: (key) => translations[key] || key,
      onResumed: (run) => window.resumedRuns.push(run),
      api: (url, options = {}) => new Promise((resolve, reject) => {
        window.requests.push({ url, options, resolve, reject });
      }),
    });
  </script></body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

const chrome = process.env.PRIME_STUDIO_CHROMIUM || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(chrome) ? { executablePath: chrome } : {}),
});
const page = await browser.newPage();
const goal = (goalId, objective, active = true) => ({
  goalId,
  objective,
  active,
  status: active ? 'active' : 'paused',
  tokensUsed: 0,
  timeUsedSeconds: 0,
  continuationsUsed: 0,
});
const envelope = (value, editable = true, controllable = true, resumable = false) => ({
  goal: value,
  editable,
  controllable,
  resumable,
});
const requestAt = async (index) => {
  await page.waitForFunction((i) => window.requests.length > i, index);
  return page.evaluate((i) => ({ url: requests[i].url, options: requests[i].options }), index);
};
const resolveAt = (index, value) => page.evaluate(([i, data]) => requests[i].resolve(data), [index, value]);
const rejectAt = (index, message, status) =>
  page.evaluate(
    ([i, text, code]) => {
      const error = new Error(text);
      error.status = code;
      requests[i].reject(error);
    },
    [index, message, status],
  );
const select = (id, readOnly = false) =>
  page.evaluate(
    ([sessionId, locked]) => {
      goalUI.setSelection({
        id: sessionId,
        cwd: '/workspace',
        readOnly: locked,
      });
    },
    [id, readOnly],
  );

try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.waitForFunction(() => Boolean(window.goalUI));

  await select('one');
  assert.equal((await requestAt(0)).url, '/api/sessions/one/goal');
  await resolveAt(0, envelope(goal('g1', 'First objective')));
  await page.locator('#session-goal-button').click();
  await requestAt(1);
  await resolveAt(1, envelope(goal('g1', 'First objective')));
  assert.equal(await page.locator('#session-goal-stop').isVisible(), true);
  assert.equal(await page.locator('#session-goal-clear').isVisible(), true);

  await page.evaluate(() => {
    document.getElementById('session-goal-stop').click();
    document.getElementById('session-goal-stop').click();
  });
  const stopped = await requestAt(2);
  assert.deepEqual(stopped, {
    url: '/api/sessions/one/goal/stop',
    options: {
      method: 'POST',
      body: {
        cwd: '/workspace',
        goalId: 'g1',
        expectedObjective: 'First objective',
      },
    },
  });
  assert.equal(await page.locator('#session-goal-edit').isDisabled(), true);
  assert.equal(await page.locator('#session-goal-save').isDisabled(), true);
  assert.equal(await page.locator('#session-goal-stop').isDisabled(), true);
  assert.equal(await page.locator('#session-goal-clear').isDisabled(), true);
  assert.equal(await page.evaluate(() => requests.length), 3, 'double click sends one Stop request');
  await resolveAt(2, envelope(goal('g1', 'First objective', false)));
  await page.locator('#session-goal-stop').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#session-goal-status').textContent(), 'paused');

  await page.locator('#session-goal-clear').click();
  assert.deepEqual(await requestAt(3), {
    url: '/api/sessions/one/goal/clear',
    options: {
      method: 'POST',
      body: {
        cwd: '/workspace',
        goalId: 'g1',
        expectedObjective: 'First objective',
      },
    },
  });
  await resolveAt(3, envelope(null));
  await page.waitForFunction(() => !document.getElementById('session-goal-dialog').open);
  assert.equal(await page.locator('#session-goal-button').isVisible(), false);

  await select('locked', true);
  await requestAt(4);
  await resolveAt(4, envelope(goal('g2', 'Read only')));
  await page.locator('#session-goal-button').click();
  await requestAt(5);
  await resolveAt(5, envelope(goal('g2', 'Read only')));
  assert.equal(await page.locator('#session-goal-edit').isVisible(), false);
  assert.equal(await page.locator('#session-goal-stop').isVisible(), false);
  assert.equal(await page.locator('#session-goal-clear').isVisible(), false);

  await select('conflict');
  await requestAt(6);
  await resolveAt(6, envelope(goal('g3', 'Original')));
  await page.locator('#session-goal-button').click();
  await requestAt(7);
  await resolveAt(7, envelope(goal('g3', 'Original')));
  await page.locator('#session-goal-stop').click();
  await requestAt(8);
  await rejectAt(8, 'Conflict', 409);
  await page.locator('#session-goal-reload').waitFor({ state: 'visible' });
  assert.match(await page.locator('#session-goal-error').textContent(), /Reload the latest goal/);
  await page.locator('#session-goal-reload').click();
  await requestAt(9);
  await resolveAt(9, envelope(goal('g3', 'Updated elsewhere')));
  await page.waitForFunction(() => document.getElementById('session-goal-error').hidden);
  assert.equal(await page.locator('#session-goal-objective').textContent(), 'Updated elsewhere');

  await select('old');
  await requestAt(10);
  await resolveAt(10, envelope(goal('g4', 'Old session')));
  await page.locator('#session-goal-button').click();
  await requestAt(11);
  await resolveAt(11, envelope(goal('g4', 'Old session')));
  await page.locator('#session-goal-stop').click();
  await requestAt(12);
  await select('new');
  await requestAt(13);
  await resolveAt(13, envelope(goal('g5', 'New session')));
  await page.locator('#session-goal-button').click();
  await requestAt(14);
  await resolveAt(14, envelope(goal('g5', 'New session')));
  await resolveAt(12, envelope(goal('g4', 'Old session', false)));
  assert.equal(await page.locator('#session-goal-dialog').evaluate((node) => node.open), true);
  assert.equal(await page.locator('#session-goal-objective').textContent(), 'New session');
  assert.equal(await page.locator('#session-goal-status').textContent(), 'active');

  await page.locator('#session-goal-edit').click();
  await page.locator('#session-goal-input').fill('Revised objective');
  await page.locator('#session-goal-save').click();
  assert.equal((await requestAt(15)).options.method, 'PATCH');
  assert.equal(await page.locator('#session-goal-save').isDisabled(), true);
  assert.equal(await page.locator('#session-goal-stop').isVisible(), false);
  assert.equal(await page.locator('#session-goal-clear').isVisible(), false);
  await resolveAt(15, envelope(goal('g5', 'Revised objective')));
  await page.waitForFunction(() => document.getElementById('session-goal-save').hidden);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobile = await page.evaluate(() => {
    const dialog = document.getElementById('session-goal-dialog');
    const actions = dialog.querySelector('.modal-actions');
    const buttons = ['session-goal-stop', 'session-goal-clear'].map((id) => {
      const element = document.getElementById(id);
      return {
        id,
        height: element.getBoundingClientRect().height,
        visible: !element.hidden && getComputedStyle(element).display !== 'none',
      };
    });
    const bounds = dialog.getBoundingClientRect();
    return {
      viewportWidth: innerWidth,
      pageWidth: document.documentElement.scrollWidth,
      dialogLeft: bounds.left,
      dialogRight: bounds.right,
      dialogWidth: dialog.clientWidth,
      dialogScrollWidth: dialog.scrollWidth,
      actionsWidth: actions.clientWidth,
      actionsScrollWidth: actions.scrollWidth,
      buttons,
    };
  });
  assert.equal(mobile.viewportWidth, 390);
  assert.ok(mobile.pageWidth <= 390, `page overflows mobile viewport: ${JSON.stringify(mobile)}`);
  assert.ok(
    mobile.dialogLeft >= 0 && mobile.dialogRight <= 390,
    `dialog exceeds mobile viewport: ${JSON.stringify(mobile)}`,
  );
  assert.ok(
    mobile.dialogScrollWidth <= mobile.dialogWidth + 1,
    `dialog has horizontal overflow: ${JSON.stringify(mobile)}`,
  );
  assert.ok(
    mobile.actionsScrollWidth <= mobile.actionsWidth + 1,
    `actions have horizontal overflow: ${JSON.stringify(mobile)}`,
  );
  for (const button of mobile.buttons) {
    assert.equal(button.visible, true, `${button.id} should be visible on mobile`);
    assert.ok(button.height >= 44, `${button.id} touch height is ${button.height}px`);
  }
  if (process.platform === 'win32' && existsSync('R:/TEMP'))
    await page.screenshot({ path: 'R:/TEMP/prime-goal-controls-mobile.png' });

  const errored = { ...goal('g6', 'Keep counters'), active: false, status: 'error', tokensUsed: 72 };
  await select('unsupported');
  await requestAt(16);
  await resolveAt(16, envelope(errored));
  await page.locator('#session-goal-button').click();
  await requestAt(17);
  await resolveAt(17, envelope(errored));
  assert.equal(await page.locator('#session-goal-resume').isVisible(), false);

  await select('read-only-error', true);
  await requestAt(18);
  await resolveAt(18, envelope(errored, true, true, true));
  await page.locator('#session-goal-button').click();
  await requestAt(19);
  await resolveAt(19, envelope(errored, true, true, true));
  assert.equal(await page.locator('#session-goal-resume').isVisible(), false);

  await select('retry');
  await requestAt(20);
  await resolveAt(20, envelope(errored, true, true, true));
  await page.locator('#session-goal-button').click();
  await requestAt(21);
  await resolveAt(21, envelope(errored, true, true, true));
  await page.evaluate(() => {
    document.getElementById('session-goal-resume').click();
    document.getElementById('session-goal-resume').click();
  });
  assert.deepEqual(await requestAt(22), {
    url: '/api/sessions/retry/goal/resume',
    options: {
      method: 'POST',
      body: {
        cwd: '/workspace',
        goalId: 'g6',
        expectedObjective: 'Keep counters',
      },
    },
  });
  assert.equal(await page.evaluate(() => requests.length), 23, 'double click starts one retry');
  await resolveAt(22, { ...envelope(errored), resumable: false, run: { id: 'run-1', sessionId: 'retry' } });
  await page.waitForFunction(() => !document.getElementById('session-goal-dialog').open);
  assert.equal(await page.evaluate(() => resumedRuns.length), 1);

  console.log('Session Goal controls UI: actions, races, and 390px mobile layout passed');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
