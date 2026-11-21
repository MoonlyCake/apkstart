'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Sharer } = require('../src/core/sharer');

const bridgePath = require.resolve('../src/core/notify');
let NotifyBridge;
const load = Module._load;
try {
  Module._load = function (id, ...args) {
    if (id === 'electron') return { Notification: {}, nativeImage: {} };
    return load.call(this, id, ...args);
  };
  ({ NotifyBridge } = require(bridgePath));
} finally {
  Module._load = load;
  delete require.cache[bridgePath];
}

const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const dump = (key) => 'NotificationRecord(pkg=com.example.fixture key=' + key + '\nandroid.title=Fixture';
const endOfTurn = () => new Promise(setImmediate);

test('slow guest notifications never stack another ADB dump on a timer tick', async () => {
  const request = deferred();
  let calls = 0;
  const client = { isOnline: async () => true, shell: () => { calls++; return request.promise; } };
  const bridge = new NotifyBridge({ getClient: () => client });
  bridge.running = true;
  const first = bridge._tick();
  await endOfTurn();
  const later = Array.from({ length: 4 }, () => bridge._tick());
  await endOfTurn();
  const peak = calls;
  request.resolve(dump('first'));
  await Promise.all([first, ...later]);
  await bridge._tick();
  assert.equal(peak, 1);
  assert.equal(calls, 2);
});

test('an old notification response after stop cannot affect the restarted bridge', async (t) => {
  const pending = deferred();
  let reply = dump('seen');
  const client = { isOnline: async () => true, shell: async () => reply };
  const bridge = new NotifyBridge({ getClient: () => client });
  const shown = [];
  bridge._show = (record) => shown.push(record.key);
  bridge.running = true;
  await bridge._tick();
  reply = pending.promise;
  const old = bridge._tick();
  await endOfTurn();
  bridge.stop();
  t.after(() => bridge.stop());
  bridge.start();
  pending.resolve(dump('late'));
  await old;
  assert.deepEqual(shown, []);
  reply = dump('new');
  await bridge._tick();
  assert.deepEqual(shown, ['new']);
});

test('a replaced guest gets its own notification baseline and no old response', async () => {
  const pending = deferred();
  let firstReply = dump('old-seen');
  let nextReply = dump('new-seen');
  let client = { isOnline: async () => true, shell: async () => firstReply };
  const bridge = new NotifyBridge({ getClient: () => client });
  const shown = [];
  bridge._show = (record) => shown.push(record.key);
  bridge.running = true;
  await bridge._tick();
  firstReply = pending.promise;
  const old = bridge._tick();
  await endOfTurn();
  client = { isOnline: async () => true, shell: async () => nextReply };
  pending.resolve(dump('late-old'));
  await old;
  await bridge._tick();
  assert.deepEqual(shown, []);
  nextReply = dump('new-fresh');
  await bridge._tick();
  assert.deepEqual(shown, ['new-fresh']);
});

test('sharing background scans use async directory IO across nested host folders', async (t) => {
  const temp = fs.realpathSync.native(os.tmpdir());
  const base = fs.mkdtempSync(path.join(temp, 'apkstart-async-scan-'));
  fs.mkdirSync(path.join(base, 'host', 'nested'), { recursive: true });
  const host = fs.realpathSync.native(path.join(base, 'host'));
  const nested = fs.realpathSync.native(path.join(host, 'nested'));
  const client = {
    deviceState: async () => 'device',
    shell: async (command) => command.startsWith('mkdir ') ? '' : '__APKSTART_SHARED_SCAN_DONE__',
  };
  const runtime = { guestGeneration: 1, _networkEndpoint: async () => ({ client, revalidate: async () => true }) };
  const sharer = new Sharer(runtime, { settings: () => ({ sharedDir: host, deviceSharedDir: '/sdcard/fixture' }),
    stateFile: path.join(base, 'state.json') });
  const originalSync = fs.readdirSync;
  const originalAsync = fs.promises.readdir;
  const key = (dir) => process.platform === 'win32' ? String(dir).toLowerCase() : String(dir);
  const fixtures = new Map([[key(host), host], [key(nested), nested]]);
  const scanned = [];
  fs.readdirSync = function (dir, ...args) {
    assert.equal(fixtures.has(key(dir)), false, 'host scan blocked the main thread');
    return originalSync.call(this, dir, ...args);
  };
  fs.promises.readdir = async function (dir, ...args) {
    if (fixtures.has(key(dir))) scanned.push(fixtures.get(key(dir)));
    return originalAsync.call(this, dir, ...args);
  };
  t.after(() => {
    fs.readdirSync = originalSync;
    fs.promises.readdir = originalAsync;
    assert.equal(path.dirname(fs.realpathSync.native(base)), temp);
    fs.rmSync(base, { recursive: true, force: true });
  });
  assert.deepEqual(await sharer.sync(), { ok: true, pushed: 0, pulled: 0, errors: [], conflicts: [] });
  assert.deepEqual(scanned, [host, nested]);
});
