'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const Module = require('node:module');
const { test } = require('node:test');
const layers = require('../src/core/layers');

function write(filename, contents = 'fixture') {
  fs.mkdirSync(path.dirname(filename), { recursive: true });
  fs.writeFileSync(filename, contents);
  return filename;
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'apkstart-storage-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dataDir = path.join(home, 'profile');
  const runtimeDir = path.join(dataDir, 'runtime');
  const preferences = { runtime: { dir: runtimeDir }, engine: {} };
  const options = [];
  const disk = { free: 10000 };
  const filename = require.resolve('../src/core/provision');
  const module = { exports: {} };
  const requireReal = Module.createRequire(filename);
  // Stub only this module's transport and ZIP size; the disk changes under test use real scratch files.
  const requireFixture = (part) => {
    if (part === './store') return { DATA_DIR: dataDir, getSettings: () => preferences };
    if (part === './doctor') return { ...requireReal(part), freeDiskMB: () => disk.free };
    if (part === './download') {
      const download = async (urls, dest, opt) => { options.push({ urls, opt }); write(dest); };
      return { ...requireReal(part), downloadMulti: download, downloadAnyParallel: download };
    }
    if (part === 'fs') {
      return { ...fs, statSync(file, opt) {
        const stat = fs.statSync(file, opt);
        return stat && /^(runtime-pack|play-sysimg)\.zip$/.test(path.basename(file))
          ? { size: 500 * 1048576 } : stat;
      } };
    }
    return requireReal(part);
  };
  const call = vm.runInThisContext(Module.wrap(fs.readFileSync(filename, 'utf8')), { filename });
  call(module.exports, requireFixture, module, filename, path.dirname(filename));
  const provision = new module.exports.Provisioner(home);
  provision.invalidateEnvCache = () => {};
  return { home, dataDir, runtimeDir, preferences, provision, options, disk };
}

test('a selected AVD path works in the default layout without making prior apps vanish', (t) => {
  const { home, runtimeDir, preferences, provision } = fixture(t);
  const legacy = path.join(runtimeDir, 'avd');
  const chosen = path.join(home, 'data-on-second-volume');
  assert.equal(provision.paths().avdHome, legacy);
  preferences.runtime.avdDir = chosen;
  assert.equal(provision.paths().avdHome, chosen);
  write(path.join(legacy, 'apkstart.avd', 'userdata-qemu.img.qcow2'), 'legacy-preserved');
  assert.deepEqual(provision.paths().avdDirConflict, { current: legacy, requested: chosen });
  assert.equal(provision.paths().avdHome, legacy);
  write(path.join(chosen, 'apkstart.avd', 'userdata-qemu.img.qcow2'), 'migrated-data');
  assert.equal(provision.paths().avdHome, legacy, 'partial migration does not replace the old active path');
  write(path.join(chosen, 'apkstart.avd', 'config.ini'));
  assert.equal(provision.paths().avdHome, chosen);
  assert.equal(provision.paths().avdDirConflict, null);
  assert.equal(fs.readFileSync(path.join(legacy, 'apkstart.avd', 'userdata-qemu.img.qcow2'), 'utf8'), 'legacy-preserved');
});

test('a sibling of the data directory is not treated as the default runtime tree', (t) => {
  const { dataDir, preferences, provision } = fixture(t);
  preferences.runtime.dir = dataDir + '-other';
  assert.equal(provision.paths().avdHome, path.join(dataDir, 'avd'));
});

test('provisioning cannot treat a full or unreadable target volume as sufficient space', async (t) => {
  const { provision, runtimeDir, disk } = fixture(t);
  disk.free = 0;
  await assert.rejects(provision.guardDisk('runtime', runtimeDir), /无法确认/);
  disk.free = 512;
  await assert.rejects(provision.guardDisk('runtime', runtimeDir), /空间不足/);
  disk.free = 10000;
  assert.equal(await provision.guardDisk('runtime', runtimeDir), 10000);
});

test('split-layout cleanup only deletes explicitly requested installed AVD snapshots', (t) => {
  const { home, runtimeDir } = fixture(t);
  const avdHome = path.join(home, 'avd-on-second-volume');
  const activeAvd = path.join(avdHome, 'apkstart.avd');
  const activeData = write(path.join(activeAvd, 'userdata-qemu.img'), 'active');
  const oldData = write(path.join(avdHome, 'old.avd', 'userdata-qemu.img'), 'old-data');
  const oldImage = write(path.join(runtimeDir, 'system-images', 'android-30', 'system.img'), 'old-image');
  const newImage = write(path.join(runtimeDir, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'), 'new-image');
  const inFlight = write(path.join(runtimeDir, '_tmp', 'emulator.zip'), 'in-flight');
  const arbitrary = write(path.join(avdHome, 'do-not-scan', 'other-data'), 'unrelated');
  const pinned = write(path.join(runtimeDir, 'avd', 'apkstart.avd', 'snapshots', 'ram.bin'), 'different-avd');
  const fresh = write(path.join(activeAvd, 'snapshots', 'ram.bin'), 'delete-me');
  const options = { avdHome };
  const preview = layers.prune(runtimeDir, { ...options, keepSnapshots: true });
  assert.equal(preview.avdSize, fs.statSync(activeData).size + fs.statSync(fresh).size);
  assert.equal(preview.candidates.length, 0);
  const done = layers.prune(runtimeDir, { ...options, apply: true, keepSnapshots: false });
  assert.equal(done.removed.length, 1);
  assert.equal(done.failed.length, 0);
  assert.equal(fs.existsSync(fresh), false);
  for (const file of [activeData, oldData, oldImage, newImage, inFlight, arbitrary, pinned]) {
    assert.equal(fs.existsSync(file), true, file);
  }
});

test('a linked AVD cannot make snapshot cleanup delete another directory', (t) => {
  const { home, runtimeDir } = fixture(t);
  const avdHome = path.join(home, 'active');
  fs.mkdirSync(avdHome);
  const other = path.join(home, 'elsewhere');
  const proof = write(path.join(other, 'snapshots', 'ram.bin'), 'do-not-remove');
  fs.symlinkSync(other, path.join(avdHome, 'apkstart.avd'), 'junction');
  const report = layers.prune(runtimeDir, { avdHome, apply: true });
  assert.equal(report.failed.length, 1);
  assert.equal(report.removed.length, 0);
  assert.equal(report.saved, 0);
  assert.equal(fs.readFileSync(proof, 'utf8'), 'do-not-remove');
});

test('installing API 34 leaves the older referenced API 30 image untouched', async (t) => {
  const { runtimeDir, provision } = fixture(t);
  const p = provision.ensureDirs();
  const legacy = write(path.join(p.sysImgRoot, 'android-30', 'google_apis_playstore', 'x86_64', 'system.img'), 'legacy-image-data');
  write(path.join(p.avdHome, 'apkstart.avd', 'config.ini'), 'image.sysdir.1=' + path.dirname(legacy));
  let ready = false;
  provision.playImageInfo = () => ({ ok: ready, api: '34' });
  provision.resolvePlayUrl = async () => 'https://fixture.invalid/api34.zip';
  provision.extractZip = async (_zip, dest) => {
    assert.equal(dest, path.join(p.sysImgRoot, 'android-34', 'google_apis_playstore'));
    ready = true;
  };
  const result = await provision.installPlayImage();
  assert.equal(result.ok, true);
  assert.equal(fs.readFileSync(legacy, 'utf8'), 'legacy-image-data');
  assert.equal(fs.existsSync(runtimeDir), true);
});

test('runtime pack is not marked ready or discarded before verified expanded components', async (t) => {
  const { runtimeDir, provision, options } = fixture(t);
  const metadata = path.join(runtimeDir, '.runtime-pack.json');
  const zip = path.join(runtimeDir, '_tmp', 'runtime-pack.zip');
  const bytes = 500 * 1048576;
  const pack = { url: 'https://fixture.invalid/runtime.zip', name: 'runtime.zip', tag: '1.0.5', size: bytes };
  provision.resolveRuntimePack = async () => pack;
  provision.extractZip = async () => {};
  provision._downloadUrls = (url) => [url];
  provision.sources.rank = async (urls) => urls;
  provision.materializeImages = async () => { throw new Error('disk full'); };
  await assert.rejects(provision.installRuntimePack(), /disk full/);
  assert.equal(fs.existsSync(metadata), false);
  assert.equal(fs.existsSync(zip), true);
  provision.materializeImages = async () => 1;
  provision.checkEnv = async () => ({ adb: { ok: false }, emulator: { ok: true }, sysimg: { ok: true }, needsExtract: false });
  await assert.rejects(provision.installRuntimePack(), /未通过/);
  assert.equal(fs.existsSync(metadata), false);
  assert.equal(fs.existsSync(zip), true);
  provision.checkEnv = async () => ({ adb: { ok: true }, emulator: { ok: true }, sysimg: { ok: true }, needsExtract: false });
  assert.equal((await provision.installRuntimePack()).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(metadata, 'utf8')).tag, pack.tag);
  assert.equal(fs.existsSync(zip), false);
  assert(options.every((out) => out.opt.expectSize === bytes));
});
