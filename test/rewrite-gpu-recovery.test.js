'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { mock, test } = require('node:test');
const doctor = require('../src/core/doctor');
const store = require('../src/core/store');
const { planGpuRecovery } = doctor;

const version = '37.4.1.0';
const badGpu = `${version}|host`;
const applied = `args|${version}`;
let spawnFixture;
const spawnMock = mock.method(childProcess, 'spawn', (...args) => spawnFixture(...args));
const { EmulatorEngine } = require('../src/core/emulator');
spawnMock.mock.restore();

function fixture(t, { mode = 'auto', marker = version, failed = badGpu, withoutPid = false, hostVulkan, keepSnapshot = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-gpu-recovery-'));
  const previousDir = store.DATA_DIR;
  store.DATA_DIR = dir;
  t.after(() => {
    store.DATA_DIR = previousDir;
    const logs = path.join(dir, 'logs');
    fs.rmSync(path.join(logs, 'emulator.log'), { force: true });
    if (fs.existsSync(logs)) fs.rmdirSync(logs);
    fs.rmdirSync(dir);
  });
  const engine = { gpuMode: mode, badGpu: failed, badGpuVulkanTried: marker, hostVulkan, keepSnapshot };
  const saves = [];
  t.mock.method(store, 'getSettings', () => ({ engine }));
  t.mock.method(store, 'saveSettings', (patch) => { saves.push(patch.engine); Object.assign(engine, patch.engine); });
  t.mock.method(doctor, 'detectGpuVendor', () => 'nvidia');
  t.mock.method(doctor, 'freeDiskMB', () => 50000);
  t.mock.method(doctor, 'freePortPair', async (port) => port);
  t.mock.method(doctor, 'autoProfile', () => ({
    gpu: mode === 'auto' ? 'host' : mode,
    gpuCandidates: ['host', 'swangle', 'software', 'swiftshader'],
    accel: 'auto', bootTimeoutMs: 100, dataMB: 4096,
  }));
  t.mock.method(doctor, 'planGpuRecovery', (variants, options) => planGpuRecovery(variants, { ...options, platform: 'win32' }));

  const emu = new EmulatorEngine(dir, { provisioner: {
    systemImageInfo: () => ({ ok: true }), paths: () => ({ avdHome: dir }),
    emulatorAccel: async () => ({ ok: true }), emulatorVersion: async () => ({ version }),
  } });
  emu.locate = () => ({ root: dir, emulatorExe: path.join(dir, 'mock-emulator.exe') });
  emu.imageChoice = () => ({ compat: false });
  emu._assertAvdWritable = () => {};
  emu._resolveDrivers = () => ({ applied: [], errors: [] });
  emu.ensureAvd = () => ({ wipePending: false });
  emu.hasSnapshot = () => keepSnapshot;
  emu.ensureAdbServer = async () => true;
  emu._waitSpawnSettled = async () => !emu.proc.pid;
  emu.killAttempt = async () => { emu.proc = null; return true; };
  emu.env = () => ({});

  const spawns = [];
  const argvs = [];
  const logs = [];
  spawnFixture = (_file, args) => {
    argvs.push(args);
    const gpu = args[args.indexOf('-gpu') + 1];
    const noVulkan = args.some((arg, i) => arg === '-feature' && args[i + 1] === '-Vulkan');
    spawns.push({ gpu, noVulkan });
    const proc = new EventEmitter();
    proc.pid = withoutPid && gpu === 'host' ? undefined : 12345;
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.unref = () => {};
    return proc;
  };
  return { emu, engine, saves, spawns, argvs, logs, start: (probe = () => 'ok') => emu.start({
    onLog: (line) => logs.push(line), probe,
  }) };
}

test('NVIDIA recovery sends the actual host flag; verified boot keeps it for this SDK version', async (t) => {
  const f = fixture(t, { keepSnapshot: true });
  assert.equal((await f.start()).ok, true);
  assert.deepEqual(f.spawns, [{ gpu: 'host', noVulkan: true }]);
  assert.deepEqual(f.saves, [{ badGpuVulkanTried: applied }, { badGpu: '' }]);
  assert.equal(f.logs.filter((line) => line.includes('已用 -gpu host -feature -Vulkan')).length, 1);
  assert.match(fs.readFileSync(path.join(store.DATA_DIR, 'logs', 'emulator.log'), 'utf8'), /-gpu host -feature -Vulkan/);
  assert.ok(f.argvs[0].includes('-no-snapshot-load'));
  assert.ok(!f.argvs[0].includes('-wipe-data'));

  f.emu.proc = null;
  assert.equal((await f.start()).ok, true);
  assert.deepEqual(f.spawns[1], { gpu: 'host', noVulkan: true });
  assert.ok(!f.argvs[1].includes('-no-snapshot-load'));
  assert.equal(f.saves.length, 2);
});

test('failed host recovery keeps the working accelerated software backend first on next launch', async (t) => {
  const f = fixture(t);
  assert.equal((await f.start(() => f.spawns.at(-1).gpu === 'host' ? 'fatal' : 'ok')).ok, true);
  assert.deepEqual(f.spawns, [{ gpu: 'host', noVulkan: true }, { gpu: 'swangle', noVulkan: false }]);
  assert.equal(f.engine.badGpu, badGpu);
  assert.equal(f.engine.badGpuVulkanTried, applied);

  f.emu.proc = null;
  assert.equal((await f.start()).ok, true);
  assert.deepEqual(f.spawns.slice(2), [{ gpu: 'swangle', noVulkan: false }]);
  assert.equal(f.logs.filter((line) => line.includes('已用 -gpu host -feature -Vulkan')).length, 1);
});

test('software selection does not consume the host retry', async (t) => {
  const software = fixture(t, { mode: 'swangle' });
  assert.equal((await software.start()).ok, true);
  assert.deepEqual(software.spawns, [{ gpu: 'swangle', noVulkan: false }]);
  assert.deepEqual(software.saves, []);
});

test('failure to create the host process does not consume the retry', async (t) => {
  const spawned = fixture(t, { withoutPid: true });
  assert.equal((await spawned.start()).ok, true);
  assert.deepEqual(spawned.spawns, [{ gpu: 'host', noVulkan: true }, { gpu: 'swangle', noVulkan: false }]);
  assert.equal(spawned.engine.badGpuVulkanTried, version);
  assert.ok(!spawned.logs.some((line) => line.includes('已用 -gpu host -feature -Vulkan')));
});

test('a different emulator version and unmarked configurations keep their default flags', () => {
  const variants = [{ gpu: 'host', label: 'host' }, { gpu: 'swangle', label: 'software' }];
  assert.deepEqual(planGpuRecovery(variants, { engine: {}, emulatorVersion: version, platform: 'win32' }), variants);
  assert.deepEqual(planGpuRecovery(variants, {
    engine: { badGpu, badGpuVulkanTried: applied }, emulatorVersion: '38.0.0.0', platform: 'win32',
  }), variants);
});

test('explicit Windows host Vulkan setting needs no failure or retry history', async (t) => {
  const f = fixture(t, { mode: 'host', hostVulkan: false, marker: '', failed: '' });
  f.emu._driverEffect = { args: [{ flag: '-feature', value: 'Vulkan,GLDirectMem' }] };
  assert.equal((await f.start()).ok, true);
  assert.deepEqual(f.spawns, [{ gpu: 'host', noVulkan: true }]);
  assert.deepEqual(f.argvs[0].flatMap((arg, i) => arg === '-feature' ? [f.argvs[0][i + 1]] : []), ['-Vulkan', 'GLDirectMem']);
  assert.deepEqual(f.saves, []);

  const variants = [{ gpu: 'host', label: 'host' }, { gpu: 'swangle', label: 'software' }];
  assert.deepEqual(planGpuRecovery(variants.slice(1), {
    engine: { hostVulkan: false }, emulatorVersion: version, platform: 'win32',
  }), variants.slice(1));
  assert.deepEqual(planGpuRecovery(variants, {
    engine: { hostVulkan: false }, emulatorVersion: version, platform: 'linux',
  }), variants);
});
