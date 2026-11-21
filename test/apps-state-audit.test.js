'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { fileURLToPath } = require('node:url');
const { OperationQueue } = require('../src/application/operation-queue');
const { createAppsHandlers } = require('../src/ipc/handlers/apps');

function fixture(records = [], effects = {}) {
  const items = new Map(records.map((record) => [record.package, record]));
  const store = {
    getApps: () => [...items.values()], getApp: (pkg) => items.get(pkg), getSettings: () => ({}),
    upsertApp: (record) => items.set(record.package, { ...items.get(record.package), ...record }),
  };
  const installer = {
    uninstall: async (pkg) => { await effects.uninstall?.(); items.delete(pkg); return { ok: true }; },
    createShortcut: effects.createShortcut || (() => 'sample.lnk'),
  };
  const runtime = { _networkEndpoint: async () => null, ensure: effects.ensure };
  return { items, call: createAppsHandlers({ live: { installer, runtime }, store, fs,
    appOperations: new OperationQueue(), send: () => {}, appLog: () => {}, wantLandscapeFor: () => false }) };
}

test('a stale card cannot recreate an uninstalled application record', async () => {
  const { items, call } = fixture([{ package: 'com.example.removed', label: 'Gone' }]);
  const pkg = 'com.example.removed';
  await call['app:uninstall'](null, pkg);
  assert.equal((await call['app:pin'](null, { pkg, pinned: true })).ok, false);
  assert.equal((await call['app:setOrientation'](null, { pkg, orientation: 'landscape' })).ok, false);
  assert.equal(items.has(pkg), false);
});

test('invalid orientation keeps an existing override; explicit null still clears it', async () => {
  const pkg = 'com.example.good';
  const { items, call } = fixture([{ package: pkg, label: 'Good', orientationOverride: 'portrait' }]);
  assert.equal((await call['app:setOrientation'](null, { pkg, orientation: 'landscpae' })).ok, false);
  assert.equal(items.get(pkg).orientationOverride, 'portrait');
  assert.equal((await call['app:setOrientation'](null, { pkg, orientation: null })).ok, true);
  assert.equal(items.get(pkg).orientationOverride, null);
});

test('a shortcut request queued behind removal does not create an orphan', async () => {
  const pkg = 'com.example.queued';
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let writes = 0;
  const { items, call } = fixture([{ package: pkg, label: 'Queued' }], {
    uninstall: () => gate, createShortcut: () => { writes++; return 'sample.lnk'; },
  });
  const removing = call['app:uninstall'](null, pkg);
  const shortcut = call['app:shortcut'](null, pkg);
  release();
  assert.equal((await removing).ok, true);
  assert.equal((await shortcut).ok, false);
  assert.equal(writes, 0);
  assert.equal(items.has(pkg), false);
});

test('listing tolerates an older incomplete label and round-trips an escaped icon path', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-icons-audit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const icon = path.join(root, '带 空格 # 100%.png');
  fs.writeFileSync(icon, 'fixture');
  const { call } = fixture([
    { package: 'com.example.named', label: 'Named', iconPath: icon },
    { package: 'com.example.legacy' },
  ]);
  const output = await call['apps:list']();
  assert.equal(output.find((entry) => entry.package === 'com.example.legacy').label, 'com.example.legacy');
  assert.equal(fileURLToPath(output.find((entry) => entry.package === 'com.example.named').iconUrl), icon);
});

test('clearing data from a stale card does not start Android after uninstall', async () => {
  const { call } = fixture([], { ensure: async () => { assert.fail('untracked app must not boot Android'); } });
  assert.equal((await call['app:clearData'](null, 'com.example.removed')).ok, false);
});
