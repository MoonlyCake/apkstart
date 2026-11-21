'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const ui = (file) => fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', file), 'utf8');
const appSource = ui('app.js');
const storageSource = ui('panels/settings-storage.js');
const components = { adb: { ok: true }, emulator: { ok: true }, sysimg: { ok: true } };
const running = (network, patch = {}) => ({
  adbOk: true, deviceOnline: true, ready: true, phase: 'ready',
  serial: 'emulator-5554', android: '11', env: components, network, ...patch,
});

function fixture(api = {}) {
  const nodes = new Map();
  const notices = [];
  const $ = (id) => {
    if (!nodes.has(id)) {
      const handlers = new Map();
      nodes.set(id, {
        value: '', disabled: false,
        addEventListener: (event, fn) => handlers.set(event, fn),
        fire: (event) => handlers.get(event)(),
      });
    }
    return nodes.get(id);
  };
  const panels = Object.fromEntries(['SettingsNavigation', 'DiagnosticsPanel', 'PreflightPanel', 'UpdatesPanel', 'SettingsPanel']
    .map((name) => [`create${name}`, () => ({ open() {}, close() {} })]));
  const context = vm.createContext({
    window: { apkstart: { on() {}, ...api }, apkstartUiPanels: panels, addEventListener() {}, confirm: () => true },
    document: { getElementById: $, addEventListener() {} },
  });
  const init = appSource.lastIndexOf('init().catch');
  assert.notEqual(init, -1, 'fixture must load the real renderer without initializing the desktop');
  vm.runInContext(appSource.slice(0, init), context);
  context.toast = (notice) => notices.push(notice);
  return { $, context, notices };
}

test('network badge distinguishes IP without an internet path, a pending probe, and verified connectivity', async () => {
  let status = running({ ok: false, reason: 'no-default-network', ip: '10.0.2.15' });
  const { $, context } = fixture({ runtimeStatus: async () => status });

  await context.refreshStatus();
  assert.equal($('statusNet').hidden, false);
  assert.match($('statusNet').textContent, /联网.*未确认/);
  assert.match($('statusNet').title, /默认联网通道/);
  assert.doesNotMatch($('statusNet').textContent, /10\.0\.2\.15|已联网|网络正常/);
  assert.match($('statusNet').className, /\bwarn\b/);

  status = running({ ok: false, reason: 'checking', checking: true });
  await context.refreshStatus();
  assert.match($('statusNet').textContent, /正在检查/);
  assert.doesNotMatch($('statusNet').className, /\bok\b/);

  status = running({ ok: true, reachable: true, ip: '10.0.2.16' });
  await context.refreshStatus();
  assert.match($('statusNet').textContent, /已联网.*10\.0\.2\.16/);
  assert.match($('statusNet').className, /\bok\b/);
});

test('deployed files without a booted Android are not reported as a ready runtime', async () => {
  const { $, context } = fixture({
    runtimeStatus: async () => ({
      adbOk: true, ready: false, phase: 'idle', needsSetup: 'boot', env: components,
      network: { ok: true }, serial: 'emulator-5554',
    }),
  });
  await context.refreshStatus();
  assert.match($('statusText').textContent, /组件齐全.*尚未开机/);
  assert.doesNotMatch($('statusDot').className, /\bok\b/);
  assert.equal($('statusDevice').textContent, '');
  assert.equal($('statusNet').hidden, true);
});

test('a failed status read clears old success, and an older ready response cannot restore it', async () => {
  let release;
  const slow = new Promise((resolve) => { release = resolve; });
  let count = 0;
  const green = running({ ok: true, reachable: true, ip: '10.0.2.16' });
  const { $, context } = fixture({
    runtimeStatus: () => {
      count++;
      if (count === 2) return slow;
      if (count === 3) return Promise.reject(new Error('安卓运行时已关闭'));
      return Promise.resolve(green);
    },
  });
  await context.refreshStatus();
  assert.equal($('statusNet').hidden, false);
  const olderRequest = context.refreshStatus();
  await context.refreshStatus();
  assert.match($('statusText').textContent, /状态检查失败.*已关闭/);
  assert.equal($('statusNet').hidden, true);
  assert.equal($('statusDevice').textContent, '');
  assert.doesNotMatch($('statusDot').className, /\bok\b/);
  release(green);
  await olderRequest;
  assert.match($('statusText').textContent, /状态检查失败/);
  assert.equal($('statusNet').hidden, true);
});

test('uninstall requires guest confirmation; local cleanup failure remains visible even after guest removal', async () => {
  const pkg = 'com.example.karaoke';
  let response = { ok: false, error: '安卓未确认卸载' };
  const { context, notices } = fixture({ uninstall: async () => response });
  vm.runInContext(`state.apps = [{ package: '${pkg}', label: 'Fixture' }];`, context);
  let refreshes = 0;
  context.refreshApps = async () => { refreshes++; };

  await context.uninstall(pkg);
  assert.equal(notices[0].type, 'error');
  assert.match(notices[0].body, /安卓未确认/);
  assert.equal(refreshes, 0);

  response = { ok: false, guestRemoved: true, error: '本地记录仍保留' };
  await context.uninstall(pkg);
  assert.equal(notices[1].type, 'error');
  assert.match(notices[1].title, /本地清理未完成/);
  assert.equal(refreshes, 1);

  response = { ok: true };
  await context.uninstall(pkg);
  assert.equal(notices[2].type, 'ok');
  assert.match(notices[2].title, /已卸载/);
  assert.equal(refreshes, 2);
});

test('shared sync distinguishes offline, an in-flight sync, conflicts, and a successful result', async () => {
  let response;
  const { $, context, notices } = fixture({ syncShared: async () => response });
  context.bindEvents();
  const button = $('btnSyncShared');

  response = { ok: false, error: '运行时未连接' };
  await button.fire('click');
  assert.equal(notices.at(-1).type, 'error');
  assert.match(notices.at(-1).body, /运行时未连接/);
  assert.equal(button.disabled, false);

  response = { ok: false, skipped: true, error: '同步进行中' };
  await button.fire('click');
  assert.equal(notices.at(-1).type, 'info');
  assert.match(notices.at(-1).title, /进行中/);

  response = { ok: false, pushed: 2, pulled: 1, conflicts: ['song.m4a'], error: '冲突文件未覆盖' };
  await button.fire('click');
  assert.equal(notices.at(-1).type, 'error');
  assert.match(notices.at(-1).title, /未完全同步/);
  assert.match(notices.at(-1).body, /上传 2 项，下载 1 项。.*冲突文件未覆盖/);

  response = { ok: true, pushed: 0, pulled: 2 };
  await button.fire('click');
  assert.equal(notices.at(-1).type, 'ok');
  assert.match(notices.at(-1).body, /下载 2 项/);
  assert.equal(button.disabled, false);
});

test('network repair toast requires a confirmed network even when the action itself returned ok', async () => {
  let response;
  const { $, context, notices } = fixture();
  vm.runInContext(storageSource, context);
  const storage = context.window.apkstartUiPanels.createStorageSettings({
    api: { confirm: async () => ({ response: 1 }), runtimeRepairNetwork: async () => response },
    $, save: async () => {}, toast: (notice) => notices.push(notice),
    refreshStatus: async () => {}, networkExplanation: context.networkExplanation,
  });
  storage.bind();
  const button = $('btnRepairNetwork');

  response = { ok: true, network: { ok: false, reason: 'no-default-network', ip: '10.0.2.15' } };
  await button.fire('click');
  assert.notEqual(notices.at(-1).type, 'ok');
  assert.doesNotMatch(notices.at(-1).title, /网络已恢复/);
  assert.equal(button.disabled, false);

  response = { ok: true, network: { ok: true, reachable: true, ip: '10.0.2.16' } };
  await button.fire('click');
  assert.equal(notices.at(-1).type, 'ok');
  assert.match(notices.at(-1).title, /网络已恢复|已确认.*联网/);
  assert.equal(button.disabled, false);
});
