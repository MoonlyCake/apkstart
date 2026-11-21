'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Sharer } = require('../src/core/sharer');

function fixture(t) {
  const temp = fs.realpathSync(os.tmpdir());
  const root = fs.mkdtempSync(path.join(temp, 'apkstart-share-publish-'));
  t.after(() => {
    const target = fs.realpathSync(root);
    assert.equal(path.dirname(target), temp);
    fs.rmSync(target, { recursive: true, force: true });
  });
  const sharedDir = path.join(root, 'shared');
  const deviceSharedDir = '/sdcard/TestShare';
  const local = path.join(sharedDir, 'note.txt');
  const remote = `${deviceSharedDir}/note.txt`;
  const stateFile = path.join(root, 'shared-state.json');
  fs.mkdirSync(sharedDir);
  const putHost = (text) => fs.writeFileSync(local, text, 'utf8');
  putHost('original');
  const stat = fs.lstatSync(local, { bigint: true });
  const hostBefore = { size: Number(stat.size), stamp: `${stat.mtimeNs}|${stat.ctimeNs}` };
  const remoteBefore = { size: 8, stamp: 'first|first' };
  const scope = JSON.stringify([sharedDir, deviceSharedDir, 'fixture']);
  const checkpoint = { version: 2, scope, entries: { 'note.txt': { local: hostBefore, remote: remoteBefore } } };
  fs.writeFileSync(stateFile, JSON.stringify(checkpoint));

  let delivered = false;
  let revalidate = 0;
  const guestText = 'Android edited';
  const guestStat = `${Buffer.byteLength(guestText)}|second|second`;
  const hooks = {};
  const client = {
    deviceState: async () => 'device',
    async shell(command) {
      if (command.startsWith('mkdir -p ')) return '';
      if (command.startsWith('cd ')) return `${guestStat}|./note.txt\n__APKSTART_SHARED_SCAN_DONE__`;
      if (command.startsWith('if [ -f ') && command.includes(remote)) {
        if (delivered) hooks.afterDownloadStat?.();
        return guestStat;
      }
      assert.fail(`unexpected read-only fixture command: ${command}`);
    },
    async pull(source, staged) {
      assert.equal(source, remote);
      fs.writeFileSync(staged, guestText);
      delivered = true;
    },
  };
  const runtime = {
    guestGeneration: 1,
    async _networkEndpoint() {
      return { client, revalidate: async () => {
        if (delivered) hooks.afterDownloadLease?.(++revalidate);
        return true;
      } };
    },
  };
  const sharer = new Sharer(runtime, { settings: () => ({ sharedDir, deviceSharedDir, runtime: { avdDir: 'fixture' } }), stateFile });
  return { sharer, hooks, putHost, local, sharedDir, stateFile, checkpoint, guestText };
}

for (const [timing, arm] of [
  ['while checking the remote file after staging', (f, edit) => { f.hooks.afterDownloadStat = edit; }],
  ['while rechecking the guest lease before publication', (f, edit) => {
    f.hooks.afterDownloadLease = (n) => { if (n === 2) edit(); };
  }],
]) {
  test(`a host edit ${timing} is not overwritten`, async (t) => {
    const f = fixture(t);
    const edited = 'newer windows edit that must be kept';
    arm(f, () => f.putHost(edited));
    const result = await f.sharer.sync();
    assert.equal(fs.readFileSync(f.local, 'utf8'), edited);
    assert.equal(result.code, 'SHARE_PARTIAL');
    assert.equal(result.pulled, 0);
    assert.match(result.errors[0], /文件在同步时被修改/);
    assert.deepEqual(JSON.parse(fs.readFileSync(f.stateFile)), f.checkpoint);
    assert.deepEqual(fs.readdirSync(f.sharedDir), ['note.txt']);
  });
}

test('unchanged host destination still receives the Android edit', async (t) => {
  const f = fixture(t);
  const result = await f.sharer.sync();
  assert.equal(result.ok, true);
  assert.equal(result.pulled, 1);
  assert.equal(fs.readFileSync(f.local, 'utf8'), f.guestText);
});
