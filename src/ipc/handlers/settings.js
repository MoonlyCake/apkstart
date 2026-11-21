'use strict';

const { ipcFailure } = require('../failure');

function createSettingsHandlers({
  applyAutoStart, displaySettings, getCurrentAppPkg, live,
  portraitSize, refreshPointerMapping, screenRect, store, toggleDisplayMode,
}) {
  return {
    'settings:get': () => store.getSettings(),

    'settings:set': (_e, patch) => {
      if (patch?.runtime && ('dir' in patch.runtime || 'avdDir' in patch.runtime)) {
        const runtime = live.runtime;
        // Never change the paths used for ownership checks while a guest is running.
        return runtime.lifecycle.maintain(async () => {
          const state = await runtime.inspectEmulatorOwnership();
          if (state.state !== 'absent' || runtime.vmStarting || runtime.installing
              || runtime.emulator.running() || runtime.vmProc) {
            return { ok: false, error: '请先完全停止安卓运行时，再更换数据目录。' };
          }
          return store.saveSettings(patch);
        });
      }
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
     * 按实际复制结果提交目录设置，不对已有的同名文件做覆盖，也不删除旧目录。
     */
    'settings:setSharedDir': async (_e, dir) => {
      if (typeof dir !== 'string' || !dir.trim()) return { ok: false, error: '目录不能为空' };
      try {
        const result = await live.sharer.changeLocalDir(dir.trim(), {
          migrate: true, commit: (target) => store.saveSettings({ sharedDir: target }),
        });
        return { ok: true, ...result };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    'display:state': () => ({
      ...displaySettings(),
      screen: screenRect(),
      current: getCurrentAppPkg(),
    }),

    'display:set': async (_e, patch) => {
      const next = store.saveSettings({ display: patch || {} });
      let windowLayoutApplied = false;
      if (live.appWin?.isOpen && (patch?.portrait || patch?.mode)) {
        const options = patch.mode ? { fullscreen: next.display.mode === 'fullscreen' } : {};
        try { windowLayoutApplied = await live.appWin.applyWindowSize(portraitSize(), options) === true; }
        catch (_) { /* The preference is saved even if no window can be updated. */ }
      }
      return { ...next.display, ok: true, windowLayoutApplied };
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
