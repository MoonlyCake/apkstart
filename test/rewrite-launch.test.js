'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { runLaunchPolicy } = require('../src/application/launch-policy');
const { AdbClient, friendlyLaunchError } = require('../src/core/adb');
const { Installer } = require('../src/core/installer');
const store = require('../src/core/store');
const { buildStoredZip, buildApkBytes } = require('./lib/make-apk');

function timing(overrides = {}) {
  let time = 0;
  return {
    observeMs: 12,
    stableMs: 3,
    pollMs: 1,
    probeMs: 6,
    now: () => time,
    sleep: async (ms) => { time += ms; },
    ...overrides,
  };
}

function runScript(attempts, { observer, innerSightings = [], ...overrides } = {}) {
  const clock = timing(overrides);
  const info = { starts: 0, firstSeen: [], marks: [], logs: [], probes: [] };
  let index = 0;
  const completion = runLaunchPolicy({
    start: async (noteProcessSeen) => {
      info.starts += 1;
      index = 0;
      if (innerSightings.includes(info.starts)) noteProcessSeen();
    },
    probe: async ({ timeout }) => {
      const snapshots = attempts[info.starts - 1];
      const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      info.probes.push(timeout);
      if (snapshot instanceof Error) throw snapshot;
      return snapshot;
    },
    onAppUp: () => {
      info.firstSeen.push(clock.now());
      return observer?.();
    },
    onMark: (m) => info.marks.push(m),
    onLog: (m) => info.logs.push(m),
  }, clock).then(() => clock.now());
  return { completion, info };
}

test('waits for a delayed process without retry, notifying early without awaiting window attach', async () => {
  const { completion, info } = runScript([[[], [], [], [], ['10']]], {
    observer: () => Promise.reject(new Error('window was closed')),
  });
  assert.equal(await completion, 7);
  assert.equal(info.starts, 1);
  assert.deepEqual(info.firstSeen, [4]);
  assert.deepEqual(info.marks, ['am start #1 ok', 'alive #1 true']);
});

test('PID replacement restarts the stability window; an overlapping PID may establish stability', async () => {
  const replaced = runScript([[['10'], ['10'], ['20'], ['20', '30']]]);
  assert.equal(await replaced.completion, 5);
  assert.equal(replaced.info.starts, 1);
  assert.deepEqual(replaced.info.firstSeen, [0]);

  const overlapping = runScript([[['10', '30'], ['10', '40'], ['10', '50']]]);
  assert.equal(await overlapping.completion, 3);
});

test('one confirmed absence or an ADB outage restarts stability, not the app', async () => {
  const outage = new Error('device offline');
  const { completion, info } = runScript([[['10'], [], outage, ['10']]]);
  assert.equal(await completion, 6);
  assert.equal(info.starts, 1);
  assert.deepEqual(info.firstSeen, [0]);
  assert.deepEqual(info.logs, []);
});

test('transport outage alone is inconclusive and does not cause an app restart', async () => {
  const outage = new Error('device unauthorized');
  const { completion, info } = runScript([[['10'], outage]]);
  await assert.rejects(completion, { code: 'APP_OBSERVATION_FAILED', cause: outage });
  assert.equal(info.starts, 1);
  assert.match(info.marks.at(-1), /unknown/);
  assert.equal(info.probes.at(-1), 1, 'probe timeout is clipped to observation deadline');
});

test('a process first seen near the deadline is not falsely reported stable', async () => {
  const { completion, info } = runScript([[[], [], [], [], ['10']]], { observeMs: 5 });
  await assert.rejects(completion, { code: 'APP_START_TIMEOUT' });
  assert.equal(info.starts, 1);
  assert.deepEqual(info.firstSeen, [4]);
});

test('two verified absences after a seen process allow restart without forced stop', async () => {
  const { completion, info } = runScript([[['10'], [], []], [['20']]]);
  assert.equal(await completion, 605);
  assert.equal(info.starts, 2);
  assert.deepEqual(info.firstSeen, [0]);
  assert.equal(info.logs.length, 1);
});

test('retains an inner startApp sighting that disappears before the first policy probe', async () => {
  const { completion, info } = runScript([[[], []], [['20']]], { innerSightings: [1] });
  assert.equal(await completion, 604);
  assert.equal(info.starts, 2);
  assert.deepEqual(info.firstSeen, [601]);
});

test('an inner sighting followed only by ADB outages does not retry', async () => {
  const outage = new Error('device offline');
  const { completion, info } = runScript([[[], outage]], { innerSightings: [1] });
  await assert.rejects(completion, { code: 'APP_OBSERVATION_FAILED', cause: outage });
  assert.equal(info.starts, 1);
  assert.deepEqual(info.firstSeen, []);
});

test('legacy direct ADB callers still see numeric PID and receive the original startApp result', async () => {
  const client = new AdbClient({ adbPath: 'never-run', serial: 'test' });
  let sightingCount = 0;
  client.resolveLauncher = async () => 'com.example.app/.Main';
  client.shell = async (command) => command.startsWith('pidof ') ? '42 57' : 'Starting: Intent';
  const opts = { freeform: false, onProcessSeen: () => { sightingCount += 1; } };

  assert.equal(await client.startApp('com.example.app', '.Main', opts), 'Starting: Intent');
  assert.equal(sightingCount, 1);
  assert.equal(await client.startApp('com.example.app', '.Main'), 'Starting: Intent');
});

test('legacy wait is inconclusive without numeric PID and never reads shared crash logs', async () => {
  const client = new AdbClient({ adbPath: 'never-run', serial: 'test' });
  client.shell = async (command) => {
    assert.ok(command.startsWith('pidof '));
    return 'ignored diagnostic text';
  };
  assert.deepEqual(await client.waitAppAlive('com.example.app', 2, assert.fail), {
    ok: false, crash: '', uncertain: true,
  });
});

test('rejected launch intents can fall back; unknown delivery from ADB does not replay', async () => {
  const client = new AdbClient({ adbPath: 'never-run', serial: 'test' });
  const calls = [];
  client.resolveLauncher = async () => 'com.example.app/.Main';
  client.shell = async (command) => {
    calls.push(command);
    if (command.startsWith('am start ')) return 'Error type 3\nError: Activity class does not exist.';
    return '** No activities found to run, monkey aborted.';
  };
  await assert.rejects(
    client.startApp('com.example.app', '.Main', { observeProcess: false }),
    { code: 'APP_START_FAILED', raw: /No activities found/ },
  );
  assert.equal(calls.filter((command) => command.startsWith('am start ')).length, 2);
  assert.equal(calls.filter((command) => command.startsWith('monkey -p com.example.app ')).length, 1);

  const timeout = new Error('transport timed out');
  calls.length = 0;
  client.shell = async (command) => { calls.push(command); throw timeout; };
  await assert.rejects(client.startApp('com.example.app', '.Main'), (error) => error === timeout);
  assert.equal(calls.length, 1);
});

test('orientation-only mode updates display without sending a key; existing default is unchanged', async (t) => {
  t.mock.method(store, 'getSettings', () => ({ display: { tabletMode: true, autoRotate: true } }));
  const client = new AdbClient({ adbPath: 'never-run', serial: 'test' });
  const commands = [];
  client.shell = async (command) => { commands.push(command); return ''; };
  assert.equal(await client.setOrientation(true, { sendBackKey: false }), true);
  assert.ok(commands.some((command) => command.includes('wm set-ignore-orientation-request true')));
  assert.ok(commands.some((command) => command.startsWith('wm density ')));
  assert.ok(!commands.some((command) => command.includes('input keyevent')));
  commands.length = 0;
  assert.equal(await client.setOrientation(true), true);
  assert.ok(commands.includes('input keyevent KEYCODE_BACK'));
});

test('readable launch errors recommend checking the actual image and never promise automatic switching', () => {
  const message = friendlyLaunchError('DoBadTrampoline libndk_translation', 'com.example.app');
  assert.match(message, /实际运行的镜像及 APK 架构/);
  assert.match(message, /下载并重启运行时/);
  assert.doesNotMatch(message, /自动|手动切换/);
});

test('repeated confirmed exits run only three starts and preserve app data', async () => {
  const { completion, info } = runScript([
    [['10'], [], []], [['11'], [], []], [['12'], [], []],
  ]);
  await assert.rejects(completion, {
    code: 'APP_UNSTABLE',
    message: /未执行清除应用数据/,
  });
  assert.equal(info.starts, 3);
  assert.equal(info.logs.length, 2);
});

test('start errors including existing APP_CRASHED evidence propagate unchanged', async () => {
  const failure = Object.assign(new Error('launch failed'), {
    code: 'APP_CRASHED',
    crash: 'Process: com.example.app; libndk_translation',
  });
  await assert.rejects(runLaunchPolicy({
    start: async () => { throw failure; },
    probe: assert.fail,
  }, timing()), (error) => error === failure);
});

function fixtureApk(t, bundle = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-launch-'));
  const file = path.join(dir, bundle ? 'test.apks' : 'test.apk');
  const base = buildApkBytes();
  fs.writeFileSync(file, bundle ? buildStoredZip([
    { name: 'base.apk', data: base },
    { name: 'split_config.arm64_v8a.apk', data: buildStoredZip([
      { name: 'lib/arm64-v8a/libother.so', data: Buffer.from('fixture only') },
    ]) },
  ]) : base);
  t.after(() => {
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  });
  return file;
}

test('ADB cached-reinstall mode sends no -g; ordinary explicit install retains its existing choice', async (t) => {
  const file = fixtureApk(t);
  const client = new AdbClient({ adbPath: 'never-run', serial: 'test' });
  const seen = [];
  client.exec = async (args) => { seen.push(args); return { stdout: 'Success' }; };

  await client.install(file);
  await client.install(file, { grantPermissions: false });

  assert.equal(seen.length, 2);
  assert.ok(seen[0].includes('-g'));
  assert.ok(!seen[1].includes('-g'));
  assert.ok(seen[1].includes('-r'), 'replace installs retain app data');
});

test('strict APK presence probe propagates transport failure and distinguishes explicit absence', async () => {
  const client = new AdbClient({ adbPath: 'never-run', serial: 'test' });
  const outage = new Error('device offline');
  client.shell = async (cmd) => {
    if (cmd.startsWith('pm path ')) return 'package:/data/app/com.example.app/base.apk';
    throw outage;
  };
  await assert.rejects(client.isInstalled('com.example.app', { strictProbe: true }), (err) => err === outage);

  client.shell = async () => '__APKSTART_ABSENT__';
  assert.equal(await client.isInstalled('com.example.app', { strictProbe: true }), false);
});

function installerFixture(t, {
  initialError, installError, bundle = false, ordinaryInstallState = true, shellOutput = '42',
} = {}) {
  const packageName = 'com.example.test';
  const app = { package: packageName, activity: '.Main', abis: ['arm64-v8a'], apkPath: fixtureApk(t, bundle), bundle };
  const options = { freeform: false, display: { landscape: true } };
  const updatedRecords = [];
  const events = [];
  let hasCompat = false;
  t.mock.method(store, 'getApp', (pkg) => pkg === packageName ? app : null);
  t.mock.method(store, 'getApps', () => [app]);
  t.mock.method(store, 'getSettings', () => options);
  t.mock.method(store, 'saveSettings', (patch) => events.push(['settings', patch]));
  t.mock.method(store, 'upsertApp', (record) => updatedRecords.push(record));

  function client(label, installed) {
    return {
      resetDisplayOverrides: async () => {},
      setOrientation: async (landscape, opts) => events.push(['orientation', label, landscape, opts]),
      isInstalled: async (pkg, opts) => {
        assert.equal(pkg, packageName);
        assert.deepEqual(opts, { strictProbe: true });
        if (installed instanceof Error) throw installed;
        return installed;
      },
      install: async (file, opts) => {
        events.push(['install', label, file, opts]);
        if (installError) throw installError;
      },
      installMultiple: async (files) => {
        events.push(['installMultiple', label, files]);
        assert.equal(files.length, 2);
        assert.deepEqual(fs.readFileSync(files[0]), buildApkBytes());
        assert.ok(fs.statSync(files[1]).size > 0);
        if (installError) throw installError;
      },
      shell: async (cmd) => {
        assert.ok(cmd.startsWith('pidof ' + packageName + ' '), 'ordinary launch must only use the PID shell probe');
        return shellOutput;
      },
      startApp: async (pkg, activity, opts) => {
        assert.equal(pkg, packageName);
        assert.equal(opts.observeProcess, false);
        events.push(['start', label]);
        if (label === 'base' && initialError) throw initialError;
      },
      grantRuntimePermissions: assert.fail,
      dismissPermissionDialog: assert.fail,
      clearData: assert.fail,
    };
  }
  const initial = { ok: true, engine: 'base', client: client('base', ordinaryInstallState) };
  const compat = { ok: true, engine: 'compat', client: client('compat', true) };
  const runtime = {
    ensure: async () => hasCompat ? compat : initial,
    provisioner: {
      playImageInfo: () => ({ ok: hasCompat }),
      installPlayImage: async () => { hasCompat = true; events.push(['provision']); },
    },
    stop: async () => events.push(['stop']),
    client: () => ({ devices: async () => [] }),
    emulator: { invalidateSnapshot: () => events.push(['invalidate']) },
    touch: () => events.push(['touch']),
  };

  return {
    installer: new Installer(runtime, {}, { launchPolicy: (ports) => runLaunchPolicy(ports, timing()) }),
    packageName,
    client: initial.client,
    events,
    updatedRecords,
  };
}

test('ordinary launch repairs verified missing cached data without granting permissions', async (t) => {
  const { installer, packageName, events, updatedRecords } = installerFixture(t, { ordinaryInstallState: false });
  assert.deepEqual(await installer.launch(packageName), { ok: true, engine: 'base' });
  assert.equal(updatedRecords[0].launchCount, 1);
  assert.deepEqual(events.map((e) => e[0]), ['install', 'invalidate', 'start', 'orientation', 'touch']);
  assert.deepEqual(events[0][3], { grantPermissions: false });
  assert.deepEqual(events[3], ['orientation', 'base', true, { sendBackKey: false }]);
});

test('ordinary launch does not reinstall or claim success from unknown probe results', async (t) => {
  const { installer, packageName, events, updatedRecords } = installerFixture(t, {
    ordinaryInstallState: new Error('disconnected'),
    shellOutput: 'invalid response',
  });
  await assert.rejects(installer.launch(packageName), { code: 'APP_OBSERVATION_FAILED' });
  assert.deepEqual(events.map((e) => e[0]), ['start', 'orientation']);
  assert.deepEqual(updatedRecords, []);
});

test('missing split cache uses installMultiple and removes its extracted files after success', async (t) => {
  const { installer, packageName, events } = installerFixture(t, { ordinaryInstallState: false, bundle: true });
  assert.deepEqual(await installer.launch(packageName), { ok: true, engine: 'base' });
  assert.deepEqual(events.map((e) => e[0]), ['installMultiple', 'invalidate', 'start', 'orientation', 'touch']);
  assert.ok(events[0][2].every((file) => !fs.existsSync(file)));
});

for (const bundle of [false, true]) {
  test('missing ' + (bundle ? 'split' : 'single') + ' cache with ABI mismatch reports original error and does not switch images',
    async (t) => {
      const installError = Object.assign(new Error('INSTALL_FAILED_NO_MATCHING_ABIS'), { code: 'NO_MATCHING_ABIS' });
      const { installer, packageName, events, updatedRecords } = installerFixture(t, {
        bundle, installError, ordinaryInstallState: false,
      });
      await assert.rejects(installer.launch(packageName), {
        code: 'APP_COMPAT_REQUIRED', cause: installError, message: /本次启动未切换镜像/,
      });
      assert.deepEqual(events.map((e) => e[0]), [bundle ? 'installMultiple' : 'install']);
      if (bundle) assert.ok(events[0][2].every((file) => !fs.existsSync(file)));
      assert.deepEqual(updatedRecords, []);
    });
}

test('the real dispatcher and Installer wait on one policy for delayed PID despite stale or unrelated crash lines', async (t) => {
  const { installer, packageName, client, updatedRecords } = installerFixture(t);
  const logTail = 'E/AndroidRuntime( 100): Process: ' + packageName + ', PID: 100\n'
    + 'E/AndroidRuntime( 100): previous launch UnsatisfiedLinkError\n'
    + 'F/DEBUG( 200): Cmdline: com.example.other\n'
    + 'F/DEBUG( 200): libndk_translation DoBadTrampoline';
  const commands = [];
  let pidProbes = 0;
  client.startApp = AdbClient.prototype.startApp;
  client.resolveLauncher = async () => packageName + '/.Main';
  client.waitAppAlive = assert.fail;
  client.shell = async (command) => {
    commands.push(command);
    if (command.startsWith('am start ')) return 'Starting: Intent';
    if (command.startsWith('pidof ' + packageName + ' ')) {
      pidProbes += 1;
      return pidProbes < 5 ? '__APKSTART_PID_ABSENT__' : '62';
    }
    if (command.includes('logcat')) return logTail;
    assert.fail('unexpected guest command: ' + command);
  };
  assert.deepEqual(await installer.launch(packageName), { ok: true, engine: 'base' });
  assert.equal(updatedRecords.length, 1);
  assert.equal(commands.filter((command) => command.startsWith('am start ')).length, 1);
  assert.equal(pidProbes, 8);
  assert.ok(!commands.some((command) => command.includes('logcat')));
});

test('an ABI rejection from the target launch command yields a neutral recovery hint and preserves its cause', async (t) => {
  const { installer, packageName, client, events, updatedRecords } = installerFixture(t);
  const refusal = Object.assign(new Error('command rejected'), { stdout: 'Error: INSTALL_FAILED_NO_MATCHING_ABIS' });
  client.startApp = AdbClient.prototype.startApp;
  client.resolveLauncher = async () => packageName + '/.Main';
  client.shell = async (command) => {
    assert.ok(command.startsWith('am start '));
    events.push(['start rejected']);
    throw refusal;
  };
  await assert.rejects(installer.launch(packageName), (error) => {
    assert.equal(error.code, 'APP_COMPAT_REQUIRED');
    assert.equal(error.cause.code, 'NO_MATCHING_ABIS');
    assert.equal(error.cause.cause, refusal);
    assert.match(error.message, /下载兼容镜像并重启运行时/);
    assert.doesNotMatch(error.message, /自动切换|手动切换|不丢失/);
    return true;
  });
  assert.deepEqual(events, [['start rejected']]);
  assert.deepEqual(updatedRecords, []);
});
