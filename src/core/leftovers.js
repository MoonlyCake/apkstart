'use strict';
/**
 * 清理旧版本残留。
 *
 * 用户升级 ApkStart 常出现「装过好几个版本、卸载不干净」：便携版每换一次版本就多一个
 * ApkStart-vX.Y.Z-win64-portable 目录；NSIS 安装版升级后可能留下指向已删除目录的
 * 卸载项；更新过程还会在数据目录里留下一堆临时包。
 *
 * 这里只做**可证明安全**的清理：
 *   - 只认「目录里确实有 ApkStart.exe」的旧版本目录，且绝不碰当前正在运行的那个；
 *   - 只删除「InstallLocation 已经不存在」的注册表卸载项（那个本来就已经是死条目）；
 *   - 只删自己更新缓存里的临时文件与指向不存在目标的开始菜单/桌面快捷方式。
 * 任何一步拿不准就跳过，并把原因如实返回给界面。
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const EXE = 'ApkStart.exe';
const FILE_STAT_BATCH = 32;
const WINDOWS_DRIVES = ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'H:\\'];
const UNINSTALL_ROOTS = [
  'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
];
const execFileAsync = promisify(execFile);

async function readDir(dir, io) {
  try { return await io.readdir(dir, { withFileTypes: true }); }
  catch (_) { return []; } // Drive or folder can be absent/inaccessible.
}

async function lstat(file, io) {
  try { return await io.lstat(file); }
  catch (_) { return null; }
}

async function dirSize(root, io) {
  let size = 0;
  const dirs = [root];
  while (dirs.length) {
    const dir = dirs.pop();
    const files = [];
    for (const e of await readDir(dir, io)) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) dirs.push(full);
      else if (e.isFile()) files.push(full);
    }
    // Don't enqueue one libuv request per file in large runtime/cache trees.
    for (let offset = 0; offset < files.length; offset += FILE_STAT_BATCH) {
      const stats = await Promise.all(files.slice(offset, offset + FILE_STAT_BATCH).map((file) => lstat(file, io)));
      for (const stat of stats) if (stat?.isFile()) size += stat.size;
    }
  }
  return size;
}

function norm(p) {
  try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); }
}

function within(root, full) {
  const rel = path.relative(root, full);
  return !rel || !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + path.sep);
}

function intersects(first, second) {
  return within(first, second) || within(second, first);
}

async function resolved(dir, io) {
  try { return norm(await io.realpath(dir)); }
  catch (_) { return null; }
}

async function pathKeys(dir, io) {
  return [norm(dir), await resolved(dir, io)].filter(Boolean);
}

function candidateRoots(installDir, { env, home, driveRoots }) {
  const roots = new Set([path.dirname(installDir)]);
  if (env.LOCALAPPDATA) roots.add(path.join(env.LOCALAPPDATA, 'Programs'));
  if (env.ProgramFiles) roots.add(env.ProgramFiles);
  if (env['ProgramFiles(x86)']) roots.add(env['ProgramFiles(x86)']);
  if (home) for (const name of ['Downloads', 'Desktop', 'Documents']) roots.add(path.join(home, name));
  // Keep the slash: C: is drive-relative, not the root of C:\.
  for (const drive of driveRoots) roots.add(drive);
  return [...roots];
}

/** 从桌面 / 开始菜单快捷方式反查真实 exe 所在的目录。 */
async function rootsFromShortcuts({ env, home, io }) {
  const dirs = new Set();
  const linkDirs = new Set();
  for (const h of [home, env.APPDATA, env.LOCALAPPDATA].filter(Boolean)) {
    linkDirs.add(path.join(h, 'Desktop'));
    linkDirs.add(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    linkDirs.add(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ApkStart'));
  }
  for (const d of linkDirs) {
    for (const e of await readDir(d, io)) {
      if (!e.isFile() || !/\.(lnk|desktop)$/i.test(e.name)) continue;
      const full = path.join(d, e.name);
      try {
        if (/\.desktop$/i.test(e.name)) {
          const txt = await io.readFile(full, 'utf8');
          const m = /^Exec=(?:"([^"]+)"|(\S+))/m.exec(txt);
          const exePath = m?.[1] ?? m?.[2];
          if (exePath && /[\\/]ApkStart(\.exe)?$/i.test(exePath)) dirs.add(path.dirname(exePath));
        } else {
          const buf = await io.readFile(full);
          const re = /[A-Za-z]:\\[^\x00\x01-\x1f]*?ApkStart(?:-[^\x00\x01-\x1f]*)?[\\/]?ApkStart\.exe|[A-Za-z]:\\[^\x00\x01-\x1f]*?ApkStart\.exe/gi;
          for (const hit of buf.toString('latin1').matchAll(re)) dirs.add(path.dirname(hit[0]));
        }
      } catch (_) { /* shortcut disappeared or can't be read */ }
    }
  }
  return dirs;
}

async function scanDirs(installDir, protectedKeys, options) {
  const { io } = options;
  const out = [];
  const seen = new Set();
  const consider = async (full) => {
    const key = norm(full);
    if (seen.has(key)) return;
    seen.add(key);
    if (protectedKeys.some((p) => intersects(p, key))) return;
    // A shortcut can reach a junction even when readdir normally skips it.
    if (!(await lstat(full, io))?.isDirectory()) return;
    const real = await resolved(full, io);
    if (!real || protectedKeys.some((p) => intersects(p, real))) return;
    if (real !== key) {
      if (seen.has(real)) return;
      seen.add(real);
    }
    if (!(await lstat(path.join(full, EXE), io))?.isFile()) return;
    out.push({
      kind: 'dir',
      path: full,
      size: await dirSize(full, io),
      note: '旧版本程序目录（含 ' + EXE + '）',
    });
  };
  const scanRoot = async (root) => {
    for (const e of await readDir(root, io)) {
      if (e.isDirectory() && /^ApkStart/i.test(e.name)) await consider(path.join(root, e.name));
    }
  };
  for (const root of candidateRoots(installDir, options)) await scanRoot(root);
  for (const d of await rootsFromShortcuts(options)) {
    if (/^ApkStart/i.test(path.basename(d))) await consider(d);
    await scanRoot(path.dirname(d));
  }
  return out;
}

async function explicitlyMissing(file, io) {
  try { await io.lstat(file); return false; }
  catch (error) { return error.code === 'ENOENT' || error.code === 'ENOTDIR'; }
}

async function scanRegistry(protectedKeys, { io, platform, runCommand }) {
  if (platform !== 'win32') return [];
  const results = await Promise.all(UNINSTALL_ROOTS.map(async (root) => {
    try {
      const { stdout } = await runCommand('reg', ['query', root, '/s', '/f', 'ApkStart', '/t', 'REG_SZ'],
        { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
      return String(stdout).split(/\r?\n\r?\n/);
    } catch (_) { return []; }
  }));
  const out = [];
  for (const b of results.flat()) {
    const key = (/^(HKEY_[^\r\n]+)$/m.exec(b) || [])[1];
    if (!key || !/\\ApkStart/i.test(key)) continue;
    const loc = (/InstallLocation\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
    const disp = (/DisplayName\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
    const unins = (/UninstallString\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
    const install = (loc || '').trim().replace(/^"|"$/g, '');
    const command = /^"([^"]+)"|^(.+?\.exe)(?:\s|$)/i.exec((unins || '').trim());
    const target = install || command?.[1] || command?.[2];
    // A missing uninstaller alone is not evidence when InstallLocation still exists.
    if (!target || !path.isAbsolute(target) || protectedKeys.some((p) => intersects(p, norm(target)))) continue;
    if (!await explicitlyMissing(target, io)) continue;
    out.push({
      kind: 'registry',
      path: key,
      size: 0,
      note: `失效的卸载项${disp ? `：${String(disp).trim()}` : ''}`,
    });
  }
  return out;
}

/** 更新缓存 / 临时包。 */
async function scanTemp(dataDir, protectedKeys, installAndAvd, { io, tempDir }) {
  const out = [];
  const dirs = new Set([path.join(dataDir, 'update'), tempDir].filter(Boolean));
  for (const d of dirs) {
    const realDir = await resolved(d, io);
    if (!realDir) continue;
    for (const e of await readDir(d, io)) {
      if (!e.isFile() && !e.isDirectory()) continue;
      const isOurs = /^ApkStart.*\.(zip|exe|part\d*|tmp)$/i.test(e.name);
      if (!isOurs) continue;
      const full = path.join(d, e.name);
      const keys = [norm(full), norm(path.join(realDir, e.name))];
      if (keys.some((key) => protectedKeys.some((p) => within(key, p))
        || installAndAvd.some((p) => within(p, key)))) continue;
      const size = e.isDirectory() ? await dirSize(full, io) : (await lstat(full, io))?.size ?? 0;
      out.push({ kind: 'temp', path: full, size, note: '更新下载的临时文件' });
    }
  }
  return out;
}

/** 旧/废弃的快速启动快照；Windows 路径不区分大小写。 */
async function scanSnapshots(avdHome, io) {
  const out = [];
  if (!avdHome) return out;
  const snapDir = path.join(avdHome, 'apkstart.avd', 'snapshots');
  for (const e of await readDir(snapDir, io)) {
    if (!e.isDirectory() || e.name.toLowerCase() === 'apkstart') continue;
    const full = path.join(snapDir, e.name);
    out.push({
      kind: 'dir',
      path: full,
      size: await dirSize(full, io),
      note: /^default_boot/i.test(e.name) ? '旧版遗留的快速启动快照' : '废弃的快照残留',
    });
  }
  return out;
}

async function scan({ installDir, dataDir, avdHome }, {
  io = fs.promises, env = process.env, home = os.homedir(), tempDir = os.tmpdir(),
  platform = process.platform, driveRoots = platform === 'win32' ? WINDOWS_DRIVES : [],
  runCommand = execFileAsync,
} = {}) {
  const options = { io, env, home, tempDir, platform, driveRoots, runCommand };
  // Aliases through junctions must protect the same live installation and storage.
  const [install, data, avd] = await Promise.all([installDir, dataDir, avdHome]
    .map((dir) => dir ? pathKeys(dir, io) : []));
  const protectedKeys = [...install, ...data, ...avd];
  const groups = await Promise.all([
    scanDirs(installDir, protectedKeys, options),
    scanRegistry(protectedKeys, options),
    scanTemp(dataDir, protectedKeys, [...install, ...avd], options),
    scanSnapshots(avdHome, io),
  ]);
  const items = groups.flat();
  return { items, totalBytes: items.reduce((sum, item) => sum + item.size, 0) };
}

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
}

function clean(items, { installDir }) {
  const cur = norm(installDir);
  let freed = 0;
  const removed = [];
  const failed = [];
  for (const it of items || []) {
    try {
      if (it.kind === 'dir') {
        // 双保险：绝不删当前正在运行的目录
        if (norm(it.path) === cur) { failed.push({ path: it.path, reason: '这是当前正在运行的版本' }); continue; }
        if (!fs.existsSync(path.join(it.path, EXE))) { failed.push({ path: it.path, reason: '目录里没有 ' + EXE }); continue; }
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: '文件被占用（可能有窗口还开着）' });
      } else if (it.kind === 'registry') {
        const r = execFileSync('reg', ['delete', it.path, '/f'], { windowsHide: true, timeout: 10000 });
        void r;
        removed.push(it.path);
      } else if (it.kind === 'temp') {
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: '文件被占用' });
      } else if (it.kind === 'shortcut') {
        if (rm(it.path)) removed.push(it.path);
        else failed.push({ path: it.path, reason: '删除失败' });
      }
    } catch (e) {
      failed.push({ path: it.path, reason: e.message });
    }
  }
  return { removed, failed, freedBytes: freed };
}

module.exports = { scan, clean };
