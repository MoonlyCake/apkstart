'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');
const { OperationQueue } = require('../src/application/operation-queue');
const { isWindowsShellApk, createShellApkOpener } = require('../src/desktop/shell-apk-open');

const file = 'F:\\fixture\\测试 App.apk';
const app = { package: 'com.example.app', label: 'Test', shortcutPath: 'Test.lnk' };

test('only a Windows APK argument uses the shell APK workflow', () => {
  assert.equal(isWindowsShellApk(file, 'win32'), true);
  assert.equal(isWindowsShellApk(file.toUpperCase(), 'win32'), true);
  for (const other of [null, 'test.xapk', 'test.apks', 'test.apk.exe', 'test.apk\n']) {
    assert.equal(isWindowsShellApk(other, 'win32'), false);
  }
  assert.equal(isWindowsShellApk(file, 'linux'), false);
});

test('a confirmed install or exact reuse launches only after the shared queue releases install', async () => {
  for (const reused of [false, true]) {
    const queue = new OperationQueue();
    const observed = [];
    const open = createShellApkOpener({
      runInstall: (p, opts) => queue.run('install', () => {
        observed.push(['install', p, opts]);
        return { ok: true, app, reused };
      }),
      runLaunch: (pkg) => {
        assert.equal(queue.has('install'), false);
        return queue.run('launch', () => { observed.push(['launch', pkg]); return { ok: true }; });
      },
    });
    assert.deepEqual(await open(file), { ok: true });
    assert.deepEqual(observed, [['install', file, { shellOpen: true }], ['launch', app.package]]);
  }
});

test('busy, failure, and unconfirmed or malformed receipts never launch', async () => {
  const busy = { ok: false, error: 'busy' };
  for (const receipt of [busy, { ok: false, app }, { app }, null, { ok: true, app: {} },
    { ok: true, app: { package: 'com.example.app\n' } }, { ok: true, app: { package: '../invalid' } }]) {
    const open = createShellApkOpener({
      runInstall: async () => receipt,
      runLaunch: () => assert.fail('launch called without a valid successful receipt'),
    });
    const result = await open(file);
    assert.equal(result.ok, false);
    if (receipt === busy) assert.equal(result, busy);
  }
});

test('repeated double-clicks share the complete transaction; a rejected attempt can be retried', async () => {
  let complete;
  let reject;
  let installs = 0;
  let launches = 0;
  const open = createShellApkOpener({
    runInstall: async () => {
      if (++installs === 1) return new Promise((_, r) => { reject = r; });
      return { ok: true, app };
    },
    runLaunch: () => { ++launches; return new Promise((r) => { complete = r; }); },
  });
  const first = open(file);
  assert.equal(open(file), first);
  reject(new Error('expected install failure'));
  await assert.rejects(first, /expected install failure/);
  const retry = open(file);
  await Promise.resolve();
  assert.equal(open(file), retry);
  assert.equal(installs, 2);
  assert.equal(launches, 1);
  complete({ ok: false, error: 'could not open' });
  assert.deepEqual(await retry, { ok: false, error: 'could not open' });
});

test('real install entry avoids a false installation notice for an exact reuse', async () => {
  const main = readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  const installOne = main.slice(main.indexOf('async function installOne('), main.indexOf('async function runUpdate('));
  const notifications = [];
  const refreshes = [];
  const calls = [];
  const context = vm.createContext({
    showWindow: () => {},
    startupSplash: { close() {} },
    send: () => {},
    installer: { install: async (_, progress, opts) => {
      calls.push([typeof progress, opts.shellOpen]);
      return { app, reused: opts.shellOpen };
    } },
    notify: (...args) => notifications.push(args),
    appLog: () => {},
    windowctl: { refreshShell: async () => refreshes.push('refresh') },
    isLaunchPackage: () => true,
    installBusy: file,
  });
  vm.runInContext(installOne, context);
  assert.equal((await context.installOne(file, { shellOpen: true })).ok, true);
  assert.deepEqual(notifications, []);
  assert.deepEqual(refreshes, []);
  await context.installOne(file);
  assert.deepEqual(calls, [['function', true], ['function', false]]);
  assert.equal(notifications[0][0], '安装完成');
  assert.equal(refreshes.length, 1);
});
