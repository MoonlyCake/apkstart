'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { EmulatorEngine } = require('../src/core/emulator');
const doctor = require('../src/core/doctor');
const preflight = require('../src/core/preflight');

function diskFixture(t, { encrypted = true } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-outcome-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dir = path.join(home, 'apkstart.avd');
  fs.mkdirSync(dir);
  const raw = path.join(dir, 'userdata-qemu.img');
  const head = Buffer.alloc(2048);
  head.writeUInt16LE(0xef53, 1024 + 0x38);
  head.writeUInt32LE(2, 1024 + 0x04);
  head.writeUInt32LE(encrypted ? 0x10002 : 2, 1024 + 0x60);
  fs.writeFileSync(raw, head);
  const exe = path.join(home, 'emulator-fixture');
  fs.writeFileSync(exe, '');
  const engine = Object.create(EmulatorEngine.prototype);
  engine.locate = () => ({ emulatorExe: exe });
  engine.log = () => {};
  engine._assertAvdWritable = () => {};
  engine.provisioner = { paths: () => ({ avdHome: home }) };
  const flags = () => fs.readFileSync(raw).readUInt32LE(1024 + 0x60);
  return { engine, dir, flags };
}

test('failed filesystem tool leaves the original ext4 encryption bit intact', (t) => {
  const { engine, dir, flags } = diskFixture(t);
  engine._qemuImg = () => {};
  engine._resize2fs = () => {
    assert.equal(flags(), 2, 'old resize tool receives original flags without ENCRYPT');
    throw new Error('ENOSPC');
  };
  const result = engine.ensureDataPartition(dir, 1024);
  assert.equal(result.ok, false);
  assert.equal(flags(), 0x10002);
  assert.match(result.error, /ENOSPC/);
});

test('resize does not claim success if tools return without growing the filesystem', (t) => {
  const { engine, dir, flags } = diskFixture(t, { encrypted: false });
  engine._qemuImg = () => {};
  engine._resize2fs = () => {};
  assert.equal(engine.ensureDataPartition(dir, 1024).ok, false);
  assert.equal(flags(), 2, 'preserve an originally unencrypted filesystem');
  engine.ensureDataPartition = () => ({ ok: true, grown: true });
  assert.equal(engine.resizeDataPartition(1024).ok, false, 'fresh size verification cannot be overwritten by the tool result');
});

test('manual CPU cores still apply with automatic memory enabled', () => {
  const overrides = doctor.overridesFromSettings({ autoMemory: true, memoryMB: 4096, cores: 6 });
  assert.equal(overrides.memoryMB, 0);
  assert.equal(overrides.cores, 6);
});

test('an actual successful WHPX probe outweighs a stale feature observation', () => {
  const hw = {
    platform: 'win32', arch: 'x64', osBuild: 22631,
    cpu: { cores: 8, threads: 16, vtSupported: true, vtFirmware: true, slat: true },
    memory: { totalMB: 32768, freeMB: 8192 },
    gpu: { vendor: 'intel', vramMB: 1024 },
    virtualization: { hypervisorPlatform: '2', accelOk: true, accelKind: 'whpx' },
  };
  const { items } = preflight.evaluate({ hw });
  assert.ok(items.some((item) => item.key === 'whpx-ok'));
  assert.ok(!items.some((item) => item.key === 'whpx-off'));
});
