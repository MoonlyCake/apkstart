'use strict';

const { ipcFailure } = require('../failure');

function createUpdatesHandlers({ app, cancelUpdate, live, quitForRestart, runUpdate, setUpdateInfo, shell, Updater }) {
  return {
    'app:updateCheck': async (_e, opts = {}) => {
      try {
        // 用户主动点「检查更新」→ 跳过缓存，必定重新问一次两个源
        const info = await live.updater.check({ force: opts.force !== false });
        setUpdateInfo(info);
        return { ok: true, ...info };
      } catch (e) {
        return { ...ipcFailure(e), current: app.getVersion() };
      }
    },

    'app:updateOpen': (_e, url) => {
      // GitHub 和 Gitee 的发布页都允许直接打开：检查更新失败时界面就是靠这个
      // 让用户手动去下载，只放行 github.com 会把国内用户挡在门外。
      const raw = String(url || '');
      const ok = /^https:\/\/(github\.com|gitee\.com)\//i.test(raw);
      const target = ok ? raw : Updater.repoUrl();
      shell.openExternal(target).catch(() => {});
      return { ok: true, target };
    },

    'app:updateApply': () => runUpdate(),

    'app:updateCancel': () => { cancelUpdate(); return { ok: true }; },

    'app:restart': () => {
      setTimeout(() => { quitForRestart(); }, 200);
      return { ok: true };
    },
  };
}

module.exports = { createUpdatesHandlers };
