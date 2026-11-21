'use strict';

const { ipcFailure } = require('../failure');

const { clampDataGB } = require('../../core/resources');
const doctor = require('../../core/doctor');

function createRuntimeDataHandlers({ appLog, appOperations, dialog, fs, live, notify, shell }) {
  const currentPaths = () => live.runtime.provisioner.paths();
  const avdFreeMB = (paths) => doctor.freeDiskMB(paths.avdHome || paths.root);
  function planCapacity(gb) {
    const requested = Number(gb);
    if ((!['number', 'string'].includes(typeof gb) || (typeof gb === 'string' && !gb.trim()))
        || !Number.isInteger(requested) || requested < 0) {
      return { ok: false, error: '目标容量不合法' };
    }
    const freeMB = avdFreeMB(currentPaths());
    if (requested && freeMB <= 0) return { ok: false, error: '无法确认安卓数据盘有可用空间，未调整容量。' };
    const { gb: want, capped, reason } = clampDataGB(requested, freeMB);
    // A positive size clamped to 0 means no space, not a request to turn on automatic sizing.
    if (requested && !want) return { ok: false, error: '安卓数据盘空间不足，未调整容量。' };
    if (requested && capped) return { ok: false, error: `${reason}。未调整容量。` };
    return { ok: true, want };
  }
  return {
    'runtime:usage': () => live.runtime.usage(),

    'runtime:openDirectory': async (_e, kind) => {
      if (kind !== 'runtime' && kind !== 'avd') return { ok: false, error: '未知目录类型' };
      try {
        const paths = currentPaths();
        const dir = kind === 'avd' ? paths.avdHome : paths.root;
        if (!dir || !fs.existsSync(dir)) return { ok: false, error: '该目录尚未创建' };
        const error = await shell.openPath(dir);
        return error ? { ok: false, error } : { ok: true };
      } catch (e) {
        return ipcFailure(e);
      }
    },

    /**
     * 就地扩容做不到时（quickboot 差量盘）走这条：按目标容量重建 /data。
     * 会清空已装应用与存档 —— 调用方必须已经让用户明确确认过。
     */
    'runtime:resetAndResize': async (_e, gb) => {
      const plan = planCapacity(gb);
      if (!plan.ok) return plan;
      const { want } = plan;
      if (!want) return { ok: false, error: '目标容量不合法' };
      return appOperations.run(`reset:resize:${want}`, async () => {
        const r = await live.runtime.resetAndroidData({ dataPartitionGB: want }).catch(ipcFailure);
        appLog(`reset+resize -> ${want}GB: ${r.ok ? 'ok' : 'not completed'}`);
        return { ...r, wantGB: want };
      });
    },

    // 数据分区（/data）容量：应用、游戏与它们的更新包都装在这里。
    // 「游戏更新提示空间不足」几乎都是这一项太小，扩容是就地做的，不丢数据。
    'runtime:dataInfo': () => {
      const paths = currentPaths();
      const b = live.runtime.backend;
      const info = (b && typeof b.dataInfo === 'function') ? (b.dataInfo() || {}) : {};
      return { ...info, freeDiskMB: avdFreeMB(paths), avdDir: paths.avdHome, avdDirConflict: paths.avdDirConflict || null };
    },

    'runtime:setDataSize': async (_e, gb) => {
      try {
        const plan = planCapacity(gb);
        if (!plan.ok) return plan;
        const { want } = plan;
        // The lifecycle queue owns stop-and-resize; IPC must not release it between the two.
        const r = await live.runtime.resizeDataPartition(Math.round(want * 1024));
        appLog(`data partition -> ${want}GB: ${r.ok ? 'ok' : 'not completed'}`);
        if (r.ok && want) notify('数据分区已调整', `安卓可用空间约 ${want} GB${r.stopped ? '（运行时已停止）' : ''}`);
        return r;
      } catch (e) {
        return ipcFailure(e);
      }
    },

    'runtime:cleanup': async (_e, opts = {}) => {
      // 明确两次确认：先给清单，用户确认后才真正删；且只清理 ApkStart 自己的运行时目录
      const pass = { apply: false, includeSnapshots: !!opts.includeSnapshots };
      if (!opts.apply) return live.runtime.cleanup(pass);
      const preview = await live.runtime.cleanup(pass);
      if (preview?.ok !== true || !preview.candidates?.length) return preview;
      const { response } = await dialog.showMessageBox(live.mainWindow, {
        type: 'warning',
        buttons: ['取消', `清理 ${preview.candidates.length} 项`],
        defaultId: 0,
        cancelId: 0,
        title: '确认清理运行时缓存',
        message: `将释放约 ${(preview.candidates.reduce((n, c) => n + c.size, 0) / 1048576).toFixed(0)} MB`,
        detail: (opts.includeSnapshots
          ? '只清理列出的 Apk Start 缓存和当前安卓环境的快速启动快照。不会删除系统镜像、其他安卓环境或已安装的 APK。'
          : '只清理列出的 Apk Start 缓存，不删除系统镜像或安卓数据。')
          + '此操作不可撤销，建议先导出诊断报告。',
      });
      if (response !== 1) return { ...preview, cancelled: true };
      return live.runtime.cleanup({ ...pass, apply: true });
    },

    // 彻底重置安卓数据：清空 /data 用户分区 + 已装应用 + 快速启动快照，
    // AVD 还原成「刚装好系统」的干净状态。会真实删除数 GB 数据，UI 必须二次确认。
    'runtime:resetData': () => appOperations.run('reset:android-data', async () => {
      try {
        const r = await live.runtime.resetAndroidData();
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, reclaimed: r.reclaimed, reclaimedMB: Math.round(r.reclaimed / 1048576) };
      } catch (e) {
        return ipcFailure(e);
      }
    }),
  };
}

module.exports = { createRuntimeDataHandlers };
