'use strict';

const { withIpcDiagnostics } = require('./failure');

function registerHandlers(ipcMain, groups, logIpcFailure) {
  const channels = new Map();
  // Check all definitions before registering any of them with Electron.
  for (const group of groups) {
    for (const [channel, handler] of Object.entries(group)) {
      if (channels.has(channel)) throw new Error(`Duplicate IPC handler: ${channel}`);
      channels.set(channel, handler);
    }
  }
  for (const [channel, handler] of channels) {
    ipcMain.handle(channel, function (...args) {
      return withIpcDiagnostics(channel, logIpcFailure, () => handler.apply(this, args));
    });
  }
}

module.exports = { registerHandlers };
