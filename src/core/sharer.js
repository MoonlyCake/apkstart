'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { readJsonFile, writeJsonFile } = require('../application/json-state');
const { prepareSharedDirectory } = require('../application/shared-directory');
const store = require('./store');

const MAX_FILE = 512 * 1024 * 1024;
const scanDone = '__APKSTART_SHARED_SCAN_DONE__';
const statFormat = '%s|%y|%z';
const quote = (value) => "'" + value.replace(/'/g, "'\\''") + "'";
const same = (a, b) => a === b || (!!a && !!b && a.size === b.size && a.stamp === b.stamp);
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);

function localFile(file) {
  let st;
  try { st = fs.lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!st.isFile()) throw new Error('目标不是普通文件');
  return { size: Number(st.size), stamp: st.mtimeNs + '|' + st.ctimeNs };
}

function localFiles(root, folder = root, files = new Map()) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) localFiles(root, full, files);
    else if (entry.isFile()) {
      const info = localFile(full);
      if (info) files.set(path.relative(root, full).split(path.sep).join('/'), info);
    }
  }
  return files;
}

function compatiblePath(rel) {
  return rel.split('/').every((part) => part && !part.startsWith('.') && !/[\\\x00-\x1f]/.test(part)
    && (process.platform !== 'win32' || (!/[<>:"|?*]|[ .]$/.test(part)
      && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))));
}

function remoteStat(record) {
  const match = /^(\d+)\|([^|\r\n]+)\|([^|\r\n]+)$/.exec(record);
  if (!match || !Number.isSafeInteger(Number(match[1]))) throw new Error('无法读取安卓文件的大小或修改时间');
  return { size: Number(match[1]), stamp: match[2] + '|' + match[3] };
}

async function remoteFiles(client, dir) {
  const output = await client.shell(
    'cd ' + quote(dir) + " && find . -type f -exec stat -c '" + statFormat + "|%n' {} + && echo " + scanDone,
    { timeout: 20000, maxBuffer: 8 * 1024 * 1024 },
  );
  const lines = output.split(/\r?\n/);
  if (lines.pop() !== scanDone) throw new Error('没有拿到完整的安卓文件列表，未同步');
  const files = new Map();
  for (const line of lines) {
    const match = /^(\d+\|[^|\r\n]+\|[^|\r\n]+)\|\.\/(.+)$/.exec(line);
    if (!match) throw new Error('安卓文件列表不完整，未同步');
    if (!match[2].split('/').some((p) => p.startsWith('.'))) files.set(match[2], remoteStat(match[1]));
  }
  return files;
}

async function remoteFile(client, file) {
  const q = quote(file);
  const text = await client.shell('if [ -f ' + q + ' ] && [ ! -L ' + q + " ]; then stat -c '" + statFormat + "' " + q
    + '; elif [ -e ' + q + ' ] || [ -L ' + q + ' ]; then echo NOT_REGULAR; else echo ABSENT; fi');
  if (text === 'ABSENT') return null;
  if (text === 'NOT_REGULAR') throw new Error('安卓目标不是普通文件');
  return remoteStat(text);
}

function localParent(root, rel) {
  let dir = root;
  for (const part of rel.split('/').slice(0, -1)) {
    dir = path.join(dir, part);
    try { fs.mkdirSync(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(dir).isDirectory()) throw new Error('共享路径中存在链接或非目录');
  }
  return dir;
}

async function sameContents(client, local, remote) {
  const out = await client.shell('sha256sum ' + quote(remote), { timeout: 30000 });
  const digest = /^([a-f0-9]{64})\s/i.exec(out)?.[1]?.toLowerCase();
  if (!digest) return false;
  const hash = createHash('sha256');
  for await (const data of fs.createReadStream(local)) hash.update(data);
  return hash.digest('hex') === digest;
}

class Sharer {
  constructor(runtime, { settings = () => store.getSettings(), stateFile = path.join(store.DATA_DIR, 'shared-state.json') } = {}) {
    this.runtime = runtime;
    this.settings = settings;
    this.stateFile = stateFile;
    this._busy = false;
    this._timer = null;
    this._lastError = '';
    this._ambiguous = { scope: '', files: new Map() };
  }

  get localDir() { return this.settings().sharedDir; }
  get remoteDir() { return this.settings().deviceSharedDir; }

  async changeLocalDir(to, { migrate = false, commit }) {
    if (this._busy) throw new Error('共享目录正在同步或迁移，请稍后重试');
    this._busy = true;
    try {
      const from = this.localDir;
      const prepared = await prepareSharedDirectory({ from, to, migrate });
      try {
        if (this.localDir !== from) throw new Error('共享目录设置已改变');
        await commit(prepared.path);
      } catch (error) {
        throw new Error('共享目录未切换，原目录未修改。目标目录已复制 ' + prepared.copied + ' 个文件：' + error.message, { cause: error });
      }
      return prepared;
    } finally {
      this._busy = false;
    }
  }

  async sync() {
    const result = { ok: false, pushed: 0, pulled: 0, errors: [], conflicts: [] };
    const fail = (code, error) => ({ ...result, code, error });
    if (this._busy) return { ...fail('SHARE_BUSY', '共享目录正在同步'), skipped: true };
    this._busy = true;
    this._lastError = '';
    try {
      const dir = this.localDir;
      const remote = this.remoteDir;
      const generation = this.runtime.guestGeneration;
      const endpoint = await this.runtime._networkEndpoint();
      const client = endpoint?.client;
      if (!client || await client.deviceState().catch(() => '') !== 'device' || !await endpoint.revalidate()) {
        this._lastError = 'ApkStart 的安卓运行时未连接或未授权';
        return fail('SHARE_OFFLINE', this._lastError);
      }
      const stillCurrent = async () => dir === this.localDir && remote === this.remoteDir
        && generation === this.runtime.guestGeneration && await endpoint.revalidate()
        && generation === this.runtime.guestGeneration;
      const guard = async () => {
        if (!await stillCurrent()) throw new Error('共享目录或安卓运行时已切换，请重新同步');
      };
      const avdDir = this.settings().runtime?.avdDir || this.settings().runtime?.dir || '';
      const scope = JSON.stringify([dir, remote, avdDir]);
      if (this._ambiguous.scope !== scope) this._ambiguous = { scope, files: new Map() };
      if (!path.isAbsolute(dir) || !path.posix.isAbsolute(remote) || path.posix.normalize(remote) === '/') {
        throw new Error('共享目录路径无效');
      }
      const state = readJsonFile(this.stateFile, {}, isRecord);
      // 老记录会把未复制的安卓修改当成已同步；不能拿它作为允许覆盖的依据。
      const prev = state.value.version === 2 && state.value.scope === scope && isRecord(state.value.entries)
        ? new Map(Object.entries(state.value.entries)) : new Map();

      await guard();
      fs.mkdirSync(dir, { recursive: true });
      const root = fs.realpathSync(dir);
      await client.shell('mkdir -p ' + quote(remote));
      const host = localFiles(root);
      const guest = await remoteFiles(client, remote);
      const names = new Set([...host.keys(), ...guest.keys()]);
      const count = new Map();
      const key = (name) => process.platform === 'win32' ? name.toLowerCase() : name;
      for (const name of names) count.set(key(name), (count.get(key(name)) || 0) + 1);
      let dirty = false;
      const ambiguous = new Map();
      const remember = (name, local, remoteFileInfo) => { prev.set(name, { local, remote: remoteFileInfo }); dirty = true; };

      // 必须先快照两端并决定方向，不能先把 Windows 版本推上去再检查安卓。
      for (const rel of names) {
        const l = host.get(rel) || null;
        const r = guest.get(rel) || null;
        const entry = prev.get(rel);
        if (!compatiblePath(rel) || count.get(key(rel)) > 1) { result.conflicts.push(rel); continue; }
        if (entry && same(l, entry.local) && same(r, entry.remote)) continue;
        if (Math.max(l?.size ?? 0, r?.size ?? 0) > MAX_FILE) {
          result.errors.push(rel + '：文件超过 512 MB，未同步');
          continue;
        }
        const local = path.join(root, rel);
        const target = path.posix.join(remote, rel);
        const push = !r || (!!l && !!entry && same(r, entry.remote));
        const pull = !l || (!!r && !!entry && same(l, entry.local));
        try {
          if (push || pull) {
            const pair = await transfer({ client, guard, root, rel, local, target, l, r, push });
            remember(rel, pair.local, pair.remote);
            result[push ? 'pushed' : 'pulled']++;
          } else {
            const cached = this._ambiguous.files.get(rel);
            const conflictKnown = cached && same(l, cached.local) && same(r, cached.remote);
            await guard();
            if (!conflictKnown && l.size === r.size && await sameContents(client, local, target)
              && same(localFile(local), l) && same(await remoteFile(client, target), r)) {
              await guard();
              remember(rel, l, r);
            } else {
              ambiguous.set(rel, { local: l, remote: r });
              result.conflicts.push(rel);
            }
          }
        } catch (error) { result.errors.push(rel + '：' + error.message); }
      }
      this._ambiguous.files = ambiguous;
      await guard();
      for (const rel of prev.keys()) if (!names.has(rel)) { prev.delete(rel); dirty = true; }
      if (dirty) writeJsonFile(this.stateFile, { version: 2, scope, entries: Object.fromEntries(prev) }, state);
      if (result.errors.length || result.conflicts.length) {
        this._lastError = '共享同步未全部完成：' + result.errors.length + ' 个失败，' + result.conflicts.length + ' 个冲突。冲突文件未覆盖。';
        return fail('SHARE_PARTIAL', this._lastError);
      }
      return { ...result, ok: true };
    } catch (error) {
      this._lastError = error.message;
      return fail('SHARE_SYNC_FAILED', error.message);
    } finally {
      this._busy = false;
    }
  }

  start(intervalMs = 8000) {
    if (this._timer) return;
    this._timer = setInterval(() => { this.sync().catch(() => {}); }, intervalMs);
    this._timer.unref?.();
  }

  stop() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  get lastError() { return this._lastError; }
}

async function transfer({ client, guard, root, rel, local, target, l, r, push }) {
  const unchanged = async () => {
    await guard();
    if (!same(localFile(local), l) || !same(await remoteFile(client, target), r)) {
      throw new Error('文件在同步时被修改，未覆盖');
    }
  };
  await unchanged();
  if (push) {
    const folder = path.posix.dirname(target);
    const staged = path.posix.join(folder, '.apkstart-sync-' + randomUUID());
    try {
      await guard();
      await client.shell('mkdir -p ' + quote(folder));
      await guard();
      await client.push(local, staged);
      if ((await remoteFile(client, staged))?.size !== l.size) throw new Error('上传结果校验失败');
      await unchanged();
      await guard();
      await client.shell('mv ' + (r ? '-Tf' : '-Tn') + ' ' + quote(staged) + ' ' + quote(target));
      if (await remoteFile(client, staged)) throw new Error('安卓目标已存在，未覆盖');
      const uploaded = await remoteFile(client, target);
      if (uploaded?.size !== l.size) throw new Error('上传后无法确认目标文件');
      return { local: l, remote: uploaded };
    } finally {
      // 只清理由本次传输生成的临时文件，不能向替换后的虚拟机发送清理命令。
      await guard().then(() => client.shell('rm -f ' + quote(staged))).catch(() => {});
    }
  }

  const folder = localParent(root, rel);
  const staged = path.join(folder, '.apkstart-sync-' + randomUUID());
  try {
    await guard();
    await client.pull(target, staged);
    if (localFile(staged)?.size !== r.size) throw new Error('下载结果校验失败');
    await unchanged();
    await guard();
    if (l) fs.renameSync(staged, local);
    else await fs.promises.copyFile(staged, local, fs.constants.COPYFILE_EXCL);
    return { local: localFile(local), remote: r };
  } finally {
    try { fs.unlinkSync(staged); } catch (_) { /* 已发布或没有生成临时文件。 */ }
  }
}

module.exports = { Sharer };
