import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { createNativeInteractions } from '../lib/native-interactions.mjs';
import { transformStudioRpc } from '../runtime/studio-rpc-hook.mjs';
import { discoverCli } from '../lib/agent.mjs';
import { createProjectFiles } from '../lib/project-files.mjs';

test('native answers are correlated, validated and only accepted once after acknowledgement', async () => {
  const events = [],
    commands = [];
  const bridge = createNativeInteractions({
    emit: (event) => events.push(event),
    send: (command) => commands.push(command),
  });
  bridge.consume({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'question' });
  bridge.consume({
    type: 'extension_ui_request',
    id: 'q1',
    method: 'select',
    title: 'Pick',
    options: ['A', 'B'],
  });
  const pending = bridge.respond('q1', { value: 'Custom answer' });
  assert.equal(events.at(-1).request.status, 'pending');
  await assert.rejects(bridge.respond('q1', { value: 'B' }));
  assert.deepEqual(commands, [{ type: 'extension_ui_response', id: 'q1', value: 'Custom answer' }]);
  bridge.consume({ type: 'tool_execution_end', toolCallId: 't1' });
  bridge.consume({ type: 'response', id: 'q1', command: 'extension_ui_response', success: true });
  assert.equal((await pending).status, 'answered');
  assert.equal(events.at(-1).request.answer, 'Custom answer');
  await assert.rejects(bridge.respond('q1', { value: 'B' }));
  bridge.close();
});

test('generic engine selects reject arbitrary answers; expired and cancelled tools cannot remain pending', async () => {
  const events = [];
  const bridge = createNativeInteractions({ emit: (event) => events.push(event), send() {} });
  bridge.consume({ type: 'tool_execution_start', toolCallId: 't1', toolName: 'ipython' });
  bridge.consume({
    type: 'extension_ui_request',
    id: 'q1',
    method: 'select',
    title: 'Kernel busy',
    options: ['Wait', 'Kill'],
  });
  await assert.rejects(bridge.respond('q1', { value: 'Arbitrary' }), /invalide/);
  bridge.consume({ type: 'tool_execution_end', toolCallId: 't1' });
  assert.equal(events.at(-1).request.status, 'cancelled');
  await assert.rejects(bridge.respond('q1', { value: 'Wait' }));
  bridge.consume({ type: 'extension_ui_request', id: 'q2', method: 'input', title: 'Input' });
  const pending = bridge.respond('q2', { value: 'Text' });
  bridge.consume({ type: 'response', id: 'q2', command: 'extension_ui_response', success: false });
  await assert.rejects(pending);
  assert.equal(events.at(-1).request.status, 'interrupted');
  bridge.close();
});

test('RPC adapter matches actual packaged and source modules and fails on incompatible layouts', async () => {
  const cli = discoverCli();
  if (!cli?.packageDir) return;
  const root = cli.packageDir;
  let checked = 0;
  for (const path of [
    join(root, 'dist/modes/rpc/rpc-mode.js'),
    ...(await readdir(join(root, 'dist/bundle')))
      .filter((name) => name.endsWith('.js'))
      .map((name) => join(root, 'dist/bundle', name)),
  ]) {
    const source = await readFile(path, 'utf8');
    if (!source.includes('function runRpcModeWithConnectionInternal(')) continue;
    const adapted = transformStudioRpc(source);
    assert.equal(adapted.changed, true);
    assert.ok(adapted.source.includes('waitForRlmQuiescence: true'));
    assert.throws(() => transformStudioRpc(source.replaceAll('case "get_state": {', 'case "new_state": {')));
    checked++;
  }
  assert.ok(checked >= 2);
});

test('referenced images read current project files, detect deletion and reject private/outside paths', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'prime-images-'));
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    await rm(root, { recursive: true, force: true });
  });
  const cwd = join(root, 'project'),
    outside = join(root, 'private');
  await mkdir(cwd);
  await mkdir(outside);
  await mkdir(join(cwd, '.local'));
  const images = createProjectFiles({
    protectedRoots: [join(cwd, '.local')],
    store: {
      findProject: async (value) => {
        assert.equal(value, cwd);
        return { cwd };
      },
    },
  });
  const file = join(cwd, 'résultat.png');
  await writeFile(file, 'first');
  assert.equal((await images.image(cwd, 'r%C3%A9sultat.png')).data.toString(), 'first');
  await writeFile(file, 'updated');
  assert.equal((await images.image(cwd, file)).data.toString(), 'updated');
  await rm(file);
  await assert.rejects(images.image(cwd, 'résultat.png'), (error) => error.status === 404);
  await writeFile(join(outside, 'secret.png'), 'private');
  await writeFile(join(cwd, '.local', 'secret.png'), 'private');
  await symlink(outside, join(cwd, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  for (const path of ['../private/secret.png', 'escape/secret.png', '.local/secret.png'])
    await assert.rejects(images.image(cwd, path), (error) => error.status === 403);
  await writeFile(join(cwd, 'unsafe.svg'), '<svg/>');
  await assert.rejects(images.image(cwd, 'unsafe.svg'), (error) => error.status === 415);
});
