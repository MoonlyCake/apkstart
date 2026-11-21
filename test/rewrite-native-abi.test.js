'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { AdbClient } = require('../src/core/adb');
const { parseApk } = require('../src/core/apk');
const { Installer } = require('../src/core/installer');
const { nativeLibraries, preferredArmAbi } = require('../src/core/native-abi');
const store = require('../src/core/store');
const { buildManifestAxml, buildStoredZip } = require('./lib/make-apk');

const COMMON = ['libshim.so', 'libhook.so', 'libunwind.so'];
const ARM_LIBS = [...COMMON, ...Array.from({ length: 12 }, (_, i) => `libaudio${i}.so`)];
const GUEST_ABIS = 'x86_64,x86,arm64-v8a,armeabi-v7a,armeabi';
const libNames = (abi, names) => names.map((name) => `lib/${abi}/${name}`);
const thinNames = [...libNames('x86_64', COMMON), ...libNames('arm64-v8a', ARM_LIBS)];
const fakeGuest = (abis = GUEST_ABIS) => ({ shell: async (cmd) => {
  assert.equal(cmd, 'getprop ro.product.cpu.abilist');
  return abis;
} });

test('inventory counts distinct actual ABI library entries only', () => {
  assert.deepEqual(nativeLibraries([
    'lib/x86/', 'lib/x86/liba.so', 'lib/x86/liba.so', 'lib/x86/gdbserver',
    'lib/x86/location/libnested.so', 'lib/fake/libx.so', 'assets/lib/x86/libhidden.so',
    'lib/arm64-v8a/libb.so', 'lib/arm64-v8a/lib\\escaped.so',
  ]), { x86: ['liba.so'], 'arm64-v8a': ['libb.so'] });
});

test('thin x86 default picks a complete guest-supported ARM profile of equal bitness only', async () => {
  const thin = { nativeLibs: nativeLibraries(thinNames) };
  assert.equal(await preferredArmAbi(thin, fakeGuest()), 'arm64-v8a');
  assert.equal(await preferredArmAbi(thin, fakeGuest('x86_64,x86')), null);
  assert.equal(await preferredArmAbi(thin, fakeGuest('arm64-v8a,x86_64')), null);
  assert.equal(await preferredArmAbi(thin, fakeGuest('x86_64,armeabi-v7a')), null);
  assert.equal(await preferredArmAbi(thin, fakeGuest('unknown response')), null);
  assert.equal(await preferredArmAbi(thin, { shell: async () => { throw new Error('fixture unavailable'); } }), null);
  const thin32 = { nativeLibs: nativeLibraries([...libNames('x86', COMMON), ...libNames('armeabi-v7a', ARM_LIBS)]) };
  assert.equal(await preferredArmAbi(thin32, fakeGuest()), 'armeabi-v7a');
  assert.equal(await preferredArmAbi(thin32, fakeGuest('x86,arm64-v8a')), null);
});

test('ordinary, substantial or not-strict-subset x86 and explicit manifest policies stay native', async () => {
  let probes = 0;
  const neverProbe = { shell: async () => { probes++; return GUEST_ABIS; } };
  for (const names of [
    libNames('x86_64', COMMON),
    [...libNames('x86_64', COMMON), ...libNames('arm64-v8a', COMMON)],
    [...libNames('x86_64', ['libunique.so']), ...libNames('arm64-v8a', ARM_LIBS)],
    [...thinNames, ...libNames('x86_64', ['libaudio0.so', 'libaudio1.so'])],
  ]) assert.equal(await preferredArmAbi({ nativeLibs: nativeLibraries(names) }, neverProbe), null);
  assert.equal(await preferredArmAbi({ explicitAbiPolicy: true, nativeLibs: nativeLibraries(thinNames) }, neverProbe), null);
  assert.equal(probes, 0, 'no plausible thin x86 ABI; no guest probe');
  assert.equal(await preferredArmAbi({ nativeLibs: nativeLibraries([...thinNames, ...libNames('x86', ARM_LIBS)]) }, fakeGuest()), null);
});

function makeSample(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-abi-fixture-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'original.apk');
  fs.writeFileSync(file, buildStoredZip([
    { name: 'AndroidManifest.xml', data: buildManifestAxml() },
    ...thinNames.map((name) => ({ name, data: Buffer.from('ELF fixture') })),
  ]));
  return { root, file };
}

test('ADB keeps ABI through retries, rejects invalid values and reports unsupported override', async (t) => {
  const { file } = makeSample(t);
  const trace = [];
  const client = new AdbClient();
  client.exec = async (args) => {
    trace.push(args);
    if (args.includes('--bypass-low-target-sdk-block')) throw new Error('Unknown option --bypass-low-target-sdk-block');
    return { stdout: 'Success' };
  };
  assert.equal(await client.install(file, { abi: 'arm64-v8a' }), 'Success');
  assert.equal(trace.length, 2);
  assert.ok(trace.every((args) => args.includes('-r') && !args.includes('-g') && args[args.indexOf('--abi') + 1] === 'arm64-v8a'));
  await assert.rejects(client.install(file, { abi: '--force' }), /无效的 ARM/);
  client.exec = async () => { throw new Error("Unknown option '--abi'"); };
  await assert.rejects(client.install(file, { abi: 'arm64-v8a' }), { code: 'ABI_OVERRIDE_UNSUPPORTED' });
});

test('single install, update, cached recovery and compatible-image recovery converge on the same ABI', async (t) => {
  const { root, file } = makeSample(t);
  const meta = parseApk(file);
  const events = [];
  let app = null;
  t.mock.method(store, 'getApp', () => app);
  t.mock.method(store, 'getApps', () => [app]);
  t.mock.method(store, 'getSettings', () => ({ display: {}, createShortcutOnInstall: false }));
  t.mock.method(store, 'apkPath', () => path.join(root, 'backup.apk'));
  t.mock.method(store, 'upsertApp', (next) => { app = { ...app, ...next }; });
  const client = {
    ...fakeGuest(), install: async (source, options) => { events.push([source, options]); },
    resolveLauncher: async () => '', batteryOptimizeOff: async () => {},
    resetDisplayOverrides: async () => {}, isInstalled: async () => false,
  };
  const rt = { ok: true, client, engine: 'fixture' };
  const installer = new Installer({ ensure: async () => rt, useCompatImage: async () => rt, touch() {} }, {}, {
    launchPolicy: async () => {},
  });
  await installer.install(file);
  await installer.install(file);
  await installer.launch(meta.package);
  await installer.switchToCompat(() => {});
  assert.deepEqual(events.map(([source]) => path.basename(source)), ['original.apk', 'original.apk', 'backup.apk', 'backup.apk']);
  assert.ok(events.every(([, opts]) => opts.abi === 'arm64-v8a' && opts.grantPermissions === false));
  assert.deepEqual(fs.readFileSync(file), fs.readFileSync(app.apkPath));
});

test('a rejected override may try Android default once without broad-error retries', async (t) => {
  const { root, file } = makeSample(t);
  const trace = [];
  t.mock.method(store, 'getApp', () => null);
  t.mock.method(store, 'getSettings', () => ({ createShortcutOnInstall: false }));
  t.mock.method(store, 'apkPath', () => path.join(root, 'backup.apk'));
  t.mock.method(store, 'upsertApp', () => {});
  const client = { ...fakeGuest(), resolveLauncher: async () => '', batteryOptimizeOff: async () => {},
    install: async (_file, opts) => {
      trace.push(opts.abi);
      if (opts.abi) throw Object.assign(new Error('fixture no matching ABI'), { code: 'NO_MATCHING_ABIS' });
    },
  };
  const installer = new Installer({ ensure: async () => ({ ok: true, client }), touch() {} }, {});
  await installer.install(file);
  assert.deepEqual(trace, ['arm64-v8a', undefined]);
  client.install = async () => { throw Object.assign(new Error('fixture signature failed'), { code: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' }); };
  await assert.rejects(installer.install(file), { code: 'INSTALL_FAILED_UPDATE_INCOMPATIBLE' });
});

test('optional real factory APK exposes the same strict subset', { skip: !process.env.APKSTART_REAL_ABI_APK }, async () => {
  const meta = parseApk(process.env.APKSTART_REAL_ABI_APK);
  assert.equal(meta.package, 'com.tencent.karaoke');
  assert.deepEqual([...meta.nativeLibs.x86_64].sort(), ['libbytehook.so', 'libxdl.so', 'libxunwind.so']);
  assert.ok(meta.nativeLibs['arm64-v8a'].includes('libmmkv.so'));
  assert.equal(await preferredArmAbi(meta, fakeGuest()), 'arm64-v8a');
});
