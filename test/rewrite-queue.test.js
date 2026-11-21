'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { OperationQueue } = require('../src/application/operation-queue');

function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test('three overlapping requests never overtake or run together', async () => {
  const queue = new OperationQueue();
  const gates = Array.from({ length: 3 }, deferred);
  const started = Array.from({ length: 3 }, deferred);
  const calls = [];
  const keys = ['launch:com.first.app', 'install', 'launch:com.third.app'];
  const pending = keys.map((key, i) => queue.run(key, async () => {
    calls.push(`start:${key}`);
    started[i].resolve();
    await gates[i].promise;
    calls.push(`end:${key}`);
    return key;
  }));
  for (const [i, key] of keys.entries()) {
    await started[i].promise;
    assert.equal(calls.at(-1), `start:${key}`);
    assert.equal(calls.length, i * 2 + 1);
    gates[i].resolve();
  }
  assert.deepEqual(await Promise.all(pending), keys);
  assert.deepEqual(calls, keys.flatMap((key) => [`start:${key}`, `end:${key}`]));
  assert.equal(queue.size, 0);
});

test('duplicate keys coalesce even before the queued task starts', async () => {
  const queue = new OperationQueue();
  const hold = deferred();
  const first = queue.run('install', () => hold.promise);
  let starts = 0;
  const key = 'launch:com.example.app';
  const work = () => ++starts;
  const launch = queue.run(key, work);
  assert.equal(queue.run(key, work), launch);
  assert.equal(queue.has(key), true);
  hold.resolve();
  await first;
  assert.equal(await launch, 1);
  assert.equal(queue.has(key), false);
  assert.equal(await queue.run(key, work), 2);
});

test('failed task releases its key and does not cancel queued or later work', async () => {
  const queue = new OperationQueue();
  const error = new Error('guest offline');
  const failure = queue.run('install', () => { throw error; });
  const next = queue.run('launch:com.example.app', () => 'ok');
  await assert.rejects(failure, (actual) => actual === error);
  assert.equal(await next, 'ok');
  assert.equal(await queue.run('install', () => 'recovered'), 'recovered');
});

test('keeps one successful early attach in flight and does not attach twice', async () => {
  const { createWindowAttachment } = require('../src/application/window-attachment');
  const gate = deferred();
  let attempts = 0;
  const attachment = createWindowAttachment(() => { attempts++; return gate.promise; });
  const early = attachment.startEarly();
  assert.equal(attachment.startEarly(), early);
  const final = attachment.finish();
  await Promise.resolve();
  assert.equal(attempts, 1);
  gate.resolve(true);
  assert.equal(await final, true);
  assert.equal(attempts, 1);
});

test('retries a failed early attach after the guest is stable', async () => {
  const { createWindowAttachment } = require('../src/application/window-attachment');
  let attempts = 0;
  const attachment = createWindowAttachment(() => {
    if (++attempts === 1) throw new Error('no emulator window yet');
    return true;
  });
  assert.equal(await attachment.startEarly(), false);
  assert.equal(await attachment.finish(), true);
  assert.equal(attempts, 2);
});

test('shortcut parsing rejects unsupported package names without entering silent launch', () => {
  const { validPackageName } = require('../src/core/pkgname');
  const fs = require('node:fs');
  const vm = require('node:vm');
  const main = fs.readFileSync(require.resolve('../src/main.js'), 'utf8');
  const parser = main.slice(main.indexOf('function parseArgs(argv)'), main.indexOf('/** Chromium 能解 WebP'));
  const parse = vm.runInNewContext(parser + '\nparseArgs', { IS_DEV: false, validPackageName });
  const invalid = parse(['ApkStart.exe', '--launch', 'com.123']);
  assert.equal(invalid.launch, null);
  assert.equal(invalid.silent, false);
  assert.match(invalid.error, /包名/);
  assert.equal(parse(['ApkStart.exe', '--launch', 'com.good.app']).launch, 'com.good.app');
  assert.equal(parse(['ApkStart.exe', 'F:/空 格/game.xapk']).apk, 'F:/空 格/game.xapk');
});

test('bound attach retries cannot run against the next app window', async () => {
  const fs = require('node:fs');
  const vm = require('node:vm');
  const source = fs.readFileSync(require.resolve('../src/main.js'), 'utf8');
  const body = source.slice(source.indexOf('async function attachAppWindow('), source.indexOf('/**\n * 打开（或复用）'));
  const delayed = deferred();
  let attempts = 0;
  let resume;
  const appWin = { win: {}, isOpen: true, embed: async () => { attempts++; return false; } };
  const attach = vm.runInNewContext(body + '\nattachAppWindow', {
    appWin, displaySettings: () => ({ windowEmbed: true }),
    setTimeout: (candidate) => { resume = candidate; delayed.resolve(); },
  });
  const result = attach();  // Explicit orientation rotation also calls it directly.
  await delayed.promise;
  assert.equal(attempts, 1);
  appWin.win = {}; // Windows opened a different shell during the retry delay.
  resume();
  assert.equal(await result, false);
  assert.equal(attempts, 1);
});
