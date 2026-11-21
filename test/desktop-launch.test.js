'use strict';

const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createLaunchPresentation } = require('../src/desktop/launch-presentation');
const { createDesktopShutdown } = require('../src/desktop/shutdown');
const { createAgentSession } = require('../src/desktop/agent-session');
const { WinAgent } = require('../src/core/agent');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

function launchFixture({ detached = false, attach, firstFrame, openDetached, canShowWait }) {
  const calls = [];
  const timers = new Map();
  let current = true;
  let owner;
  let ownerAtStart;
  const shell = (name) => ({
    show() { calls.push([name, 'show']); },
    setAlwaysOnTop(on) { calls.push([name, 'top', on]); },
    moveTop() { calls.push([name, 'move']); },
    focus() { calls.push([name, 'focus']); },
  });
  const window = {
    win: shell('original'), isOpen: true,
    openDetached: openDetached || (() => Promise.resolve(false)),
    showWaitSurface: (options) => calls.push(['wait', options]),
    setState: (state) => calls.push(['state', state]),
  };
  owner = ownerAtStart = window.win;
  const presentation = createLaunchPresentation({
    pkg: 'com.fixture.app',
    getWindow: () => window,
    isCurrent: () => current && owner === ownerAtStart,
    ownsWindow: () => owner === ownerAtStart,
    isDetached: () => detached,
    canShowWait,
    attach,
    firstFrame,
    finishSplash: () => calls.push(['splash']),
    mark: (value) => calls.push(['mark', value]),
    log: (value) => calls.push(['log', value]),
    schedule(task, ms) {
      const id = Symbol(String(ms));
      timers.set(id, { task, ms });
      return id;
    },
    cancel(id) { timers.delete(id); },
  });

  return {
    presentation, calls, timers, window,
    fire(ms) {
      const [id, job] = [...timers].find(([, entry]) => entry.ms === ms);
      timers.delete(id);
      job.task();
    },
    replaceWindow() { owner = window.win = shell('replacement'); },
    closeSession() { current = false; },
  };
}

test('final setup waits for the native discovery already underway and reuses successful early attachment', async () => {
  const discovering = deferred();
  const frame = deferred();
  let attempts = 0;
  const fixture = launchFixture({
    detached: true,
    openDetached: () => discovering.promise,
    attach: async (isCurrent) => { attempts += 1; return isCurrent(); },
    firstFrame: (pkg, options) => {
      assert.equal(pkg, 'com.fixture.app');
      assert.deepEqual(options, { timeoutMs: 20000 });
      return frame.promise;
    },
  });
  const { presentation, calls, timers } = fixture;
  presentation.startDiscovery();
  presentation.startEarly();
  const final = presentation.finishAttachment();
  await tick();
  assert.equal(attempts, 0);
  discovering.resolve(false);
  assert.equal(await final, true);
  assert.equal(attempts, 1);
  assert.deepEqual(calls, []);
  assert.equal([...timers.values()].some((timer) => timer.ms === 1500), false);

  frame.resolve(true);
  await tick();
  assert.deepEqual(calls, [['mark', 'first frame=true'], ['state', { ready: true, tip: '' }], ['splash']]);
  assert.equal(timers.size, 0);
});

test('embedded fallback retries once; delayed topmost reset and frame completion cannot affect replacement', async () => {
  const frame = deferred();
  let attempts = 0;
  const fixture = launchFixture({
    attach: async () => ++attempts === 2,
    firstFrame: () => frame.promise,
  });
  const { presentation, calls } = fixture;
  presentation.startEarly();
  assert.equal(await presentation.finishAttachment(), true);
  assert.equal(attempts, 2);
  assert.deepEqual(calls, [
    ['original', 'show'], ['original', 'top', true], ['original', 'move'], ['original', 'focus'],
  ]);
  fixture.replaceWindow();
  fixture.fire(700);
  frame.resolve(true);
  await tick();
  fixture.fire(24000);
  assert.equal(calls.length, 4);
});

test('native discovery pauses during repaneling and abort cancels a pending retry', async () => {
  let probes = 0;
  const fixture = launchFixture({
    detached: true,
    attach: async () => false,
    firstFrame: async () => assert.fail('no successful attachment'),
    openDetached: async () => { probes += 1; return false; },
  });
  const { window, presentation, calls, timers } = fixture;
  window.waitingForRestart = true;
  presentation.startDiscovery();
  assert.equal(probes, 0);
  window.waitingForRestart = false;
  fixture.fire(1500);
  await tick();
  assert.equal(probes, 1);
  fixture.closeSession();
  await presentation.abort();
  assert.deepEqual(calls, [['splash']]);
  assert.equal(timers.size, 0);
});

test('startup timeout retires an incomplete animation once without waiting for the first frame', async () => {
  const frame = deferred();
  const fixture = launchFixture({
    detached: true,
    attach: async () => true,
    firstFrame: () => frame.promise,
  });
  const { presentation, calls, timers } = fixture;
  assert.equal(await presentation.finishAttachment(), true);
  assert.deepEqual(calls, []);
  fixture.fire(24000);
  frame.resolve(true);
  await tick();
  await presentation.abort();
  assert.deepEqual(calls.filter(([kind]) => kind === 'splash' || kind === 'state'),
    [['state', { ready: true, tip: '' }], ['splash']]);
  assert.equal(timers.size, 0);
});

test('animation deadline releases the cover, not readiness, when no surface exists', async () => {
  for (const allowed of [true, false]) {
    const { presentation, fire, calls } = launchFixture({
      detached: true,
      attach: async () => false,
      firstFrame: async () => assert.fail('frame probe without a confirmed surface'),
      canShowWait: () => allowed,
    });
    fire(24000);
    assert.equal(await presentation.finishAttachment(), false);
    await presentation.abort();
    assert.deepEqual(calls, allowed ? [['wait', { activate: false }], ['splash']] : [['splash']]);
  }
});

test('a detached preference does not suppress a verified embedded fallback', async () => {
  let window;
  const fixture = launchFixture({
    detached: true,
    attach: async () => { window.detachedMode = false; return true; },
    firstFrame: () => Promise.resolve(false),
  });
  window = fixture.window;
  assert.equal(await fixture.presentation.finishAttachment(), true);
  assert.deepEqual(fixture.calls.slice(0, 4), [
    ['original', 'show'], ['original', 'top', true], ['original', 'move'], ['original', 'focus'],
  ]);
  await fixture.presentation.abort();
});

test('desktop quit waits for native park and ignores repeat quit events while pending', async () => {
  const parked = deferred();
  const calls = [];
  const shutdown = createDesktopShutdown({
    stopBackground: () => calls.push('background'),
    parkWindow: async () => { calls.push('park'); await parked.promise; calls.push('parked'); },
    disposeAgent: () => calls.push('dispose'),
    releaseRuntime: () => calls.push('release'),
    closeDecoder: () => calls.push('decoder'),
    quit: () => calls.push('quit'),
    log: (error) => assert.fail(error),
  });
  const event = { preventDefault: () => calls.push('blocked') };
  const completion = shutdown.beforeQuit(event);
  await tick();
  assert.deepEqual(calls, ['blocked', 'background', 'park']);
  assert.equal(shutdown.beforeQuit(event), completion);
  assert.equal(shutdown.ready, false);
  parked.resolve();
  await completion;
  assert.equal(shutdown.ready, true);
  shutdown.beforeQuit(event);
  assert.deepEqual(calls, ['blocked', 'background', 'park', 'blocked', 'parked', 'dispose', 'release', 'decoder', 'quit']);
});

const mainSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');

test('a guest app with no window returns a presentation failure and no launched event', async () => {
  const calls = [];
  const ticket = { pkg: 'com.fixture.app' };
  const anchor = mainSource.indexOf('async function launchOne(pkg)');
  const end = mainSource.indexOf('/**', anchor);
  const launch = vm.runInNewContext(`${mainSource.slice(anchor, end)}; launchOne`, {
    quitting: false,
    runtime: { guestGeneration: 17 },
    appSessions: {
      isCurrent: (value) => value === ticket,
      waitForTurn: async () => {},
      activate: async () => assert.fail('activate without a verified surface'),
      discard: () => calls.push('discard'),
    },
    createLaunchPresentation: () => ({
      startDiscovery: () => {}, finishAttachment: async () => false, abort: async () => {},
    }),
    mainWindow: null,
    appWin: { waitForPark: async () => {}, close: async () => calls.push('close'), lastEmbedError: 'no-emu' },
    attachAppWindow: () => {},
    openAppWindow: async () => ticket,
    desktopAgent: { arm: async () => {} },
    installer: { launch: async () => ({ generation: 17, engine: 'emulator' }) },
    startupSplash: null,
    appLog: () => {},
    showWindow: () => calls.push('manager'),
    send: (channel) => calls.push(channel),
  });
  const result = await launch(ticket.pkg);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'APP_WINDOW_UNAVAILABLE');
  assert.deepEqual(calls, ['discard', 'close', 'manager', 'toast']);
});

test('bundled discovery does not rewrite manual 4096 MB, cores, GPU, or a valid external runtime', () => {
  const anchor = mainSource.indexOf('function bootstrapBundledRuntime()');
  const end = mainSource.indexOf('// 冒烟截图', anchor);
  const bundled = 'C:\\package\\runtime';
  for (const runtime of [bundled, 'D:\\custom\\resources\\runtime']) {
    const writes = [];
    const settings = { runtime: { dir: runtime }, engine: { memoryMB: 4096, cores: 6, gpuMode: 'swiftshader_indirect', autoMemory: false } };
    const bootstrap = vm.runInNewContext(`${mainSource.slice(anchor, end)}; bootstrapBundledRuntime`, {
      app: { isPackaged: true }, process: { execPath: 'C:\\package\\ApkStart.exe', resourcesPath: 'C:\\package\\resources' },
      path: path.win32, bundledRuntimeDir: '',
      fs: {
        existsSync: (file) => file.startsWith(bundled) || file === path.win32.join(runtime, 'emulator', 'emulator.exe'),
        readdirSync: (dir) => [dir.endsWith('system-images') ? 'android-34' : dir.endsWith('android-34') ? 'google_apis_playstore' : 'x86_64'],
      },
      store: { DATA_DIR: 'C:\\data', getSettings: () => settings, saveSettings: (patch) => writes.push(patch) },
      appLog: () => {},
    });
    bootstrap();
    assert.deepEqual(writes, []);
  }
});

test('a replacement native agent is scoped before use; stale agents cannot affect it or route input', async () => {
  const oldScope = deferred();
  const entries = [];
  const agents = [];
  const createAgent = () => {
    const id = agents.length;
    const agent = new EventEmitter();
    agent.scope = async (dirs, owner) => {
      entries.push(['scope', id, dirs, owner]);
      if (id === 0) await oldScope.promise;
    };
    agent.bootHide = async () => { entries.push(['hide', id]); return { ok: true }; };
    agent.dispose = () => entries.push(['dispose', id]);
    agents.push(agent);
    return agent;
  };
  const session = createAgentSession({
    createAgent, scopeDirs: () => ['/fixture/engine'], ownerPid: 812,
    wheelRouter: { push: (value) => entries.push(['wheel', value]), dispose: () => entries.push(['wheel-dispose']) },
    wheelMode: () => 'smooth',
    onBack: async () => entries.push(['back']), onForward: async () => entries.push(['forward']),
    onReplace: (agent) => entries.push(['replace', agents.indexOf(agent)]),
    log: () => {},
  });
  const oldArm = session.arm();
  agents[0].emit('exit');
  oldScope.resolve();
  assert.deepEqual(await oldArm, { ok: false });
  assert.equal(session.current, agents[1]);
  agents[0].emit('exit');
  agents[0].emit('back');
  agents[1].emit('wheel', 9);
  session.dispose();
  session.dispose();
  agents[1].emit('exit');
  agents[1].emit('forward');
  assert.deepEqual(entries, [
    ['scope', 0, ['/fixture/engine'], 812], ['replace', 1], ['scope', 1, ['/fixture/engine'], 812],
    ['hide', 1], ['wheel', 9], ['dispose', 1], ['wheel-dispose'],
  ]);
  assert.equal(agents.length, 2);
});

function consentFixture({ show = async () => true } = {}) {
  const entries = [];
  const agents = [];
  const session = createAgentSession({
    createAgent() {
      const agent = new EventEmitter();
      const id = agents.length;
      agents.push(agent);
      agent.scope = async () => {};
      agent.bootHide = async () => ({ ok: true });
      agent.reserveAdbConsent = async (pid) => {
        entries.push(['reserve', id, pid]);
        return {
          show: () => { entries.push(['show', id]); return show(); },
          close: async () => entries.push(['close', id]),
        };
      };
      agent.dispose = () => {};
      return agent;
    },
    scopeDirs: () => ['/fixture/engine'], ownerPid: 61, log: () => {},
    wheelRouter: { dispose() {} }, onReplace: () => {},
  });
  return { entries, agents, session };
}

test('ADB consent shows only after the native window is pinned and guest ownership is freshly checked', async () => {
  const { entries, session } = consentFixture();
  const cleanup = await session.presentAdbConsent({ pid: 82, revalidate: async () => {
    entries.push(['revalidate']);
    return true;
  } });
  assert.equal(typeof cleanup, 'function');
  assert.deepEqual(entries, [['reserve', 0, 82], ['revalidate'], ['show', 0]]);
  await Promise.all([cleanup(), cleanup()]);
  assert.deepEqual(entries.at(-1), ['close', 0]);
  assert.equal(entries.length, 4);
  session.dispose();
});

test('ADB consent releases unshown leases on stale ownership and failed show', async () => {
  const { entries, session } = consentFixture({ show: async () => false });
  assert.equal(await session.presentAdbConsent({ pid: 82, revalidate: async () => false }), null);
  assert.equal(await session.presentAdbConsent({ pid: 83, revalidate: async () => true }), null);
  assert.deepEqual(entries, [['reserve', 0, 82], ['close', 0], ['reserve', 0, 83], ['show', 0], ['close', 0]]);
  session.dispose();
});

test('an agent replacement during ADB consent revalidation cannot show a stale window', async () => {
  const { entries, agents, session } = consentFixture();
  const proof = deferred();
  const pending = session.presentAdbConsent({ pid: 88, revalidate: () => proof.promise });
  await tick();
  agents[0].emit('exit');
  proof.resolve(true);
  assert.equal(await pending, null);
  assert.deepEqual(entries, [['reserve', 0, 88], ['close', 0]]);
  session.dispose();
});

test('ADB consent requests bind one PID and token to the original helper connection', async () => {
  const agent = new WinAgent();
  const calls = [];
  agent.call = async (message) => { calls.push(message); return { ok: true }; };
  assert.equal(await agent.reserveAdbConsent(91), null);
  agent._attempt = { connected: true };
  const lease = await agent.reserveAdbConsent(91);
  assert.equal(await lease.show(), true);
  await lease.close();
  assert.deepEqual(calls.map(({ cmd, pid }) => [cmd, pid]), [
    ['adbConsentTarget', 91], ['adbConsentShow', 91], ['adbConsentEnd', 91],
  ]);
  assert.match(calls[0].token, /^[0-9a-f]{32}$/);
  assert.equal(new Set(calls.map(({ token }) => token)).size, 1);
  agent._attempt = { connected: true };
  assert.equal(await lease.show(), false);
  assert.equal(await lease.close(), null);
  assert.equal(calls.length, 3);
});
