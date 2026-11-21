'use strict';

const path = require('node:path');
const { Installer } = require('../core/installer');
const { Sharer } = require('../core/sharer');
const { AndroidSettings } = require('../core/android');
const { KeymapEngine } = require('../core/keymap-engine');
const { Updater } = require('../core/updater');

function createStartupServices({ app, runtime, store, launcher, isDev, decodeIcon, onUpdateProgress }) {
  const startMenuDir = process.platform === 'win32'
    ? path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs')
    : path.join(process.env.HOME || app.getPath('home'), '.local', 'share', 'applications');
  const installer = new Installer(runtime, {
    launcherTarget: launcher.target, launcherArgs: launcher.args, cwd: launcher.cwd, isDev,
    desktopDir: app.getPath('desktop'), startMenuDir, decodeIcon,
  });
  const keymapEngine = new KeymapEngine({
    execInput: (cmd) => runtime.client().shell(cmd, { timeout: 4000 }),
    getSize: () => (store.getSettings().display || {}).landscape
      ? { width: 1280, height: 720 } : { width: 720, height: 1280 },
  });
  const engine = store.getSettings().engine;
  for (const [pkg, mappings] of Object.entries(engine.keymaps || {})) {
    if (Array.isArray(mappings) && mappings.length) keymapEngine.setMap(pkg, mappings);
  }
  keymapEngine.enable(engine.keymapEnabled !== false);

  const updater = new Updater({
    currentVersion: app.getVersion(), exePath: process.execPath, isPackaged: app.isPackaged,
    dataDir: store.DATA_DIR, electronVersion: process.versions.electron,
    settings: () => store.getSettings(), onProgress: onUpdateProgress,
  });
  return { installer, keymapEngine, updater, sharer: new Sharer(runtime), androidSet: new AndroidSettings(runtime) };
}

module.exports = { createStartupServices };
