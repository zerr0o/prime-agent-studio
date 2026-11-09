import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { messages } from '../public/translations.js';

const appSource = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');

test('newSession ignores non-string cwd (click events) in every creation mode', () => {
  const source = appSource.slice(
    appSource.indexOf('function newSession('),
    appSource.indexOf('function selectProject('),
  );
  const noop = () => {};
  const effects = Object.fromEntries(
    'afterViewFocused saveSelection renderNavigation closeSidebar openProjectDialog saveDraft resetView selectNewConversationModel restoreDraft renderMessages captureCurrentHistoryScroll pushUserSelection restoreHistoryScroll'
      .split(' ')
      .map((name) => [name, noop]),
  );
  const inputs = [undefined, null, { type: 'click' }, [], 42, false, '', '  ', 'C:/task'];
  const expectedCwd = (input, projectCwd) => (input === 'C:/task' ? input : projectCwd);
  for (const input of inputs) {
    const state = { projectCwd: 'C:/project', readOnly: false };
    const create = runInNewContext(`(${source})`, {
      ...effects,
      state,
      historyNavSilence: false,
      historyTargetViewId: null,
      navHistory: { isCurrent: () => true, invalidate: () => 0 },
      convViews: null,
      dockingUI: { active: false },
      computerUseUI: null,
      $: () => ({ focus: noop }),
    });
    create(input);
    assert.equal(
      state.execCwd,
      expectedCwd(input, 'C:/project'),
      `legacy must guard the execution cwd, got ${input === 'C:/task' ? input : state.projectCwd}`,
    );
  }
  for (const mode of ['classic', 'docked']) {
    for (const input of inputs) {
      const state = { projectCwd: 'C:/project', readOnly: false };
      let binding,
        bindingOpts,
        created = 0,
        rebound = 0;
      let paneTouched = false;
      let hostTouched = false;
      const paneBox = {
        focus: () => {
          paneTouched = true;
        },
      };
      const hostBox = {
        focus: () => {
          hostTouched = true;
        },
      };
      const bind = (value, opts) => {
        binding = value;
        bindingOpts = opts;
        return mode === 'docked'
          ? { id: 'conv:v2', units: { nodes: { textarea: paneBox } } }
          : { id: 'conversation' };
      };
      let revealed = null;
      const create = runInNewContext(`(${source})`, {
        ...effects,
        state,
        historyNavSilence: false,
        historyTargetViewId: null,
        navHistory: { isCurrent: () => true, invalidate: () => 0 },
        convViews: {
          focused: () => ({ id: 'conversation' }),
          bindFocused: (value, opts) => {
            rebound += 1;
            return bind(value, opts);
          },
          createView: (value, opts) => {
            created += 1;
            return bind(value, opts);
          },
          ...(mode === 'docked'
            ? {
                focusView: (id, opts) => {
                  revealed = { id, opts };
                },
              }
            : {}),
        },
        dockingUI: { active: mode === 'docked', openPanel: noop },
        projectNavigation: null,
        computerUseUI: null,
        $: () => hostBox,
      });
      create(input);
      assert.equal(
        binding.execCwd,
        expectedCwd(input, 'C:/project'),
        `${mode} must guard the execution cwd, got ${JSON.stringify(input)}`,
      );
      assert.equal(binding.kind, 'new', `${mode} must open a fresh new chat`);
      assert.equal(binding.sessionId, null, `${mode} new chat has no session`);
      assert.equal(created, mode === 'docked' ? 1 : 0, `${mode}: additive creation only when docked`);
      assert.equal(rebound, mode === 'docked' ? 0 : 1, `${mode}: existing docked tab must not be rebound`);
      if (mode === 'docked') {
        assert.equal(bindingOpts, undefined, 'docked must not inherit the previous tab draft slot');
        assert.equal(revealed?.id, 'conv:v2', 'docked must reveal the new pane before focusing');
        assert.equal(
          revealed?.opts?.reveal,
          true,
          'docked reveal must request panel mount, not a silent refocus',
        );
        assert.ok(paneTouched, 'docked must focus the new pane own textarea');
        assert.ok(!hostTouched, 'docked must not steal focus back to primary');
      } else {
        assert.equal(bindingOpts.keepNonce, true, 'classic retains its single draft slot');
        assert.ok(hostTouched, 'classic must focus the host composer');
      }
    }
  }
});

test('docked tab-limit refusal cannot rebind or reset the existing conversation', () => {
  const source = appSource.slice(
    appSource.indexOf('function newSession('),
    appSource.indexOf('function selectProject('),
  );
  const state = { projectCwd: 'C:/project', sessionId: 'existing', readOnly: false };
  let saved = 0;
  const create = runInNewContext(`(${source})`, {
    state,
    historyNavSilence: false,
    historyTargetViewId: null,
    navHistory: { isCurrent: () => true, invalidate: () => 0 },
    saveDraft: () => {
      saved += 1;
    },
    captureCurrentHistoryScroll: () => {},
    pushUserSelection: () => assert.fail('must not push at capacity'),
    restoreHistoryScroll: () => assert.fail('must not restore at capacity'),
    convViews: {
      focused: () => ({ id: 'conversation' }),
      createView: () => null,
      bindFocused: () => assert.fail('must not rebind at capacity'),
    },
    dockingUI: { active: true, openPanel: () => assert.fail('must not activate a missing pane') },
    afterViewFocused: () => assert.fail('must not reset generation or selection after refusal'),
  });
  create('C:/other', 'C:/other');
  assert.equal(saved, 1, 'old draft saved before attempting creation');
  assert.equal(state.projectCwd, 'C:/project');
  assert.equal(state.sessionId, 'existing');
});

test('new project and project-menu creation do not replace a tab with an overview first', () => {
  const add = appSource.slice(
    appSource.indexOf('async function addProject('),
    appSource.indexOf('let sessionMenuAnchor'),
  );
  assert.ok(add.includes('if (dockingUI?.active) newSession(cwd, cwd);'));
  const menu = appSource.slice(appSource.indexOf('async function projectMenuAction('));
  assert.match(menu, /if \(action === 'new-session'\) \{\s*newSession\(p.cwd, p.cwd\);/);
});

test("an empty new view never inherits another view's unbound running agent", () => {
  const source = appSource.slice(
    appSource.indexOf('function runningForSession('),
    appSource.indexOf('function modelForView('),
  );
  const unbound = { id: 'starting', sessionId: null, status: 'running' };
  const bound = { id: 'existing-run', sessionId: 'existing', status: 'running' };
  const runForView = runInNewContext(`${source}; runForView`, {
    state: {
      runs: new Map([
        [unbound.id, unbound],
        [bound.id, bound],
      ]),
    },
    isRunning: (run) => run.status === 'running',
  });
  assert.equal(runForView({ sessionId: null, viewRunId: null }), null);
  assert.equal(runForView({ sessionId: undefined }), null);
  assert.equal(runForView({ sessionId: null, viewRunId: 'starting' }), unbound);
  assert.equal(runForView({ sessionId: 'existing' }), bound);
});

test('new-session buttons do not forward the click event', () => {
  assert.ok(
    appSource.includes("$('new-session').onclick = () => newSession();"),
    'sidebar button must call newSession without the event',
  );
  assert.ok(
    appSource.includes("$('project-new-session').onclick = () => newSession();"),
    'listing button must call newSession without the event',
  );
  assert.ok(
    !appSource.includes("$('new-session').onclick = newSession;"),
    'direct wiring would store the MouseEvent as cwd',
  );
});

test('first send never POSTs without a valid absolute cwd', () => {
  assert.ok(appSource.includes('if (!isValidRunCwd(cwd))'), 'sendMessage must validate cwd before POST');
  assert.ok(
    appSource.includes("tr('conversation.missing_project')"),
    'missing cwd must show the actionable message',
  );
  assert.match(
    appSource,
    /const isValidRunCwd = \(value\) => \{[\s\S]*?typeof value !== 'string'[\s\S]*?\^?\[a-zA-Z\]/,
    'isValidRunCwd must reject non-strings and require an absolute path',
  );
});

test('missing project message is translated in FR and EN with no em dash', () => {
  const row = messages['conversation.missing_project'];
  assert.ok(row, 'conversation.missing_project must exist');
  assert.ok(row.fr?.trim(), 'French text is required');
  assert.ok(row.en?.trim(), 'English text is required');
  assert.ok(!row.fr.includes('\u2014') && !row.en.includes('\u2014'), 'no em dashes allowed');
  assert.match(row.fr, /projet/i);
  assert.match(row.en, /project/i);
});
