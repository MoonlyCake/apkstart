'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { captureHandlers } = require('./helpers/ipc-registry');
const resources = require('../src/core/resources');

function fixture(t) {
  const parent = fs.realpathSync(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(parent, 'apkstart-resource-policy-'));
  t.after(() => {
    const target = fs.realpathSync(profile);
    assert.equal(path.dirname(target), parent);
    assert.match(path.basename(target), /^apkstart-resource-policy-/);
    fs.rmSync(target, { recursive: true, force: true });
  });
  const storePath = require.resolve('../src/core/store');
  const previous = process.env.APPDATA;
  process.env.APPDATA = profile;
  delete require.cache[storePath];
  let store;
  try { store = require(storePath); }
  finally {
    if (previous === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
    delete require.cache[storePath];
  }
  assert.equal(store.DATA_DIR, path.join(profile, 'apkstart'));
  return { store, file: path.join(store.DATA_DIR, 'settings.json') };
}

const fixedHost = { totalMB: 32768, cores: 16 };
const engineLimits = { memoryMB: 24576, cores: 15, dataPartitionGB: 256, autoMemory: false };
const limited = ({ memoryMB, cores, dataPartitionGB, autoMemory }) => ({ memoryMB, cores, dataPartitionGB, autoMemory });

test('direct saves and settings IPC share one resource policy, including persisted bytes', (t) => {
  const { store, file } = fixture(t);
  const host = t.mock.method(resources, 'hostProfile', () => fixedHost);
  const patch = { engine: { memoryMB: 1024 * 1024, cores: 8192, dataPartitionGB: 1024, unknownFutureFlag: ['keep'] } };
  const original = structuredClone(patch);
  assert.deepEqual(limited(store.saveSettings(patch).engine), engineLimits);
  const handlers = captureHandlers({ store });
  const saved = handlers.get('settings:set')({}, patch);
  assert.deepEqual(limited(saved.engine), engineLimits);
  assert.deepEqual(saved.engine.unknownFutureFlag, ['keep']);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), saved);
  assert.deepEqual(patch, original);
  assert.equal(host.mock.callCount(), 2, 'one host profile per write containing RAM/CPU');
});

test('reads and unrelated saves leave legacy allocations intact and keep extra fields', (t) => {
  const { store, file } = fixture(t);
  const host = t.mock.method(resources, 'hostProfile', () => assert.fail('unrelated patches must not probe the host'));
  store.ensureDirs();
  const legacy = { future: { value: 1 }, engine: { memoryMB: 385, cores: 72, dataPartitionGB: 800, privateOption: true } };
  const bytes = '\uFEFF' + JSON.stringify(legacy);
  fs.writeFileSync(file, bytes, 'utf8');
  assert.equal(store.getSettings().engine.memoryMB, 385);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
  const saved = store.saveSettings({ engine: { audio: false, resourceMode: 'smooth' } });
  assert.equal(saved.engine.memoryMB, 385);
  assert.equal(saved.engine.cores, 72);
  assert.equal(saved.engine.dataPartitionGB, 800);
  assert.equal(saved.engine.privateOption, true);
  assert.equal(saved.engine.renderSize, '720x1280');
  assert.deepEqual(saved.future, legacy.future);
  assert.ok(fs.readFileSync(file, 'utf8').startsWith('\uFEFF'));
  assert.equal(host.mock.callCount(), 0);
});

test('auto values and the existing shared autoMemory switch remain compatible', (t) => {
  const { store, file } = fixture(t);
  t.mock.method(resources, 'hostProfile', () => fixedHost);
  const manual = store.saveSettings({ engine: { memoryMB: 3000, cores: 8 } });
  assert.equal(manual.engine.memoryMB, 3072);
  assert.equal(manual.engine.autoMemory, false);
  const mixed = store.saveSettings({ engine: { memoryMB: 0, cores: 8, autoMemory: false } });
  assert.equal(mixed.engine.memoryMB, 0);
  assert.equal(mixed.engine.cores, 8);
  assert.equal(mixed.engine.autoMemory, false, 'zero RAM must not disable a manual CPU choice');
  const auto = store.saveSettings({ engine: { memoryMB: 0, cores: 0, dataPartitionGB: 0, autoMemory: true } });
  assert.deepEqual(limited(auto.engine), { memoryMB: 0, cores: 0, dataPartitionGB: 0, autoMemory: true });
  const committed = fs.readFileSync(file, 'utf8');
  assert.throws(() => store.saveSettings({ engine: [] }), { code: 'STATE_INVALID_SHAPE' });
  assert.equal(fs.readFileSync(file, 'utf8'), committed);
});

test('preflight persists normalized recommendations through the same real store', async (t) => {
  const { store, file } = fixture(t);
  t.mock.method(resources, 'hostProfile', () => ({ totalMB: 4096, cores: 4 }));
  const preflight = require('../src/core/preflight');
  const report = { patch: { engine: { memoryMB: 16384, cores: 32, renderSize: 'auto' } }, driver: {
    format: 'apkstart-driver/1', id: 'fixture-driver', name: 'Fixture driver', version: '1.0.0',
    match: { any: true }, effect: { gpuMode: 'software' },
  }};
  t.mock.method(preflight, 'collect', async () => ({}));
  t.mock.method(preflight, 'evaluate', () => report);
  const handlers = captureHandlers({ store, fs, path, appLog: () => {}, live: {
    runtime: { provisioner: { emulatorAccel: async () => ({ ok: true }) } },
  } });
  const result = await handlers.get('preflight:apply')({});
  assert.equal(result.ok, true);
  assert.equal(result.driverError, '');
  assert.equal(result.settings.engine.memoryMB, 3072);
  assert.equal(result.settings.engine.cores, 3);
  assert.equal(result.settings.engine.autoMemory, false);
  assert.equal(report.patch.engine.memoryMB, 16384);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), result.settings);
});

test('configured ceiling and actual disk availability are distinct limits', async (t) => {
  const { store } = fixture(t);
  t.mock.method(resources, 'hostProfile', () => assert.fail('a disk-only update must not probe RAM/CPU'));
  assert.equal(store.saveSettings({ engine: { dataPartitionGB: 1024 } }).engine.dataPartitionGB, 256);
  const doctor = require('../src/core/doctor');
  t.mock.method(doctor, 'freeDiskMB', () => 1024 * 1024);
  const calls = [];
  const runtime = {
    provisioner: { paths: () => ({ root: store.DATA_DIR }) },
    resizeDataPartition: async (mb) => { calls.push(mb); return { ok: true }; },
  };
  const handlers = captureHandlers({ store, live: { runtime }, appLog: () => {}, notify: () => {} });
  assert.deepEqual(await handlers.get('runtime:setDataSize')({}, 1024), { ok: true });
  assert.deepEqual(calls, [256 * 1024], 'actual resize cannot exceed the setting persisted later');
  assert.equal(resources.clampDataGB(256, 20 * 1024).gb, 16);
  assert.equal(resources.clampDataGB(256, 0).gb, 256);
  assert.equal(resources.diskLimits(1024 * 1024).maxGB, 256);
});
