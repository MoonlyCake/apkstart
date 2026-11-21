'use strict';

const { registerHandlers } = require('./dispatch');
const { createDesktopHandlers } = require('./handlers/desktop');
const { createAppsHandlers } = require('./handlers/apps');
const { createSettingsHandlers } = require('./handlers/settings');
const { createProvisionHandlers } = require('./handlers/provision');
const { createDriversHandlers } = require('./handlers/drivers');
const { createRuntimeHandlers } = require('./handlers/runtime');
const { createDiagnosticsHandlers } = require('./handlers/diagnostics');
const { createWindowsFeaturesHandlers } = require('./handlers/windows-features');
const { createRuntimeDataHandlers } = require('./handlers/runtime-data');
const { createWindowHandlers } = require('./handlers/window');
const { createAndroidHandlers } = require('./handlers/android');
const { createUpdatesHandlers } = require('./handlers/updates');

const domains = [
  createDesktopHandlers,
  createAppsHandlers,
  createSettingsHandlers,
  createProvisionHandlers,
  createDriversHandlers,
  createRuntimeHandlers,
  createDiagnosticsHandlers,
  createWindowsFeaturesHandlers,
  createRuntimeDataHandlers,
  createWindowHandlers,
  createAndroidHandlers,
  createUpdatesHandlers,
];

function registerIpc(ipcMain, dependencies) {
  registerHandlers(ipcMain, domains.map((create) => create(dependencies)), dependencies.appLog);
}

module.exports = { registerIpc };
