'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Updater } = require('../src/core/updater');
const { createUpdatesHandlers } = require('../src/ipc/handlers/updates');

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

test('prepare rejects foreign release assets before any download or cache write', async (t) => {
  const u = fixture(t);
  const name = 'ApkStart-v1.0.1-win64-portable.zip';
  for (const base of [upstream, gitee, 'https://mirror.invalid/' + releases]) {
    const url = asset(name, base).browser_download_url;
    await assert.rejects(u.prepare({ version: '1.0.1', tag, asset: { name, url } }), /Apk Start --Q/);
  }
  assert.equal(fs.existsSync(u.updateDir), false);
});

test('only the new update cache and its matching channel marker can resume', (t) => {
  const u = fixture(t);
  const makePayload = (root, version, marker) => {
    const payload = path.join(root, version, 'payload');
    fs.mkdirSync(payload, { recursive: true });
    fs.writeFileSync(path.join(payload, 'ApkStart.exe'), 'fixture');
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
  u._markPayloadReady(ready, '1.0.1');
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
