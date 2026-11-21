'use strict';
/**
 * 容器式分层：只读基础镜像 + 精简运行时 + 可回收的临时层
 *
 * 比喻（和 Docker 一样）：
 *   system-images/  = 只读 base layer，所有应用、所有会话共享一份，绝不复制
 *   avd/*.avd/      = 可写 thin layer（qcow2 差量 + quickboot 快照），只存改动
 *   _tmp/ snapshots = 可回收的 scratch layer
 *
 * 本模块只做「盘点」与「按明确清单回收」，默认 dryRun，不碰用户个人文件。
 */
const fs = require('fs');
const path = require('path');

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, out, depth + 1);
    else if (it.isFile()) {
      try { out.push({ path: p, size: fs.statSync(p).size }); } catch (_) { /* ignore */ }
    }
  }
  return out;
}

function dirSize(dir) { return walk(dir).reduce((n, f) => n + f.size, 0); }
const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };

function strictRelative(root, item) {
  const rel = path.relative(root, item);
  return rel && !path.isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${path.sep}`) ? rel : null;
}

/**
 * 盘点运行时占用，并列出「可安全回收」的条目。
 * @returns {{total:number, groups:Array, candidates:Array}}
 */
function analyze(root, {
  keepAvd = 'apkstart.avd', avdHome = path.join(root, 'avd'), sysImgRoot = path.join(root, 'system-images'),
  aggressive = false, keepSnapshots = false,
} = {}) {
  const groups = [];
  const candidates = [];
  const avdName = /^[^/\\]+\.avd$/i.test(keepAvd) ? keepAvd : 'apkstart.avd';
  const activeAvd = path.join(avdHome, avdName);

  const groupOf = (name, dir) => {
    const size = dirSize(dir);
    groups.push({ name, size });
    return size;
  };
  const add = (p, size, reason, kind = 'file', scope = 'runtime') => candidates.push({ path: p, size, reason, kind, scope });

  groupOf('emulator 引擎', path.join(root, 'emulator'));
  groupOf('系统镜像（只读基础层）', path.join(root, 'system-images'));
  if (path.relative(path.join(root, 'system-images'), sysImgRoot)) groupOf('当前镜像目录', sysImgRoot);
  groupOf('platform-tools', path.join(root, 'platform-tools'));
  groupOf('QEMU / ISO', path.join(root, 'images'));
  groupOf('下载暂存区', path.join(root, '_tmp'));
  const avdSize = groupOf('AVD 可写层 / 快照', activeAvd);

  // An SDK can be referenced by AVDs outside its directory. Never infer that images or other user disks are unused.
  // Downloads may be live on a separate queue, so this guest cleanup does not touch them either.
  if (!keepSnapshots && exists(activeAvd)) {
    for (const e of fs.readdirSync(activeAvd, { withFileTypes: true })) {
      if (!e.isDirectory() || !/^snapshots(\.stale-\d+)?$/.test(e.name)) continue;
      const p = path.join(activeAvd, e.name);
      add(p, dirSize(p), '当前 AVD 的快速启动快照（可重新生成）', 'dir', 'avd');
    }
  }

  // 激进裁剪：仅构建发行包时启用。
  // 注意：Qt6WebEngineCoreAndroidEmu.dll 是 qemu-system-x86_64.exe 的加载时依赖，
  // 实测删掉会直接起不来，绝不能放进清单；qsn/netsim 也可能被快照与网络功能按需调用，保守保留。
  if (aggressive) {
    const qemuDir = path.join(root, 'emulator', 'qemu', 'windows-x86_64');
    for (const f of walk(qemuDir)) {
      if (/^qemu-system-(aarch64|armel|i386)(-headless)?\.exe$/i.test(path.basename(f.path))) {
        add(f.path, f.size, '发行包不包含非 x86_64 的 QEMU 目标');
      }
    }
    const extras = [
      ['emulator/crashreport.exe', '崩溃上报工具（无头运行不需要）'],
    ];
    for (const [rel, reason] of extras) {
      const p = path.join(root, rel);
      if (exists(p)) add(p, fs.statSync(p).size, reason);
    }
  }

  const total = groups.reduce((n, g) => n + g.size, 0);
  return { total, avdSize, activeAvd, groups, candidates };
}

/**
 * 回收。必须显式传 apply:true；调用方（UI/构建脚本）负责先展示清单并取得确认。
 * 安全约束：路径只能在指定的 SDK 或 AVD 根下，且不能穿过链接删除别处的数据。
 */
function prune(root, { apply = false, onRemove = () => {}, ...options } = {}) {
  const report = analyze(root, options);
  const removed = [];
  const failed = [];
  let saved = 0;
  for (const c of report.candidates) {
    if (!apply) break;
    const scopeRoot = path.resolve(c.scope === 'avd' ? (options.avdHome || path.join(root, 'avd')) : root);
    const p = path.resolve(c.path);
    try {
      const stat = fs.lstatSync(p, { throwIfNoEntry: false });
      if (!stat) continue;
      const rel = strictRelative(scopeRoot, p);
      if (!rel || stat.isSymbolicLink() || path.relative(path.join(fs.realpathSync(scopeRoot), rel), fs.realpathSync(p))) {
        throw new Error('清理目标已改动或经过目录链接，未执行删除。');
      }
      fs.rmSync(p, c.kind === 'dir' ? { recursive: true } : {});
    } catch (e) {
      failed.push({ ...c, error: e.message });
      continue;
    }
    removed.push(c);
    saved += c.size;
    onRemove(c);
  }
  return { ...report, apply, removed, failed, saved, after: Math.max(0, report.total - saved) };
}

/** 给设置页用的简短摘要 */
function summary(root, options) {
  const a = analyze(root, options);
  const mb = (n) => (n >= 1048576 * 1024
    ? `${(n / 1073741824).toFixed(2)} GB`
    : `${(n / 1048576).toFixed(0)} MB`);
  // 除了运行时目录，用户最关心「这东西一共占了我多少盘」：
  // AVD（应用数据 + 快照）、APK 缓存、图标、日志都算进来。
  const store = require('./store');
  const extra = [
    { key: 'apk', label: 'APK 安装包缓存', path: store.APK_DIR },
    { key: 'icons', label: '桌面图标缓存', path: store.ICON_DIR },
    { key: 'logs', label: '日志', path: path.join(store.DATA_DIR, 'logs') },
  ].map((g) => ({ ...g, size: dirSize(g.path) })).filter((g) => g.size > 0);

  const extraTotal = extra.reduce((n, g) => n + g.size, 0);
  const totalAll = a.total + extraTotal;
  return {
    total: totalAll,
    totalText: mb(totalAll),
    runtimeText: mb(a.total - a.avdSize),
    groups: [
      { key: 'runtime', label: '运行时（引擎 + 系统镜像）', size: a.total - a.avdSize, text: mb(a.total - a.avdSize) },
      { key: 'avd', label: '安卓数据（应用 + 快照）', path: a.activeAvd, size: a.avdSize, text: mb(a.avdSize) },
      ...extra.map((g) => ({ ...g, text: mb(g.size) })),
    ],
    reclaimable: a.candidates.reduce((n, c) => n + c.size, 0),
    reclaimableText: mb(a.candidates.reduce((n, c) => n + c.size, 0)),
    count: a.candidates.length,
  };
}

module.exports = { analyze, prune, summary, walk, dirSize };
