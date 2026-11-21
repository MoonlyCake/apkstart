'use strict';

const { ipcFailure } = require('../failure');

function createDesktopHandlers({
  app, APPICON_FILE, assoc, dialog, findUninstaller, fs, ICON_PNG, IS_DEV, launcherInfo,
  live, NO_SHELL_PROBE, openManual, parseArgs, path, send, shell, store,
}) {
  return {
    'app:info': () => ({
      version: app.getVersion(),
      isDev: IS_DEV,
      platform: process.platform,
      dataDir: store.DATA_DIR,
      runtimeDir: live.runtime.provisioner.paths().root,
      diskFreeMB: (() => {
        try { return require('../../core/doctor').freeDiskMB(live.runtime.provisioner.paths().root); } catch (_) { return 0; }
      })(),
      exe: process.execPath,
      packaged: app.isPackaged,
    }),

    // 启动方式（开机自启 / 双击打开）：欢迎卡据此决定是否自动弹出
    'app:startupInfo': () => {
      const a = parseArgs(process.argv);
      return {
        autostart: process.argv.includes('--autostart') || !!a.silent,
        launch: a.launch || null,
        smoke: process.argv.includes('--smoke'),
        version: app.getVersion(),
        isPackaged: app.isPackaged,
      };
    },

    // 选文件夹（用于把运行时/镜像/已装应用挪到非系统盘）
    'dialog:openDir': async (_e, defaultPath) => {
      const r = await dialog.showOpenDialog(live.mainWindow, {
        title: '选择数据存放目录',
        defaultPath: defaultPath || store.DATA_DIR,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
      return r.filePaths[0];
    },

    // 通用确认框（渲染层统一走这里，避免各处自己拼 dialog 文案）
    'app:confirm': async (_e, opts = {}) => {
      const { response } = await dialog.showMessageBox(live.mainWindow || undefined, {
        type: opts.type || 'question',
        title: opts.title || '确认',
        message: opts.message || '',
        detail: opts.detail || '',
        buttons: ['取消', opts.okLabel || '确定'],
        defaultId: 1,
        cancelId: 0,
        noLink: true,
      });
      return { response };
    },

    'assoc:status': () => {
      // 冒烟/无 shell 环境：不探测注册表（reg.exe 可能被策略拦截）
      if (NO_SHELL_PROBE) return { registered: false, skipped: true };
      const { execFileSync } = require('child_process');
      try {
        const out = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\.apk', '/ve'], { windowsHide: true, encoding: 'utf8' });
        return { registered: out.includes(assoc.PROGID) };
      } catch (_) {
        return { registered: false };
      }
    },

    'assoc:register': () => {
      const l = launcherInfo();
      const icoPath = path.join(store.ICON_DIR, 'apkstart.ico');
      if (!fs.existsSync(icoPath)) {
        // 优先用随包分发的多尺寸品牌 ICO，缺失时从 Logo PNG 现算
        if (fs.existsSync(APPICON_FILE)) fs.copyFileSync(APPICON_FILE, icoPath);
        else {
          const { pngToIco } = require('../../core/shortcut');
          const ico = pngToIco(ICON_PNG);
          if (ico) fs.writeFileSync(icoPath, ico);
        }
      }
      return assoc.registerAssociation(l.target, icoPath, l.args);
    },

    'assoc:unregister': () => assoc.unregisterAssociation(),

    'share:sync': async () => live.sharer.sync({ onLog: (m) => send('runtime:log', m) }),

    'share:open': async () => {
      const dir = store.getSettings().sharedDir;
      fs.mkdirSync(dir, { recursive: true });
      shell.openPath(dir);
    },

    /**
     * 一键卸载 ApkStart 本体：
     * 1) 先取消 .apk 文件关联（避免卸载后双击 APK 指向已删除的程序）
     * 2) 安装版：启动 NSIS 卸载程序（它会自行请求管理员/确认），随后退出本程序
     * 3) 便携版（旁加载 / 免安装）：没有 uninstaller.exe，返回提示让用户手动删除程序与数据目录
     */
    'app:removeSelf': async () => {
      try {
        try { await assoc.unregisterAssociation(); } catch (_) { /* 取消关联失败不影响卸载 */ }
        const exeDir = path.dirname(process.execPath);
        // 和 updater.flavor 用同一套识别规则：electron-builder 生成的是
        // "Uninstall ApkStart.exe"，旧代码只找 "uninstaller.exe"，
        // 导致安装版点「一键卸载」被误判成便携版、只弹提示不真卸载（issue #51）。
        const unName = findUninstaller(exeDir);
        if (!unName) {
          return { ok: true, portable: true, dataDir: store.DATA_DIR, exeDir };
        }
        const uninstaller = path.join(exeDir, unName);
        const { spawn } = require('child_process');
        // 卸载前先收掉常驻的模拟器：qemu 会锁住 resources\runtime 里的 exe/dll，
        // NSIS 删不掉就会留下半个安装目录。这里只针对「真的在卸载」，不影响日常退出。
        if (live.runtime && !await live.runtime.stop()) {
          return { ok: false, error: '请先关闭 ApkStart 安卓运行时，再卸载。' };
        }
        // 先让本程序退出，再由一个独立进程延迟 2 秒拉起卸载器：
        // 运行中的 exe 会锁住安装目录里的文件，直接拉起卸载器容易删不干净。
        const cmd = `ping 127.0.0.1 -n 3 >nul & start "" "${uninstaller}"`;
        spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
        setTimeout(() => app.quit(), 300);
        return { ok: true, portable: false };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    'shell:open': (_e, url) => shell.openExternal(url),

    // 内置手册：渲染层只说「哪个故障/哪个主题」，主进程解析成受信任的本地章节
    'manual:open': (_e, payload) => openManual(payload || {}),
  };
}

module.exports = { createDesktopHandlers };
