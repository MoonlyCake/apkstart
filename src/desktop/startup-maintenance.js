'use strict';

const fs = require('node:fs');
const { parseApk } = require('../core/apk');
const doctor = require('../core/doctor');

function backfillAppOrientations(store, log) {
  try {
    const filled = [];
    for (const app of store.getApps()) {
      if (app.orientation || !app.apkPath || !fs.existsSync(app.apkPath)) continue;
      try {
        const { orientation } = parseApk(app.apkPath);
        if (!orientation) continue;
        store.upsertApp({ package: app.package, orientation });
        filled.push(`${app.label}=${orientation}`);
      } catch (_) { /* A stale APK must not prevent startup. */ }
    }
    if (filled.length) log(`orientation backfill: ${filled.join(', ')}`);
  } catch (_) { /* Catalog maintenance is best-effort. */ }
}

function warnAboutFreeSpace({ dataDir, notify, send, log }) {
  const freeMB = doctor.freeDiskMB(dataDir);
  if (!freeMB || freeMB >= 3072) return;
  const remaining = (freeMB / 1024).toFixed(1);
  log(`LOW_DISK free=${freeMB}MB dir=${dataDir}`);
  setTimeout(() => {
    notify('磁盘空间不足', `只剩 ${remaining} GB。请到「设置 → 系统集成」把安卓数据目录/运行时目录改到其他盘，或先清理磁盘。`);
    send('toast', { type: 'error', message: `磁盘只剩 ${remaining} GB，安卓可能无法启动（设置 → 系统集成 可换盘）` });
  }, 3000).unref?.();
}

function repairMissingShortcuts({ installer, refreshShell, notify }) {
  installer.ensureShortcuts().then((fixed) => {
    if (!fixed?.length) return;
    refreshShell().catch(() => {});
    notify('快捷方式已补齐', fixed.join('、'));
  }).catch(() => {});
}

module.exports = { backfillAppOrientations, warnAboutFreeSpace, repairMissingShortcuts };
