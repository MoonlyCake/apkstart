'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildApkBytes } = require('./lib/make-apk');

const state = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-package-outcomes-'));
process.env.APPDATA = state;
const store = require('../src/core/store');
const { AdbClient } = require('../src/core/adb');
const { Installer } = require('../src/core/installer');

const pkg = 'com.example.app';
const androidList = ['package:android', 'package:com.example.app.pro'].join('\n');

test('ADB online means an authorized exact serial, not a device prefix or get-state echo', async () => {
  const client = new AdbClient({ serial: 'emulator-555' });
  let state = 'List of devices attached\nemulator-5554 device\nemulator-555 unauthorized\n';
  client.exec = async (args) => {
    assert.deepEqual(args, ['devices']);
    return { stdout: state };
  };
  assert.equal(await client.isOnline(), false);
  state = 'List of devices attached\nemulator-5554 device\n';
  assert.equal(await client.isOnline(), false);
  state = 'List of devices attached\nemulator-555 device\n';
  assert.equal(await client.isOnline(), true);
});

test('package registration is confirmed only by the exact name and complete guest output', async () => {
  const client = new AdbClient({ serial: 'emulator-5554' });
  let state = androidList;
  client.shell = async (cmd) => {
    assert.equal(cmd, 'pm list packages --user 0');
    return state;
  };
  assert.equal(await client.isRegisteredPackage(pkg), false);
  state += '\npackage:' + pkg;
  assert.equal(await client.isRegisteredPackage(pkg), true);
  state += '\nError: could not list packages';
  await assert.rejects(client.isRegisteredPackage(pkg), /无法确认/);
  state = '';
  await assert.rejects(client.isRegisteredPackage(pkg), /无法确认/);
});

test('Android package operations reject ambiguous acknowledgments, including exit 0', async (t) => {
  const client = new AdbClient({ serial: 'emulator-5554' });
  const file = path.join(state, 'fixture.apk');
  fs.writeFileSync(file, buildApkBytes());
  t.after(() => fs.rmSync(file, { force: true }));
  client.exec = async () => ({ stdout: 'Performing Streamed Install' });
  await assert.rejects(client.install(file), /安装失败/);
  await assert.rejects(client.installMultiple([file]), /安装失败/);
  client.shell = async () => 'Failure [DELETE_FAILED_INTERNAL_ERROR]';
  await assert.rejects(client.uninstall(pkg), /DELETE_FAILED_INTERNAL_ERROR/);
  await assert.rejects(client.clearData(pkg), /DELETE_FAILED_INTERNAL_ERROR/);
  client.shell = async () => 'Error: Permission Denial';
  await assert.rejects(client.forceStop(pkg), /Permission Denial/);
  client.shell = async () => '';
  assert.equal(await client.forceStop(pkg), true);
  client.shell = async () => 'Success';
  assert.equal(await client.uninstall(pkg), true);
});

test('a late exit and old stdout cannot reject or confirm a replacement ADB input command', async () => {
  const child = () => {
    const stdin = Object.assign(new EventEmitter(), {
      writable: true,
      lines: [],
      write(line) { this.lines.push(line); },
      end() {},
    });
    const stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
    return Object.assign(new EventEmitter(), {
      stdin, stdout, stderr: new EventEmitter(), exitCode: null, killed: false, kill() {},
    });
  };
  const children = [child(), child()];
  let index = 0;
  const client = new AdbClient({ serial: 'emulator-5554', startProcess: () => children[index++] });
  const old = client.input('input keyevent 4');
  const oldFailure = assert.rejects(old, /输入通道已关闭/);
  children[0].exitCode = 1;
  const current = client.input('input keyevent 4');
  await oldFailure;
  children[0].stdout.emit('data', '__APKSTART_2__:1\n');
  children[0].emit('exit');
  assert.match(children[1].stdin.lines[0], /echo __APKSTART_2__:\$\?/);
  children[1].stdout.emit('data', '__APKSTART_2__:0\n');
  assert.equal(await current, true);
  const rejected = client.input('input keyevent 4');
  children[1].stdout.emit('data', '__APKSTART_3__:5\n');
  await assert.rejects(rejected, /退出码 5/);
  client.disposeInput();
});

test('launcher cache and explicit activity belong to the target ADB client/package', async () => {
  const one = new AdbClient({ adbPath: 'same-adb', serial: 'emulator-5554', port: 5044 });
  const two = new AdbClient({ adbPath: 'same-adb', serial: 'emulator-5556', port: 5044 });
  one.shell = async () => pkg + '/.One';
  two.shell = async () => pkg + '/.Two';
  assert.equal(await one.resolveLauncher(pkg), pkg + '/.One');
  assert.equal(await two.resolveLauncher(pkg), pkg + '/.Two');
  two.clearLauncherCache(pkg);
  const seen = [];
  two.shell = async (command) => { seen.push(command); return command.startsWith('am start') ? 'Starting: Intent' : ''; };
  await two.startApp(pkg, 'com.example.app.pro/.Paid', { freeform: false, observeProcess: false });
  assert.match(seen.at(-1), /-p com\.example\.app$/);
  assert.doesNotMatch(seen.at(-1), /\.pro/);
});

test('recents and private process matches are exact and use the task ID, not the list ordinal', async () => {
  const client = new AdbClient({ serial: 'emulator-5554' });
  client.shell = async () => [
    '* Recent #0: Task{00001 #41 type=standard A=10004:com.example.app.pro}',
    '  realActivity=com.example.app.pro/.Main',
    '* Recent #1: Task{00002 #57 type=standard A=10003:com.example.app}',
    '  realActivity=com.example.app/.Main',
  ].join('\n');
  assert.equal(await client.taskIdOfPackage(pkg), 57);
  client.shell = async () => 'PID COMMAND\n41 com.example.app.pro\n57 com.example.app:ui --service';
  assert.deepEqual(await client.appProcessIds(pkg), ['57']);
  client.shell = async () => 'android running but the ADB output was incomplete';
  await assert.rejects(client.appProcessIds(pkg), /无法识别/);
});

function fixture(t) {
  fs.mkdirSync(store.APK_DIR, { recursive: true });
  fs.mkdirSync(store.ICON_DIR, { recursive: true });
  const app = {
    package: pkg, label: 'fixture',
    apkPath: path.join(store.APK_DIR, pkg + '.apk'),
    iconPath: path.join(store.ICON_DIR, pkg + '.png'),
    shortcutPath: path.join(state, pkg + '.lnk'),
  };
  for (const file of [app.apkPath, app.iconPath, app.shortcutPath]) fs.writeFileSync(file, 'preserve me');
  const calls = [];
  let other = [];
  let catalog = app;
  t.mock.method(store, 'getApp', () => catalog);
  t.mock.method(store, 'getApps', () => [catalog, ...other].filter(Boolean));
  t.mock.method(store, 'removeApp', () => { calls.push('catalog'); catalog = null; });
  const owner = { current: true, ready: true, error: '', observations: [true, false] };
  const client = {
    async isRegisteredPackage(name) { calls.push('observe'); assert.equal(name, pkg); return owner.observations.shift(); },
    async uninstall(name) { calls.push('uninstall'); assert.equal(name, pkg); return true; },
  };
  const installer = new Installer({
    guestGeneration: 2,
    ensure: async () => ({ ok: owner.ready, error: owner.error, client, generation: 2, revalidate: async () => owner.current }),
  }, {});
  return { app, owner, client, calls, installer, shareShortcut() { other = [{ package: 'com.example.other', shortcutPath: app.shortcutPath }]; },
    assertPreserved() { assert.equal(store.getApp(pkg), app); for (const file of [app.apkPath, app.iconPath, app.shortcutPath]) assert.equal(fs.readFileSync(file, 'utf8'), 'preserve me'); } };
}

test('uninstall with an unavailable runtime leaves APK, icon, shortcut and catalog intact', async (t) => {
  const { owner, installer, assertPreserved, calls } = fixture(t);
  owner.ready = false;
  owner.error = 'device offline';
  const result = await installer.uninstall(pkg);
  assert.equal(result.ok, false);
  assert.match(result.error, /device offline/);
  assertPreserved();
  assert.deepEqual(calls, []);
});

test('uninstall rejection, failed postcheck and replaced guest preserve local artifacts', async (t) => {
  const { owner, installer, assertPreserved, client, calls } = fixture(t);
  const succeed = client.uninstall;
  client.uninstall = async () => { throw new Error('guest rejected'); };
  assert.match((await installer.uninstall(pkg)).error, /guest rejected/);
  assertPreserved();
  client.uninstall = succeed;
  owner.observations = [true, true];
  const present = await installer.uninstall(pkg);
  assert.equal(present.ok, false);
  assert.match(present.error, /仍登记/);
  assertPreserved();
  owner.observations = [true, false];
  client.uninstall = async () => { owner.current = false; return true; };
  assert.match((await installer.uninstall(pkg)).error, /运行时已切换/);
  assertPreserved();
  assert.ok(!calls.includes('catalog'));
});

test('verified package absence commits its catalog first and does not remove a shared shortcut', async (t) => {
  const { app, installer, shareShortcut, calls } = fixture(t);
  shareShortcut();
  assert.deepEqual(await installer.uninstall(pkg), { ok: true });
  assert.deepEqual(calls, ['observe', 'uninstall', 'observe', 'catalog']);
  assert.equal(fs.existsSync(app.apkPath), false);
  assert.equal(fs.existsSync(app.iconPath), false);
  assert.equal(fs.readFileSync(app.shortcutPath, 'utf8'), 'preserve me');
});

test('already absent is idempotent, and failed local catalog commit leaves both APK and shortcut intact', async (t) => {
  const { app, installer, owner, calls } = fixture(t);
  t.mock.method(store, 'removeApp', () => { throw new Error('catalog locked'); });
  owner.observations = [false];
  const result = await installer.uninstall(pkg);
  assert.deepEqual(calls, ['observe']);
  assert.equal(result.ok, false);
  assert.equal(result.guestRemoved, true);
  assert.equal(result.code, 'LOCAL_CATALOG_WRITE_FAILED');
  assert.equal(fs.readFileSync(app.apkPath, 'utf8'), 'preserve me');
  assert.equal(fs.readFileSync(app.shortcutPath, 'utf8'), 'preserve me');
});

test('an install result from a retired guest cannot publish a new host entry', async (t) => {
  t.mock.method(store, 'getApp', () => null);
  t.mock.method(store, 'upsertApp', assert.fail);
  let current = true;
  const runtime = { guestGeneration: 1 };
  const guest = {
    generation: 1,
    revalidate: async () => current,
    client: { install: async () => { current = false; return 'Success'; } },
  };
  const installer = new Installer(runtime, {});
  await assert.rejects(installer.finishInstall(guest, { package: pkg }, 'fixture.apk', null, () => {}), /运行时已切换/);
});

test('network unverified after bounded runtime attempt does not block a local app or create another repair', async (t) => {
  t.mock.method(store, 'getApp', () => null);
  t.mock.method(store, 'getSettings', () => ({}));
  const logs = [];
  let displayPending = false;
  let releaseDisplay;
  const client = {
    resetDisplayOverrides() {
      displayPending = true;
      return new Promise((resolve) => { releaseDisplay = resolve; });
    },
    startApp: async () => true,
  };
  let waits = 0;
  const runtime = {
    ensure: async () => ({ ok: true, engine: 'builtin', client }),
    async waitForNetwork({ timeoutMs }) {
      waits++;
      assert.equal(timeoutMs, 7000);
      assert.equal(displayPending, true);
      releaseDisplay();
      return { ok: false, ip: '10.0.2.15', reason: 'no-default-network' };
    },
    repairWifi: assert.fail,
    touch() {},
  };
  const installer = new Installer(runtime, {}, { launchPolicy: async ({ start }) => start() });
  assert.equal((await installer.launch(pkg, { onLog: (line) => logs.push(line) })).ok, true);
  assert.equal(waits, 1);
  assert.ok(logs.some((line) => /未确认安卓可以上网/.test(line)));
  assert.ok(!logs.some((line) => /网络已验证/.test(line)));
});

test.after(() => fs.rmSync(state, { recursive: true, force: true }));
