'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const { registerIpc } = require('../src/ipc');
const { registerHandlers } = require('../src/ipc/dispatch');
const { registerSplashIpc } = require('../src/ipc/splash');
const { captureHandlers } = require('./helpers/ipc-registry');

const src = (name) => fs.readFileSync(path.join(__dirname, '..', 'src', name), 'utf8');
const exposes = (source) => [...source.matchAll(/\binvoke\(\s*'([^']+)'/g)].map((match) => match[1]);
function handlerFor(overrides, channel) {
  const handlers = captureHandlers(overrides);
  const handler = handlers.get(channel);
  assert.equal(typeof handler, 'function', channel);
  return handler;
}

test('every preload invoke has exactly one production handler, including the splash lifecycle', () => {
  const main = new Map();
  const events = new Map();
  const fake = {
    handle(name, fn) {
      assert.ok(!main.has(name), 'duplicate: ' + name);
      main.set(name, fn);
    },
    on(name, fn) { events.set(name, fn); },
  };
  registerIpc(fake, { live: {} });

  const calls = [];
  let bundled = false;
  registerSplashIpc(fake, {
    getVersion: () => 'fixture',
    isFirstRun: true,
    isBundled: () => bundled,
    close: () => calls.push('closed'),
  });
  const expected = [...new Set([...exposes(src('preload.js')), ...exposes(src('splash-preload.js'))])].sort();
  assert.equal(expected.length, 124);
  assert.deepEqual([...main.keys()].sort(), expected);
  assert.equal(main.get('splash:version')(), 'fixture');
  assert.equal(main.get('splash:isFirstRun')(), true);
  assert.equal(main.get('splash:bundled')(), false);
  bundled = true;
  assert.equal(main.get('splash:bundled')(), true);
  assert.deepEqual([...events.keys()], ['splash:close']);
  events.get('splash:close')();
  assert.deepEqual(calls, ['closed']);
});

test('duplicate domain routes are rejected before touching the Electron registry', () => {
  const bound = [];
  const handler = () => true;
  assert.throws(() => registerHandlers({ handle: (name) => bound.push(name) },
    [{ one: handler, dup: handler }, { two: handler, dup: handler }],
  ), /Duplicate IPC handler: dup/);
  assert.deepEqual(bound, []);
});

test('settings and runtime handlers read the active session and current runtime at call time', async () => {
  let active = null;
  let runtime = { status: () => ({ id: 1 }) };
  const deps = {
    getCurrentAppPkg: () => active,
    displaySettings: () => ({ mode: 'window' }),
    screenRect: () => ({ width: 720, height: 1280 }),
    live: { get runtime() { return runtime; } },
  };
  const handlers = captureHandlers(deps);
  const state = handlers.get('display:state');
  const status = handlers.get('runtime:status');
  assert.deepEqual(state(), { mode: 'window', current: null, screen: { width: 720, height: 1280 } });
  assert.deepEqual(await status(), { id: 1 });
  active = 'com.example.karaoke';
  runtime = { status: () => ({ id: 2 }) };
  assert.equal(state().current, 'com.example.karaoke');
  assert.deepEqual(await status(), { id: 2 });
});

test('the initialized keymap engine receives the actual key and the current package', async () => {
  const events = [];
  let active = null;
  const keymapEngine = {
    enabled: true,
    handleKey: (key, pkg) => { events.push({ key, pkg }); return true; },
    getMap: (pkg) => [{ pkg, key: 'K' }],
  };
  const handlers = captureHandlers({ keymapEngine, getCurrentAppPkg: () => active });
  const keyEvent = handlers.get('shell:keyEvent');
  const event = { sender: { id: 1 } };
  assert.equal(await keyEvent(event, 'K'), false);
  active = 'com.example.karaoke';
  assert.equal(await keyEvent(event, 'K'), true);
  assert.deepEqual(events, [{ key: 'K', pkg: active }]);
  assert.deepEqual(handlers.get('keymap:getMap')(event, active), [{ pkg: active, key: 'K' }]);
  assert.equal(handlers.get('keymap:isEnabled')(), true);
});

test('application invocation preserves options and failed installation responses', async () => {
  const options = { reason: 'click', keepContainer: true };
  const calls = [];
  const failure = { ok: false, error: 'bad archive' };
  const handlers = captureHandlers({
    stopApp: (...args) => { calls.push(args); return options; },
    runInstall: (file) => { calls.push([file]); return failure; },
    openManual: (payload) => payload,
  });
  assert.equal(await handlers.get('app:stop')({ sender: {} }, 'com.example.app', options), options);
  assert.equal(await handlers.get('apk:install')({ sender: {} }, 'fixture.xapk'), failure);
  assert.deepEqual(calls, [['com.example.app', options], ['fixture.xapk']]);
});

test('uninstall does not turn a failing Android result into successful cleanup', async () => {
  const fail = { ok: false, guestRemoved: false, error: 'Android is offline' };
  const effects = [];
  const handler = handlerFor({
    appOperations: { run(key, action) { effects.push(key); return action(); } },
    live: { installer: { uninstall: async (pkg) => (effects.push(pkg), fail) } },
  }, 'app:uninstall');
  assert.equal(await handler({}, 'com.example.karaoke'), fail);
  assert.deepEqual(effects, ['uninstall:com.example.karaoke', 'com.example.karaoke']);
});

test('keymap arguments survive preload and clearing uses an explicit persisted empty map', async () => {
  const pkg = 'com.example.karaoke';
  const mapping = { key: 'F', action: 'tap', x: 0.5, y: 0.25 };
  let bridge;
  const handlers = captureHandlers({
    keymapEngine: { setMap: (p, m) => entries.push([p, m]) },
    KEYMAP_PRESETS: { fixture: { mappings: [mapping] } },
    store: { saveSettings: (patch) => saved.push(patch.engine.keymaps[pkg]) },
  });
  const entries = [];
  const saved = [];
  const require = () => ({
    contextBridge: { exposeInMainWorld: (_name, api) => { bridge = api; } },
    ipcRenderer: { invoke: (channel, ...args) => handlers.get(channel)({}, ...args) },
  });
  vm.runInNewContext(src('preload.js'), { require });
  assert.deepEqual(await bridge.keymap.applyPreset(pkg, 'fixture'), { ok: true, mappings: [mapping] });
  assert.equal((await bridge.keymap.setMap(pkg, [{ key: 'W', action: 'keyevent', code: '4' }])).ok, false);
  assert.deepEqual(await bridge.keymap.setMap(pkg, []), { ok: true });
  assert.deepEqual(saved, [[mapping], []]);
  assert.deepEqual(entries, [[pkg, [mapping]], [pkg, []]]);
});

test('malformed persisted keymaps never create input commands', () => {
  const { lookup, toCommand } = require('../src/core/keymap');
  assert.equal(lookup([null, { key: true }, { key: 'T' }], 'T').key, 'T');
  assert.equal(toCommand({ action: 'keyevent', code: '4' }), '');
  assert.equal(toCommand({ action: 'tap', x: NaN, y: 0 }, 720, 1280), '');
  assert.equal(toCommand({ action: 'swipe', x1: 0, y1: 0.5, x2: 1, y2: 0.5, duration: 100.5 }, 720, 1280), '');
  assert.equal(toCommand({ action: 'keyevent', code: 4 }), 'input keyevent 4');
});

test('directory opening is limited to the effective runtime and AVD paths and reports OS errors', async () => {
  const opened = [];
  const handler = handlerFor({
    live: { runtime: { provisioner: { paths() { return { root: 'sdk', avdHome: 'actual-data' }; } } } },
    fs: { existsSync: () => true },
    shell: { openPath: async (dir) => { opened.push(dir); return 'Permission denied'; } },
  }, 'runtime:openDirectory');
  assert.equal((await handler({}, 'untrusted-path')).ok, false);
  assert.deepEqual(await handler({}, 'avd'), { ok: false, error: 'Permission denied' });
  assert.deepEqual(opened, ['actual-data']);
});

test('disk space gating uses the AVD volume and never turns a requested expansion into auto mode', async (t) => {
  const observed = [];
  let freeMB = 100;
  t.mock.method(require('../src/core/doctor'), 'freeDiskMB', (dir) => {
    observed.push(dir);
    return freeMB;
  });
  const handler = handlerFor({
    live: { runtime: {
      provisioner: { paths() { return { root: 'sdk', avdHome: 'actual-data' }; } },
      resizeDataPartition: () => assert.fail('no usable space for expansion'),
    } },
  }, 'runtime:setDataSize');
  assert.equal((await handler({}, 8)).ok, false);
  freeMB = 8192;
  assert.equal((await handler({}, 32)).ok, false);
  assert.deepEqual(observed, ['actual-data', 'actual-data']);
});

test('Windows window mode and size use host-only layout, not Android rotation', async () => {
  const calls = [];
  const handler = handlerFor({
    store: { saveSettings: (patch) => ({ display: { portrait: '720x1280', ...patch.display } }) },
    portraitSize: () => ({ width: 720, height: 1280 }),
    live: { appWin: {
      isOpen: true,
      applyWindowSize: async (...a) => { calls.push(a); return true; },
      setLandscape: () => assert.fail('must not rotate or restart Android'),
    } },
  }, 'display:set');
  assert.equal((await handler({}, { mode: 'fullscreen' })).windowLayoutApplied, true);
  assert.deepEqual(calls, [[{ width: 720, height: 1280 }, { fullscreen: true }]]);
});

test('runtime restart is a single lifecycle operation and still sends progress', async () => {
  const log = [];
  const runtime = {
    stop: () => assert.fail('IPC must not stop and boot in two operations'),
    ensure: () => assert.fail('IPC must not escape the lifecycle queue'),
    restart: ({ onLog }) => { onLog('starting'); return { ok: true, extra: 'not in IPC result' }; },
  };
  const restart = handlerFor({ live: { runtime }, send: (...args) => log.push(args) }, 'runtime:restart');
  assert.deepEqual(await restart(), { ok: true, ready: true });
  assert.deepEqual(log, [['runtime:log', 'starting']]);
  runtime.restart = () => ({ ok: false, error: 'still running' });
  assert.deepEqual(await restart(), { ok: false, error: 'still running' });
});

test('runtime partition size is applied through lifecycle, without direct guest probing', async (t) => {
  t.mock.method(require('../src/core/doctor'), 'freeDiskMB', () => 65536);
  const order = [];
  const result = { ok: true, stopped: true, confirmed: true };
  const runtime = {
    provisioner: { paths: () => ({ root: 'fixture' }) },
    resizeDataPartition: async (value) => { order.push(['resize', value]); return result; },
    client: () => assert.fail('IPC must not probe the guest directly'),
  };
  const resize = handlerFor({
    live: { runtime },
    appLog: () => order.push(['log']),
    notify: () => order.push(['notify']),
  }, 'runtime:setDataSize');
  assert.equal(await resize({}, 4), result);
  assert.deepEqual(order, [['resize', 4096], ['log'], ['notify']]);
});

test('cache cleanup still requires confirmation after preview, using the current native window', async () => {
  const calls = [];
  const preview = { ok: true, candidates: [{ size: 1048576 }] };
  const runtime = { cleanup: (opts) => { calls.push(opts); return opts.apply ? { ok: true, removed: 1 } : preview; } };
  const active = { id: 7 };
  let approve = false;
  const cleanup = handlerFor({
    live: { runtime, mainWindow: active },
    dialog: { showMessageBox: (win, options) => {
      assert.equal(win, active);
      assert.equal(options.defaultId, 0);
      assert.equal(options.buttons[1], '清理 1 项');
      return { response: approve ? 1 : 0 };
    } },
  }, 'runtime:cleanup');
  assert.deepEqual(await cleanup({}, { apply: true }), { ...preview, cancelled: true });
  assert.deepEqual(calls.map(({ apply }) => apply), [false]);
  approve = true;
  assert.deepEqual(await cleanup({}, { apply: true, includeSnapshots: true }), { ok: true, removed: 1 });
  assert.deepEqual(calls.map(({ apply, includeSnapshots }) => [apply, includeSnapshots]), [
    [false, false], [false, true], [true, true],
  ]);
});

test('Windows acceleration uses one verified AEHD entry, never in the Store edition', async () => {
  const progress = [];
  const steps = [];
  let enabled = false;
  const store = { STORE_BUILD: true };
  const provisioner = {
    emulatorAccel: async () => ({ ok: enabled, note: 'fixture' }),
    enableAehd: async (onProgress) => {
      steps.push('verified helper');
      onProgress({ phase: 'verify' });
      enabled = true;
    },
    invalidateEnvCache: () => steps.push('invalidate after WHPX'),
  };
  const handlers = captureHandlers({
    store,
    live: { runtime: { provisioner } },
    MSIX_ACCEL_HINT: 'manual hint',
    enableWhpxFeatures: async () => { steps.push('WHPX'); return { ok: false, steps: [] }; },
    send: (...args) => progress.push(args),
  });
  const direct = handlers.get('provision:enableAccel');
  const automatic = handlers.get('provision:enableVirtualization');
  assert.equal((await direct()).ok, false);
  const storeFallback = await automatic();
  assert.equal(storeFallback.manual, true);
  assert.deepEqual(steps, ['WHPX', 'invalidate after WHPX']);
  store.STORE_BUILD = false;
  steps.length = 0;
  assert.equal((await automatic()).ok, true);
  assert.deepEqual(steps, ['WHPX', 'invalidate after WHPX', 'verified helper']);
  assert.deepEqual(progress, [['provision:progress', { phase: 'verify', component: 'aehd' }]]);
  enabled = false;
  provisioner.enableAehd = async () => { throw new Error('archive rejected'); };
  assert.deepEqual(await direct(), { ok: false, error: 'archive rejected' });
});

test('preload delivers the existing app-list change event without exposing arbitrary IPC', () => {
  const listeners = new Map();
  let preload;
  vm.runInNewContext(src('preload.js'), { require: () => ({
    contextBridge: { exposeInMainWorld: (_, api) => { preload = api; } },
    ipcRenderer: {
      on: (name, handler) => listeners.set(name, handler),
      removeListener: (name, handler) => { if (listeners.get(name) === handler) listeners.delete(name); },
    },
  }) });
  const seen = [];
  const undo = preload.on('apps:changed', (value) => seen.push(value));
  preload.on('unknown-channel', () => assert.fail('should not subscribe'));
  assert.deepEqual([...listeners.keys()], ['apps:changed']);
  listeners.get('apps:changed')({}, true);
  assert.deepEqual(seen, [true]);
  undo();
  assert.equal(listeners.size, 0);
});
