'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { buildApkBytes } = require('./lib/make-apk');
const { parseApk } = require('../src/core/apk');
const { matchesInstalledApk } = require('../src/core/apk-installed');
const { Installer } = require('../src/core/installer');
const store = require('../src/core/store');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-installed-'));
const file = path.join(dir, 'fixture.apk');
const bytes = buildApkBytes();
fs.writeFileSync(file, bytes);
const meta = parseApk(file);
const digest = createHash('sha256').update(bytes).digest('hex');
const guestApk = '/data/app/~~test/com.example.test-abc/base.apk';
const open = { shellOpen: true };

test.after(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });

function fixture(t, options = {}) {
  const app = Object.freeze({ package: meta.package, versionCode: meta.versionCode, label: 'Fixture', ...options.app });
  const calls = [];
  let stillOwned = true;
  t.mock.method(store, 'getApp', (pkg) => {
    assert.equal(pkg, meta.package);
    calls.push('catalog');
    return options.noCatalog ? null : app;
  });
  const client = {
    async shell(command) {
      if (command.startsWith('pm path')) {
        calls.push('paths');
        assert.equal(command, `pm path --user 0 ${meta.package}`);
        return options.paths ?? `package:${guestApk}\r\n`;
      }
      if (command.startsWith('sha256sum')) {
        calls.push('hash');
        assert.equal(command, `sha256sum '${guestApk}'`);
        if (options.replaceGuest) stillOwned = false;
        if (options.unreadable) throw new Error('ADB disconnected');
        return `${options.hash ?? digest}  ${guestApk}\r\n`;
      }
      assert.fail(`Unexpected ADB call: ${command}`);
    },
  };
  const guest = { ok: true, client, engine: 'emulator', generation: 4, revalidate: async () => {
    calls.push('lease');
    return stillOwned;
  } };
  const installer = new Installer({
    guestGeneration: 4,
    ensure: async () => { calls.push('ensure'); return guest; },
    touch: () => calls.push('touch'),
    backend: { checkDiskFor: () => { calls.push('disk'); return { ok: !options.diskFull, message: 'disk full' }; } },
  }, {});
  t.mock.method(installer, 'finishInstall', async (target, parsed, apkPath, bundle) => {
    assert.equal(target, guest);
    assert.equal(parsed.package, app.package);
    assert.equal(apkPath, file);
    assert.equal(bundle, null);
    calls.push('install');
    if (options.installError) throw options.installError;
    return { app, warnings: [], engine: target.engine };
  });
  return { app, calls, installer };
}

test('identical guest APK reuses the existing record without copying or installing, even if the disk is full', async (t) => {
  const { installer, calls, app } = fixture(t, { diskFull: true });
  const progress = [];
  const result = await installer.install(file, (p) => progress.push(p), open);
  assert.equal(result.reused, true);
  assert.equal(result.app, app);
  assert.deepEqual(calls, ['catalog', 'ensure', 'lease', 'paths', 'hash', 'lease', 'touch']);
  assert.equal(progress.at(-1).stage, 'done');
});

test('matching labels and version codes do not bypass PackageManager for different APK bytes', async (t) => {
  const rejected = new Error('INSTALL_FAILED_UPDATE_INCOMPATIBLE');
  const { installer, calls } = fixture(t, { hash: '0'.repeat(64), installError: rejected });
  await assert.rejects(installer.install(file, undefined, open), (error) => error === rejected);
  assert.deepEqual(calls, ['catalog', 'ensure', 'lease', 'paths', 'hash', 'lease', 'disk', 'install']);
});

test('a new app and an upgrade both retain normal preflight and installation', async (t) => {
  await t.test('new app', async (t) => {
    const { installer, calls } = fixture(t, { noCatalog: true });
    assert.equal((await installer.install(file, undefined, open)).reused, undefined);
    assert.deepEqual(calls, ['catalog', 'disk', 'ensure', 'install']);
  });
  await t.test('upgrade', async (t) => {
    const { installer, calls } = fixture(t, { app: { versionCode: meta.versionCode - 1 } });
    assert.equal((await installer.install(file, undefined, open)).reused, undefined);
    assert.deepEqual(calls, ['catalog', 'disk', 'ensure', 'install']);
  });
});

test('missing, split and unreadable guest files fall back to normal install', async (t) => {
  for (const [name, options, hashes] of [
    ['missing', { paths: '' }, []],
    ['split', { paths: `package:${guestApk}\npackage:/data/app/example/split_config.en.apk` }, []],
    ['unreadable', { unreadable: true }, ['hash']],
  ]) {
    await t.test(name, async (t) => {
      const { installer, calls } = fixture(t, options);
      assert.equal((await installer.install(file, undefined, open)).reused, undefined);
      assert.deepEqual(calls, ['catalog', 'ensure', 'lease', 'paths', ...hashes, 'lease', 'disk', 'install']);
    });
  }
});

test('replaced guest aborts before acknowledging reuse or installing', async (t) => {
  const { installer, calls } = fixture(t, { replaceGuest: true });
  await assert.rejects(installer.install(file, undefined, open), /安卓运行时已切换/);
  assert.deepEqual(calls, ['catalog', 'ensure', 'lease', 'paths', 'hash', 'lease']);
});

test('drag-and-drop retains the same installer behavior even for an existing byte-identical package', async (t) => {
  const { installer, calls } = fixture(t);
  assert.equal((await installer.install(file, () => {})).reused, undefined);
  assert.deepEqual(calls, ['disk', 'ensure', 'install']);
});

test('guest paths cannot inject shell commands into the hash probe', async () => {
  const oddPath = "/data/app/it's test/base.apk";
  const probe = { shell: async (cmd) => {
    if (cmd.startsWith('pm path ')) return `package:${oddPath}`;
    assert.equal(cmd, "sha256sum '/data/app/it'\\''s test/base.apk'");
    return `${digest}  ${oddPath}`;
  } };
  assert.equal(await matchesInstalledApk(probe, meta.package, file), true);
  assert.equal(await matchesInstalledApk(probe, `${meta.package}; invalid`, file), false);
});
