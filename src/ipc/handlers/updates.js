'use strict';

const { ipcFailure } = require('../failure');

function createUpdatesHandlers({ app, cancelUpdate, live, quitForRestart, runUpdate, setUpdateInfo, shell, Updater }) {
  return {
    'app:updateCheck': async (_e, opts = {}) => {
      try {
        // 用户主动点「检查更新」时绕过短期缓存。
        const info = await live.updater.check({ force: opts.force !== false });
        setUpdateInfo(info);
        return { ok: true, ...info };
      } catch (e) {
        return { ...ipcFailure(e), current: app.getVersion() };
      }
    },

    'app:updateOpen': (_e, url) => {
      const target = Updater.releasePageUrl(url);
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
