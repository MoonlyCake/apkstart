'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { APP_AUMID, MAINTAINER, WINDOWS_DISPLAY_NAME, appAumid, registerManagerShortcut, showAsManager }
  = require('../src/core/branding');

test('manager and guest window identities use the maintainer namespace', () => {
  assert.equal(MAINTAINER, 'MoonlyCake');
  assert.equal(APP_AUMID, 'MoonlyCake.ApkStart');
  assert.equal(WINDOWS_DISPLAY_NAME, 'Apk Start --Q · MoonlyCake');
  assert.equal(appAumid('com.example.app'), `${APP_AUMID}.com.example.app`);
  assert.equal(appAumid(`com.${'g'.repeat(200)}`).length, 128);
});

test('register a matching manager shortcut once, update owned links, and preserve a collision', (t) => {
  const programs = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-brand-'));
  t.after(() => fs.rmSync(programs, { recursive: true, force: true }));
  const writes = [];
  const state = new Map();
  const shell = {
    readShortcutLink: (link) => state.get(link),
    writeShortcutLink(link, op, details) {
      assert.equal(op, fs.existsSync(link) ? 'update' : 'create');
      fs.writeFileSync(link, 'fixture link');
      writes.push(op);
      state.set(link, { ...details });
      return true;
    },
  };
  const target = path.join(programs, 'ApkStart.exe');
  const icon = path.join(programs, 'icon.ico');
  const toastActivatorClsid = '{1DE34EBF-25C9-499A-9EC9-4229295AB9DC}';
  const opts = { shell, programs, target, icon, toastActivatorClsid };
  const link = registerManagerShortcut(opts);
  assert.equal(path.basename(link), `${WINDOWS_DISPLAY_NAME}.lnk`);
  assert.deepEqual(state.get(link), { target, cwd: programs, icon, iconIndex: 0,
    description: WINDOWS_DISPLAY_NAME, appUserModelId: APP_AUMID, toastActivatorClsid });
  assert.equal(registerManagerShortcut(opts), link);
  assert.deepEqual(writes, ['create']);
  const replacement = path.join(programs, '1.0.6', 'ApkStart.exe');
  assert.equal(registerManagerShortcut({ ...opts, target: replacement }), link);
  assert.equal(state.get(link).target, replacement);
  assert.deepEqual(writes, ['create', 'update']);

  state.set(link, { appUserModelId: 'OtherPublisher.App', target });
  assert.throws(() => registerManagerShortcut(opts), /already in use/);
  assert.deepEqual(writes, ['create', 'update']);
  assert.equal(state.get(link).appUserModelId, 'OtherPublisher.App');
});

test('native toast initializes the manager sender and restores the current window identity', () => {
  const guest = appAumid('com.example.app');
  let current = guest;
  const events = [];
  const setAumid = (id) => { current = id; events.push(id); };
  const publish = () => { events.push(`publish:${current}`); return 'posted'; };
  assert.equal(showAsManager(publish, current, setAumid), 'posted');
  assert.equal(current, guest);
  assert.deepEqual(events, [APP_AUMID, `publish:${APP_AUMID}`, guest]);
  assert.throws(() => showAsManager(() => { throw new Error('Windows rejected toast'); }, current, setAumid), /rejected/);
  assert.equal(current, guest);
});

test('guest notification bridge delegates native presentation without losing the click action', () => {
  const pathToBridge = require.resolve('../src/core/notify');
  const originalLoad = Module._load;
  const events = [];
  let cachedSender;
  let activeAumid = appAumid('com.example.app');
  class NotificationFixture {
    static isSupported() { cachedSender ??= activeAumid; events.push('isSupported'); return true; }
    constructor(options) {
      cachedSender ??= activeAumid;
      assert.equal(options.title, 'Test App');
      assert.equal(options.body, 'Hello · message');
      this.handlers = new Map();
    }
    on(name, handler) { this.handlers.set(name, handler); }
    show() { events.push('show'); this.handlers.get('click')(); }
  }
  let NotifyBridge;
  try {
    Module._load = function (id, ...args) {
      if (id === 'electron') return { Notification: NotificationFixture, nativeImage: {} };
      return originalLoad.call(this, id, ...args);
    };
    ({ NotifyBridge } = require(pathToBridge));
  } finally {
    Module._load = originalLoad;
    delete require.cache[pathToBridge];
  }
  const bridge = new NotifyBridge({
    getClient: () => null,
    getAppLabel: () => 'Test App',
    showNotification(publish) {
      events.push('manager-sender');
      showAsManager(publish, activeAumid, (id) => { activeAumid = id; });
    },
    onOpen: (pkg) => events.push(pkg),
  });
  bridge._show({ pkg: 'com.example.app', title: 'Hello', text: 'message' });
  assert.deepEqual(events, ['manager-sender', 'isSupported', 'show', 'com.example.app']);
  assert.equal(cachedSender, APP_AUMID);
  assert.equal(activeAumid, appAumid('com.example.app'));
});
