'use strict';

const { ipcFailure } = require('../failure');

function createRuntimeHandlers({ live, send }) {
  return {
    'runtime:status': async () => live.runtime.status(),

    'runtime:probe': async () => live.runtime.probe(),

    'runtime:start': async () => {
      const r = await live.runtime.ensure({ onLog: (m) => send('runtime:log', m) });
      return r.ok ? { ok: true, engine: r.engine } : { ok: false, error: r.error, needsSetup: r.needsSetup };
    },

    'runtime:stop': async () => {
      const stopped = await live.runtime.stop();
      return stopped ? { ok: true } : { ok: false, error: '未能确认 ApkStart 安卓运行时已停止。' };
    },

    'runtime:log': () => live.runtime.bootLog,

    /** 清残留的孤儿模拟器进程（emulator.exe 只是启动器，qemu 是 detached 的） */
    'app:clearOrphans': async () => {
      try {
        const stopped = await live.runtime.stop();
        return stopped ? { ok: true, note: '已确认没有在运行的 ApkStart 安卓实例。' }
          : { ok: false, error: '无法确认归属或关闭失败，未终止其他模拟器。' };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    /** 作废快速启动快照（快照坏了会导致每次开机都白等一次冷启动） */
    'app:clearSnapshot': async () => {
      try {
        const ok = live.runtime.emulator.invalidateSnapshot();
        return { ok: !!ok };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    /** 重启运行时：自愈 unauthorized / 引导卡死 / 孤儿锁的首选动作 */
    'runtime:restart': async () => {
      try {
        const r = await live.runtime.restart({ onLog: (m) => send('runtime:log', m) });
        return r?.ok ? { ok: true, ready: true } : { ok: false, error: r?.error || '安卓运行时未能启动。' };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    /**
     * 资源分配总览：宿主上限、当前分配、数据盘余量。
     * 由运行时自己的 resources() 回答，界面只认这个结构。
     */
    'engine:resources': async () => {
      try {
        const backend = live.runtime.backend;
        if (backend && typeof backend.resources === 'function') return await backend.resources();
        return { backend: backend ? backend.id : '', ok: false, note: '运行时未就绪，暂时读不到资源分配' };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    // 修复虚拟机网络；不隐式重置安卓数据。
    // 典型场景：安卓里所有联网页面一直黑屏，其实是 wlan0 没起来、没有默认路由。
    'runtime:repairNetwork': async () => {
      try {
        const r = await live.runtime.repairNetwork({
          onLog: (m) => send('toast', { message: m, kind: 'info', timeout: 6000 }),
        });
        return r;
      } catch (e) {
        return ipcFailure(e);
      }
    },

    // 只做网络体检，不动任何数据（设置页用来显示当前状态）
    'runtime:checkNetwork': async () => {
      try {
        const network = await live.runtime.checkNetwork();
        return { ok: !!network.ok, network };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    /** 不手动删除模拟器的锁，避免其他进程正在重新打开该目录。 */
    'app:clearLocks': () => {
      const { state } = live.runtime.avdOwner();
      if (state === 'live' || state === 'unknown') {
        return { ok: false, error: '请先关闭 ApkStart 安卓运行时，再重新启动。' };
      }
      return { ok: true, note: '重新启动时由 Android Emulator 回收失效的锁。' };
    },
  };
}

module.exports = { createRuntimeHandlers };
