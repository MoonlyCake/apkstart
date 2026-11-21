'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createAehdPackage, GOOGLE_AEHD } = require('../src/core/aehd-package');
const { buildStoredZip } = require('./lib/make-apk');

// Neither fixture member is executed. Tests inspect bytes delivered to the injected boundary.
const batch = Buffer.from('rem Verified staging fixture\r\n');
const driver = Buffer.from('Fixture bytes, not a driver');
const valid = buildStoredZip([
  { name: 'silent_install.bat', data: batch },
  { name: 'aehd.Sys', data: driver },
]);

function fixture(t, bytes = valid) {
  const runtime = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-aehd-test-'));
  t.after(() => fs.rmSync(runtime, { recursive: true, force: true }));
  const paths = { root: runtime, aehdDir: path.join(runtime, 'aehd'), tmp: path.join(runtime, '_tmp') };
  const pin = { ...GOOGLE_AEHD, size: bytes.length, sha1: createHash('sha1').update(bytes).digest('hex') };
  return { paths, pin };
}

test('AEHD uses only the fixed official address, publishes verified bytes, then works offline', async (t) => {
  const { paths, pin } = fixture(t);
  let requests = 0;
  const pkg = createAehdPackage({ pin, request: async (url, options) => {
    requests += 1;
    assert.equal(url, 'https://dl.google.com/android/repository/aehd-windows_v2.2.zip');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    return { ok: true, body: [valid.subarray(0, 50), valid.subarray(50)] };
  } });
  const prepared = await pkg.prepare(paths);
  assert.deepEqual(fs.readFileSync(path.join(paths.aehdDir, pin.filename)), valid);
  assert.deepEqual(fs.readFileSync(prepared.installer), batch);
  assert.equal(requests, 1);

  // A stale unpacked file, even right beside the ZIP, is not the one passed to the loader.
  fs.writeFileSync(prepared.installer, 'rem Old unpacked fixture');
  const staged = await pkg.withInstaller(paths, () => {}, async (installer) => {
    assert.notEqual(installer, prepared.installer);
    assert.deepEqual(fs.readFileSync(installer), batch);
    assert.deepEqual(fs.readFileSync(path.join(path.dirname(installer), 'aehd.Sys')), driver);
    return path.dirname(installer);
  });
  assert.equal(requests, 1);
  assert.equal(fs.existsSync(staged), false);
  assert.equal(fs.readFileSync(prepared.installer, 'utf8'), 'rem Old unpacked fixture');
});

test('a damaged legacy ZIP and an unverified script never reach the installer boundary', async (t) => {
  const { paths, pin } = fixture(t);
  const corrupt = Buffer.from(valid);
  corrupt[0] ^= 1;
  fs.mkdirSync(paths.aehdDir);
  fs.writeFileSync(path.join(paths.aehdDir, pin.filename), corrupt);
  fs.writeFileSync(path.join(paths.aehdDir, 'silent_install.bat'), 'rem Old fixture');
  const pkg = createAehdPackage({ pin, request: async () => ({ ok: true, body: [corrupt] }) });
  await assert.rejects(pkg.withInstaller(paths, () => {}, () => assert.fail('installer ran')), /SHA-1 校验失败/);
  assert.equal(fs.existsSync(paths.tmp), false);
});

test('short or oversized responses are rejected without a staging directory', async (t) => {
  const { paths, pin } = fixture(t);
  for (const [body, reason] of [
    [[valid.subarray(0, -1)], /大小不符/],
    [[valid, Buffer.from('trailing')], /超过预期/],
  ]) {
    const pkg = createAehdPackage({ pin, request: async () => ({ ok: true, body }) });
    await assert.rejects(pkg.withInstaller(paths, () => {}, () => assert.fail('installer ran')), reason);
    assert.equal(fs.existsSync(paths.tmp), false);
  }
});

test('verified but structurally incomplete fixture is not runnable', async (t) => {
  const incomplete = buildStoredZip([{ name: 'aehd.sys', data: driver }]);
  const { paths, pin } = fixture(t, incomplete);
  const pkg = createAehdPackage({ pin, request: async () => ({ ok: true, body: [incomplete] }) });
  await assert.rejects(pkg.withInstaller(paths, () => {}, () => assert.fail('installer ran')), /缺少安装脚本/);
  assert.equal(fs.existsSync(paths.tmp), false);
});

test('different runs get independent stages and failed elevation cleans its own stage', async (t) => {
  const { paths, pin } = fixture(t);
  const pkg = createAehdPackage({ pin, request: async () => ({ ok: true, body: [valid] }) });
  const seen = [];
  await pkg.withInstaller(paths, () => {}, async (first) => {
    seen.push(first);
    await assert.rejects(pkg.withInstaller(paths, () => {}, async (second) => {
      seen.push(second);
      assert.notEqual(second, first);
      assert.ok(fs.existsSync(first));
      throw new Error('fixture cancellation');
    }), /fixture cancellation/);
    assert.ok(fs.existsSync(first));
    assert.equal(fs.existsSync(seen[1]), false);
  });
  assert.equal(fs.existsSync(seen[0]), false);
  assert.deepEqual(fs.readdirSync(paths.tmp), []);
});

test('a verified bundled archive remains available when the install root is read-only', async (t) => {
  const { paths, pin } = fixture(t);
  fs.mkdirSync(paths.aehdDir);
  fs.writeFileSync(path.join(paths.aehdDir, pin.filename), valid);
  const fallbackPaths = { ...paths, aehdDir: path.join(paths.root, 'user-data', 'aehd') };
  const pkg = createAehdPackage({ pin, request: async () => assert.fail('network not needed') });
  await pkg.withInstaller(fallbackPaths, () => {}, async (installer) => assert.deepEqual(fs.readFileSync(installer), batch));
  assert.equal(fs.existsSync(fallbackPaths.aehdDir), false);
});
