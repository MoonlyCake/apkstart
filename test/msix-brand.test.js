'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const path = require('node:path');

const build = path.join(__dirname, '../build/msix.js');
const env = Object.fromEntries(Object.entries(process.env)
  .filter(([name]) => !/^APKSTART_MSIX_/i.test(name)));

function run(...args) {
  const result = spawnSync(process.execPath, [build, '--print-manifest', ...args], { encoding: 'utf8', env });
  assert.ifError(result.error);
  return result;
}

test('default local MSIX manifest shows the maintainer, not the upstream publisher', () => {
  const r = run();
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /<Identity\s+Name="MoonlyCake\.ApkStart"\s+Publisher="CN=MoonlyCake"/u);
  assert.match(r.stdout, /<PublisherDisplayName>MoonlyCake<\/PublisherDisplayName>/u);
  assert.doesNotMatch(r.stdout, /RoutineMiku|58CA1DED/i);
});

test('store manifest requires three account values and rejects local or upstream ownership', () => {
  const missing = run('--store');
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /Partner Center/);
  assert.equal(missing.stdout, '');
  const local = run('--store', '--identity', 'MoonlyCake.ApkStart', '--publisher', 'CN=MoonlyCake',
    '--publisherDisplay', 'MoonlyCake');
  assert.equal(local.status, 3);
  const upstream = run('--store', '--identity', 'RoutineMiku.ApkStart',
    '--publisher', 'CN=58CA1DED-8AB3-4D0D-AF50-62C9B781AA4D', '--publisherDisplay', 'MoonlyCake');
  assert.equal(upstream.status, 3);
  assert.match(upstream.stderr, /上游/);
});

test('store manifest uses the explicit publisher and safely renders XML characters', () => {
  const fields = ['--store', '--identity', 'MoonlyCake.ApkStart', '--publisher', 'CN=Publisher & Store',
    '--publisherDisplay', 'MoonlyCake & Team', '--display', 'Apk Start "Q"'];
  const r = run(...fields);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /Name="MoonlyCake\.ApkStart"\s+Publisher="CN=Publisher &amp; Store"/u);
  assert.match(r.stdout, /<PublisherDisplayName>MoonlyCake &amp; Team<\/PublisherDisplayName>/u);
  assert.match(r.stdout, /DisplayName="Apk Start &quot;Q&quot;"/u);
  const signed = run(...fields, '--sign');
  assert.equal(signed.status, 3);
  assert.match(signed.stderr, /--sign/);
});
