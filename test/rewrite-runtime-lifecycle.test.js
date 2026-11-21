'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const assert = require('node:assert/strict');
const test = require('node:test');
const { Runtime } = require('../src/core/engine');
const { AdbClient } = require('../src/core/adb');
const { EmulatorEngine } = require('../src/core/emulator');
const store = require('../src/core/store');

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

function runtimeFixture() {
  const runtime = Object.create(Runtime.prototype);
  runtime.emulator = { running: () => false };
  return runtime;
}

test('ten concurrent production ensure calls share exactly one hardware attempt', async () => {
  const runtime = runtimeFixture();
  const gate = deferred();
  let boots = 0;
  const result = { ok: true, client: {} };
  runtime._ensureInner = async () => {
    boots++;
    assert.equal(runtime.lifecycle.phase, 'ensuring');
    await gate.promise;
    return result;
  };
  const requests = Array.from({ length: 10 }, () => runtime.ensure());
  assert.ok(requests.every((request) => request === requests[0]));
  gate.resolve();
  const values = await Promise.all(requests);
  assert.ok(values.every((value) => value === values[0]));
  assert.deepEqual(values[0], { ...result, generation: runtime.guestGeneration });
  assert.equal(boots, 1);
  assert.equal(runtime.lifecycle.phase, 'idle');
});

test('a stop separates pending ensures, including a new coalesced run after stop', async () => {
  const runtime = runtimeFixture();
  const gate = deferred();
  const trace = [];
  runtime._ensureInner = async () => {
    const run = 1 + trace.filter((item) => item === 'boot').length;
    trace.push('boot');
    if (run === 1) await gate.promise;
    return run;
  };
  runtime._stopInner = async () => { trace.push('stop'); return true; };
  const before = runtime.ensure();
  const stop = runtime.stop();
  const after = runtime.ensure();
  assert.notEqual(before, after);
  assert.equal(after, runtime.ensure());
  gate.resolve();
  assert.deepEqual(await Promise.all([before, stop, after]), [1, true, 2]);
  assert.deepEqual(trace, ['boot', 'stop', 'boot']);
});

test('repanel is one stop -> setting -> boot transition; ordinary ensures wait', async (t) => {
  const runtime = runtimeFixture();
  const stopped = deferred();
  const trace = [];
  let landscape = false;
  t.mock.method(store, 'saveSettings', ({ display }) => {
    landscape = display.landscape;
    trace.push('setting');
  });
  runtime._stopInner = async ({ graceful }) => {
    assert.equal(graceful, false);
    trace.push('stop');
    return stopped.promise;
  };
  runtime._ensureInner = async () => {
    trace.push(landscape ? 'landscape' : 'portrait');
    return { ok: true };
  };
  const change = runtime.repanel(true);
  const open = runtime.ensure();
  await Promise.resolve();
  assert.deepEqual(trace, ['stop']);
  assert.equal(landscape, false);
  stopped.resolve(true);
  await Promise.all([change, open]);
  assert.deepEqual(trace, ['stop', 'setting', 'landscape', 'landscape']);
});

test('unconfirmed shutdown never publishes a new panel or boots another guest', async (t) => {
  const runtime = runtimeFixture();
  const settings = t.mock.method(store, 'saveSettings', () => {});
  const boot = t.mock.method(runtime, '_ensureInner', async () => ({ ok: true }));
  runtime._stopInner = async () => false;
  const failure = await runtime.repanel(true);
  assert.equal(failure.ok, false);
  assert.equal(failure.reason, 'stop-failed');
  assert.equal(settings.mock.callCount(), 0);
  assert.equal(boot.mock.callCount(), 0);
  assert.equal((await runtime.ensure()).ok, true);
});

test('QEMU fallback only releases the slot after its own child exit event', async () => {
  const runtime = runtimeFixture();
  const signalled = deferred();
  const child = new EventEmitter();
  child.exitCode = null;
  child.signalCode = null;
  child.killed = false;
  child.kill = () => { child.killed = true; signalled.resolve(); return true; };
  runtime.vmProc = child;
  runtime.inspectEmulatorOwnership = async () => ({ state: 'absent' });
  let didBoot = false;
  runtime._ensureInner = async () => { didBoot = true; return { ok: true }; };
  const shutdown = runtime.stop({ graceful: false });
  const boot = runtime.ensure();
  await signalled.promise;
  assert.equal(runtime.lifecycle.phase, 'stopping');
  assert.equal(runtime.vmProc, child);
  assert.equal(didBoot, false);
  child.emit('exit', 0);
  assert.equal(await shutdown, true);
  assert.equal((await boot).ok, true);
  assert.equal(runtime.vmProc, null);
});

test('failed restart does not block the next individual launch', async () => {
  const runtime = runtimeFixture();
  let attempts = 0;
  runtime._stopInner = async () => true;
  runtime._ensureInner = async () => {
    if (++attempts === 1) throw new Error('boot unavailable');
    return { ok: true };
  };
  const result = runtime.restart();
  const next = runtime.ensure();
  await assert.rejects(result, /boot unavailable/);
  assert.equal((await next).ok, true);
  assert.equal(runtime.lifecycle.phase, 'idle');
});

test('failed Wi-Fi recovery never initiates a restart or data reset', async () => {
  const runtime = runtimeFixture();
  const trace = [];
  runtime._networkEndpoint = async () => ({ client: {}, revalidate: async () => true });
  runtime._lifecycle = { restart: async () => assert.fail('must not restart the active session') };
  runtime.adbPath = () => 'fixture-adb';
  runtime.waitForNetwork = async () => { trace.push('network'); return { ok: false, reason: 'wifi-not-connected' }; };
  runtime._resetAndroidData = async () => assert.fail('must not reset data');
  const result = await runtime.repairNetwork();
  assert.equal(result.ok, false);
  assert.equal(result.wiped, false);
  assert.match(result.error, /没有重启运行时或清除安卓数据/);
  assert.deepEqual(trace, ['network']);
});

test('installed app launch rechecks network instead of trusting a cached radio address', async () => {
  const runtime = runtimeFixture();
  const guest = { identity: { pid: 1000, generation: 'current' }, client: {}, revalidate: async () => true };
  runtime._networkEndpoint = async () => guest;
  runtime._lastNetwork = { ok: true, ip: '10.0.2.15', at: Date.now(), ownerKey: '1000:current' };
  let clock = 0;
  let repairs = 0;
  const probes = [];
  runtime.checkNetwork = async ({ guest: pinned, verifyInternet }) => {
    assert.equal(pinned, guest);
    probes.push(verifyInternet);
    return repairs ? { ok: true, ip: '10.0.2.16', reachable: true } : { ok: false, reason: 'no-default-network' };
  };
  runtime.repairWifi = async ({ guest: pinned, canContinue }) => {
    assert.equal(pinned, guest);
    assert.equal(canContinue(), true);
    repairs++;
    return true;
  };
  assert.deepEqual(await runtime.waitForNetwork({ now: () => clock, pause: async (ms) => { clock += ms; } }),
    { ok: true, ip: '10.0.2.16', reachable: true });
  assert.equal(repairs, 1);
  assert.deepEqual(probes, [false, false, true]);
});

test('the launch budget cancels late Wifi writes and never reports a reconnect request as internet', async () => {
  const runtime = runtimeFixture();
  runtime._networkEndpoint = async () => ({ client: {}, revalidate: async () => true });
  runtime.checkNetwork = async () => ({ ok: false, reason: 'no-default-network' });
  let mutationCheck;
  runtime.repairWifi = ({ canContinue }) => {
    mutationCheck = canContinue;
    return new Promise(() => {}); // Slow stock emulator control command.
  };
  const result = await runtime.waitForNetwork({ timeoutMs: 40, pause: async () => {} });
  assert.deepEqual(result, { ok: false, reason: 'no-default-network' });
  assert.equal(mutationCheck(), false);
});

test('network cache only belongs to the exact guest and expires to unknown', () => {
  const runtime = runtimeFixture();
  const first = { identity: { pid: 1000, generation: 'a' } };
  const replacement = { identity: { pid: 1000, generation: 'b' } };
  runtime._lastNetwork = { ok: true, ip: '10.0.2.16', at: Date.now(), ownerKey: '1000:a' };
  assert.equal(runtime._networkSnapshot(first).ok, true);
  assert.equal(runtime._networkSnapshot(replacement).ok, false);
  runtime._lastNetwork.at -= 15001;
  assert.deepEqual(runtime._networkSnapshot(first), { ok: false, reason: 'unknown' });
});

test('confirmed stop retires its lease and discards already pending network probes', async () => {
  const runtime = runtimeFixture();
  const inFlight = deferred();
  const entered = deferred();
  runtime._ensureInner = async () => ({ ok: true, client: {} });
  runtime.adbPath = () => 'fixture-adb';
  runtime._networkEndpoint = async () => ({ client: {}, revalidate: async () => true });
  runtime.inspectEmulatorOwnership = async () => ({ state: 'absent' });
  runtime.emulator.checkNetwork = async () => { entered.resolve(); return inFlight.promise; };
  const old = await runtime.ensure();
  runtime._probeNetworkInBackground();
  const net = runtime.waitForNetwork();
  await entered.promise;
  await Promise.resolve();
  assert.equal(await runtime.stop(), true);
  assert.notEqual(runtime.guestGeneration, old.generation);
  inFlight.resolve({ ok: true, ip: '192.0.2.1' });
  assert.deepEqual(await net, { ok: false, reason: 'guest-changed' });
  assert.equal(runtime._lastNetwork, null);
  assert.equal((await runtime.ensure()).generation, runtime.guestGeneration);
});

test('image selection keeps an existing data-bearing AVD, and a forced change preserves its files', async (t) => {
  const avdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-image-'));
  t.after(() => fs.rmSync(avdHome, { recursive: true, force: true }));
  const emu = Object.create(EmulatorEngine.prototype);
  const base = { ok: true, api: 30, tag: 'default', dir: 'F:/runtime/system-images/android-30/default/x86_64', abi: 'x86_64' };
  const play = { ok: true, api: 34, tag: 'google_apis_playstore', dir: 'F:/runtime/system-images/android-34/google_apis_playstore/x86_64', abi: 'x86_64' };
  emu.provisioner = {
    paths: () => ({ avdHome }),
    ensureDirs: () => ({ avdHome }),
    playImageInfo: () => play,
    systemImageInfo: ({ imageId } = {}) => imageId ? base : play,
  };
  Object.defineProperty(emu, 'settings', { value: { engine: {} } });
  const dir = path.join(avdHome, 'apkstart.avd');
  fs.mkdirSync(dir);
  const config = path.join(dir, 'config.ini');
  const pointer = path.join(avdHome, 'apkstart.ini');
  const userData = path.join(dir, 'userdata-qemu.img.qcow2');
  fs.writeFileSync(config, `tag.id=default
image.sysdir.1=${base.dir}/
`);
  fs.writeFileSync(pointer, 'keep metadata');
  fs.writeFileSync(userData, 'keep apps');
  const original = fs.readFileSync(config);
  assert.equal(emu.imageChoice().dir, base.dir);
  assert.equal(emu.canUseCompatImage(), false);
  const runtime = runtimeFixture();
  runtime.emulator = emu;
  runtime._stopInner = async () => assert.fail('must not stop a retained image');
  const blocked = await runtime.useCompatImage();
  assert.equal(blocked.code, 'APP_COMPAT_REQUIRED');

  t.mock.method(emu.provisioner, 'systemImageInfo', () => ({ ok: false }));
  assert.throws(() => emu.ensureAvd(), { code: 'AVD_IMAGE_CHANGE_REQUIRES_RESET' });
  assert.deepEqual(fs.readFileSync(config), original);
  assert.equal(fs.readFileSync(pointer, 'utf8'), 'keep metadata');
  assert.equal(fs.readFileSync(userData, 'utf8'), 'keep apps');

  fs.unlinkSync(userData); // Simulate a separately confirmed reset on the disposable fixture.
  assert.equal(emu.canUseCompatImage(), true);
  assert.equal(emu.imageChoice().dir, play.dir);
});

test('explicit reset and positive resize use exclusive VM slots', async (t) => {
  const runtime = runtimeFixture();
  const gate = deferred();
  const trace = [];
  t.mock.method(store, 'saveSettings', () => trace.push('settings'));
  runtime.avdOwner = () => ({ state: 'live' });
  runtime._resetAndroidData = async () => { trace.push('reset'); await gate.promise; return { ok: true }; };
  runtime._stopInner = async () => { trace.push('stop'); return true; };
  runtime.emulator.resizeDataPartition = () => { trace.push('resize'); return { ok: true }; };
  runtime.emulator.dataInfo = () => ({ actualGB: 4 });
  runtime._ensureInner = async () => { trace.push('boot'); return { ok: true }; };
  const reset = runtime.resetAndroidData({ dataPartitionGB: 4 });
  const resize = runtime.resizeDataPartition(4096);
  const boot = runtime.ensure();
  await Promise.resolve();
  assert.deepEqual(trace, ['reset']);
  gate.resolve();
  await reset;
  assert.deepEqual(await resize, { ok: true, stopped: true, actualGB: 4 });
  assert.equal((await boot).ok, true);
  assert.deepEqual(trace, ['reset', 'settings', 'stop', 'resize', 'settings', 'boot']);
});

test('a failed physical resize does not publish new settings, and an ambiguous AVD is untouched', async (t) => {
  const runtime = runtimeFixture();
  const write = t.mock.method(store, 'saveSettings', () => {});
  runtime.avdOwner = () => ({ state: 'absent' });
  runtime.emulator.resizeDataPartition = () => ({ ok: false, error: 'disk full' });
  runtime.emulator.dataInfo = () => ({ ok: true, actualGB: 4 });
  const result = await runtime.resizeDataPartition(8192);
  assert.equal(result.ok, false);
  assert.equal(result.actualGB, 4);
  assert.equal(write.mock.callCount(), 0);
  runtime.provisioner = { paths: () => ({ avdDirConflict: { current: 'old', requested: 'new' } }) };
  runtime._resetAndroidData = async () => assert.fail('cannot reset an ambiguous AVD');
  assert.equal((await runtime.resetAndroidData()).code, 'AVD_DIR_CONFLICT');
  assert.equal((await runtime.resizeDataPartition(8192)).code, 'AVD_DIR_CONFLICT');
});

test('compatibility restart refuses an unsafe change before stop, otherwise invalidates before boot', async () => {
  const runtime = runtimeFixture();
  const trace = [];
  let blocked = true;
  runtime.compatImageChangeError = () => blocked ? 'existing guest data' : '';
  runtime._stopInner = async () => { trace.push('stop'); return true; };
  runtime.emulator.invalidateSnapshot = () => trace.push('invalidate');
  runtime._ensureInner = async () => { trace.push('boot'); return { ok: true }; };
  const denied = await runtime.useCompatImage();
  assert.equal(denied.code, 'APP_COMPAT_REQUIRED');
  assert.deepEqual(trace, []);
  blocked = false;
  assert.equal((await runtime.useCompatImage()).ok, true);
  assert.deepEqual(trace, ['stop', 'invalidate', 'boot']);
});

test('idle shutdown distinguishes a missing activity probe from a verified empty result', async () => {
  const runtime = runtimeFixture();
  const client = new AdbClient({ adbPath: 'injected', serial: 'fixture' });
  runtime.lastActivity = 0;
  runtime._networkEndpoint = async () => ({ client, revalidate: async () => true });
  let stops = 0;
  runtime._stopInner = async () => { stops++; return true; };
  client.shell = async () => { throw new Error('ADB disconnected'); };
  assert.equal(await runtime._stopIfIdle(1), false);
  client.shell = async () => 'device not found';
  assert.equal(await runtime._stopIfIdle(1), false);
  assert.equal(stops, 0);

  client.shell = async () => 'ACTIVITY MANAGER ACTIVITIES (dumpsys activity activities)\nmResumedActivity: null';
  assert.equal(await runtime._stopIfIdle(1), true);
  assert.equal(stops, 1);
});

test('a session opened after an idle probe cancels queued idle shutdown', async () => {
  const runtime = runtimeFixture();
  const gate = deferred();
  const probed = deferred();
  const block = runtime.lifecycle.maintain(() => gate.promise);
  runtime.lastActivity = 0;
  runtime.sessionActivity = { isIdle: true };
  runtime.client = () => ({ runningPackages: async ({ strict }) => {
    assert.equal(strict, true);
    probed.resolve();
    return [];
  } });
  runtime._networkEndpoint = async () => ({ client: runtime.client(), revalidate: async () => true });
  runtime._stopInner = async () => assert.fail('must not stop a newly requested session');
  const shutdown = runtime._stopIfIdle(1);
  await probed.promise;
  await Promise.resolve();
  runtime.sessionActivity.isIdle = false;
  gate.resolve();
  await block;
  assert.equal(await shutdown, false);
});

test('watchdog scales tablet density from the running panel and never writes across a stale lease', async () => {
  const runtime = runtimeFixture();
  runtime.emulator.running = () => true;
  Object.defineProperty(runtime, 'settings', { value: { display: { landscape: false, tabletMode: true } } });
  let alive = true;
  let retireOnProbe = false;
  const commands = [];
  const client = { async shell(cmd) {
    commands.push(cmd);
    if (cmd === 'dumpsys window displays') {
      if (retireOnProbe) alive = false;
      return 'init=1080x1920 cur=1080x1920';
    }
    return 'Override density: 190';
  } };
  runtime._emulatorGuest = async () => ({ client, revalidate: async () => alive });
  runtime.log = () => {};
  await runtime._healOrientation();
  assert.deepEqual(commands, ['dumpsys window displays', 'wm density', 'wm density 285']);
  retireOnProbe = true;
  commands.length = 0;
  await runtime._healOrientation();
  assert.deepEqual(commands, ['dumpsys window displays']);
});
