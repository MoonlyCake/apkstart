'use strict';

function createAppsHandlers({
  appLog, dialog, fs, live, parseApk, runInstall, runLaunch, send, shell, stopApp, store,
  wantLandscapeFor,
}) {
  return {
    'apps:list': async () => {
      const apps = store.getApps();
      store.getSettings(); // Keep existing validation of settings before listing.
      let running = [];
      try {
        const c = live.runtime.client();
        if (await c.isOnline()) running = await c.runningPackages();
      } catch (_) { /* 运行时未启动时忽略 */ }
      return apps
        .map((a) => ({
          ...a,
          running: running.includes(a.package),
          iconUrl: a.iconPath && fs.existsSync(a.iconPath)
            ? `file:///${a.iconPath.replace(/\\/g, '/').replace(/ /g, '%20')}`
            : null,
          shortcutExists: a.shortcutPath ? fs.existsSync(a.shortcutPath) : false,
        }))
        .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastLaunchAt || 0) - (a.lastLaunchAt || 0) || a.label.localeCompare(b.label, 'zh'));
    },

    'apk:pick': async () => {
      const r = await dialog.showOpenDialog(live.mainWindow, {
        title: '选择要安装的 APK',
        filters: [{ name: 'Android 应用', extensions: ['apk', 'apks', 'xapk'] }],
        properties: ['openFile', 'multiSelections'],
      });
      if (r.canceled) return [];
      return r.filePaths;
    },

    'apk:parse': async (_e, filePath) => parseApk(filePath),

    'apk:install': async (_e, filePath) => {
      const r = await runInstall(filePath);
      if (r.ok === false) return r;
      return { ok: true, app: r.app, warnings: r.warnings };
    },

    'app:launch': async (_e, pkg) => runLaunch(pkg),

    /**
     * 关掉一个正在运行的安卓应用。
     *
     * 以前根本没有这个入口：endApp 只在「应用窗口被关闭」时触发，而独立窗口模式下
     * 那个窗口是隐藏的、永远不会被关，所以应用一旦起来就关不掉，
     * 用户只能退到托盘退出整个 ApkStart（连虚拟机一起没了）。
     */
    'app:stop': async (_e, pkg, opts = {}) => stopApp(pkg, opts),

    'app:uninstall': async (_e, pkg) => {
      await live.installer.uninstall(pkg);
      return { ok: true };
    },

    'app:shortcut': async (_e, pkg) => {
      const appRecord = store.getApp(pkg);
      if (!appRecord) throw new Error('应用不存在');
      const p = live.installer.createShortcut(appRecord);
      store.upsertApp({ package: pkg, shortcutPath: p });
      return { ok: true, path: p };
    },

    'app:clearData': async (_e, pkg) => {
      const rt = await live.runtime.ensure();
      if (!rt.ok) throw new Error(rt.error);
      await rt.client.clearData(pkg);
      return { ok: true };
    },

    'app:pin': async (_e, { pkg, pinned }) => {
      store.upsertApp({ package: pkg, pinned: !!pinned });
      return { ok: true };
    },

    /**
     * 单个应用的横竖屏覆盖（应用卡片右键菜单用）。
     * 只写 apps.json 的 orientationOverride，不在这里重启运行时 ——
     * 下次打开该应用时 wantLandscapeFor 会读它并把面板切到对应方向。
     * 传 null 表示清除覆盖，回到 APK 清单解析出的天然方向。
     */
    'app:setOrientation': async (_e, { pkg, orientation: value }) => {
      if (!pkg) return { ok: false, error: '缺少包名' };
      const next = value === 'landscape' || value === 'portrait' ? value : null;
      store.upsertApp({ package: pkg, orientationOverride: next });
      appLog(`orientation override ${pkg} = ${next || '(跟随应用)'}`);
      // 主界面列表要立刻显示新的方向文字
      send('apps:changed');
      return { ok: true, orientation: next, landscape: wantLandscapeFor(pkg) };
    },

    'app:revealApk': async (_e, pkg) => {
      const a = store.getApp(pkg);
      if (a?.apkPath && fs.existsSync(a.apkPath)) shell.showItemInFolder(a.apkPath);
    },

    'apk:reveal': async () => {
      fs.mkdirSync(store.APK_DIR, { recursive: true });
      shell.openPath(store.APK_DIR);
    },

    'shortcut:rebuild': async () => ({ ok: true, fixed: await live.installer.ensureShortcuts() }),
  };
}

module.exports = { createAppsHandlers };
