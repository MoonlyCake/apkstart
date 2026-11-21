'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { createAssociationService, createWindowsBackend, PROGID, DEFAULT_APPS_URI } = require('../src/core/assoc');

const ext = 'HKCU\\Software\\Classes\\.apk';
const commandKey = 'HKCU\\Software\\Classes\\ApkStart.apk\\shell\\open\\command';
const registryApp = 'HKCU\\Software\\RegisteredApplications';
const store = 'HKCU\\Software\\ApkStart';
const caps = store + '\\Capabilities';
const choice = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\FileExts\\.apk\\UserChoice';
const oldExe = 'F:\\APK 安装\\原版\\ApkStart.exe';
const currentExe = 'F:\\APK 安装\\新版\\ApkStart.exe';
const previousProg = 'BlueStacks.Apk';
const anotherProg = 'AnotherInstall.apks';
const defaultCommand = (exe, args = '') => '"' + exe + '" ' + (args ? args + ' ' : '') + '"%1"';

function fixture(initialShell, { fail = () => false } = {}) {
  const values = new Map();
  const updates = [];
  let shell = initialShell;
  const id = (key, name = '') => JSON.stringify([key, name]);
  const seed = (key, name, value, type = 'REG_SZ') => values.set(id(key, name), { type, value });
  const read = (key, name) => values.get(id(key, name)) || null;
  const backend = {
    read,
    write(key, name, value, type) {
      updates.push({ op: 'write', key, name, value, type });
      if (fail(key, name)) throw new Error('denied');
      seed(key, name, value, type);
    },
    remove(key, name) {
      updates.push({ op: 'remove', key, name });
      if (fail(key, name)) throw new Error('denied');
      values.delete(id(key, name));
    },
    resolve: async ({ refresh } = {}) => {
      const result = typeof shell === 'function' ? shell() : shell;
      return { ...result, refresh };
    },
  };
  return {
    api: createAssociationService(backend, { platform: 'win32' }), backend, seed, read, updates,
    setShell: (s) => { shell = s; },
  };
}

test('registered candidates are not the effective default; writes include Unicode and Windows capabilities', async () => {
  const f = fixture({ exe: 'C:\\Windows\\System32\\OpenWith.exe', command: null });
  f.seed(ext, '', previousProg);
  const result = await f.api.registerAssociation(currentExe);
  assert.equal(result.ok, false);
  assert.equal(result.registered, true);
  assert.equal(result.effective, false);
  assert.equal(result.needsDefaultSelection, true);
  assert.equal(result.settingsUri, DEFAULT_APPS_URI);
  assert.equal(f.read(registryApp, 'Apk Start --Q').value, 'Software\\ApkStart\\Capabilities');
  assert.equal(f.read(caps + '\\FileAssociations', '.apk').value, PROGID);
  assert.equal(f.read(commandKey, '').value, defaultCommand(currentExe));
  assert.equal(f.read(store, 'assocPrev').value, previousProg);
  assert.ok(f.updates.every(({ key }) => key !== choice));
  f.setShell({ exe: currentExe, command: defaultCommand(currentExe) });
  assert.deepEqual(await f.api.associationStatus(currentExe), { ok: true, registered: true, effective: true });
});

test('registration preserves a user-selected default and reports explicit next step', async () => {
  const f = fixture({ exe: 'E:\\BlueStacks.exe', command: null });
  f.seed(ext, '', previousProg);
  f.seed(choice, 'ProgId', previousProg);
  const result = await f.api.registerAssociation(currentExe);
  assert.equal(result.needsDefaultSelection, true);
  assert.equal(result.effective, false);
  assert.equal(f.read(ext, '').value, previousProg);
  assert.equal(f.read(choice, 'ProgId').value, previousProg);
  assert.ok(f.updates.every(({ key }) => key !== ext && key !== choice));
});

test('registration denied fails before replacing the fallback', async () => {
  const f = fixture({ exe: 'E:\\BlueStacks.exe', command: null }, { fail: (k) => k === registryApp });
  f.seed(ext, '', previousProg);
  const result = await f.api.registerAssociation(currentExe);
  assert.equal(result.ok, false);
  assert.equal(result.effective, false);
  assert.match(result.error, /denied/);
  assert.equal(f.read(ext, '').value, previousProg);
  assert.equal(f.read(commandKey, ''), null);
});

test('a missing launcher cannot be registered or reported as effective', async () => {
  const f = fixture({ exe: currentExe, command: defaultCommand(currentExe) });
  f.backend.isExecutable = () => false;
  f.seed(commandKey, '', defaultCommand(currentExe));
  assert.equal((await f.api.associationStatus(currentExe)).effective, false);
  const result = await f.api.registerAssociation(currentExe);
  assert.equal(result.ok, false);
  assert.deepEqual(f.updates, []);
});

test('unregistering an older installation leaves the active version and backup alone', async () => {
  const f = fixture({ exe: currentExe, command: defaultCommand(currentExe) });
  f.seed(ext, '', PROGID);
  f.seed(commandKey, '', defaultCommand(currentExe));
  f.seed(store, 'assocPrev', previousProg);
  const result = await f.api.unregisterAssociation(oldExe);
  assert.deepEqual(result, { ok: true, removed: false, skipped: true, restored: '' });
  assert.deepEqual(f.updates, []);
});

test('unregister restores an old fallback only while it still owns that fallback', async () => {
  for (const [fallback, expected, restored] of [[PROGID, previousProg, previousProg], [anotherProg, anotherProg, '']]) {
    const f = fixture({ exe: 'E:\\Other.exe', command: null });
    f.seed(ext, '', fallback);
    f.seed(commandKey, '', defaultCommand(currentExe));
    f.seed(store, 'assocPrev', previousProg);
    f.seed(caps + '\\FileAssociations', '.apk', PROGID);
    f.seed(registryApp, 'Apk Start --Q', 'Software\\ApkStart\\Capabilities');
    const result = await f.api.unregisterAssociation(currentExe);
    assert.deepEqual(result, { ok: true, removed: true, restored });
    assert.equal(f.read(ext, '').value, expected);
    assert.equal(f.read(commandKey, ''), null);
    assert.equal(f.read(registryApp, 'Apk Start --Q'), null);
  }
});

test('an explicit Windows choice for this installation is not broken by unregistering', async () => {
  for (const progId of [PROGID, 'Applications\\ApkStart.exe']) {
    const f = fixture({ exe: currentExe, command: defaultCommand(currentExe) });
    f.seed(ext, '', PROGID);
    f.seed(commandKey, '', defaultCommand(currentExe));
    f.seed(choice, 'ProgId', progId);
    const result = await f.api.unregisterAssociation(currentExe);
    assert.equal(result.ok, false);
    assert.equal(result.needsDefaultSelection, true);
    assert.equal(result.settingsUri, 'ms-settings:defaultapps');
    assert.deepEqual(f.updates, []);
  }
});

test('different launch arguments using the same executable are not the same default', async () => {
  const f = fixture({ exe: currentExe, command: defaultCommand(currentExe, '"F:\\copy-2"') });
  f.seed(commandKey, '', defaultCommand(currentExe, '"F:\\copy-1"'));
  const result = await f.api.associationStatus(currentExe, '"F:\\copy-1"');
  assert.equal(result.registered, true);
  assert.equal(result.effective, false);
});

test('the Windows bridge carries Unicode as encoded data, and generates parseable PowerShell', async () => {
  const scripts = [];
  const backend = createWindowsBackend({
    executeFile: async (_file, args) => {
      assert.deepEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
      const script = Buffer.from(args[3], 'base64').toString('utf16le');
      scripts.push(script);
      return { stdout: script.includes('AssocQueryStringW')
        ? JSON.stringify({ exe: currentExe, command: defaultCommand(currentExe) }) : 'true' };
    },
  });
  const value = defaultCommand(currentExe);
  await backend.writeMany([[commandKey, '', value]]);
  const encoded = /FromBase64String\('([^']+)'\)/.exec(scripts[0])[1];
  assert.deepEqual(JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')),
    [{ op: 'write', key: commandKey, name: '', value, type: 'REG_SZ' }]);
  assert.ok(!scripts[0].includes(currentExe));
  assert.deepEqual(await backend.resolve({ refresh: true }), { exe: currentExe, command: value });
  assert.match(scripts[1], /SHChangeNotify\(0x08000000/);
  if (process.platform !== 'win32') return;
  const parser = '$ProgressPreference="SilentlyContinue"; $issues=$null; $tokens=$null;'
    + ' [void][System.Management.Automation.Language.Parser]::ParseInput($env:MOCK_SCRIPT,[ref]$tokens,[ref]$issues);'
    + ' if($issues){$issues | ForEach-Object { [Console]::Error.WriteLine($_.Message) };exit 1}';
  for (const script of scripts) {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
      Buffer.from(parser, 'utf16le').toString('base64')], {
      env: { ...process.env, MOCK_SCRIPT: script }, windowsHide: true, timeout: 8000, encoding: 'utf8',
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr);
  }
});

const nsis = fs.readFileSync(path.join(__dirname, '..', 'build', 'installer.nsh'), 'utf8');
test('installer overrides electron-builder process handling without any global kill', () => {
  assert.match(nsis, /!macro customCheckAppRunning\b/);
  assert.match(nsis, /SetEnvironmentVariableW\(w "APKSTART_INSTALL_CHECK_ROOT", w "\$INSTDIR"/);
  assert.doesNotMatch(nsis, /\b(?:taskkill|Stop-Process)\b/i);
  assert.match(nsis, /SetErrorLevel 1\s+Quit/);
});

test('installer check ignores foreign matching processes, refuses on owned live or unknown paths',
  { skip: process.platform !== 'win32' }, () => {
    const extracted = /-Command "([^"]+)"/.exec(nsis);
    assert.ok(extracted);
    const command = extracted[1].replace(/\$\$/g, '$');
    // Supply a fake WMI result; the test never queries or closes actual Windows processes.
    const prefix = '$ProgressPreference="SilentlyContinue"\nfunction Get-CimInstance { if($env:MOCK_DENIED){throw "denied"}; return ($env:MOCK_PROCESSES | ConvertFrom-Json) }\n';
    const encoded = Buffer.from(prefix + command, 'utf16le').toString('base64');
    const root = "F:\\Apk ' $ Start";
    const run = (items, denied = false) => {
      const result = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        env: { ...process.env, APKSTART_INSTALL_CHECK_ROOT: root, MOCK_PROCESSES: JSON.stringify(items), MOCK_DENIED: denied ? '1' : '' },
        timeout: 8000, windowsHide: true, encoding: 'utf8',
      });
      assert.ifError(result.error);
      assert.equal(result.stderr.trim(), '');
      return result.status;
    };
    assert.equal(run([{ Name: 'adb.exe', ExecutablePath: 'C:\\Android\\adb.exe' },
      { Name: 'qemu-system-x86_64.exe', ExecutablePath: root + '-old\\qemu-system-x86_64.exe' }]), 0);
    assert.equal(run([{ Name: 'qemu-system-x86_64.exe', ExecutablePath: root + '\\qemu\\qemu-system-x86_64.exe' }]), 1);
    assert.equal(run([{ Name: 'adb.exe', ExecutablePath: null }]), 2);
    assert.equal(run([], true), 2);
  });
