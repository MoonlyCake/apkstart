'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { Updater } = require('../src/core/updater');
const { createUpdatesHandlers } = require('../src/ipc/handlers/updates');
const { writeUpdatePayload } = require('./helpers/update-fixture');
const { buildStoredZip } = require('./lib/make-apk');

const releases = 'https://github.com/MoonlyCake/apkstart/releases';
const latest = 'https://api.github.com/repos/MoonlyCake/apkstart/releases/latest';
const upstream = 'https://github.com/RoutineMiku/apkstart/releases';
const gitee = 'https://gitee.com/RoutineMiku/apkstart/releases';
const tag = 'v1.0.1';

function fixture(t, fetchRelease = async () => { throw new Error('unexpected network request'); }) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-q-update-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  return new Updater({
    currentVersion: '1.0.0', exePath: path.join(dataDir, 'ApkStart.exe'),
    isPackaged: true, dataDir, fetchRelease,
    settings: () => ({ runtime: { sourcePreference: 'gitee', mirrorPrefix: 'https://mirror.invalid/' } }),
  });
}

function asset(name, base = releases, releaseTag = tag) {
  return { name, size: 1024, browser_download_url: base + '/download/' + releaseTag + '/' + name };
}

test('no published Q release returns no update without consulting runtime mirrors or upstream', async (t) => {
  const calls = [];
  const u = fixture(t, async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error');
    return new Response(null, { status: 404 });
  });
  const info = await u.check();
  assert.equal(info.hasUpdate, false);
  assert.equal(info.current, '1.0.0');
  assert.equal(info.releasePublished, false);
  assert.equal(info.asset, null);
  assert.equal(info.htmlUrl, releases);
  await u.check();
  await u.check({ force: true });
  assert.deepEqual(calls, [latest, latest]);
});

test('only exact downloads from the fork and matching release tag are eligible', async (t) => {
  const full = 'ApkStart-v1.0.1-win64-portable.zip';
  const setup = 'ApkStart-1.0.1-Setup.exe';
  const app = 'ApkStart-v1.0.1-app.zip';
  const manifest = 'ApkStart-v1.0.1-manifest.json';
  const u = fixture(t, async (url) => {
    assert.equal(url, latest);
    return Response.json({
      tag_name: tag, html_url: gitee + '/tag/' + tag,
      assets: [
        asset(full, upstream), asset(full, gitee), asset(full, releases, 'v1.0.0'),
        asset('ApkStart-runtime-v1.0.1.zip'), asset(full), asset(setup), asset(app), asset(manifest),
      ],
    });
  });
  const portable = await u.check();
  assert.equal(portable.hasUpdate, true);
  assert.equal(portable.releasePublished, true);
  assert.equal(portable.htmlUrl, releases + '/tag/' + tag);
  assert.equal(portable.asset.url, asset(full).browser_download_url);
  assert.equal(portable.assets.length, 5);
  assert.equal(portable.incremental.app.name, app);
  assert.equal(portable.incremental.manifest.name, manifest);

  fs.writeFileSync(path.join(u.installDir, 'Uninstall ApkStart.exe'), 'fixture');
  const installed = await u.check();
  assert.equal(installed.asset.url, asset(setup).browser_download_url);
  assert.equal(installed.incremental, null);
});

test('remote checks fail visibly on HTTP errors without consulting upstream', async (t) => {
  const calls = [];
  const u = fixture(t, async (url) => {
    calls.push(url);
    return new Response(null, { status: 403 });
  });
  await assert.rejects(u.check(), /HTTP 403/);
  assert.deepEqual(calls, [latest]);
});

test('overlapping automatic and manual release checks share one request and recover after failure', async (t) => {
  let requests = 0;
  let release;
  const u = fixture(t, () => {
    requests++;
    return new Promise((resolve) => { release = resolve; });
  });
  const automatic = u.check();
  const manual = u.check({ force: true });
  assert.equal(requests, 1, 'automatic and manual checks must not race the release cache');
  release(new Response(null, { status: 503 }));
  const failures = await Promise.allSettled([automatic, manual]);
  for (const failure of failures) {
    assert.equal(failure.status, 'rejected');
    assert.match(failure.reason.message, /HTTP 503/);
  }

  const retry = u.check();
  assert.equal(requests, 2, 'a failed request must not pin the shared promise');
  release(Response.json({ tag_name: tag }));
  assert.equal((await retry).version, '1.0.1');
  assert.equal((await u.check()).version, '1.0.1');
  assert.equal(requests, 2, 'a successful result must still be cached');
  const refresh = u.check({ force: true });
  const passive = u.check();
  assert.equal(requests, 3, 'force bypasses the settled cache, not an in-flight request');
  release(Response.json({ tag_name: 'v1.0.2' }));
  assert.equal((await refresh).version, '1.0.2');
  assert.equal((await passive).version, '1.0.2');
});

test('prepare rejects foreign release assets before any download or cache write', async (t) => {
  const u = fixture(t);
  const name = 'ApkStart-v1.0.1-win64-portable.zip';
  for (const base of [upstream, gitee, 'https://mirror.invalid/' + releases]) {
    const url = asset(name, base).browser_download_url;
    await assert.rejects(u.prepare({ version: '1.0.1', tag, asset: { name, url } }), /Apk Start --Q/);
  }
  assert.equal(fs.existsSync(u.updateDir), false);
});

test('only the new update cache and its matching channel marker can resume', async (t) => {
  const u = fixture(t);
  const makePayload = (root, version, marker) => {
    const payload = path.join(root, version, 'payload');
    writeUpdatePayload(payload, version);
    fs.writeFileSync(path.join(payload, '.apkstart-ready'), JSON.stringify({ version, mode: 'zip', ...marker }));
    return payload;
  };
  const old = makePayload(path.join(u.dataDir, 'update'), '99.0.0');
  const unverified = makePayload(u.updateDir, '88.0.0');
  const foreign = makePayload(u.updateDir, '77.0.0', { channel: 'RoutineMiku/apkstart' });
  assert.equal(u.findResumableJob(), null);
  for (const payload of [old, unverified, foreign]) {
    assert.equal(fs.readFileSync(path.join(payload, 'ApkStart.exe'), 'utf8'), 'fixture');
  }
  const ready = makePayload(u.updateDir, '1.0.1');
  await u._markPayloadReady(ready, '1.0.1');
  assert.deepEqual(u.findResumableJob(), { mode: 'zip', payload: ready, version: '1.0.1' });
});

test('manual downloads never send the user to upstream or an arbitrary page', () => {
  const opened = [];
  const handler = createUpdatesHandlers({
    Updater,
    shell: { openExternal: async (url) => opened.push(url) },
  })['app:updateOpen'];
  const allowed = releases + '/tag/' + tag;
  assert.equal(handler(null, allowed).target, allowed);
  for (const url of [undefined, upstream + '/tag/' + tag, gitee, releases + '/download/' + tag + '/a.exe']) {
    assert.equal(handler(null, url).target, releases);
  }
  assert.deepEqual(opened, [allowed, releases, releases, releases, releases]);
});

async function markedUpdate(u, mode = 'zip') {
  const version = '1.0.1';
  const payload = path.join(u.updateDir, version, mode === 'zip' ? 'payload' : 'app-payload');
  writeUpdatePayload(payload, version, mode);
  await u._markPayloadReady(payload, version, mode);
  return { mode, payload, version };
}

test('resume ignores a ready marker when the cached entrypoint is missing', async (t) => {
  const u = fixture(t);
  const job = await markedUpdate(u, 'app');
  assert.deepEqual(u.findResumableJob(), job);
  fs.unlinkSync(path.join(job.payload, 'resources/app/src/main.js'));
  assert.equal(u.findResumableJob(), null);
});

test('preparing a same-size corrupted portable payload repairs it instead of reporting ready', async (t) => {
  const u = fixture(t);
  const job = await markedUpdate(u);
  const names = ['ApkStart.exe', 'resources.pak', 'icudtl.dat', 'resources/app/package.json', 'resources/app/src/main.js'];
  const zip = buildStoredZip(names.map((name) => ({ name, data: fs.readFileSync(path.join(job.payload, name)) })));
  const file = path.join(job.payload, 'resources.pak');
  fs.writeFileSync(file, 'Resources.pak');
  let requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    res.setHeader('Content-Length', zip.length);
    res.end(zip);
  });
  await new Promise((resolve, reject) => server.listen(0, '127.0.0.1', resolve).once('error', reject));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}/fixture.zip`;
  const info = { version: job.version, asset: { name: 'ApkStart-portable.zip', size: zip.length } };
  assert.deepEqual(await u._prepareFull(info, path.dirname(job.payload), url), job);
  assert.ok(requests > 0, 'corrupt staged bytes must not bypass download');
  assert.equal(fs.readFileSync(file, 'utf8'), 'resources.pak');

  const completed = requests;
  await u._prepareFull(info, path.dirname(job.payload), url);
  assert.equal(requests, completed, 'an intact payload must still avoid redownload');
});

test('cached tampering of the same size fails preflight and will not trigger auto-replay', async (t) => {
  const u = fixture(t);
  const job = await markedUpdate(u);
  fs.writeFileSync(path.join(job.payload, 'resources.pak'), 'Resources.pak');
  assert.deepEqual(u.findResumableJob(), job, 'the cheap discovery check confirms shape only');
  await assert.rejects(u.apply(job, { resume: true }), /校验失败/);
  assert.equal(u.findResumableJob(), null);
  assert.ok(fs.existsSync(path.join(u.updateDir, job.version, '.apkstart-apply-attempted')));
  assert.equal(fs.readFileSync(path.join(job.payload, 'resources.pak'), 'utf8'), 'Resources.pak');
});

test('an already attempted cache is skipped even if its verified bytes are still present', async (t) => {
  const u = fixture(t);
  const job = await markedUpdate(u);
  fs.writeFileSync(path.join(u.updateDir, job.version, '.apkstart-apply-attempted'), '');
  assert.equal(u.findResumableJob(), null);
  assert.ok(fs.existsSync(path.join(job.payload, 'ApkStart.exe')));
});

const onWindows = { skip: process.platform !== 'win32' };
function runApplyScript(u, job, injected = '') {
  const script = injected + '\r\n' + u.apply(job, { spawn: false, waitPid: 0, relaunch: false });
  const exe = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return spawnSync(exe, ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
    windowsHide: true, encoding: 'utf8', timeout: 15000,
  });
}

test('Windows staged update replaces package code and preserves a bundled runtime in light update', onWindows, async (t) => {
  const u = fixture(t);
  writeUpdatePayload(u.installDir, '1.0.0');
  const runtime = path.join(u.installDir, 'resources/runtime');
  fs.mkdirSync(runtime);
  fs.writeFileSync(path.join(runtime, 'existing'), 'keep runtime');
  fs.writeFileSync(path.join(u.installDir, 'resources/app/src/obsolete.js'), 'old-only code');
  const job = await markedUpdate(u);
  const result = runApplyScript(u, job);
  const log = fs.readFileSync(path.join(u.updateDir, 'update.log'), 'utf8');
  assert.equal(result.status, 0, log + (result.stderr || result.error?.message || ''));
  assert.ok(!fs.existsSync(path.join(u.installDir, 'resources/app/src/obsolete.js')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(u.installDir, 'resources/app/package.json'))).version, '1.0.1');
  assert.equal(fs.readFileSync(path.join(runtime, 'existing'), 'utf8'), 'keep runtime');
  assert.match(log, /update verified/);
});

test('Windows move failure after earlier entries switched restores all old bytes', onWindows, async (t) => {
  const u = fixture(t);
  writeUpdatePayload(u.installDir, '1.0.0');
  fs.writeFileSync(u.exePath, 'original executable');
  fs.writeFileSync(path.join(u.installDir, 'zz-fault.dll'), 'original library');
  const job = await markedUpdate(u);
  fs.writeFileSync(path.join(job.payload, 'zz-fault.dll'), 'new library');
  await u._markPayloadReady(job.payload, job.version);
  const hook = String.raw`
function Move-Item([string]$LiteralPath,[string]$Destination) {
  if ($LiteralPath -match '[\\/]stage[\\/].*zz-fault.dll$') { throw 'injected move error' }
  Microsoft.PowerShell.Management\Move-Item -LiteralPath $LiteralPath -Destination $Destination
}`;
  const result = runApplyScript(u, job, hook);
  assert.equal(result.status, 1, result.stderr || result.error?.message);
  assert.equal(fs.readFileSync(u.exePath, 'utf8'), 'original executable');
  assert.equal(fs.readFileSync(path.join(u.installDir, 'zz-fault.dll'), 'utf8'), 'original library');
  assert.equal(JSON.parse(fs.readFileSync(path.join(u.installDir, 'resources/app/package.json'))).version, '1.0.0');
  assert.ok(fs.existsSync(path.join(job.payload, 'zz-fault.dll')));
  const log = fs.readFileSync(path.join(u.updateDir, 'update.log'), 'utf8');
  assert.match(log, /update failed: injected move error/);
  assert.doesNotMatch(log, /update verified/);
  assert.match(u.takeApplyFailure().error, /v1\.0\.1 未完成/);
  assert.equal(u.takeApplyFailure(), null);
});

test('a nonzero Windows installer exit keeps its download and never logs update success', onWindows, (t) => {
  const u = fixture(t);
  const version = '1.0.1';
  const payload = path.join(u.updateDir, version, 'ApkStart-1.0.1-Setup.exe');
  const contents = 'placeholder, launch intercepted in the generated script fixture';
  fs.mkdirSync(path.dirname(payload), { recursive: true });
  fs.writeFileSync(payload, contents);
  const hook = `
function Start-Process([string]$FilePath,[string]$ArgumentList,[string]$WindowStyle,[switch]$PassThru,[switch]$Wait) {
  return [pscustomobject]@{ ExitCode=23 }
}`;
  const result = runApplyScript(u, { version, mode: 'setup', payload, sha256: createHash('sha256').update(contents).digest('hex') }, hook);
  assert.equal(result.status, 1, result.stderr || result.error?.message);
  assert.equal(fs.readFileSync(payload, 'utf8'), contents);
  const log = fs.readFileSync(path.join(u.updateDir, 'update.log'), 'utf8');
  assert.match(log, /Installer failed \(exit 23\)/);
  assert.doesNotMatch(log, /update verified/);
});
