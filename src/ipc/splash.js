'use strict';

const { registerHandlers } = require('./dispatch');

function registerSplashIpc(ipcMain, { getVersion, isFirstRun, isBundled, close }) {
  registerHandlers(ipcMain, [{
    'splash:version': getVersion,
    'splash:isFirstRun': () => isFirstRun,
    // Bundled builds use different wording from builds that must download a runtime.
    'splash:bundled': isBundled,
  }]);
  ipcMain.on('splash:close', close);
}

module.exports = { registerSplashIpc };
