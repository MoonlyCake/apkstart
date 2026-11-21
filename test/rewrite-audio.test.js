'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const audio = require('../src/core/audio-policy');
const drivers = require('../src/core/drivers');
const { EmulatorEngine } = require('../src/core/emulator');

const micFlag = '-allow-host-audio';
const muteFlag = '-no-audio';

function testAvd(t) {
  const avdHome = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-audio-'));
  t.after(() => fs.rmSync(avdHome, { recursive: true, force: true }));
  const emu = new EmulatorEngine(avdHome);
  emu.provisioner = { ensureDirs: () => ({ avdHome }), paths: () => ({ avdHome }) };
  emu.imageChoice = () => ({ api: 34, tag: 'google_apis_playstore', abi: 'x86_64', compat: true });
  emu.ensureDataPartition = () => ({ ok: true });
  Object.defineProperty(emu, 'settings', { value: { engine: {} } });
  const dir = path.join(avdHome, 'apkstart.avd');
  return { emu, dir, ini: () => fs.readFileSync(path.join(dir, 'config.ini'), 'utf8') };
}

const prepare = (emu, settings) => emu.ensureAvd({ audioPolicy: audio.resolve(settings, 'win32') });

function mockSnapshot(dir) {
  const snap = path.join(dir, 'snapshots', 'apkstart');
  fs.mkdirSync(snap, { recursive: true });
  fs.writeFileSync(path.join(snap, 'snapshot.pb'), Buffer.alloc(2048));
  fs.writeFileSync(path.join(snap, 'ram.bin'), Buffer.alloc(0));
  fs.truncateSync(path.join(snap, 'ram.bin'), 2 * 1024 * 1024);
  return snap;
}

test('host microphone strictly opts in on Windows, independently of playback', () => {
  const matrix = [
    ['win32', undefined, 'no', 'yes', []],
    ['win32', { hostMicrophone: 'true' }, 'no', 'yes', []],
    ['win32', { hostMicrophone: true }, 'yes', 'yes', [micFlag]],
    ['win32', { hostMicrophone: true, audio: false }, 'yes', 'no', [micFlag]],
    ['win32', { hostMicrophone: false, audio: false }, 'no', 'no', [muteFlag]],
    ['linux', { hostMicrophone: true }, 'no', 'yes', []],
    ['darwin', { hostMicrophone: true, audio: false }, 'no', 'no', [muteFlag]],
  ];
  for (const [platform, settings, input, output, args] of matrix) {
    const policy = audio.resolve(settings, platform);
    const context = `${platform} ${JSON.stringify(settings)}`;
    assert.deepEqual(policy.ini, [`hw.audioInput=${input}`, `hw.audioOutput=${output}`], context);
    assert.deepEqual(policy.args, args, context);
  }
});

test('valid legacy drivers cannot override consent or mute explicitly enabled host capture', (t) => {
  const { emu, ini } = testAvd(t);
  const driver = drivers.validateDriver({
    format: 'apkstart-driver/1', id: 'audio-test', name: 'legacy audio override', version: '1.0.0',
    match: { any: true },
    effect: {
      emulatorArgs: ['-qemu=--allow-host-audio', '-no-audio', '-feature=-Vulkan'],
      configIni: { 'hw.audioInput': 'yes', 'hw.audioOutput': 'no', 'hw.gps': 'yes' },
    },
  });
  assert.equal(driver.ok, true, driver.errors.join('; '));
  emu._driverEffect = driver.driver.effect;

  prepare(emu, {});
  assert.deepEqual(ini().match(/^hw\.audio(?:Input|Output)=.*$/gm), ['hw.audioInput=no', 'hw.audioOutput=yes']);
  assert.match(ini(), /^hw\.gps=yes$/m);
  const defaultArgs = emu.buildArgs();
  for (const arg of ['-qemu', '--allow-host-audio', micFlag, muteFlag]) assert.ok(!defaultArgs.includes(arg));
  assert.equal(defaultArgs[defaultArgs.indexOf('-feature') + 1], '-Vulkan');

  const micOnly = { hostMicrophone: true, audio: false };
  emu._driverEffect.ini['hw.audioInput'] = 'none';
  emu._driverEffect.ini['hw.audioOutput'] = 'yes';
  prepare(emu, micOnly);
  assert.deepEqual(ini().match(/^hw\.audio(?:Input|Output)=.*$/gm), ['hw.audioInput=yes', 'hw.audioOutput=no']);
  const args = emu.buildArgs({ audioPolicy: audio.resolve(micOnly, 'win32') });
  assert.equal(args.filter((arg) => arg === micFlag).length, 1);
  assert.ok(!args.includes(muteFlag));
});

test('ordinary QEMU passthrough is still available after emulator flags', (t) => {
  const { emu } = testAvd(t);
  emu._driverEffect = { args: [{ flag: '-qemu', value: '-no-reboot' }, { flag: '-feature', value: '-Vulkan' }] };
  const args = emu.buildArgs({ audioPolicy: audio.resolve({ hostMicrophone: true }, 'win32') });
  assert.ok(args.includes(micFlag));
  assert.deepEqual(args.slice(-4), ['-feature', '-Vulkan', '-qemu', '-no-reboot']);
  for (const option of ['-audio', '--audiodev=none,id=test', '-soundhw', '-noaudio']) {
    assert.equal(audio.isAudioDriverArg('-qemu', option), true, option);
  }
});

test('changing either audio direction invalidates quickboot but never user data', (t) => {
  const { emu, dir } = testAvd(t);
  const first = prepare(emu, {});
  const userdata = path.join(dir, 'userdata-qemu.img');
  fs.writeFileSync(userdata, 'preserve installed applications');
  const snap = mockSnapshot(dir);
  const keyFile = path.join(dir, 'snapshot.key');
  const key = () => fs.readFileSync(keyFile, 'utf8');
  const originalKey = key();
  assert.equal(first.wipePending, false);
  assert.equal(prepare(emu, {}).wipePending, false);
  assert.equal(key(), originalKey);
  assert.ok(emu.hasSnapshot());

  const micOn = { hostMicrophone: true };
  assert.equal(prepare(emu, micOn).wipePending, false);
  assert.notEqual(key(), originalKey);
  assert.ok(!fs.existsSync(snap));
  mockSnapshot(dir);
  const micKey = key();

  assert.equal(prepare(emu, { ...micOn, audio: false }).wipePending, false);
  assert.notEqual(key(), micKey);
  assert.ok(!fs.existsSync(snap));
  assert.equal(fs.readFileSync(userdata, 'utf8'), 'preserve installed applications');
});

test('emulator ini whitespace does not look like an image change when restarting for audio', (t) => {
  const { emu, dir, ini } = testAvd(t);
  prepare(emu, {});
  const config = path.join(dir, 'config.ini');
  const rewrite = (content) => content.replace(/^([^=\r\n]+)=/gm, (_, key) => `${key} = `);
  fs.writeFileSync(config, rewrite(ini()));
  const disk = path.join(dir, 'userdata-qemu.img');
  const pristine = Buffer.from('installed data must survive restart');
  fs.writeFileSync(disk, pristine);
  assert.equal(prepare(emu, { hostMicrophone: true }).wipePending, false);
  assert.match(ini(), /^hw\.audioInput=yes$/m);
  assert.deepEqual(fs.readFileSync(disk), pristine);

  const differentImage = rewrite(ini().replace('system-images/android-34/', 'system-images/android-30/'));
  fs.writeFileSync(config, differentImage);
  assert.throws(() => prepare(emu, {}), { code: 'AVD_IMAGE_CHANGE_REQUIRES_RESET' });
  assert.equal(ini(), differentImage);
  assert.deepEqual(fs.readFileSync(disk), pristine);
});

test('a locked stale snapshot is not loaded or relabeled as current', (t) => {
  const { emu, dir } = testAvd(t);
  prepare(emu, {});
  const snap = mockSnapshot(dir);
  const snapRoot = path.dirname(snap);
  const keyFile = path.join(dir, 'snapshot.key');
  const oldKey = fs.readFileSync(keyFile, 'utf8');
  const rmSync = fs.rmSync;
  const renameSync = fs.renameSync;
  t.mock.method(fs, 'rmSync', (target, ...rest) => {
    if (target === snapRoot) throw new Error('locked');
    return rmSync(target, ...rest);
  });
  t.mock.method(fs, 'renameSync', (target, ...rest) => {
    if (target === snapRoot) throw new Error('locked');
    return renameSync(target, ...rest);
  });

  const micOn = { hostMicrophone: true };
  assert.equal(prepare(emu, micOn).wipePending, false);
  assert.ok(emu.hasSnapshot());
  assert.equal(fs.readFileSync(keyFile, 'utf8'), oldKey);
  assert.ok(emu.buildArgs({ audioPolicy: audio.resolve(micOn, 'win32') }).includes('-no-snapshot-load'));
});
