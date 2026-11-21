'use strict';

const { ipcFailure } = require('../failure');

function createProvisionHandlers({ autoDeploy, dialog, live, send, store }) {
  return {
    // 用户手动点「一键部署」时强制重试，绕过失败冷却
    'runtime:autoDeploy': (_e, opts = {}) => autoDeploy({ force: !!opts.force }),

    'provision:installEmulator': async () => {
      try {
        const r = await live.runtime.provisioner.installEmulator(
          (p) => send('provision:progress', { ...p, component: 'emulator' }),
        );
        return { ok: true, ...r };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    'provision:installSysimg': async () => {
      try {
        const r = await live.runtime.provisioner.installSystemImage(
          (p) => send('provision:progress', { ...p, component: 'sysimg' }),
        );
        return { ok: true, ...r };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    'provision:installPlayImage': async () => {
      try {
        const r = await live.runtime.provisioner.installPlayImage(
          (p) => send('provision:progress', { ...p, component: 'playimg' }),
        );
        return { ok: true, ...r };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    'provision:installAehd': async () => {
      try {
        const r = await live.runtime.provisioner.installAehd(
          (p) => send('provision:progress', { ...p, component: 'aehd' }),
        );
        return { ok: true, ...r };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    'provision:installAdb': async () => {
      try {
        const r = await live.runtime.provisioner.installAdb((p) => send('provision:progress', { ...p, component: 'adb' }));
        return { ok: true, ...r };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    'provision:installQemu': async () => {
      try {
        const r = await live.runtime.provisioner.installQemu((p) => send('provision:progress', { ...p, component: 'qemu' }));
        return { ok: true, ...r };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    'provision:downloadIso': async () => {
      try {
        const r = await live.runtime.provisioner.downloadIso((p) => send('provision:progress', { ...p, component: 'iso' }));
        return { ok: true, ...r };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    'provision:createDisk': async (_e, sizeGB) => {
      try {
        const r = await live.runtime.provisioner.createDisk(sizeGB || store.getSettings().runtime.diskSizeGB || 24,
          (p) => send('provision:progress', { ...p, component: 'disk' }));
        return { ok: true, ...r };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    'provision:importIso': async () => {
      const r = await dialog.showOpenDialog(live.mainWindow, {
        title: '选择 Android-x86 / Bliss OS 系统镜像',
        filters: [{ name: '系统镜像', extensions: ['iso', 'img'] }],
        properties: ['openFile'],
      });
      if (r.canceled) return { ok: false, canceled: true };
      try {
        return { ok: true, ...live.runtime.provisioner.importIso(r.filePaths[0]) };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    'provision:importDisk': async () => {
      const r = await dialog.showOpenDialog(live.mainWindow, {
        title: '选择已安装 Android 的虚拟磁盘',
        filters: [{ name: '虚拟磁盘', extensions: ['qcow2', 'img', 'vmdk', 'raw'] }],
        properties: ['openFile'],
      });
      if (r.canceled) return { ok: false, canceled: true };
      try {
        const info = live.runtime.provisioner.importDisk(r.filePaths[0]);
        store.saveSettings({ runtime: { installed: true } });
        return { ok: true, ...info };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    'provision:check': async () => live.runtime.provisioner.checkEnv(),

    'provision:probeSources': async () => live.runtime.provisioner.probeSources(),

    'runtime:startInstaller': async () => {
      try {
        await live.runtime.startInstaller({ onLog: (m) => send('runtime:log', m) });
        return { ok: true };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    'runtime:markInstalled': async () => {
      try {
        await live.runtime.markInstalled();
        return { ok: true };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    'runtime:resetInstall': async () => {
      store.saveSettings({ runtime: { installed: false } });
      return { ok: true };
    },
  };
}

module.exports = { createProvisionHandlers };
