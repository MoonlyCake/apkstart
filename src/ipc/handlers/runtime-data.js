'use strict';

function createRuntimeDataHandlers({ appLog, appOperations, dialog, live, notify }) {
  return {
    'runtime:usage': () => live.runtime.usage(),

    /**
     * 就地扩容做不到时（quickboot 差量盘）走这条：按目标容量重建 /data。
     * 会清空已装应用与存档 —— 调用方必须已经让用户明确确认过。
     */
    'runtime:resetAndResize': async (_e, gb) => {
      const res = require('../../core/resources');
      const doctor = require('../../core/doctor');
      const freeMB = doctor.freeDiskMB(live.runtime.provisioner.paths().root);
      const want = res.clampDataGB(gb, freeMB).gb;
      if (!want) return { ok: false, error: '目标容量不合法' };
      return appOperations.run(`reset:resize:${want}`, async () => {
        const r = await live.runtime.resetAndroidData({ dataPartitionGB: want }).catch((e) => ({ ok: false, error: e.message }));
        appLog(`reset+resize -> ${want}GB: ${JSON.stringify(r)}`);
        return { ...r, wantGB: want };
      });
    },

    // 数据分区（/data）容量：应用、游戏与它们的更新包都装在这里。
    // 「游戏更新提示空间不足」几乎都是这一项太小，扩容是就地做的，不丢数据。
    'runtime:dataInfo': () => {
      const doctor = require('../../core/doctor');
      const b = live.runtime.backend;
      const info = (b && typeof b.dataInfo === 'function') ? (b.dataInfo() || {}) : {};
      const freeDiskMB = Number(info.freeMB) || Number(info.freeDiskMB)
        || doctor.freeDiskMB(live.runtime.provisioner.paths().root);
      return { ...info, freeDiskMB };
    },

    'runtime:setDataSize': async (_e, gb) => {
      const res = require('../../core/resources');
      const doctor = require('../../core/doctor');
      const freeMB = doctor.freeDiskMB(live.runtime.provisioner.paths().root);
      const want = res.clampDataGB(gb, freeMB).gb;
      try {
        // The lifecycle queue owns stop-and-resize; IPC must not release it between the two.
        const r = await live.runtime.resizeDataPartition(Math.round(want * 1024));
        appLog(`data partition -> ${want}GB: ${JSON.stringify(r)}`);
        if (r.ok && want) notify('数据分区已调整', `安卓可用空间约 ${want} GB${r.stopped ? '（运行时已停止）' : ''}`);
        return r;
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    'runtime:cleanup': async (_e, opts = {}) => {
      // 明确两次确认：先给清单，用户确认后才真正删；且只清理 ApkStart 自己的运行时目录
      const pass = { apply: false, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots };
      if (!opts.apply) return live.runtime.cleanup(pass);
      const preview = await live.runtime.cleanup(pass);
      const { response } = await dialog.showMessageBox(live.mainWindow, {
        type: 'warning',
        buttons: ['取消', `清理 ${preview.candidates.length} 项`],
        defaultId: 0,
        cancelId: 0,
        title: '确认清理运行时缓存',
        message: `将释放约 ${(preview.candidates.reduce((n, c) => n + c.size, 0) / 1048576).toFixed(0)} MB`,
        detail: (opts.includeSnapshots
          ? '会先停止运行时，再删除旧镜像、当前 AVD 的快速启动快照和非活动 AVD 的缓存。已安装的应用本身保留（只清快照），'
          : '只删除旧镜像和非活动 AVD 的缓存，已安装的应用会保留。')
          + '此操作不可撤销，建议先导出诊断报告。',
      });
      if (response !== 1) return { ...preview, cancelled: true };
      return live.runtime.cleanup({ apply: true, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots });
    },

    // 彻底重置安卓数据：清空 /data 用户分区 + 已装应用 + 快速启动快照，
    // AVD 还原成「刚装好系统」的干净状态。会真实删除数 GB 数据，UI 必须二次确认。
    'runtime:resetData': () => appOperations.run('reset:android-data', async () => {
      try {
        const r = await live.runtime.resetAndroidData();
        if (!r.ok) return { ok: false, error: r.error };
        return { ok: true, reclaimed: r.reclaimed, reclaimedMB: Math.round(r.reclaimed / 1048576) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }),
  };
}

module.exports = { createRuntimeDataHandlers };
