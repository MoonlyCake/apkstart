'use strict';

const { sanitizeResourcePatch } = require('../resource-settings');

function createSettingsHandlers({
  applyAutoStart, copyDirContents, displaySettings, fs, getCurrentAppPkg, live,
  portraitSize, refreshPointerMapping, screenRect, store, toggleDisplayMode,
}) {
  return {
    'settings:get': () => store.getSettings(),

    'settings:set': (_e, rawPatch) => {
      const patch = sanitizeResourcePatch(rawPatch);
      const next = store.saveSettings(patch);
      if (patch && patch.autoStart !== undefined) applyAutoStart();
      if (patch && patch.display && live.appWin && live.appWin.isOpen) {
        // 竖屏基准尺寸变了：只影响后续打开的窗口大小，不打断正在跑的应用
        live.appWin.portrait = portraitSize();
      }
      // 打开「开始菜单快捷方式」时立刻补齐，不用等下次安装
      if (patch && (patch.createStartMenuShortcut === true || patch.createShortcutOnInstall === true)) {
        live.installer.ensureShortcuts().catch(() => {});
      }
      // 鼠标键位变了：立刻按当前焦点重装/卸载钩子，不用等下次切窗口
      if (patch && patch.engine && (
        'mouseRightBack' in patch.engine || 'mouseWheelMode' in patch.engine || 'mouseSideButtons' in patch.engine
      )) {
        refreshPointerMapping();
      }
      // 换了更新源 / 镜像前缀 / 整包地址：之前那套「谁最快」的结论不再成立，清掉测速缓存；
      // 运行时整包 / 引擎 / 镜像的地址还缓存在 provisioner._cache 里，不清掉就要重启进程才生效。
      if (patch && patch.runtime && (
        'sourcePreference' in patch.runtime || 'mirrorPrefix' in patch.runtime
        || 'autoMirror' in patch.runtime || 'runtimePackUrl' in patch.runtime
        || 'emulatorUrl' in patch.runtime || 'sysimgUrl' in patch.runtime
      )) {
        try {
          live.updater?.sources?.reset();
          live.runtime?.provisioner?.sources?.reset();
          live.runtime?.provisioner?.invalidateEnvCache?.();
        } catch (_) { /* ignore */ }
      }
      return next;
    },

    /**
     * 修改本机共享目录：把旧目录里已有的文件一次性迁到新目录（best-effort，不删旧文件），
     * 再保存设置。Sharer 每次同步都动态读 store.getSettings().sharedDir，无需重启即可生效。
     */
    'settings:setSharedDir': async (_e, dir) => {
      if (!dir || !dir.trim()) return { ok: false, error: '目录不能为空' };
      const newDir = dir.trim();
      const oldDir = store.getSettings().sharedDir;
      try {
        if (oldDir && oldDir !== newDir) copyDirContents(oldDir, newDir);
        fs.mkdirSync(newDir, { recursive: true });
        store.saveSettings({ sharedDir: newDir });
        return { ok: true, oldDir, newDir };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    'display:state': () => ({
      ...displaySettings(),
      screen: screenRect(),
      current: getCurrentAppPkg(),
    }),

    'display:set': async (_e, patch) => {
      const next = store.saveSettings({ display: patch || {} });
      if (live.appWin && live.appWin.isOpen) {
        live.appWin.portrait = portraitSize();
        const full = next.display.mode === 'fullscreen';
        if (full && !live.appWin.win.isMaximized()) live.appWin.win.maximize();
        if (!full && live.appWin.win.isMaximized()) live.appWin.win.unmaximize();
        // 全屏 = 平板横屏排版（见 toggleDisplayMode 的说明）
        live.appWin.setLandscape(full).catch(() => {});
        live.appWin.scheduleFit();
      }
      return next.display;
    },

    'display:toggle': () => toggleDisplayMode(),

    // 关闭「深度裁剪」时把被 pm disable-user 的系统包恢复回来
    'settings:restoreSystem': async () => live.runtime.restoreSystemApps(),

    // 鼠标键位改变：只同步配置，不再无条件卸载（右键返回/滚轮可能仍需要钩子）
    'settings:refreshPointer': async () => { refreshPointerMapping(); return true; },

    // 兼容旧界面：语义已改为「按设置重新同步」
    'settings:unhook': async () => { refreshPointerMapping(); return true; },
  };
}

module.exports = { createSettingsHandlers };
