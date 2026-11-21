'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Sharer } = require('../src/core/sharer');

function fixture(t) {
  const tempBase = fs.realpathSync(os.tmpdir());
  const tmp = fs.mkdtempSync(path.join(tempBase, 'apkstart-share-'));
  t.after(() => {
    const target = fs.realpathSync(tmp);
    assert.equal(path.dirname(target), tempBase);
    fs.rmSync(target, { recursive: true, force: true });
  });
  const sharedDir = path.join(tmp, 'host');
  const deviceSharedDir = '/sdcard/Shared';
  const file = path.join(sharedDir, 'note.txt');
  const device = deviceSharedDir + '/note.txt';
  const stateFile = path.join(tmp, 'state.json');
  const files = new Map();
  let clock = 0;
  const put = (name, text) => {
    files.set(name, { data: Buffer.from(text), stamp: String(++clock).padStart(5, '0') });
  };
  const stat = (row) => row ? row.data.length + '|' + row.stamp + '|' + row.stamp : 'ABSENT';
  const client = {
    deviceState: async () => 'device',
    async shell(cmd) {
      const tokens = Array.from(cmd.matchAll(/'([^']*)'/g), (m) => m[1]);
      if (cmd.startsWith('mkdir -p ')) return '';
      if (cmd.startsWith('cd ')) {
        return [
          ...Array.from(files, ([name, row]) => stat(row) + '|./' + name.slice(deviceSharedDir.length + 1)),
          '__APKSTART_SHARED_SCAN_DONE__',
        ].join('\n');
      }
      if (cmd.startsWith('if [ -f ')) return stat(files.get(tokens[0]));
      if (cmd.startsWith('rm -f ')) { files.delete(tokens[0]); return ''; }
      if (cmd.startsWith('mv ')) {
        if (cmd.startsWith('mv -Tn ') && files.has(tokens[1])) return '';
        const row = files.get(tokens[0]);
        assert(row);
        files.delete(tokens[0]);
        put(tokens[1], row.data);
        return '';
      }
      if (cmd.startsWith('sha256sum ')) {
        return createHash('sha256').update(files.get(tokens[0]).data).digest('hex') + '  ' + tokens[0];
      }
      throw new Error('Unexpected fixture command: ' + cmd);
    },
    async push(local, remote) { put(remote, fs.readFileSync(local)); },
    async pull(remote, local) { fs.writeFileSync(local, files.get(remote).data); },
  };
  const runtime = { guestGeneration: 1, async _networkEndpoint() { return { client, revalidate: async () => true }; } };
  const settings = () => ({ sharedDir, deviceSharedDir, runtime: { avdDir: 'fixture' } });
  const sharer = new Sharer(runtime, { settings, stateFile });
  const write = (text) => { fs.mkdirSync(sharedDir, { recursive: true }); fs.writeFileSync(file, text); };
  const host = () => fs.readFileSync(file, 'utf8');
  const guest = () => files.get(device)?.data.toString();
  const state = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  return { runtime, client, sharer, sharedDir, file, device, stateFile, state, write, put, host, guest };
}

test('same-size Android edits after a Windows push pull once and then remain stable', async (t) => {
  const f = fixture(t);
  f.write('AAAA');
  assert.deepEqual(await f.sharer.sync(), { ok: true, pushed: 1, pulled: 0, errors: [], conflicts: [] });
  assert.equal(f.guest(), 'AAAA');
  const initial = f.state().entries['note.txt'];
  f.put(f.device, 'BBBB');
  assert.deepEqual(await f.sharer.sync(), { ok: true, pushed: 0, pulled: 1, errors: [], conflicts: [] });
  assert.equal(f.host(), 'BBBB');
  assert.notDeepEqual(f.state().entries['note.txt'].remote, initial.remote);
  assert.deepEqual(await f.sharer.sync(), { ok: true, pushed: 0, pulled: 0, errors: [], conflicts: [] });
});

test('simultaneous edits preserve both copies and do not advance the checkpoint', async (t) => {
  const f = fixture(t);
  f.write('ORIGINAL');
  assert.equal((await f.sharer.sync()).ok, true);
  const before = f.state();
  f.write('Windows edited');
  f.put(f.device, 'Android edited');
  const result = await f.sharer.sync();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SHARE_PARTIAL');
  assert.deepEqual(result.conflicts, ['note.txt']);
  assert.deepEqual(f.state(), before);
  assert.equal(f.host(), 'Windows edited');
  assert.equal(f.guest(), 'Android edited');
});

test('legacy up markers are not trusted, even if both sides have kept the file size', async (t) => {
  const f = fixture(t);
  f.write('AAAA');
  f.put(f.device, 'BBBB');
  const legacy = { 'note.txt': { size: 4, lmtime: 1000, rmtime: 2000, dir: 'up' } };
  fs.writeFileSync(f.stateFile, JSON.stringify(legacy));
  const result = await f.sharer.sync();
  assert.equal(result.ok, false);
  assert.deepEqual(result.conflicts, ['note.txt']);
  assert.deepEqual(f.state(), legacy);
  assert.equal(f.host(), 'AAAA');
  assert.equal(f.guest(), 'BBBB');
});

test('identical first-seen files are reconciled without copying', async (t) => {
  const f = fixture(t);
  f.write('AAAA');
  f.put(f.device, 'AAAA');
  assert.deepEqual(await f.sharer.sync(), { ok: true, pushed: 0, pulled: 0, errors: [], conflicts: [] });
  assert(f.state().entries['note.txt']);
});

test('failed transfers preserve destination bytes, do not advance state and can be retried', async (t) => {
  const f = fixture(t);
  f.write('FIRST');
  assert.equal((await f.sharer.sync()).ok, true);
  const initial = f.state();
  f.put(f.device, 'LATER');
  const pull = f.client.pull;
  f.client.pull = async (_remote, temp) => {
    fs.writeFileSync(temp, 'L');
    throw new Error('test transport interrupted');
  };
  const result = await f.sharer.sync();
  assert.equal(result.ok, false);
  assert.equal(result.code, 'SHARE_PARTIAL');
  assert.match(result.errors[0], /interrupted/);
  assert.equal(f.host(), 'FIRST');
  assert.deepEqual(f.state(), initial);
  assert.deepEqual(fs.readdirSync(f.sharedDir), ['note.txt']);
  f.client.pull = pull;
  assert.equal((await f.sharer.sync()).pulled, 1);
  assert.equal(f.host(), 'LATER');
});

test('distinguishes an unauthorized guest, an existing sync, and a failed inventory', async (t) => {
  const f = fixture(t);
  f.client.deviceState = async () => 'unauthorized';
  const offline = await f.sharer.sync();
  assert.equal(offline.ok, false);
  assert.equal(offline.code, 'SHARE_OFFLINE');
  assert.equal(fs.existsSync(f.sharedDir), false);

  let answer;
  f.client.deviceState = () => new Promise((resolve) => { answer = resolve; });
  const pending = f.sharer.sync();
  assert.equal((await f.sharer.sync()).code, 'SHARE_BUSY');
  answer('device');
  assert.equal((await pending).ok, true);

  f.write('saved');
  f.client.deviceState = async () => 'device';
  const shell = f.client.shell;
  f.client.shell = (cmd) => cmd.startsWith('cd ') ? 'partial list' : shell(cmd);
  const failed = await f.sharer.sync();
  assert.equal(failed.code, 'SHARE_SYNC_FAILED');
  assert.equal(f.guest(), undefined);
});

test('does not publish a download to the host after the owned guest changes', async (t) => {
  const f = fixture(t);
  f.write('FIRST');
  assert.equal((await f.sharer.sync()).ok, true);
  const initial = f.state();
  f.put(f.device, 'LATER');
  const pull = f.client.pull;
  f.client.pull = async (...args) => { await pull(...args); f.runtime.guestGeneration += 1; };
  assert.equal((await f.sharer.sync()).ok, false);
  assert.equal(f.host(), 'FIRST');
  assert.deepEqual(f.state(), initial);
});

test('does not overwrite an Android destination created while an upload is staged', async (t) => {
  const f = fixture(t);
  f.write('FIRST');
  const shell = f.client.shell;
  f.client.shell = (cmd) => {
    if (cmd.startsWith('mv -Tn ')) f.put(f.device, 'LATER');
    return shell(cmd);
  };
  const result = await f.sharer.sync();
  assert.equal(result.ok, false);
  assert.equal(result.pushed, 0);
  assert.equal(f.host(), 'FIRST');
  assert.equal(f.guest(), 'LATER');
  assert.equal(fs.existsSync(f.stateFile), false);
});

test('migration rejects a child of the current directory before creating anything', async (t) => {
  const f = fixture(t);
  f.write('FIRST');
  const child = path.join(f.sharedDir, 'child');
  await assert.rejects(f.sharer.changeLocalDir(child, {
    migrate: true, commit: () => assert.fail('must not commit'),
  }), /上级或子目录/);
  assert.equal(fs.existsSync(child), false);
  assert.equal(f.host(), 'FIRST');
});

test('migration detects all existing target conflicts before any copy and does not save settings', async (t) => {
  const f = fixture(t);
  f.write('FIRST');
  fs.writeFileSync(path.join(f.sharedDir, 'a.txt'), 'a separate file');
  const to = path.join(path.dirname(f.sharedDir), 'new');
  fs.mkdirSync(to);
  fs.writeFileSync(path.join(to, 'note.txt'), 'NEWER');
  await assert.rejects(f.sharer.changeLocalDir(to, {
    migrate: true, commit: () => assert.fail('must not commit'),
  }), /不同内容的同名文件/);
  assert.deepEqual(fs.readdirSync(to), ['note.txt']);
  assert.equal(fs.readFileSync(path.join(to, 'note.txt'), 'utf8'), 'NEWER');
});

test('migration preserves the old directory and identical files, publishing settings only after copying', async (t) => {
  const f = fixture(t);
  f.write('FIRST');
  fs.mkdirSync(path.join(f.sharedDir, 'nested'));
  fs.writeFileSync(path.join(f.sharedDir, 'nested', 'new.txt'), 'DATA');
  const to = path.join(path.dirname(f.sharedDir), 'new');
  fs.mkdirSync(to);
  fs.writeFileSync(path.join(to, 'note.txt'), 'FIRST');
  const inode = fs.statSync(path.join(to, 'note.txt')).mtimeMs;
  let committed;
  const migrated = await f.sharer.changeLocalDir(to, {
    migrate: true, commit: async (dir) => {
      assert.equal(fs.readFileSync(path.join(to, 'nested', 'new.txt'), 'utf8'), 'DATA');
      assert.equal((await f.sharer.sync()).code, 'SHARE_BUSY');
      committed = dir;
    },
  });
  assert.equal(migrated.path, committed);
  assert.equal(migrated.copied, 1);
  assert.equal(migrated.unchanged, 1);
  assert.equal(fs.statSync(path.join(to, 'note.txt')).mtimeMs, inode);
  assert.equal(f.host(), 'FIRST');
});

test('a settings write failure after migration explicitly reports already-created files', async (t) => {
  const f = fixture(t);
  f.write('FIRST');
  const to = path.join(path.dirname(f.sharedDir), 'new');
  await assert.rejects(f.sharer.changeLocalDir(to, {
    migrate: true, commit: () => { throw new Error('test write refused'); },
  }), /未切换.*已复制 1 个文件.*test write refused/);
  assert.equal(f.host(), 'FIRST');
  assert.equal(fs.readFileSync(path.join(to, 'note.txt'), 'utf8'), 'FIRST');
});
