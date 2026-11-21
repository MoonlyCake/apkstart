'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const test = require('node:test');
const { Installer, parseBundle } = require('../src/core/installer');
const store = require('../src/core/store');
const { ZipFile } = require('../src/core/zip');
const { buildApkBytes, buildStoredZip } = require('./lib/make-apk');

const base = buildApkBytes();
const split = Buffer.from(base);
// Keep the synthetic binary manifest's UTF-16 string length unchanged.
Buffer.from('SplitAp', 'utf16le').copy(split, split.indexOf(Buffer.from('TestApp', 'utf16le')));

function fixture(t, entries = [{ name: 'base.apk', data: base }]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-phase2-bundle-'));
  const temp = path.join(root, 'stage');
  fs.mkdirSync(temp);
  t.mock.method(os, 'tmpdir', () => temp);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const file = path.join(root, 'app.xapk');
  const archive = buildStoredZip(entries);
  let central = archive.readUInt32LE(archive.length - 22 + 16);
  for (const entry of entries) {
    // buildStoredZip creates method-0 entries; mark a pre-deflated payload as method 8.
    const local = archive.readUInt32LE(central + 42);
    if (entry.deflated) {
      archive.writeUInt16LE(8, local + 8);
      archive.writeUInt16LE(8, central + 10);
    }
    if (entry.declaredSize !== undefined) {
      archive.writeUInt32LE(entry.declaredSize, local + 22);
      archive.writeUInt32LE(entry.declaredSize, central + 24);
    }
    central += 46 + archive.readUInt16LE(central + 28);
  }
  fs.writeFileSync(file, archive);
  return { file, temp, staged: () => fs.readdirSync(temp) };
}

test('concurrent extraction owns separate stages; nested base wins without reordering split install', async (t) => {
  const { file, staged } = fixture(t, [
    { name: 'splits/config.apk', data: split },
    { name: 'splits/base-master.apk', data: split },
    { name: 'splits/BASE.APK', data: base },
  ]);
  const [first, second] = await Promise.all([parseBundle(file), parseBundle(file)]);
  try {
    assert.notEqual(path.dirname(first.files[0]), path.dirname(second.files[0]));
    assert.equal(staged().length, 2);
    assert.equal(first.meta.label, 'TestApp');
    assert.equal(second.meta.label, 'TestApp');
    assert.deepEqual(first.files.map((item) => fs.readFileSync(item)), [split, split, base]);
    first.cleanup();
    first.cleanup();
    assert.equal(staged().length, 1);
    assert.deepEqual(second.files.map((item) => fs.readFileSync(item)), [split, split, base]);
  } finally {
    first.cleanup();
    second.cleanup();
  }
  assert.deepEqual(staged(), []);
});

test('a corrupt named base can fall back to a parseable legacy member', async (t) => {
  const { file } = fixture(t, [
    { name: 'base.apk', data: Buffer.from('not an APK') },
    { name: 'com.example.test.apk', data: base },
  ]);
  const bundle = await parseBundle(file);
  try {
    assert.equal(bundle.meta.package, 'com.example.test');
    assert.equal(bundle.files.length, 2);
  } finally { bundle.cleanup(); }
});

test('guest disk rejection happens before extracting any compressed member', async (t) => {
  const { file, staged } = fixture(t, [
    { name: 'base.apk', data: zlib.deflateRawSync(base), deflated: true, declaredSize: base.length },
  ]);
  const checked = [];
  const progress = [];
  const pipe = t.mock.method(ZipFile.prototype, 'pipeTo', () => assert.fail('must not extract'));
  const installer = new Installer({
    backend: { checkDiskFor: (bytes) => { checked.push(bytes); return { ok: false, message: 'disk fixture reject' }; } },
    ensure: () => assert.fail('must not start runtime'),
  }, {});
  await assert.rejects(installer.install(file, (event) => progress.push(event.stage)), {
    message: 'disk fixture reject', needsSetup: 'disk',
  });
  assert.deepEqual(checked, [base.length]);
  assert.deepEqual(progress, ['parse', 'error']);
  assert.equal(pipe.mock.callCount(), 0);
  assert.deepEqual(staged(), []);
});

test('successful deflate extraction preserves exact APK bytes and reports written size', async (t) => {
  const { file, staged } = fixture(t, [
    { name: 'base.apk', data: zlib.deflateRawSync(base), deflated: true, declaredSize: base.length },
    { name: 'other/empty.apk', data: Buffer.alloc(0) },
  ]);
  const checked = [];
  const bundle = await parseBundle(file, (bytes) => checked.push(bytes));
  try {
    assert.deepEqual(checked, [base.length]);
    assert.equal(bundle.sizeBytes, base.length);
    assert.deepEqual(bundle.files.map((item) => fs.readFileSync(item)), [base, Buffer.alloc(0)]);
  } finally { bundle.cleanup(); }
  assert.deepEqual(staged(), []);
});

for (const overage of [0, 1]) {
  test(`disk is rechecked after extraction, even with a ${overage}-byte discrepancy`, async (t) => {
    const declaredSize = base.length - overage;
    const { file, staged } = fixture(t, [{ name: 'base.apk', data: base, declaredSize }]);
    const checked = [];
    const installer = new Installer({
      backend: { checkDiskFor: (bytes) => {
        checked.push([bytes, staged().length]);
        return { ok: checked.length === 1, message: 'post-extraction disk fixture reject' };
      } },
      ensure: () => assert.fail('must not start runtime'),
    }, {});
    await assert.rejects(installer.install(file), { message: 'post-extraction disk fixture reject', needsSetup: 'disk' });
    assert.deepEqual(checked, [[declaredSize, 0], [base.length, 1]]);
    assert.deepEqual(staged(), []);
  });
}

test('missing members, invalid APK metadata and damaged deflate streams leave no stage', async (t) => {
  // Give each parse path an isolated temp directory to prove its own cleanup.
  await t.test('no APK entries', async (sub) => {
    const { file, staged } = fixture(sub, [{ name: 'readme.txt', data: Buffer.from('no APK') }]);
    await assert.rejects(parseBundle(file), /没有找到 APK 分片/);
    assert.deepEqual(staged(), []);
  });
  await t.test('no parseable manifest after extraction', async (sub) => {
    const { file, staged } = fixture(sub, [{ name: 'base.apk', data: Buffer.from('not an APK') }]);
    await assert.rejects(parseBundle(file), /base APK 解析失败/);
    assert.deepEqual(staged(), []);
  });
  await t.test('corrupt deflate after a valid member', async (sub) => {
    const { file, staged } = fixture(sub, [
      { name: 'base.apk', data: base },
      { name: 'damaged.apk', data: Buffer.from([0x07]), deflated: true, declaredSize: 2048 },
    ]);
    await assert.rejects(parseBundle(file), { code: 'Z_DATA_ERROR' });
    assert.deepEqual(staged(), []);
  });
});

test('an error opening a destination closes the write stream and preserves the archive for the next member', async (t) => {
  const { file, temp } = fixture(t);
  const zip = new ZipFile(file);
  try {
    const invalid = fs.createWriteStream(path.join(temp, 'missing-directory', 'out.apk'));
    await assert.rejects(zip.pipeTo('base.apk', invalid), { code: 'ENOENT' });
    assert.equal(invalid.closed, true);
    const notOpened = fs.createWriteStream(path.join(temp, 'missing-directory', 'absent.apk'));
    await assert.rejects(zip.pipeTo('absent.apk', notOpened), /条目不存在/);
    assert.equal(notOpened.closed, true);
    const target = path.join(temp, 'ok.apk');
    await zip.pipeTo('base.apk', fs.createWriteStream(target));
    assert.deepEqual(fs.readFileSync(target), base);
  } finally { zip.close(); }
});

test('progress failure and runtime preflight failure both clean a successfully staged bundle', async (t) => {
  const { file, staged } = fixture(t);
  const installer = new Installer({ ensure: async () => ({ ok: false, error: 'fixture runtime offline' }) }, {});
  await assert.rejects(installer.install(file, ({ stage }) => {
    if (stage === 'parse-done') throw new Error('fixture progress consumer failed');
  }), /fixture progress consumer failed/);
  assert.deepEqual(staged(), []);

  await assert.rejects(installer.install(file), { message: 'fixture runtime offline', needsSetup: 'provision' });
  assert.deepEqual(staged(), []);
});

test('guest ABI retry reuses the same split files, then cleans them if the guest rejects installation', async (t) => {
  const { file, staged } = fixture(t);
  t.mock.method(store, 'getApp', () => null);
  const installs = [];
  const installer = new Installer({ ensure: async () => ({ ok: true, client: {
    shell: async () => 'arm64-v8a',
    installMultiple: async (files) => {
      installs.push(files);
      assert.deepEqual(fs.readFileSync(files[0]), base);
      throw Object.assign(new Error('fixture ABI mismatch'), { code: 'NO_MATCHING_ABIS' });
    },
  } }) }, {});
  t.mock.method(installer, 'ensureCompatImage', async () => {});
  t.mock.method(installer, 'switchToCompat', async () => ({ client: {
    installMultiple: async (files) => {
      installs.push(files);
      assert.deepEqual(fs.readFileSync(files[0]), base);
      throw new Error('fixture guest install refused');
    },
  } }));

  await assert.rejects(installer.install(file), { abiRetried: true, message: /fixture guest install refused/ });
  assert.equal(installs.length, 2);
  assert.equal(installs[0], installs[1]);
  assert.deepEqual(staged(), []);
});

for (const canBackup of [true, false]) {
  test(`split success releases the stage before ${canBackup ? 'successful' : 'failed'} backup`, async (t) => {
    const { file, temp, staged } = fixture(t);
    const backup = path.join(path.dirname(temp), 'backup.apk');
    const records = [];
    t.mock.method(store, 'getApp', () => null);
    t.mock.method(store, 'getSettings', () => ({ createShortcutOnInstall: false }));
    t.mock.method(store, 'iconPath', () => { throw new Error('no icon output in fixture'); });
    t.mock.method(store, 'apkPath', () => backup);
    t.mock.method(store, 'upsertApp', (app) => records.push(app));
    const copy = fs.promises.copyFile;
    const checks = [];
    t.mock.method(fs.promises, 'copyFile', async (source, target) => {
      checks.push([source, target, staged()]);
      if (!canBackup) throw new Error('fixture backup denied');
      await copy(source, target);
    });
    const installer = new Installer({
      ensure: async () => ({ ok: true, client: {
        shell: async () => 'arm64-v8a',
        installMultiple: async ([apk]) => assert.deepEqual(fs.readFileSync(apk), base),
        batteryOptimizeOff: async () => {},
      } }),
      touch() {},
    }, {});
    t.mock.method(installer, 'icoFile', () => { throw new Error('no ico output in fixture'); });
    const { app, warnings } = await installer.install(file);
    assert.deepEqual(checks, [[file, backup, []]]);
    assert.deepEqual(records, [app]);
    assert.equal(app.apkPath, canBackup ? backup : null);
    assert.equal(warnings.some((warning) => warning.includes('本地安装包备份失败')), !canBackup);
    if (canBackup) assert.deepEqual(fs.readFileSync(backup), fs.readFileSync(file));
  });
}
