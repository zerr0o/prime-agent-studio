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
    'afterViewFocused saveSelection renderNavigation closeSidebar openProjectDialog saveDraft resetView selectNewConversationModel restoreDraft renderMessages'
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
        created = 0;
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
        convViews: {
          bindFocused: bind,
          createView: () => {
            created += 1;
            return null;
          },
          ...(mode === 'docked'
            ? {
                focusView: (id, opts) => {
                  revealed = { id, opts };
                },
              }
            : {}),
        },
        dockingUI: { active: mode === 'docked' },
        computerUseUI: null,
        $: () => hostBox,
      });
      create(input);
      assert.equal(
        binding.execCwd,
        expectedCwd(input, 'C:/project'),
        `${mode} must guard the execution cwd before rebinding, got ${JSON.stringify(input)}`,
      );
      assert.equal(binding.kind, 'new', `${mode} must rebind a fresh new chat`);
      assert.equal(binding.sessionId, null, `${mode} must clear the session binding`);
      assert.equal(bindingOpts.keepNonce, true, `${mode} must preserve the draft slot`);
      assert.equal(created, 0, `${mode} must not create an extra tab`);
      if (mode === 'docked') {
        assert.equal(revealed?.id, 'conv:v2', 'docked must reveal the rebound pane before focusing');
        assert.equal(
          revealed?.opts?.reveal,
          true,
          'docked reveal must request panel mount, not a silent refocus',
        );
        assert.ok(paneTouched, 'docked must focus the rebound pane own textarea');
        assert.ok(!hostTouched, 'docked must not steal focus back to primary');
      } else {
        assert.ok(hostTouched, 'classic must focus the host composer');
      }
    }
  }
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
