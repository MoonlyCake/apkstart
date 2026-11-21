'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { scan } = require('../src/core/leftovers');
const { createDiagnosticsHandlers } = require('../src/ipc/handlers/diagnostics');

const options = { platform: 'linux', driveRoots: [], home: '', tempDir: '', env: {} };

function deferred() {
  let resolve;
  const promise = new Promise((yes) => { resolve = yes; });
  return { promise, resolve };
}

async function fixtureFile(file, contents, encoding) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, contents, encoding);
}

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'apkstart-leftovers-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin');
  const installDir = path.join(bin, 'ApkStart-current');
  const dataParent = path.join(bin, 'ApkStart-container');
  const dataDir = path.join(dataParent, 'user-data');
  const avdHome = path.join(bin, 'ApkStart-runtime');
  const old = path.join(bin, 'ApkStart-old.prev-backup');
  const notOurs = path.join(bin, 'ApkStart-same-name-only');
  await Promise.all([
    fixtureFile(path.join(installDir, 'ApkStart.exe'), 'current'),
    fixtureFile(path.join(dataParent, 'ApkStart.exe'), 'contains live data'),
    fixtureFile(path.join(avdHome, 'ApkStart.exe'), 'contains the live AVD'),
    fixtureFile(path.join(old, 'ApkStart.exe'), 'old'),
    fixtureFile(path.join(old, 'nested', 'bin.dat'), '12345'),
    fixtureFile(path.join(notOurs, 'ordinary.txt'), 'not an install'),
  ]);
  return { root, bin, installDir, dataDir, dataParent, avdHome, old, notOurs };
}

test('scan keeps old backups, cache and obsolete snapshots but excludes current storage', async (t) => {
  const f = await fixture(t);
  const tempDir = path.join(f.root, 'temp');
  const cache = path.join(f.dataDir, 'update', 'ApkStart-cache.zip');
  const download = path.join(tempDir, 'ApkStart-partial.part12');
  const snaps = path.join(f.avdHome, 'apkstart.avd', 'snapshots');
  const active = path.join(snaps, 'ApkStart'); // Case variation is the active snapshot on Windows.
  const obsolete = path.join(snaps, 'default_boot');
  const desktop = path.join(f.root, 'profile', 'Desktop');
  const portable = path.join(f.root, 'somewhere elsewhere', 'nested', 'ApkStart-from-link');
  await Promise.all([
    fixtureFile(cache, 'abc'),
    fixtureFile(download, '45'),
    fixtureFile(path.join(tempDir, 'other.zip'), 'do not scan'),
    fixtureFile(path.join(active, 'ram.img'), 'live snapshot'),
    fixtureFile(path.join(obsolete, 'ram.img'), 'old snap'),
    fixtureFile(path.join(portable, 'ApkStart.exe'), 'link'),
    fixtureFile(path.join(desktop, 'ApkStart.desktop'),
      `[Desktop Entry]\nExec="${path.join(portable, 'ApkStart.exe')}" --fixture\n`, 'utf8'),
  ]);
  const result = await scan(f, { ...options, tempDir, home: path.dirname(desktop) });
  assert.deepEqual(result.items.map(({ kind, path: filename, size }) => [kind, filename, size]), [
    ['dir', f.old, 8], ['dir', portable, 4], ['temp', cache, 3], ['temp', download, 2], ['dir', obsolete, 8],
  ]);
  assert.equal(result.totalBytes, 25);
  assert.equal(await fs.readFile(path.join(f.installDir, 'ApkStart.exe'), 'utf8'), 'current');
  assert.equal(await fs.readFile(path.join(active, 'ram.img'), 'utf8'), 'live snapshot');
  assert.equal(await fs.readFile(cache, 'utf8'), 'abc');
});

test('registry queries run asynchronously and only list demonstrably missing targets', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const gate = deferred();
  t.after(() => gate.resolve());
  const firstQuery = deferred();
  const deadPath = path.join(f.root, 'deleted install');
  const deniedPath = path.join(f.root, 'unknown install');
  const deadKey = 'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\ApkStart-dead';
  const liveKey = deadKey.replace(/-dead$/, '-live');
  const deniedKey = deadKey.replace(/-dead$/, '-inaccessible');
  const mockRegistry = [
    `${deadKey}\r\n    DisplayName    REG_SZ    ApkStart old\r\n    InstallLocation    REG_SZ    ${deadPath}`,
    `${liveKey}\r\n    InstallLocation    REG_SZ    ${f.installDir}\r\n    UninstallString    REG_SZ    "${path.join(f.installDir, 'missing.exe')}" /S`,
    `${deniedKey}\r\n    InstallLocation    REG_SZ    ${deniedPath}`,
  ].join('\r\n\r\n');
  const invocations = [];
  const runCommand = async (file, args, settings) => {
    invocations.push({ file, args, settings });
    firstQuery.resolve();
    await gate.promise;
    return { stdout: args[1].startsWith('HKCU') ? mockRegistry : '' };
  };

  const result = scan(f, {
    ...options, platform: 'win32', runCommand,
    io: { ...fs, lstat: async (filename) => {
      if (filename === deniedPath) throw Object.assign(new Error('inaccessible'), { code: 'EACCES' });
      return fs.lstat(filename);
    } },
  });
  let complete = false;
  result.then(() => { complete = true; });
  await firstQuery.promise;
  await new Promise(setImmediate);
  assert.equal(complete, false, 'main loop ran while registry query was in flight');
  assert.equal(invocations.length, 3);
  assert.ok(invocations.every(({ file, args, settings }) => file === 'reg'
    && args[0] === 'query' && settings.windowsHide && settings.timeout === 15000));
  gate.resolve();
  const entries = (await result).items.filter(({ kind }) => kind === 'registry');
  assert.deepEqual(entries.map(({ path: key }) => key), [deadKey]);
});

test('directory size keeps filesystem work bounded and yields during a large scan', { timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 70 }, (_, i) => fixtureFile(path.join(f.old, `asset-${i}.dat`), 'z')));
  const blocked = deferred();
  const gate = deferred();
  t.after(() => gate.resolve());
  let concurrent = 0;
  let peak = 0;
  const result = scan(f, {
    ...options, io: { ...fs, lstat: async (filename) => {
      if (!/^asset-\d+\.dat$/.test(path.basename(filename))) return fs.lstat(filename);
      concurrent++;
      peak = Math.max(peak, concurrent);
      blocked.resolve();
      await gate.promise;
      try { return await fs.lstat(filename); } finally { concurrent--; }
    } },
  });
  let complete = false;
  result.then(() => { complete = true; });
  await blocked.promise;
  await new Promise(setImmediate);
  assert.equal(complete, false, 'main loop ran while file stats were still blocked');
  assert.ok(peak >= 1 && peak <= 32, `unexpected parallelism: ${peak}`);
  gate.resolve();
  assert.equal((await result).items.find(({ path: filename }) => filename === f.old).size, 78);
  assert.ok(peak <= 32);
});

test('scan IPC awaits result and preserves the request scope and output shape', async () => {
  const exe = path.join(process.cwd(), 'fixture', 'ApkStart.exe');
  const gate = deferred();
  let given;
  const handlers = createDiagnosticsHandlers({
    path, app: { getPath: (key) => {
      assert.equal(key, 'exe');
      return exe;
    } },
    store: { DATA_DIR: 'fixture-data' },
    live: { runtime: { provisioner: { paths: () => ({ avdHome: 'fixture-avd' }) } } },
    leftovers: { async scan(scope) {
      given = scope;
      await gate.promise;
      return { items: [{ kind: 'temp', path: 'fixture-cache', size: 1 }], totalBytes: 1 };
    } },
  });
  const response = handlers['leftovers:scan']();
  assert.deepEqual(given, { installDir: path.dirname(exe), dataDir: 'fixture-data', avdHome: 'fixture-avd' });
  gate.resolve();
  assert.deepEqual(await response, {
    ok: true, items: [{ kind: 'temp', path: 'fixture-cache', size: 1 }], totalBytes: 1,
  });
});
