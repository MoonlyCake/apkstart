'use strict';

const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createStartupSplash, splashBounds } = require('../src/desktop/startup-splash');
const { createStartupBackground } = require('../src/desktop/startup-background');

function createClock() {
  let now = 0;
  const timers = new Set();
  return {
    now: () => now,
    setTimer(task, delay) {
      const timer = { task, at: now + delay, detached: false, unref() { this.detached = true; } };
      timers.add(timer);
      return timer;
    },
    clearTimer(timer) { timers.delete(timer); },
    delays: () => [...timers].map((timer) => [timer.at - now, timer.detached]).sort((a, b) => a[0] - b[0]),
    async advance(ms) {
      const end = now + ms;
      while (true) {
        const timer = [...timers].sort((a, b) => a.at - b.at)[0];
        if (!timer || timer.at > end) break;
        timers.delete(timer);
        now = timer.at;
        await timer.task();
      }
      now = end;
    },
  };
}

function splashSetup({ loadFile, create, workArea = { x: 0, y: 0, width: 1200, height: 1000 } } = {}) {
  const clock = createClock();
  const events = [];
  let ipc;
  let window;
  const screen = new EventEmitter();
  const display = { id: 2, workArea };
  const cursor = { x: workArea.x + 30, y: workArea.y + 30 };
  screen.getCursorScreenPoint = () => cursor;
  screen.getDisplayNearestPoint = (point) => { assert.equal(point, cursor); return display; };
  screen.getDisplayMatching = () => display;
  class Window extends EventEmitter {
    constructor(options) {
      super();
      if (create) create();
      this.destroyed = false;
      this.options = options;
      window = this;
      this.webContents = { send: (...args) => events.push(args) };
    }
    setAlwaysOnTop(on, level) { events.push(['top', on, level]); }
    loadFile(file) {
      assert.ok(ipc, 'startup IPC must exist before the renderer loads');
      events.push(['load']);
      return loadFile?.(file);
    }
    show() { events.push(['show']); }
    getBounds() { return this.options; }
    setBounds(bounds) { events.push(['bounds', bounds]); }
    isDestroyed() { return this.destroyed; }
    close() {
      this.destroyed = true;
      events.push(['close']);
      this.emit('closed');
    }
  }

  const splash = createStartupSplash({
    BrowserWindow: Window,
    screen,
    srcDir: 'fixture-src',
    registerIpc: (api) => { ipc = api; },
    log: (message) => events.push(['log', message]),
    ...clock,
  });
  return { splash, window, ipc, events, clock, screen, display };
}

test('splash fits 720p through 4K and centers inside a screen with an arbitrary origin', () => {
  const sizes = [[1280, 680, 480, 360], [1920, 1040, 536, 402], [2560, 1400, 576, 432], [3840, 2120, 632, 474]];
  for (const [width, height, w, h] of sizes) {
    const x = -width + 36;
    const y = 52;
    const workArea = { x, y, width, height };
    const { window, splash } = splashSetup({ workArea });
    assert.equal(window.options.width, w);
    assert.equal(window.options.height, h);
    assert.equal(window.options.x, x + Math.round((width - w) / 2));
    assert.equal(window.options.y, y + Math.round((height - h) / 2));
    splash.close();
  }
  const small = splashBounds({ x: 50, y: -210, width: 360, height: 280 });
  assert.ok(small.x > 50 && small.y > -210 && small.x + small.width < 410 && small.y + small.height < 70);
});

test('splash responds to changes on its current display and unregisters on close', () => {
  const { splash, window, screen, display, events } = splashSetup();
  window.emit('ready-to-show');
  const changed = { ...display, workArea: { x: 1920, y: -30, width: 1920, height: 1040 } };
  screen.emit('display-metrics-changed', {}, { ...changed, id: 3 }, ['workArea']);
  screen.emit('display-metrics-changed', {}, changed, ['rotation']);
  assert.equal(events.some(([name]) => name === 'bounds'), false);
  screen.emit('display-metrics-changed', {}, changed, ['workArea', 'scaleFactor']);
  assert.deepEqual(events.at(-1), ['bounds', splashBounds(changed.workArea)]);
  splash.close();
  assert.equal(screen.listenerCount('display-metrics-changed'), 0);
});

test('splash completion waits for 1800ms on screen and sends the finish message only once', async () => {
  const { splash, window, events, clock, ipc } = splashSetup();
  assert.equal(typeof ipc.close, 'function');
  assert.equal(window.options.x, 360);
  assert.equal(window.options.y, 320);
  assert.deepEqual(events.slice(0, 2), [['top', true, 'screen-saver'], ['load']]);
  splash.finish();
  splash.finish();
  await clock.advance(5000);
  assert.equal(events.some(([event]) => event === 'splash:done'), false);

  window.emit('ready-to-show');
  splash.progress({ percent: 100 });
  await clock.advance(1799);
  assert.equal(events.some(([event]) => event === 'splash:done'), false);
  await clock.advance(1);
  splash.finish();
  assert.deepEqual(events.slice(2), [['show'], ['splash:progress', { percent: 100 }], ['splash:done']]);
  await clock.advance(2500);
  assert.equal(splash.hasWindow(), false);
  assert.deepEqual(events.slice(-2), [['splash:done'], ['close']]);
  assert.deepEqual(clock.delays(), []);
});

test('splash close, failed load, and hung initial rendering leave no late callbacks or orphan window', async () => {
  const normal = splashSetup();
  normal.splash.finish();
  normal.ipc.close();
  normal.window.emit('ready-to-show');
  await normal.clock.advance(180000);
  assert.equal(normal.splash.hasWindow(), false);
  assert.deepEqual(normal.events.slice(2), [['close']]);
  assert.deepEqual(normal.clock.delays(), []);

  const failed = splashSetup({ loadFile: async () => { throw new Error('unavailable'); } });
  await Promise.resolve();
  assert.equal(failed.splash.hasWindow(), false);
  assert.deepEqual(failed.events.slice(2), [['log', 'splash window failed: unavailable'], ['close']]);
  assert.deepEqual(failed.clock.delays(), []);

  const held = splashSetup();
  await held.clock.advance(180000);
  assert.equal(held.splash.hasWindow(), false);
  assert.deepEqual(held.events.slice(2), [['close']]);
});

test('startup keeps diagnostics, prewarm, and deployment at separate times and arms the guard before prewarm', async () => {
  const clock = createClock();
  const events = [];
  const background = createStartupBackground({
    log: (message) => events.push(message),
    send: (channel, value) => events.push([channel, value]),
    ...clock,
  });
  const fakeAgent = {};
  background.scheduleDiagnostics({
    initialize: () => events.push('diagnostics configured'),
    run: async () => events.push('diagnostics run'),
  });
  background.scheduleRuntime({
    args: {},
    settings: () => ({ engine: {} }),
    apps: () => ['app'],
    runtime: {
      provisioner: { checkEnv: async () => {
        events.push('probe');
        return { adb: { ok: true }, emulator: { ok: true }, sysimg: { ok: true } };
      } },
      prewarm: async () => { events.push('boot'); return { ok: true }; },
    },
    getAgent: () => fakeAgent,
    armAgent: async (agent) => {
      assert.equal(agent, fakeAgent);
      events.push('arm');
    },
    autoDeploy: async () => { events.push('deploy'); return { ok: true }; },
  });
  assert.deepEqual(events, ['diagnostics configured']);
  assert.deepEqual(clock.delays(), [[1200, true], [20000, true], [25000, true]]);

  await clock.advance(1200);
  assert.deepEqual(events.slice(1), ['probe', 'arm', 'prewarm start', 'boot', 'prewarm ready in 0ms']);
  await clock.advance(23800);
  assert.deepEqual(events.slice(-3), [
    'deploy',
    ['toast', { type: 'ok', message: '运行时已自动准备完成' }],
    'diagnostics run',
  ]);
});

test('direct app launch skips background prewarm but keeps delayed deployment', () => {
  const clock = createClock();
  const background = createStartupBackground({ log: () => {}, ...clock });
  background.scheduleRuntime({
    args: { launch: 'com.example.test' },
    settings: () => ({ engine: {} }),
    apps: () => ['app'],
  });
  assert.deepEqual(clock.delays(), [[20000, true]]);
});

test('updates resume a cached job first, skip MSIX and dev, and only check after the scheduled delay', async () => {
  const clock = createClock();
  const events = [];
  const info = { hasUpdate: false };
  const job = { version: '0.6.4' };
  let cached = null;
  const background = createStartupBackground({
    log: (message) => events.push(['log', message]),
    send: (channel, value) => events.push([channel, value]),
    ...clock,
  });
  const options = {
    packaged: true,
    storeBuild: false,
    updater: {
      findResumableJob: () => { events.push('find'); return cached; },
      apply: (value) => { assert.equal(value, job); events.push('apply'); },
      check: async () => { events.push('check'); return info; },
    },
    version: () => '0.6.3',
    setInfo: (value) => { assert.equal(value, info); events.push('set info'); },
    requestQuit: () => events.push('quit'),
  };

  background.scheduleUpdates({ ...options, packaged: false });
  background.scheduleUpdates({ ...options, storeBuild: true });
  assert.deepEqual(events, []);
  background.scheduleUpdates(options);
  assert.deepEqual(events, ['find']);
  assert.deepEqual(clock.delays(), [[8000, true]]);
  await clock.advance(8000);
  assert.deepEqual(events, ['find', 'check', 'set info', ['update:state', info]]);

  events.length = 0;
  cached = job;
  background.scheduleUpdates(options);
  assert.equal(events[0], 'find');
  assert.equal(events.at(-1), 'apply');
  assert.deepEqual(clock.delays(), [[900, false]]);
  await clock.advance(8000);
  assert.equal(events.at(-1), 'quit');
  assert.ok(!events.includes('check'));
});
