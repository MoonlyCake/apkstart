'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { EmulatorEngine } = require('../src/core/emulator');
const { stageBootPublicKey } = require('../src/core/emulator-boot-data');
const userdata = require('../src/core/userdata');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-boot-data-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const home = path.join(dir, 'avds');
  const avdDir = path.join(home, 'apkstart.avd');
  const profile = path.join(dir, 'host');
  const hostKeys = path.join(profile, '.android');
  const emulatorExe = path.join(dir, 'emulator.exe');
  fs.mkdirSync(avdDir, { recursive: true });
  fs.mkdirSync(hostKeys, { recursive: true });
  fs.writeFileSync(emulatorExe, '');
  const emu = new EmulatorEngine(dir);
  emu.provisioner = { ensureDirs: () => ({ avdHome: home }), paths: () => ({ avdHome: home }) };
  emu.locate = () => ({ emulatorExe });
  Object.defineProperty(emu, 'settings', { value: { engine: {} } });
  return { emu, dir, home, avdDir, profile, hostKeys, base: path.join(avdDir, 'userdata-qemu.img') };
}

// Android's adb public-key format (2048-bit RSA record); fixtures are never used by ADB.
function token(fill) {
  const bytes = Buffer.alloc(524, fill);
  bytes.writeUInt32LE(64, 0);
  return bytes.toString('base64');
}

test('native initialization owns /data on fresh API 30 and API 34 with the stock data template', (t) => {
  const f = fixture(t);
  const staged = [];
  f.emu._stageBootPublicKey = (home) => { staged.push(home); return true; };
  f.emu.ensureDataPartition = () => assert.fail('stock emulator must be the first to create userdata');
  for (const api of [30, 34]) {
    const dir = path.join(f.dir, 'system-images', `android-${api}`, 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    f.emu.imageChoice = () => ({ api, dir, abi: 'x86_64', tag: 'google_apis_playstore', compat: true });
    const result = f.emu.ensureAvd({ dataMB: 4096 });
    assert.equal(result.data.deferred, true);
    assert.match(fs.readFileSync(path.join(f.avdDir, 'config.ini'), 'utf8'), /disk\.dataPartition\.size=4096M/);
    assert.equal(fs.existsSync(f.base), false);
  }
  assert.deepEqual(staged, [f.home, f.home]);
});

test('old templates keep the existing preformat path without staging a public key', (t) => {
  const f = fixture(t);
  const dir = path.join(f.dir, 'legacy-image');
  fs.mkdirSync(dir);
  let staged = 0;
  f.emu._stageBootPublicKey = () => { staged += 1; return true; };
  const seen = [];
  f.emu.ensureDataPartition = (...args) => { seen.push(args); return { ok: true }; };
  f.emu._prepareBootData(f.avdDir, f.home, dir, 4096);
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data', 'empty_data_disk'), '');
  f.emu._prepareBootData(f.avdDir, f.home, dir, 4096);
  assert.deepEqual(seen, [[f.avdDir, 4096], [f.avdDir, 4096]]);
  assert.equal(staged, 0);
});

test('only the matching normal host public token enters emulator home, never the private key', (t) => {
  const f = fixture(t);
  const key = path.join(f.hostKeys, 'adbkey');
  const known = token(1);
  fs.writeFileSync(key, 'private fixture');
  fs.writeFileSync(`${key}.pub`, `${known} local user@desktop\r\n`);
  const options = {
    hostHome: f.profile,
    publicFromPrivate(adbPath, file) {
      assert.equal(adbPath, 'selected-adb');
      assert.equal(file, key);
      return known;
    },
  };
  assert.equal(stageBootPublicKey(f.home, 'selected-adb', options), true);
  assert.equal(stageBootPublicKey(f.home, 'selected-adb', options), true);
  assert.equal(fs.readFileSync(path.join(f.home, 'adbkey.pub'), 'utf8'), `${known} apkstart-host\n`);
  assert.equal(fs.existsSync(path.join(f.home, 'adbkey')), false);
  assert.equal(fs.readFileSync(`${key}.pub`, 'utf8'), `${known} local user@desktop\r\n`);
});

test('a mismatched or multi-line public key is not staged, and a conflicting staged file is not replaced', (t) => {
  const f = fixture(t);
  const key = path.join(f.hostKeys, 'adbkey');
  const dest = path.join(f.home, 'adbkey.pub');
  const known = token(1);
  const other = token(2);
  const options = { hostHome: f.profile, publicFromPrivate: () => known };
  fs.writeFileSync(key, 'private fixture');
  for (const invalid of [`${known} first\n${other} extra\n`, `${other} stale\n`, 'not an adb public key']) {
    fs.writeFileSync(`${key}.pub`, invalid);
    assert.equal(stageBootPublicKey(f.home, 'selected-adb', options), false);
    assert.equal(fs.existsSync(dest), false);
  }
  fs.writeFileSync(`${key}.pub`, `${known} legitimate\n`);
  fs.writeFileSync(dest, `${other} original\n`);
  assert.equal(stageBootPublicKey(f.home, 'selected-adb', options), false);
  assert.equal(fs.readFileSync(dest, 'utf8'), `${other} original\n`);
});

test('existing overlay or unrecognized data is never rekeyed, overwritten or reformatted', (t) => {
  const f = fixture(t);
  let staged = 0;
  f.emu._stageBootPublicKey = () => { staged += 1; return true; };
  f.emu._qemuImg = () => assert.fail('existing data must not be rebuilt');
  const overlay = `${f.base}.qcow2`;
  fs.writeFileSync(overlay, 'existing overlay');
  assert.equal(f.emu._prepareBootData(f.avdDir, f.home, f.dir, 4096).reason, 'existing-userdata');
  assert.equal(fs.existsSync(f.base), false);
  fs.writeFileSync(f.base, 'unrecognized existing disk');
  assert.equal(f.emu._prepareBootData(f.avdDir, f.home, f.dir, 4096).reason, 'existing-userdata');
  assert.equal(fs.readFileSync(f.base, 'utf8'), 'unrecognized existing disk');
  assert.equal(staged, 0);
  assert.equal(fs.readFileSync(overlay, 'utf8'), 'existing overlay');
  fs.unlinkSync(overlay);
  assert.equal(f.emu._prepareBootData(f.avdDir, f.home, f.dir, 4096).reason, 'existing-userdata');
  assert.equal(fs.readFileSync(f.base, 'utf8'), 'unrecognized existing disk');
});

test('existing bare ext4 retains in-place growth and does not stage keys', (t) => {
  const f = fixture(t);
  fs.writeFileSync(f.base, userdata.buildEmptyExt4({ sizeMB: 64, encrypt: true }));
  const calls = [];
  f.emu._stageBootPublicKey = () => assert.fail('existing bare ext4 must not be reseeded');
  const stat = fs.statSync;
  let logicalSize = 64 * 1024 ** 2;
  t.mock.method(fs, 'statSync', (file, ...args) => {
    const actual = stat(file, ...args);
    return file === f.base ? { ...actual, size: logicalSize } : actual;
  });
  f.emu._qemuImg = (...args) => { calls.push(args); logicalSize = args[2]; };
  f.emu._resize2fs = (img) => {
    calls.push(['resize2fs', img]);
    // Simulate the on-disk ext4 size change without allocating a 1 GiB file.
    const count = Buffer.alloc(4);
    count.writeUInt32LE(logicalSize / userdata.BLOCK);
    const fd = fs.openSync(img, 'r+');
    try { fs.writeSync(fd, count, 0, 4, 1024 + 0x04); } finally { fs.closeSync(fd); }
  };
  const result = f.emu._prepareBootData(f.avdDir, f.home, f.dir, 1024);
  assert.equal(result.created, false);
  assert.equal(result.grown, true);
  assert.deepEqual(calls, [['resize', f.base, 1024 ** 3], ['resize2fs', f.base]]);
  assert.equal(userdata.hasExt4Superblock(f.base), true);
});
