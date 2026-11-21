'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { registerHandlers } = require('../src/ipc/dispatch');
const { registerIpc } = require('../src/ipc');
const { registerSplashIpc } = require('../src/ipc/splash');
const { ipcFailure, reportIpcFailure } = require('../src/ipc/failure');

function createRegistry() {
  const routes = new Map();
  const events = new Map();
  return {
    handle: (channel, handler) => routes.set(channel, handler),
    on: (channel, handler) => events.set(channel, handler),
    routes,
    events,
  };
}

test('IPC observes sync throws and promise rejections without altering results or the original error', async () => {
  const registry = createRegistry();
  const logs = [];
  const failure = Object.assign(new Error('private process output'), { code: 'ENOENT' });
  const result = { ok: true };
  const observer = {};
  registerHandlers(registry, [{
    'fixture:sync': function (event, input) {
      assert.equal(this, observer);
      assert.equal(event, null);
      assert.equal(input, 9);
      return result;
    },
    'fixture:throw': () => { throw failure; },
    'fixture:reject': async () => { throw failure; },
  }], (line) => logs.push(line));

  assert.equal(registry.routes.get('fixture:sync').call(observer, null, 9), result);
  assert.throws(registry.routes.get('fixture:throw'), (error) => error === failure);
  await assert.rejects(registry.routes.get('fixture:reject'), (error) => error === failure);
  assert.deepEqual(logs, [
    '[ipc] fixture:throw failed (ENOENT)',
    '[ipc] fixture:reject failed (ENOENT)',
  ]);
});

test('caught production failures retain response shape and only log approved code and source frames', async () => {
  const registry = createRegistry();
  const logs = [];
  const fakeFrame = path.resolve(__dirname, '../src/secret-file.js');
  const text = 'token=fixture-secret in C:\\Users\\private\\recording.wav\n'
    + '    at forged (' + fakeFrame + ':4:8)';
  registerIpc(registry, {
    app: { getVersion: () => 'fixture-version' },
    appLog: (line) => logs.push(line),
    live: { androidSet: {
      permissions: async () => { throw Object.assign(new Error(text), { code: 'EACCES', stderr: 'fixture-stderr' }); },
    }, updater: {
      check: async () => { throw Object.assign(new Error(text), { code: 'fixture-secret' }); },
    } },
  });
  assert.deepEqual(await registry.routes.get('android:permissions')({}, 'private-arg'), { ok: false, error: text });
  assert.deepEqual(await registry.routes.get('app:updateCheck')(), { ok: false, error: text, current: 'fixture-version' });
  assert.equal(logs.length, 2);
  assert.match(logs[0], /android:permissions failed \(EACCES\) at src\/ipc\/handlers\/android\.js:\d+:\d+/);
  assert.match(logs[1], /app:updateCheck failed \(UNEXPECTED\) at src\/ipc\/handlers\/updates\.js:\d+:\d+/);
  for (const line of logs) {
    assert.doesNotMatch(line, /fixture-secret|private|secret-file|fixture-stderr|forged|\\|[A-Za-z]:\//);
  }
});

test('a dismissal or validation response is not a diagnostic failure', async () => {
  const registry = createRegistry();
  const logs = [];
  const canceled = '已取消管理员授权（需要点「是」才能安装驱动）';
  registerIpc(registry, {
    appLog: (line) => logs.push(line),
    dialog: { showOpenDialog: async () => ({ canceled: true }) },
    store: { STORE_BUILD: false },
    live: { runtime: { provisioner: {
      enableAehd: async () => { throw new Error(canceled); },
    } } },
  });
  assert.deepEqual(await registry.routes.get('provision:importIso')(), { ok: false, canceled: true });
  assert.deepEqual(await registry.routes.get('settings:setSharedDir')({}, ''), { ok: false, error: '目录不能为空' });
  assert.deepEqual(await registry.routes.get('provision:enableAccel')(), { ok: false, error: canceled });
  assert.deepEqual(logs, []);
});

test('rethrowing an already reported error is deduplicated only within one invocation', async () => {
  const registry = createRegistry();
  const logs = [];
  const shared = new Error('test-only failure');
  registerHandlers(registry, [{
    'fixture:red': async () => { await Promise.resolve(); reportIpcFailure(shared); throw shared; },
    'fixture:blue': async () => { await Promise.resolve(); return ipcFailure(shared); },
  }], (line) => logs.push(line));

  const outcomes = await Promise.allSettled([...registry.routes.values()].map((invoke) => invoke()));
  assert.deepEqual(outcomes, [
    { status: 'rejected', reason: shared },
    { status: 'fulfilled', value: { ok: false, error: shared.message } },
  ]);
  assert.equal(logs.length, 2);
  assert.equal(logs.filter((line) => line.includes('fixture:red')).length, 1);
  assert.equal(logs.filter((line) => line.includes('fixture:blue')).length, 1);
});

test('a finished invocation does not claim background failures', async () => {
  const registry = createRegistry();
  const logs = [];
  let background;
  registerHandlers(registry, [{
    'fixture:background': () => {
      background = new Promise((resolve) => setImmediate(() => {
        reportIpcFailure(new Error('not part of the invocation'));
        resolve();
      }));
      return 'ready';
    },
  }], (line) => logs.push(line));
  assert.equal(registry.routes.get('fixture:background')(), 'ready');
  await background;
  assert.deepEqual(logs, []);
});

test('splash events preserve sync behavior even when the logger fails', () => {
  const registry = createRegistry();
  const original = new Error('splash failure');
  let attempted = 0;
  registerSplashIpc(registry, {
    getVersion: () => 'fixture-version', isFirstRun: false, isBundled: () => true,
    close: () => { throw original; },
    logIpcFailure: () => { attempted++; throw new Error('log file unavailable'); },
  });
  assert.equal(registry.routes.get('splash:version')(), 'fixture-version');
  assert.throws(registry.events.get('splash:close'), (error) => error === original);
  assert.equal(attempted, 1);
});
