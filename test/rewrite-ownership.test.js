'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Runtime } = require('../src/core/engine');
const { EmulatorEngine } = require('../src/core/emulator');
const { adbEnvironment } = require('../src/core/adb');
const {
  readAvdOwner, parseWindowsListeners, parseLinuxListeners, findOwnedEmulator, ownsPort,
} = require('../src/core/runtime-ownership');

const pid = process.pid === 42001 ? 42002 : 42001;
const other = pid + 8;
const endpoints = (...entries) => new Map(entries.map(([port, ...pids]) => [port, new Set(pids)]));

test('AVD lock proof distinguishes absent, Windows directory PID, POSIX NUL PID, stale and malformed', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-owner-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const avd = path.join(home, 'apkstart.avd');
  const lock = path.join(avd, 'hardware-qemu.ini.lock');
  const inspect = (alive) => readAvdOwner(home, { isAlive: (value) => {
    assert.equal(value, pid);
    return alive;
  } });
  assert.equal(inspect(true).state, 'absent');
  fs.mkdirSync(lock, { recursive: true });
  assert.equal(inspect(true).state, 'unknown');
  const pidFile = path.join(lock, 'pid');
  fs.writeFileSync(pidFile, String(pid));
  const win = inspect(true);
  assert.equal(win.state, 'live');
  assert.equal(win.pid, pid);
  assert.equal(inspect(false).state, 'stale');
  fs.unlinkSync(pidFile);
  fs.rmdirSync(lock);
  fs.writeFileSync(lock, `${pid}\0`);
  assert.equal(inspect(true).state, 'live');
  fs.writeFileSync(lock, `${pid} ignored`);
  assert.equal(inspect(true).state, 'unknown');
});

test('listener ownership ignores remote/client ports and rejects ambiguous loopback mappings', () => {
  const windows = parseWindowsListeners(`
    TCP 127.0.0.1:5554 0.0.0.0:0 侦听 ${other}
    TCP 127.0.0.1:5556 0.0.0.0:0 LISTENING ${pid}
    TCP 127.0.0.1:5557 0.0.0.0:0 LISTENING ${pid}
    TCP 192.0.2.2:5558 0.0.0.0:0 LISTENING ${other}
    TCP 127.0.0.1:52300 127.0.0.1:5558 ESTABLISHED ${other}
    TCP [::1]:5556 [::]:0 LISTENING ${other}
    UDP 0.0.0.0:5558 *:* ${other}
    TCP 0.0.0.0:5554 0.0.0.0:0 LISTENING ${pid}
  `);
  assert.equal(ownsPort(windows, 5554, pid), false);
  assert.equal(ownsPort(windows, 5556, pid), true);
  assert.equal(ownsPort(windows, 5557, pid), true);
  assert.equal(windows.has(5558), false);
  const linux = parseLinuxListeners(`
    LISTEN 0 16 127.0.0.1:5554 0.0.0.0:* users:(("qemu",pid=${pid},fd=10))
    LISTEN 0 16 [::1]:5554 [::]:* users:(("other",pid=${other},fd=11))
    LISTEN 0 16 127.0.0.1:5556 0.0.0.0:*
  `);
  assert.equal(ownsPort(linux, 5554, pid), false);
  assert.deepEqual([...linux.get(5556)], [0]);
});

test('a single live lock PID must match the console, AVD name and final re-read', async () => {
  let listeners = endpoints([5554, other], [5556, pid], [5557, pid]);
  let owner = { state: 'live', pid, generation: 'initial' };
  let name = 'apkstart\r\nOK';
  let commands = 0;
  const inspect = () => findOwnedEmulator({
    readOwner: () => owner,
    readListeners: async () => listeners,
    consoleClient: (serial) => ({ serial, async exec(args) {
      assert.equal(serial, 'emulator-5556');
      assert.deepEqual(args, ['emu', 'avd', 'name']);
      commands++;
      return { stdout: name };
    } }),
  });
  const confirmed = await inspect();
  assert.equal(confirmed.state, 'owned');
  assert.equal(confirmed.emulator.serial, 'emulator-5556');
  assert.equal(await confirmed.emulator.revalidate({ adbPort: true }), true);
  listeners = endpoints([5554, other], [5556, pid], [5557, other]);
  assert.equal(await confirmed.emulator.revalidate(), true);
  assert.equal(await confirmed.emulator.revalidate({ adbPort: true }), false);
  owner = { ...owner, generation: 'different lock file' };
  assert.equal(await confirmed.emulator.revalidate(), false);
  name = 'Android_Studio_Test\nOK';
  assert.equal((await inspect()).state, 'unknown');
  listeners = endpoints([5556, pid], [5558, pid]);
  assert.equal((await inspect()).state, 'unknown');
  owner = { state: 'absent' };
  assert.equal((await inspect()).state, 'absent');
  assert.equal(commands, 2);
});

test('Windows adb console extra CR does not hide the owned AVD or accept a foreign name', async () => {
  const inspect = (stdout) => findOwnedEmulator({
    readOwner: () => ({ state: 'live', pid, generation: 'windows-adb' }),
    readListeners: async () => endpoints([5554, pid], [5555, pid]),
    consoleClient: () => ({ exec: async () => ({ stdout }) }),
  });
  assert.equal((await inspect('apkstart\r\r\nOK\r\r\n')).state, 'owned');
  assert.equal((await inspect('Another_AVD\r\r\nOK\r\r\n')).state, 'unknown');
  assert.equal((await inspect('apkstart\r\r\nextra\r\r\nOK\r\r\n')).state, 'unknown');
});

function fakeRuntime() {
  const runtime = Object.create(Runtime.prototype);
  Object.defineProperty(runtime, 'settings', { value: { engine: { headless: false }, runtime: { installed: false } } });
  runtime.emuSerial = 'emulator-5554';
  runtime.emulator = { port: 5554, running: () => false };
  runtime.inspectEmulatorOwnership = async () => ({ state: 'absent' });
  runtime.client = () => { throw new Error('unverified ADB'); };
  runtime.prepare = async () => { throw new Error('unverified prepare'); };
  runtime.adbPath = () => 'fake-adb';
  runtime._activeApps = new Set();
  return runtime;
}

test('ensure does not enumerate/reuse foreign ADB devices and does not boot over an unknown lock', async () => {
  const runtime = fakeRuntime();
  let bootCalls = 0;
  runtime.provisioner = { materializeImages: async () => {}, checkEnv: async () => ({ emulator: { ok: true }, sysimg: { ok: true } }) };
  runtime._boot = async () => { bootCalls++; return { ok: true, client: {} }; };
  runtime.inspectEmulatorOwnership = async () => ({ state: 'unknown' });
  assert.equal((await runtime.ensure()).ok, false);
  assert.equal(bootCalls, 0);
  runtime.inspectEmulatorOwnership = async () => ({ state: 'absent' });
  assert.deepEqual((await runtime.ensure()).client, {});
  assert.equal(bootCalls, 1);
});

test('owned guest reuse requires package-ready guest and fresh proof before prepare', async () => {
  const runtime = fakeRuntime();
  let response = '1\n';
  let stillOwned = true;
  let prepared = 0;
  const client = { serial: 'emulator-5556', async shell(args) {
    assert.equal(args, 'getprop sys.boot_completed; pm path android');
    return response;
  } };
  runtime.inspectEmulatorOwnership = async () => ({ state: 'owned', emulator: {
    port: 5556, serial: client.serial, revalidate: async () => stillOwned,
  } });
  runtime.client = (serial) => { assert.equal(serial, client.serial); return client; };
  runtime.prepare = async (value) => { assert.equal(value, client); prepared++; };
  const starting = await runtime.ensure();
  assert.equal(starting.ok, false);
  assert.equal(starting.code, 'ANDROID_STARTING');
  assert.equal(prepared, 0);
  response = '1\r\npackage:/system/framework/framework-res.apk\r\n';
  stillOwned = false;
  assert.equal((await runtime.ensure()).ok, false);
  stillOwned = true;
  assert.equal((await runtime.ensure()).client, client);
  assert.equal(runtime.emuSerial, client.serial);
  assert.equal(runtime.emulator.port, 5556);
  assert.equal(prepared, 1);
});

test('an owned native transport in authorization is reported without connecting a TCP alias', async () => {
  const runtime = fakeRuntime();
  const native = 'emulator-5556';
  runtime.inspectEmulatorOwnership = async () => ({ state: 'owned', emulator: {
    port: 5556, pid, serial: native, revalidate: async () => true,
  } });
  runtime.client = (serial) => {
    assert.equal(serial, native);
    return {
      serial,
      shell: async () => { throw new Error('device unauthorized'); },
      deviceState: async () => 'unauthorized',
      exec: async () => assert.fail('attempted to connect an alias instead of handling authorization'),
    };
  };

  const result = await runtime.ensure();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'ADB_UNAUTHORIZED');
  assert.match(result.error, /允许 USB 调试/);
  assert.equal(result.client, undefined);
});

test('offline native ADB is not replaced with a competing TCP transport', async () => {
  const runtime = fakeRuntime();
  const native = 'emulator-5556';
  runtime.inspectEmulatorOwnership = async () => ({ state: 'owned', emulator: {
    port: 5556, pid, serial: native, revalidate: async () => true,
  } });
  runtime.client = (serial) => {
    assert.equal(serial, native);
    return {
      serial,
      shell: async () => { throw new Error('device offline'); },
      deviceState: async () => 'offline',
      exec: async () => assert.fail('offline transport must not get a competing connection'),
    };
  };

  const result = await runtime.ensure();
  assert.equal(result.ok, false);
  assert.notEqual(result.code, 'ADB_UNAUTHORIZED');
  assert.equal(result.client, undefined);
});

test('authorization handoff prepares only the exact proven existing guest after approval', async () => {
  const runtime = fakeRuntime();
  const native = 'emulator-5556';
  const trace = [];
  const owned = { port: 5556, pid, serial: native, revalidate: async () => true };
  let approved = false;
  const client = {
    serial: native,
    shell: async (cmd) => {
      assert.equal(cmd, 'getprop sys.boot_completed; pm path android');
      if (!approved) throw new Error('device unauthorized');
      return '1\npackage:/system/framework/framework-res.apk';
    },
    deviceState: async () => approved ? 'device' : 'unauthorized',
    exec: async () => assert.fail('authorization handoff must keep the existing transport'),
  };
  runtime.inspectEmulatorOwnership = async () => ({ state: 'owned', emulator: owned });
  runtime.client = (serial) => { assert.equal(serial, native); return client; };
  runtime.presentAdbConsent = async (identity) => {
    assert.equal(identity, owned);
    trace.push('present');
    approved = true;
    return async () => { trace.push('close'); };
  };
  runtime.prepare = async (value) => {
    assert.equal(value, client);
    assert.ok(approved);
    trace.push('prepare');
  };

  const result = await runtime.ensure();
  assert.equal(result.ok, true);
  assert.equal(result.client, client);
  assert.deepEqual(trace, ['present', 'close', 'prepare']);
  assert.ok(!runtime._adbConsentPending);
});

test('a previously proven guest cannot be adopted if the authorization window returns after ownership changes', async () => {
  const runtime = fakeRuntime();
  const native = 'emulator-5556';
  let known = true;
  let cleaned = false;
  const owned = { port: 5556, pid, serial: native, revalidate: async () => known };
  runtime.inspectEmulatorOwnership = async () => ({ state: 'owned', emulator: owned });
  runtime.client = (serial) => {
    assert.equal(serial, native);
    return {
      serial,
      shell: async () => {
        assert.ok(known, 'must not probe a new guest on the old serial');
        throw new Error('device unauthorized');
      },
      deviceState: async () => 'unauthorized',
    };
  };
  runtime.presentAdbConsent = async (identity) => {
    assert.equal(identity, owned);
    known = false;
    return async () => { cleaned = true; };
  };

  const result = await runtime.ensure();
  assert.equal(result.ok, false);
  assert.equal(result.client, undefined);
  assert.equal(cleaned, true);
});

test('existing guest authorization times out and closes a late-arriving window handle', async () => {
  const runtime = fakeRuntime();
  const owned = { port: 5556, pid, serial: 'emulator-5556', revalidate: async () => true };
  let show;
  let hidden = false;
  runtime.presentAdbConsent = async () => new Promise((resolve) => { show = resolve; });
  let probes = 0;
  runtime.reuseProbe = async () => { probes += 1; return true; };

  assert.equal(await runtime._waitForExistingAdbConsent(owned, {}, () => {}, { waitMs: 25 }), 'authorization-timeout');
  assert.ok(!runtime._adbConsentPending);
  assert.equal(runtime._existingAdbConsent, null);
  show(async () => { hidden = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(hidden, true);
  assert.equal(probes, 0);
});

test('status does not read ADB or report ready for an unknown guest on the expected port', async () => {
  const runtime = fakeRuntime();
  Object.defineProperty(runtime, 'backend', { value: { id: 'builtin', label: 'Builtin' } });
  runtime.inspectEmulatorOwnership = async () => ({ state: 'unknown' });
  runtime.provisioner = { checkEnv: async () => ({
    emulator: { ok: true }, sysimg: { ok: true }, adb: { ok: true }, qemu: { ok: true },
  }) };
  runtime.client = () => assert.fail('status must not probe an unowned guest');
  const status = await runtime.status();
  assert.equal(status.ready, false);
  assert.equal(status.deviceOnline, false);
  assert.notEqual(status.phase, 'ready');
});

test('status drops the transport result if guest ownership changes during the ADB read', async () => {
  const runtime = fakeRuntime();
  Object.defineProperty(runtime, 'backend', { value: { id: 'builtin', label: 'Builtin' } });
  runtime.provisioner = { checkEnv: async () => ({
    emulator: { ok: true }, sysimg: { ok: true }, adb: { ok: true }, qemu: { ok: true },
  }) };
  let known = true;
  let shellProbes = 0;
  runtime._networkEndpoint = async () => ({
    client: {
      async deviceState() {
        known = false;
        return 'device';
      },
      async shell() {
        shellProbes += 1;
        return '1\npackage:/system/framework/framework-res.apk';
      },
    },
    revalidate: async () => known,
  });
  const status = await runtime.status();
  assert.equal(status.deviceOnline, false);
  assert.equal(status.ready, false);
  assert.equal(shellProbes, 0);
});

test('ownership lost during guest preparation does not publish a client', async () => {
  const runtime = fakeRuntime();
  let stillOwned = true;
  const client = { serial: 'emulator-5556' };
  runtime.inspectEmulatorOwnership = async () => ({ state: 'owned', emulator: {
    port: 5556, serial: client.serial, revalidate: async () => stillOwned,
  } });
  runtime.client = () => client;
  runtime.reuseProbe = async () => true;
  runtime.prepare = async () => { stillOwned = false; };
  const result = await runtime.ensure();
  assert.equal(result.ok, false);
  assert.equal(result.client, undefined);
});

test('late ADB recovery only connects to the independently verified paired port', async () => {
  const runtime = fakeRuntime();
  const commands = [];
  let ownsAdb = false;
  runtime.inspectEmulatorOwnership = async () => ({ state: 'owned', emulator: {
    port: 5556, serial: 'emulator-5556', revalidate: async ({ adbPort } = {}) => !adbPort || ownsAdb,
  } });
  runtime.client = (serial) => ({ serial,
    async shell() {
      if (serial === 'emulator-5556') throw new Error('missing transport');
      return '1\npackage:/system/framework/framework-res.apk';
    },
    async deviceState() { return serial === 'emulator-5556' ? 'no-device' : 'device'; },
    async exec(args) { commands.push(args); },
  });
  runtime.prepare = async () => {};
  assert.equal((await runtime.ensure()).ok, false);
  assert.deepEqual(commands, []);
  ownsAdb = true;
  assert.equal((await runtime.ensure()).client.serial, '127.0.0.1:5557');
  assert.deepEqual(commands, [['connect', '127.0.0.1:5557']]);
});

test('TCP recovery neither probes nor returns a replacement guest after losing the paired port', async () => {
  const runtime = fakeRuntime();
  let ownsAdb = true;
  runtime.inspectEmulatorOwnership = async () => ({ state: 'owned', emulator: {
    port: 5556, pid, serial: 'emulator-5556', revalidate: async ({ adbPort } = {}) => !adbPort || ownsAdb,
  } });
  runtime.client = (serial) => ({
    serial,
    async shell() {
      assert.equal(serial, 'emulator-5556', 'must not send shell to replacement guest');
      throw new Error('missing transport');
    },
    async deviceState() {
      assert.equal(serial, 'emulator-5556', 'must not query replacement guest');
      return 'no-device';
    },
    async exec(args) {
      assert.deepEqual(args, ['connect', '127.0.0.1:5557']);
      ownsAdb = false;
    },
  });
  const result = await runtime.ensure();
  assert.equal(result.ok, false);
  assert.equal(result.client, undefined);
});

test('stop refuses an unscoped device and passes the verified identity to lower stop', async () => {
  const runtime = fakeRuntime();
  const owned = { serial: 'emulator-5556', port: 5556, pid };
  let stopCalls = 0;
  const client = { serial: owned.serial };
  runtime.client = (serial) => {
    assert.equal(serial, owned.serial);
    return client;
  };
  runtime.emulator.stop = async (input) => {
    assert.deepEqual(input, { client, identity: owned });
    stopCalls++;
    return true;
  };
  assert.equal(await runtime.stop(), true); // already stopped is a no-op
  runtime.inspectEmulatorOwnership = async () => ({ state: 'unknown' });
  assert.equal(await runtime.stop(), false);
  assert.equal(stopCalls, 0);
  runtime.inspectEmulatorOwnership = async () => ({ state: 'owned', emulator: owned });
  assert.equal(await runtime.stop(), true);
  assert.equal(stopCalls, 1);
});

test('fresh launch will not read or prepare an emulator without a current owner proof', async () => {
  const runtime = fakeRuntime();
  runtime.emulator.running = () => true;
  runtime._probeClient = { serial: 'emulator-5554', async shell() { assert.fail('unknown ADB touched'); } };
  runtime.emulator.start = async ({ probe, stopOwnedAttempt }) => {
    assert.equal(await probe({ serial: 'emulator-5554', port: 5554 }), 'pending');
    assert.equal(await stopOwnedAttempt(5554), false);
    return { ok: true, serial: 'emulator-5554' };
  };
  assert.equal((await runtime.bootEmulator({ env: { accel: { ok: true } } })).ok, false);
});

test('Windows priority uses only a verified PID and preserves all four levels', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const changes = [];
  t.mock.method(os, 'setPriority', (pid, level) => { changes.push([pid, level]); });
  const emu = Object.create(EmulatorEngine.prototype);
  assert.equal(await emu.setPriority('game'), 0);
  assert.equal(await emu.setPriority('game', { pid, revalidate: async () => false }), 0);
  assert.equal(await emu.setPriority('other', { pid, revalidate: async () => true }), 0);
  const levels = ['idle', 'below', 'normal', 'game'];
  for (const level of levels) assert.equal(await emu.setPriority(level, { pid, revalidate: async () => true }), 1);
  assert.deepEqual(changes, [
    [pid, os.constants.priority.PRIORITY_LOW], [pid, os.constants.priority.PRIORITY_BELOW_NORMAL],
    [pid, os.constants.priority.PRIORITY_NORMAL], [pid, os.constants.priority.PRIORITY_HIGH],
  ]);
});

test('environment keeps AVD and ADB endpoints out of driver and inherited overrides', () => {
  const poisoned = {
    adb_server_socket: 'tcp:unrelated:5037', ANDROID_ADB_SERVER_ADDRESS: 'other-host',
    android_adb_server_port: '5037', LIBGL_DEBUG: 'verbose',
  };
  const adb = adbEnvironment(5048, poisoned);
  assert.equal(adb.ANDROID_ADB_SERVER_PORT, '5048');
  assert.equal(adb.adb_server_socket, undefined);
  assert.equal(adb.ANDROID_ADB_SERVER_ADDRESS, undefined);
  assert.equal(adb.android_adb_server_port, undefined);
  assert.equal(adb.LIBGL_DEBUG, 'verbose');

  const emu = Object.create(EmulatorEngine.prototype);
  emu.provisioner = { paths: () => ({ avdHome: path.join(__dirname, 'managed-avds') }) };
  emu._driverEffect = { env: {
    ...poisoned, ANDROID_AVD_HOME: 'foreign-avds', ANDROID_SDK_ROOT: 'foreign-sdk',
  } };
  const env = emu.env(__dirname, { adbPort: 5048 });
  assert.equal(env.ANDROID_AVD_HOME, path.join(__dirname, 'managed-avds'));
  assert.equal(env.ANDROID_SDK_ROOT, __dirname);
  assert.equal(env.ANDROID_ADB_SERVER_PORT, '5048');
  assert.equal(env.LIBGL_DEBUG, 'verbose');
});

test('an existing ADB port is not restarted and an unused port waits for the listener', async () => {
  const emu = Object.create(EmulatorEngine.prototype);
  let listening = true;
  let starts = 0;
  emu._consoleAlive = async (port) => { assert.equal(port, 5048); return listening; };
  emu._startAdbServer = async (port) => { assert.equal(port, 5048); starts += 1; listening = true; };
  assert.equal(await emu.ensureAdbServer(5048), true);
  assert.equal(starts, 0);
  listening = false;
  assert.equal(await emu.ensureAdbServer(5048), true);
  assert.equal(starts, 1);
  listening = false;
  emu._startAdbServer = async () => { throw new Error('spawn failed'); };
  assert.equal(await emu.ensureAdbServer(5048), false);
});

test('cache preview does not stop a VM and a failed close preserves the active AVD', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-cleanup-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const avd = path.join(root, 'avd', 'apkstart.avd');
  const snapshot = path.join(avd, 'snapshots', 'ram.img');
  const lock = path.join(avd, 'hardware-qemu.ini.lock');
  fs.mkdirSync(path.dirname(snapshot), { recursive: true });
  fs.writeFileSync(snapshot, 'keep until the VM stops');
  fs.writeFileSync(lock, 'owned');
  const runtime = Object.create(Runtime.prototype);
  let running = true;
  let stops = 0;
  runtime.emulator = { running: () => running };
  runtime.provisioner = { paths: () => ({ root }) };
  runtime.avdOwner = () => running ? { state: 'live', pid } : { state: 'stale', pid };
  runtime._stopInner = async () => { stops += 1; return false; };

  const preview = await runtime.cleanup({ includeSnapshots: true });
  assert.equal(preview.ok, true);
  assert.equal(preview.stoppedVm, false);
  assert.ok(preview.candidates.some((entry) => entry.path === path.dirname(snapshot)));
  assert.equal(stops, 0);
  assert.equal((await runtime.cleanup({ apply: true })).ok, false);
  assert.equal(stops, 0);
  assert.equal((await runtime.cleanup({ apply: true, includeSnapshots: true })).ok, false);
  assert.equal(stops, 1);
  assert.ok(fs.existsSync(snapshot));
  assert.ok(fs.existsSync(lock));

  runtime._stopInner = async () => { running = false; return true; };
  const applied = await runtime.cleanup({ apply: true, includeSnapshots: true });
  assert.equal(applied.ok, true);
  assert.equal(applied.stoppedVm, true);
  assert.equal(fs.existsSync(snapshot), false);
  assert.ok(fs.existsSync(lock), 'the emulator reclaims its own lock');
});
