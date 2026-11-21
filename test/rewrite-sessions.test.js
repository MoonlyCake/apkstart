'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { AppSessions } = require('../src/application/app-sessions');

function deferred() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

function makeSessions({ engine = {}, stop, priority } = {}) {
  const calls = [];
  const sessions = new AppSessions({
    getSettings: () => ({ engine }),
    getApps: () => [],
    getClient: () => ({
      forceStop: async (pkg) => { calls.push(['stop', pkg]); return stop?.(pkg); },
      shell: async (command) => { calls.push(['shell', command]); },
    }),
    touch: () => {},
    cancelSnapshot: () => calls.push(['cancelSnapshot']),
    scheduleSnapshot: (delay) => calls.push(['snapshot', delay]),
    setPriority: async (level) => { calls.push(['priority', level]); await priority?.(level); },
    onActivityChanged: (active) => calls.push(['activity', active]),
    log: () => {},
  });
  return { sessions, calls };
}

test('warm foreground and the last close use consistent priority and activity edges', async () => {
  for (const [mode, foreground, idle] of [['balanced', 'normal', 'idle'], ['game', 'game', 'normal']]) {
    const { sessions, calls } = makeSessions({ engine: { priorityMode: mode } });
    const ticket = sessions.reserve('com.example.app');
    assert.equal(sessions.isIdle, false, 'opening vetoes low-priority parking');
    await sessions.activate(ticket);
    assert.equal(sessions.currentPackage, ticket.pkg);
    assert.equal(sessions.hasActive(ticket.pkg), true);
    assert.equal(sessions.reserve(ticket.pkg, { reuse: true }), ticket);
    await sessions.activate(ticket);
    await sessions.close(ticket);
    assert.equal(sessions.isIdle, true);
    assert.equal(sessions.currentPackage, null);
    assert.deepEqual(calls.filter(([kind]) => kind === 'priority'), [
      ['priority', foreground], ['priority', foreground], ['priority', idle],
    ]);
    assert.deepEqual(calls.filter(([kind]) => kind === 'activity'), [['activity', true], ['activity', false]]);
    assert.equal(calls.filter(([kind]) => kind === 'cancelSnapshot').length, 1);
    assert.deepEqual(calls.at(-1), ['snapshot', 8000]);
  }
});

test('a previous close event does not stop a new window for the same package', async () => {
  const { sessions, calls } = makeSessions();
  const old = sessions.reserve('com.example.app');
  await sessions.activate(old);
  const pendingClose = sessions.close(old);
  const next = sessions.reserve(old.pkg);
  assert.notEqual(next, old);
  assert.equal(await sessions.waitForTurn(next), true);
  await pendingClose;
  await sessions.activate(next);
  await sessions.close(old);
  assert.equal(sessions.currentTicket, next);
  assert.equal(sessions.hasActive(next.pkg), true);
  assert.equal(calls.some(([kind]) => kind === 'stop' || kind === 'snapshot'), false);
});

test('launch preparation waits for a dispatched close and does not park over a new app', async () => {
  const release = deferred();
  const started = deferred();
  const { sessions, calls } = makeSessions({ stop: () => { started.resolve(); return release.promise; } });
  const old = sessions.reserve('com.first.app');
  await sessions.activate(old);
  const pendingClose = sessions.close(old);
  await started.promise;
  const next = sessions.reserve('com.second.app');
  let ready = false;
  const turn = sessions.waitForTurn(next).then((ok) => { ready = ok; });
  await Promise.resolve();
  assert.equal(ready, false);
  release.resolve();
  await Promise.all([turn, pendingClose]);
  assert.equal(ready, true);
  assert.deepEqual(calls.filter(([kind]) => kind === 'stop'), [['stop', old.pkg]]);
  assert.equal(calls.some(([kind]) => kind === 'snapshot'), false);
});

test('experimental multi-window trimming keeps the most recent background and never stops foreground', async () => {
  const { sessions, calls } = makeSessions({ engine: { multiWindow: true, keepBackground: 1 } });
  for (const pkg of ['com.old.app', 'com.recent.app', 'com.current.app']) {
    await sessions.activate(sessions.reserve(pkg));
  }
  assert.deepEqual(calls.filter(([kind]) => kind === 'shell'), [['shell', 'am force-stop com.old.app']]);
  const recent = sessions.reserve('com.recent.app', { reuse: true });
  await sessions.activate(recent);
  assert.deepEqual(calls.at(-1), ['shell', 'am force-stop com.old.app']);
  await sessions.close(recent);
  assert.equal(sessions.currentPackage, 'com.current.app');
  assert.equal(calls.some(([kind]) => kind === 'snapshot'), false);
});

test('a stopped guest invalidates queued app effects but retains its window ticket for repanel', async () => {
  const gate = deferred();
  const started = deferred();
  const { sessions, calls } = makeSessions({ priority: () => { started.resolve(); return gate.promise; } });
  const ticket = sessions.reserve('com.example.app');
  const activating = sessions.activate(ticket);
  await started.promise;
  sessions.guestStopped();
  assert.equal(sessions.isCurrent(ticket), true);
  assert.equal(sessions.isIdle, true);
  assert.equal(sessions.hasActive(ticket.pkg), false);
  gate.resolve();
  assert.equal(await activating, null);
  assert.deepEqual(calls.filter(([kind]) => kind === 'activity'), [['activity', true], ['activity', false]]);
  await sessions.activate(ticket);
  assert.equal(sessions.hasActive(ticket.pkg), true);
});

test('explicit stop preserves the foreground ticket until Android confirms and never parks on rejection', async () => {
  let acknowledge = false;
  const { sessions, calls } = makeSessions({
    stop: async () => {
      if (!acknowledge) throw new Error('adb disconnected');
      return true;
    },
  });
  const ticket = sessions.reserve('com.example.app');
  await sessions.activate(ticket);
  await assert.rejects(sessions.stop(ticket.pkg), /adb disconnected/);
  assert.equal(sessions.currentTicket, ticket);
  assert.equal(sessions.hasActive(ticket.pkg), true);
  assert.equal(calls.some(([kind]) => kind === 'snapshot'), false);
  acknowledge = true;
  await sessions.stop(ticket.pkg);
  assert.equal(sessions.currentTicket, null);
  assert.equal(sessions.isIdle, true);
  assert.deepEqual(calls.at(-1), ['snapshot', 8000]);
});

test('an old acknowledged stop cannot discard a replacement ticket', async () => {
  const issued = deferred();
  const confirm = deferred();
  const { sessions, calls } = makeSessions({ stop: () => { issued.resolve(); return confirm.promise; } });
  const ticket = sessions.reserve('com.example.app');
  await sessions.activate(ticket);
  const pending = sessions.stop(ticket.pkg);
  await issued.promise;
  const next = sessions.reserve(ticket.pkg);
  confirm.resolve(true);
  await assert.rejects(pending, /会话或安卓运行时已切换/);
  assert.equal(sessions.currentTicket, next);
  assert.equal(calls.some(([kind]) => kind === 'snapshot'), false);
});

// A Node fixture supplies only the BrowserWindow boundary; no desktop or guest is started.
class FixtureWindow extends EventEmitter {
  constructor() { super(); this.webContents = new EventEmitter(); this.destroyed = false; }
  loadFile() {}
  isDestroyed() { return this.destroyed; }
  destroy() { this.destroyed = true; this.emit('closed'); }
  show() { this.visible = true; }
  hide() { this.visible = false; this.hides = (this.hides || 0) + 1; }
}

function fixtureAppWindow() {
  const load = Module._load;
  try {
    Module._load = function (id, parent, main) {
      if (id === 'electron' && /appwin\.js$/.test(parent?.filename || '')) {
        return {
          BrowserWindow: FixtureWindow,
          screen: { getCursorScreenPoint: () => ({}), getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, w: 900, h: 820 } }) },
        };
      }
      return load.call(this, id, parent, main);
    };
    return require('../src/core/appwin').AppWindow;
  } finally { Module._load = load; }
}

test('a late old BrowserWindow close reports its own ticket and does not remove the new shell', async () => {
  const AppWindow = fixtureAppWindow();
  const firstPark = deferred();
  let parks = 0;
  const win = new AppWindow({ agent: { park: () => ++parks === 1 ? firstPark.promise : Promise.resolve() } });
  win._syncHook = () => {};
  const pkg = 'com.example.app';
  const old = Object.freeze({ pkg });
  const next = Object.freeze({ pkg });
  const oldClosed = [];
  const externalClosed = [];
  win.onCloseApp((name, ticket) => externalClosed.push([name, ticket]));
  const former = win.open({ pkg, session: old, onClosed: (name, ticket) => oldClosed.push([name, ticket]) });
  const closing = win.close({ keepApp: true });
  const latest = win.open({ pkg, session: next });
  former.emit('closed');
  assert.equal(win.win, latest);
  assert.equal(win.session, next);
  assert.deepEqual(externalClosed, []);
  firstPark.resolve();
  await closing;
  assert.deepEqual(oldClosed, [[pkg, old]]);
  assert.equal(win.win, latest);
  latest.destroy();
  await win.waitForPark();
  assert.deepEqual(externalClosed, [[pkg, next]]);
  assert.equal(win.session, null);
});

test('failed detached lookup leaves the waiting shell open', async () => {
  const AppWindow = fixtureAppWindow();
  const win = new AppWindow({
    agent: {
      detach: async () => ({ ok: true }), setTitle: async () => ({ ok: true }),
      show: async () => ({ ok: false }),
    },
  });
  win._syncHook = () => {};
  const shell = win.open({ pkg: 'com.example.app', detached: true, showWhileWaiting: true });
  win._push = () => {};
  shell.emit('ready-to-show');
  assert.equal(await win.openDetached(), false);
  assert.equal(shell.visible, true);
  assert.equal(shell.hides, undefined);
});

test('close waits for in-flight attach before native park and prevents later show', async () => {
  const AppWindow = fixtureAppWindow();
  const sentDetach = deferred();
  const detached = deferred();
  const calls = [];
  const win = new AppWindow({
    agent: {
      detach: () => { calls.push('detach'); sentDetach.resolve(); return detached.promise; },
      setTitle: async () => calls.push('title'),
      show: async () => calls.push('show'),
      park: async (timeout) => { calls.push(['park', timeout]); return { ok: true }; },
    },
  });
  win._syncHook = () => {};
  const shell = win.open({ pkg: 'com.example.app', detached: true });
  shell.on('closed', () => calls.push('destroy'));
  const attaching = win.openDetached();
  await sentDetach.promise;
  const closing = win.close({ keepApp: true });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ['detach']);
  detached.resolve({ ok: true });
  assert.equal(await attaching, false);
  await closing;
  assert.deepEqual(calls, ['detach', ['park', 0], 'destroy']);
});

test('a rejected physical rotate keeps the previous panel and does not apply a logical fallback', async () => {
  const AppWindow = fixtureAppWindow();
  const logical = [];
  const win = new AppWindow({ agent: {}, setOrientation: async (landscape) => logical.push(landscape) });
  win._syncHook = () => {};
  win._push = () => {};
  win.open({ pkg: 'com.example.app' });
  const result = await win.rotate(async () => false, true);
  assert.equal(result, false);
  assert.equal(win.state.landscape, false);
  assert.deepEqual(logical, []);
  assert.equal(await win.rotate(undefined, true), true);
  assert.deepEqual(logical, [true]);
});
