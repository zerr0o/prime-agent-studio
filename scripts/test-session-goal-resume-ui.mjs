import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from '@playwright/test';

const root = new URL('../', import.meta.url);
const index = await readFile(new URL('index.html', root), 'utf8');
const dialog = index.match(/<dialog\b(?=[^>]*\bid="session-goal-dialog")[^>]*>[\s\S]*?<\/dialog>/)?.[0];
const button = index.match(/<button\b(?=[^>]*\bid="session-goal-button")[^>]*>[\s\S]*?<\/button>/)?.[0];
assert.ok(dialog && button);
assert.match(dialog, /id="session-goal-resume-hint"/);
const translations = {
  'goal.status.active': 'active',
  'goal.status.paused': 'paused',
  'goal.status.budget_limited': 'budget limited',
  'goal.status.complete': 'complete',
  'goal.status.error': 'error',
  'goal.title': 'Goal',
  'goal.tokens': 'Tokens',
  'goal.time': 'Time',
  'goal.continuations': 'Continuations',
  'goal.retry': 'Retry goal',
  'goal.resume': 'Resume goal',
  'goal.retryHint': 'Retry continues this goal without resetting its usage.',
  'goal.resumeHint': 'Resume continues this goal without resetting its usage.',
  'goal.resumeBlockedRunning': 'Wait for the current run to finish before resuming this goal.',
  'goal.resumeBlockedStopping': 'Waiting for the current run to finish…',
  'goal.resumeBlockedBusy': 'The session is changing. Please wait.',
  'goal.controlConflict': 'This goal changed elsewhere. Reload the latest goal before trying again.',
};
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
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/public/styles.css"></head><body>${button}${dialog}<script type="module">
import {createSessionGoal} from '/public/session-goal.js';
const translations=${JSON.stringify(translations)};
window.requests=[];window.resumed=[];
window.goalUI=createSessionGoal({t:key=>translations[key]||key,
 api:(url,options={})=>new Promise((resolve,reject)=>requests.push({url,options,resolve,reject})),
 onResumed:(run,context)=>resumed.push({run,context})});
</script></body></html>`);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const chrome = process.env.PRIME_STUDIO_CHROMIUM || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({
  headless: true,
  ...(existsSync(chrome) ? { executablePath: chrome } : {}),
});
const page = await browser.newPage();
const baseGoal = {
  goalId: 'goal-1',
  objective: 'Fixture objective',
  status: 'error',
  active: false,
  tokensUsed: 42,
  timeUsedSeconds: 80,
  continuationsUsed: 3,
  tokenBudget: 1000,
};
async function prepare(goal = baseGoal, { resumable = true, readOnly = false, id = 'session-1' } = {}) {
  await page.goto('http://127.0.0.1:' + server.address().port);
  await page.waitForFunction(() => window.goalUI);
  await page.evaluate(
    ({ goal, resumable, readOnly, id }) => {
      goalUI.setSelection({ id, cwd: '/fixture', readOnly });
      requests[0].resolve({ goal, editable: !readOnly, controllable: !readOnly, resumable });
    },
    { goal, resumable, readOnly, id },
  );
  await page.locator('#session-goal-button').click();
  await page.waitForFunction(() => requests.length > 1);
  await page.evaluate(
    ({ goal, resumable, readOnly }) => {
      requests[1].resolve({ goal, editable: !readOnly, controllable: !readOnly, resumable });
    },
    { goal, resumable, readOnly },
  );
}
async function resolveAt(index, data) {
  await page.evaluate(({ index, data }) => requests[index].resolve(data), { index, data });
}
try {
  await prepare();
  const resume = page.locator('#session-goal-resume');
  assert.equal(await resume.innerText(), 'Retry goal');
  assert.match(await page.locator('#session-goal-resume-hint').innerText(), /without resetting its usage/);
  await resume.click();
  assert.equal(await resume.isDisabled(), true);
  await page.evaluate(() => document.getElementById('session-goal-resume').click());
  const posted = await page.evaluate(() =>
    requests.slice(2).map((r) => ({ url: r.url, options: r.options })),
  );
  assert.equal(posted.length, 1);
  assert.equal(posted[0].url, '/api/sessions/session-1/goal/resume');
  assert.equal(posted[0].options.method, 'POST');
  assert.deepEqual(posted[0].options.body, {
    cwd: '/fixture',
    goalId: 'goal-1',
    expectedObjective: 'Fixture objective',
  });
  const active = { ...baseGoal, status: 'active', active: true };
  await resolveAt(2, {
    goal: active,
    editable: false,
    run: { id: 'run-1', sessionId: 'session-1', cwd: '/fixture' },
  });
  await page.waitForFunction(() => !document.getElementById('session-goal-dialog').open);
  assert.equal(await page.evaluate(() => resumed.length), 1);
  await page.locator('#session-goal-button').click();
  await resolveAt(3, { goal: active, editable: false });
  assert.match(await page.locator('#session-goal-usage').innerText(), /42/);
  assert.equal(await resume.isVisible(), false);

  await prepare({ ...baseGoal, status: 'paused' });
  assert.equal(await resume.innerText(), 'Resume goal');
  await resume.click();
  await page.evaluate(() => requests[2].reject(Object.assign(new Error('Stale'), { status: 409 })));
  await page.waitForFunction(() => document.getElementById('session-goal-reload').hidden === false);
  assert.equal(await page.locator('#session-goal-dialog').evaluate((n) => n.open), true);
  assert.equal(await page.evaluate(() => requests.length), 3, 'a rejected POST is not automatically retried');

  for (const [goal, options] of [
    [{ ...baseGoal, status: 'active', active: true }, {}],
    [baseGoal, { resumable: false }],
    [baseGoal, { readOnly: true }],
    [{ ...baseGoal, status: 'budget_limited', tokensUsed: 1000 }, {}],
  ]) {
    await prepare(goal, options);
    assert.equal(await resume.isVisible(), false);
    await page.evaluate(() => document.getElementById('session-goal-resume').click());
    assert.equal(await page.evaluate(() => requests.length), 2);
  }
  await prepare({ ...baseGoal, status: 'budget_limited', tokensUsed: 50 });
  assert.equal(await resume.isVisible(), true);
  assert.equal(await resume.innerText(), 'Resume goal');

  await prepare();
  await resume.click();
  await page.evaluate(() => document.getElementById('session-goal-dialog').close());
  await page.locator('#session-goal-button').click();
  await resolveAt(3, { goal: baseGoal, editable: true, controllable: true, resumable: true });
  await resolveAt(2, { goal: active, editable: false, run: { id: 'reopened-run', sessionId: 'session-1' } });
  await page.waitForFunction(() => document.getElementById('session-goal-resume').hidden);
  assert.equal(
    await page.locator('#session-goal-dialog').evaluate((n) => n.open),
    true,
    'old action does not close a newly reopened dialog',
  );
  assert.equal(await page.locator('#session-goal-status').textContent(), 'active');
  assert.equal(await page.evaluate(() => resumed.length), 0);

  await prepare();
  await resume.click();
  await page.evaluate(() => {
    goalUI.setSelection({ id: 'session-2', cwd: '/other', readOnly: false });
    requests[3].resolve({
      goal: {
        goalId: 'goal-2',
        objective: 'Second fixture',
        status: 'paused',
        active: false,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        continuationsUsed: 0,
      },
      editable: true,
      resumable: true,
    });
  });
  await page.locator('#session-goal-button').click();
  await resolveAt(4, {
    goal: {
      goalId: 'goal-2',
      objective: 'Second fixture',
      status: 'paused',
      active: false,
      tokensUsed: 0,
      timeUsedSeconds: 0,
      continuationsUsed: 0,
    },
    editable: true,
    resumable: true,
  });
  await resolveAt(2, { goal: active, editable: false, run: { id: 'old-run', sessionId: 'session-1' } });
  await page.waitForTimeout(30);
  assert.equal(await page.locator('#session-goal-dialog').evaluate((n) => n.open), true);
  assert.equal(await page.locator('#session-goal-objective').innerText(), 'Second fixture');
  assert.equal(await page.evaluate(() => resumed.length), 0, 'stale resume never steals a selected session');

  await page.setViewportSize({ width: 390, height: 844 });
  const bounds = await page.locator('#session-goal-resume').boundingBox();
  assert.ok(bounds.height >= 44 && bounds.x >= 0 && bounds.x + bounds.width <= 390);
  console.log(
    'Goal resume UI: explicit CAS POST, usage preservation, permissions, budget, stale selection and mobile target passed.',
  );
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
