'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const storePath = require.resolve('../src/core/store');

function fixture(t, { withRuntime = false } = {}) {
  const parent = fs.realpathSync(os.tmpdir());
  const profile = fs.mkdtempSync(path.join(parent, 'apkstart-rewrite-state-'));
  t.after(() => {
    const absolute = fs.realpathSync(profile);
    assert.equal(path.dirname(absolute), parent);
    assert.ok(path.basename(absolute).startsWith('apkstart-rewrite-state-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  const previous = process.env.APPDATA;
  process.env.APPDATA = profile;
  delete require.cache[storePath];
  let store;
  let Runtime;
  try {
    store = require(storePath);
    if (withRuntime) {
      const enginePath = require.resolve('../src/core/engine');
      try {
        ({ Runtime } = require(enginePath));
      } finally {
        delete require.cache[enginePath];
      }
    }
  } finally {
    if (previous === undefined) delete process.env.APPDATA;
    else process.env.APPDATA = previous;
    delete require.cache[storePath];
  }
  assert.equal(store.DATA_DIR, path.join(profile, 'apkstart'));
  return {
    store,
    Runtime,
    profile,
    settings: path.join(store.DATA_DIR, 'settings.json'),
    apps: path.join(store.DATA_DIR, 'apps.json'),
  };
}

const bom = '\uFEFF';
const read = (file) => fs.readFileSync(file, 'utf8');

test('a missing profile can be read without creating files or mutating shared defaults', (t) => {
  const { store } = fixture(t);
  const defaults = store.getSettings();
  assert.equal(defaults.engine.mode, 'builtin');
  assert.equal(defaults.display.windowEmbed, false);
  defaults.engine.gpuMode = 'test-only';
  assert.equal(store.getSettings().engine.gpuMode, 'auto');
  assert.deepEqual(store.getApps(), []);
  assert.equal(fs.existsSync(store.DATA_DIR), false);
});

test('legacy settings are migrated in memory and retain BOM and unknown fields on explicit save', (t) => {
  const { store, settings } = fixture(t);
  store.ensureDirs();
  const old = {
    futureOption: { enabled: true },
    engine: { mode: 'mumu', mumuPath: 'legacy', headless: true, customBackendOption: 42 },
    display: { windowEmbed: true, windowEmbedMigrated2: true, customScale: 200 },
    hideAfterLaunch: true,
    freeform: true,
  };
  const bytes = bom + JSON.stringify(old);
  fs.writeFileSync(settings, bytes);
  const view = store.getSettings();
  assert.equal(view.engine.mode, 'builtin');
  assert.equal(view.engine.headless, false);
  assert.equal(view.engine.customBackendOption, 42);
  assert.equal(Object.hasOwn(view.engine, 'mumuPath'), false);
  assert.equal(view.hideAfterLaunch, false);
  assert.equal(view.freeform, false);
  assert.equal(view.display.windowEmbed, false);
  assert.equal(read(settings), bytes);

  const saved = store.saveSettings({ engine: { resourceMode: 'smooth' } });
  const published = read(settings);
  assert.ok(published.startsWith(bom));
  assert.deepEqual(JSON.parse(published.slice(1)), saved);
  assert.deepEqual(saved.futureOption, old.futureOption);
  assert.equal(saved.display.customScale, 200);
  assert.equal(saved.engine.renderSize, '720x1280');
});

test('deliberately chosen embedded mode is not overridden', (t) => {
  const { store, settings } = fixture(t);
  store.ensureDirs();
  const bytes = '{"display":{"windowEmbed":true,"windowEmbedChosen":true}}';
  fs.writeFileSync(settings, bytes);
  assert.equal(store.getSettings().display.windowEmbed, true);
  assert.equal(read(settings), bytes);
  store.saveSettings({ notifyOnInstall: false });
  assert.equal(store.getSettings().display.windowEmbed, true);
});

test('catalogue mutations preserve BOM, envelope fields, and untouched app metadata', (t) => {
  const { store, apps } = fixture(t);
  store.ensureDirs();
  const initial = {
    ownerMetadata: { source: 'v1' },
    apps: [{ package: 'org.example.sample', label: '原名', launchCount: 3, extra: { a: 1 } }],
  };
  fs.writeFileSync(apps, bom + JSON.stringify(initial));
  store.upsertApp({ package: 'org.example.sample', label: '新名' });
  assert.deepEqual(store.getApp('org.example.sample'), { ...initial.apps[0], label: '新名' });
  store.removeApp('org.example.sample');
  assert.deepEqual(store.getApps(), []);
  const published = read(apps);
  assert.ok(published.startsWith(bom));
  assert.deepEqual(JSON.parse(published.slice(1)), { ...initial, apps: [] });
});

test('truncated or invalid UTF-8 settings are reported without disk changes', (t) => {
  const { store, settings } = fixture(t);
  store.ensureDirs();
  const candidates = [
    Buffer.from('{"display":'),
    Buffer.concat([Buffer.from('{"option":"'), Buffer.from([0xc3]), Buffer.from('"}')]),
  ];
  for (const expected of candidates) {
    fs.writeFileSync(settings, expected);
    assert.throws(() => store.getSettings(), { code: 'STATE_INVALID_JSON', path: settings });
    assert.throws(() => store.saveSettings({ autoDeploy: false }), { code: 'STATE_INVALID_JSON', path: settings });
    assert.deepEqual(fs.readFileSync(settings), expected);
  }
});

test('malformed settings and catalogue shapes cannot be replaced by mutations', (t) => {
  const { store, settings, apps } = fixture(t);
  store.ensureDirs();
  fs.writeFileSync(settings, '{"runtime":null}');
  fs.writeFileSync(apps, '{"apps":[null]}');
  assert.throws(() => store.getSettings(), { code: 'STATE_INVALID_SHAPE', path: settings });
  assert.throws(() => store.saveSettings({}), { code: 'STATE_INVALID_SHAPE', path: settings });
  assert.throws(() => store.getApps(), { code: 'STATE_INVALID_SHAPE', path: apps });
  assert.throws(() => store.saveApps([]), { code: 'STATE_INVALID_SHAPE', path: apps });
  assert.throws(() => store.upsertApp({ package: 'org.example.sample' }), { code: 'STATE_INVALID_SHAPE', path: apps });
  assert.throws(() => store.removeApp('org.example.sample'), { code: 'STATE_INVALID_SHAPE', path: apps });
  assert.equal(read(settings), '{"runtime":null}');
  assert.equal(read(apps), '{"apps":[null]}');
});

test('read I/O errors are not confused with a missing file', (t) => {
  const { store, settings } = fixture(t);
  store.ensureDirs();
  fs.mkdirSync(settings);
  const matchesIOError = (error) => {
    assert.match(error.code, /^(EISDIR|EPERM|EACCES)$/);
    assert.equal(error.path, settings);
    return true;
  };
  assert.throws(() => store.getSettings(), matchesIOError);
  assert.throws(() => store.saveSettings({}), matchesIOError);
  assert.ok(fs.statSync(settings).isDirectory());
});

test('a failed atomic replace leaves destination and existing .tmp untouched', (t) => {
  const { store, settings } = fixture(t);
  store.ensureDirs();
  fs.writeFileSync(settings, '{"autoDeploy":false}');
  const legacyTemp = settings + '.tmp';
  fs.writeFileSync(legacyTemp, 'do not overwrite');
  const temporaryFiles = new Set();
  t.mock.method(fs, 'renameSync', (temporary, destination) => {
    assert.equal(destination, settings);
    assert.equal(path.dirname(temporary), path.dirname(settings));
    assert.notEqual(temporary, legacyTemp);
    temporaryFiles.add(temporary);
    assert.equal(JSON.parse(read(temporary)).engine.prewarm, false);
    throw Object.assign(new Error('destination temporarily locked'), { code: 'EPERM' });
  });
  for (let attempt = 0; attempt < 2; attempt++) {
    assert.throws(() => store.saveSettings({ engine: { prewarm: false } }), { code: 'EPERM' });
    assert.equal(read(settings), '{"autoDeploy":false}');
    assert.equal(read(legacyTemp), 'do not overwrite');
  }
  assert.equal(temporaryFiles.size, 2);
  assert.ok([...temporaryFiles].every((file) => !fs.existsSync(file)));
});

test('legacy null settings groups use defaults without rewriting until save', (t) => {
  const { store, settings } = fixture(t);
  store.ensureDirs();
  const legacy = '{"debug":null,"welcome":null,"drivers":null,"custom":42}';
  fs.writeFileSync(settings, legacy);
  const view = store.getSettings();
  assert.deepEqual(view.debug, store.DEFAULT_SETTINGS.debug);
  assert.deepEqual(view.welcome, store.DEFAULT_SETTINGS.welcome);
  assert.deepEqual(view.drivers, store.DEFAULT_SETTINGS.drivers);
  assert.equal(read(settings), legacy);
  store.saveSettings({ notifyOnInstall: false });
  const actual = JSON.parse(read(settings));
  assert.deepEqual(actual.debug, store.DEFAULT_SETTINGS.debug);
  assert.deepEqual(actual.welcome, store.DEFAULT_SETTINGS.welcome);
  assert.deepEqual(actual.drivers, store.DEFAULT_SETTINGS.drivers);
  assert.equal(actual.custom, 42);
  assert.equal(actual.notifyOnInstall, false);
});

test('legacy catalogue envelopes with no apps read empty without rewriting', (t) => {
  const { store, apps } = fixture(t);
  store.ensureDirs();
  for (const legacy of [{}, { custom: { edition: 'legacy' } }]) {
    const original = JSON.stringify(legacy);
    fs.writeFileSync(apps, original);
    assert.deepEqual(store.getApps(), []);
    assert.equal(read(apps), original);
    store.upsertApp({ package: 'org.example.sample' });
    assert.deepEqual(JSON.parse(read(apps)), { ...legacy, apps: [{ package: 'org.example.sample' }] });
  }
});

function resetFixture(t) {
  const f = fixture(t, { withRuntime: true });
  f.store.ensureDirs();
  const avdHome = path.join(f.profile, 'avd');
  const avdDir = path.join(avdHome, 'apkstart.avd');
  fs.mkdirSync(avdDir, { recursive: true });
  const userdata = path.join(avdDir, 'userdata-qemu.img');
  fs.writeFileSync(userdata, 'guest fixture');
  const config = path.join(avdDir, 'config.ini');
  fs.writeFileSync(config, 'config fixture');
  const runtime = Object.assign(Object.create(f.Runtime.prototype), {
    provisioner: { paths: () => ({ avdHome }) },
    client: () => ({ isOnline: async () => false }),
    emulatorPorts: async () => [],
    emulator: { cancelSnapshotSave() {} },
  });
  Object.defineProperty(runtime, 'vmRunning', { value: false, writable: true });
  return {
    ...f, userdata, avdDir, config, runtime,
    reset: () => runtime.resetAndroidData(),
  };
}

test('a corrupt catalogue blocks reset before touching the fixture guest', async (t) => {
  const { apps, runtime, reset, userdata } = resetFixture(t);
  fs.writeFileSync(apps, '{"apps":');
  runtime.vmRunning = true;
  runtime.stop = t.mock.fn(async () => {});
  const result = await reset();
  assert.equal(result.ok, false);
  assert.match(result.error, /apps\.json/);
  assert.equal(runtime.stop.mock.callCount(), 0);
  assert.equal(read(userdata), 'guest fixture');
  assert.equal(read(apps), '{"apps":');
});

function adoptedGuest(t, { runtime, avdDir }, { name = 'apkstart', onKill = () => {} } = {}) {
  const owner = 424242;
  const lockDir = path.join(avdDir, 'hardware-qemu.ini.lock');
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, 'pid'), String(owner));
  let online = true;
  const commands = [];
  t.mock.method(process, 'kill', (pid, signal) => {
    assert.equal(pid, owner);
    assert.equal(signal, 0); // This is only a process-existence check.
    if (!online) throw Object.assign(new Error('process gone'), { code: 'ESRCH' });
    return true;
  });
  runtime.client = (serial) => ({
    isOnline: async () => online,
    exec: async (argv) => {
      commands.push([serial, argv]);
      if (serial !== 'emulator-5556') throw new Error('not the owned console');
      if (argv[1] === 'avd') return { stdout: `${name}\r\nOK\r\n` };
      assert.deepEqual(argv, ['emu', 'kill']);
      online = false;
      onKill();
      return { stdout: 'OK: killing emulator' };
    },
  });
  runtime.emulatorPorts = async () => [5554, 5556];
  runtime.pidOnPort = async (port) => (port === 5556 ? owner : 123);
  return commands;
}

test('reset safely stops the verified adopted guest even with no local VM handle', async (t) => {
  const f = resetFixture(t);
  const commands = adoptedGuest(t, f);
  assert.equal(f.runtime.vmRunning, false);
  assert.equal(await f.runtime.client().isOnline(), true);
  const result = await f.reset();
  assert.equal(result.ok, true);
  assert.deepEqual(commands, [
    ['emulator-5556', ['emu', 'avd', 'name']],
    ['emulator-5556', ['emu', 'kill']],
  ]);
  assert.equal(fs.existsSync(f.userdata), false);
});

test('reset refuses a guest online without ownership evidence', async (t) => {
  const f = resetFixture(t);
  const exec = t.mock.fn();
  f.runtime.emulatorPorts = async () => [5558];
  f.runtime.client = () => ({ isOnline: async () => true, exec });
  const result = await f.reset();
  assert.equal(result.ok, false);
  assert.match(result.error, /无法确认/);
  assert.equal(exec.mock.callCount(), 0);
  assert.equal(read(f.userdata), 'guest fixture');
});

test('reset refuses a mismatched console, even when the AVD lock PID matches', async (t) => {
  const f = resetFixture(t);
  const commands = adoptedGuest(t, f, { name: 'AndroidStudio_AVD' });
  const result = await f.reset();
  assert.equal(result.ok, false);
  assert.deepEqual(commands, [['emulator-5556', ['emu', 'avd', 'name']]]);
  assert.equal(read(f.userdata), 'guest fixture');
});

test('reset rechecks the catalogue after the verified runtime stops', async (t) => {
  const f = resetFixture(t);
  fs.writeFileSync(f.apps, '{"apps":[]}');
  adoptedGuest(t, f, { onKill: () => fs.writeFileSync(f.apps, '{"apps":') });
  const result = await f.reset();
  assert.equal(result.ok, false);
  assert.match(result.error, /apps\.json/);
  assert.equal(read(f.userdata), 'guest fixture');
});

test('reset reports a catalogue publication error after fixture disk deletion', async (t) => {
  const { apps, userdata, config, avdDir, reset } = resetFixture(t);
  const before = '{"apps":[{"package":"org.example.sample"}]}';
  fs.writeFileSync(apps, before);
  const rename = fs.renameSync;
  t.mock.method(fs, 'renameSync', (from, to) => {
    if (to === apps) throw Object.assign(new Error('destination temporarily locked'), { code: 'EPERM' });
    return rename(from, to);
  });
  const result = await reset();
  assert.equal(result.ok, false);
  assert.match(result.error, /应用清单未能更新.*destination temporarily locked/);
  assert.equal(result.reclaimed, Buffer.byteLength('guest fixture'));
  assert.equal(result.avdDir, avdDir);
  assert.equal(fs.existsSync(userdata), false);
  assert.equal(read(config), 'config fixture');
  assert.equal(read(apps), before);
});

test('reset updates a valid catalogue and preserves the other fixture AVD files', async (t) => {
  const { store, apps, userdata, config, avdDir, reset } = resetFixture(t);
  fs.writeFileSync(apps, '{"retained":"legacy","apps":[{"package":"org.example.sample"}]}');
  assert.deepEqual(await reset(), { ok: true, reclaimed: Buffer.byteLength('guest fixture'), avdDir });
  assert.equal(fs.existsSync(userdata), false);
  assert.equal(read(config), 'config fixture');
  assert.deepEqual(store.getApps(), []);
  assert.deepEqual(JSON.parse(read(apps)), { retained: 'legacy', apps: [] });
});

test('legacy null catalogue loads empty and saves a real array with envelope keys', (t) => {
  const { store, apps } = fixture(t);
  store.ensureDirs();
  const legacy = '{"apps":null,"extra":42}';
  fs.writeFileSync(apps, legacy);
  assert.deepEqual(store.getApps(), []);
  assert.equal(read(apps), legacy);
  assert.throws(() => store.saveApps(null), { code: 'STATE_INVALID_SHAPE', path: apps });
  assert.equal(read(apps), legacy);
  store.upsertApp({ package: 'org.example.sample' });
  assert.deepEqual(JSON.parse(read(apps)), { apps: [{ package: 'org.example.sample' }], extra: 42 });
});

for (const blockedName of ['userdata-qemu.img', 'snapshots']) {
  test(`reset leaves the catalogue intact when removing ${blockedName} fails`, async (t) => {
    const f = resetFixture(t);
    const before = '{"apps":[{"package":"org.example.sample"}]}';
    fs.writeFileSync(f.apps, before);
    const blocked = path.join(f.avdDir, blockedName);
    if (blockedName === 'snapshots') fs.mkdirSync(blocked);
    const rm = fs.rmSync;
    t.mock.method(fs, 'rmSync', (target, opts) => {
      if (target === blocked) throw Object.assign(new Error('fixture file locked'), { code: 'EPERM' });
      return rm(target, opts);
    });
    const result = await f.reset();
    assert.equal(result.ok, false);
    assert.match(result.error, /应用清单未清除/);
    assert.ok(result.error.includes(blockedName));
    assert.equal(read(f.apps), before);
    assert.ok(fs.existsSync(blocked));
  });
}
