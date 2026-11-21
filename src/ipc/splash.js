'use strict';

const { registerHandlers } = require('./dispatch');
const { withIpcDiagnostics } = require('./failure');

function registerSplashIpc(ipcMain, { getVersion, isFirstRun, isBundled, close, logIpcFailure }) {
  registerHandlers(ipcMain, [{
    'splash:version': getVersion,
    'splash:isFirstRun': () => isFirstRun,
    // Bundled builds use different wording from builds that must download a runtime.
    'splash:bundled': isBundled,
  }], logIpcFailure);
  ipcMain.on('splash:close', function (...args) {
    return withIpcDiagnostics('splash:close', logIpcFailure, () => close.apply(this, args));
  });
}

module.exports = { registerSplashIpc };
