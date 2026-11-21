'use strict';

const path = require('path');

const MIN_VISIBLE_MS = 1800;
const CLOSE_GRACE_MS = 2500;
const STARTUP_DEADLINE_MS = 180000;

function createStartupSplash({
  BrowserWindow, screen, srcDir, registerIpc, log, now = Date.now,
  setTimer = setTimeout, clearTimer = clearTimeout,
}) {
  let window = null;
  let shownAt = null;
  let finishRequested = false;
  let doneSent = false;
  let minimumTimer;
  let closeTimer;
  let deadline;

  const later = (task, ms) => {
    const timer = setTimer(task, ms);
    timer?.unref?.();
    return timer;
  };
  const hasWindow = () => !!window && !window.isDestroyed();
  const retire = () => {
    window = null;
    clearTimer(minimumTimer);
    clearTimer(closeTimer);
    clearTimer(deadline);
  };
  const close = () => {
    const active = window;
    retire();
    if (!active || active.isDestroyed()) return;
    try { active.close(); } catch (_) { /* The window can already be closing. */ }
  };

  function finish() {
    finishRequested = true;
    if (doneSent || !hasWindow() || shownAt === null) return;
    const remaining = MIN_VISIBLE_MS - (now() - shownAt);
    if (remaining > 0) {
      minimumTimer ??= later(() => {
        minimumTimer = undefined;
        finish();
      }, remaining);
      return;
    }

    doneSent = true;
    try { window.webContents.send('splash:done'); } catch (_) { /* Deadline still closes it. */ }
    closeTimer = later(close, CLOSE_GRACE_MS);
  }

  try {
    const { width, height } = screen.getPrimaryDisplay().workAreaSize;
    const splashWidth = 480;
    const splashHeight = 360;
    const active = window = new BrowserWindow({
      width: splashWidth, height: splashHeight,
      x: Math.round((width - splashWidth) / 2),
      y: Math.round((height - splashHeight) / 2),
      frame: false, transparent: false, resizable: false,
      alwaysOnTop: true, skipTaskbar: true,
      backgroundColor: '#0b0c0e', show: false,
      webPreferences: {
        preload: path.join(srcDir, 'splash-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
      },
    });
    active.setAlwaysOnTop(true, 'screen-saver');
    active.once('closed', () => { if (window === active) retire(); });
    active.once('ready-to-show', () => {
      if (window !== active || !hasWindow()) return;
      shownAt = now();
      active.show();
      if (finishRequested) finish();
    });
    // The renderer can invoke its channels as soon as the page loads.
    registerIpc({ close });
    Promise.resolve(active.loadFile(path.join(srcDir, 'ui', 'splash.html'))).catch((error) => {
      if (window !== active) return;
      log('splash window failed: ' + error.message);
      close();
    });
    deadline = later(() => {
      if (shownAt === null) close();
      else finish();
    }, STARTUP_DEADLINE_MS);
  } catch (error) {
    log('splash window failed: ' + error.message);
    close();
  }

  return {
    hasWindow,
    close,
    finish,
    progress: (payload) => {
      if (hasWindow()) window.webContents.send('splash:progress', payload);
    },
  };
}

module.exports = { createStartupSplash };
