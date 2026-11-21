'use strict';

const path = require('path');

const MIN_VISIBLE_MS = 1800;
const CLOSE_GRACE_MS = 2500;
const STARTUP_DEADLINE_MS = 180000;

function splashBounds(workArea) {
  const { x, y, width, height } = workArea;
  // Electron reports work area in DIP; scale gently without turning a 4K splash into a full window.
  const roomy = Math.min(width / 1280, height / 680);
  const scale = Math.min(1.32, 1 + 0.2 * Math.max(0, Math.log2(roomy)),
    (width - Math.min(32, width / 10)) / 480, (height - Math.min(32, height / 10)) / 360);
  const splashWidth = Math.max(1, Math.floor(480 * scale));
  const splashHeight = Math.max(1, Math.floor(360 * scale));
  return {
    width: splashWidth, height: splashHeight,
    x: x + Math.round((width - splashWidth) / 2),
    y: y + Math.round((height - splashHeight) / 2),
  };
}

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
  const onDisplayMetrics = (_event, display, metrics) => {
    if (shownAt === null || !hasWindow() || !metrics.some((m) => m === 'workArea' || m === 'bounds' || m === 'scaleFactor')) return;
    // Resize only for a change on the display containing this splash, never on ordinary window moves.
    if (screen.getDisplayMatching(window.getBounds()).id === display.id) window.setBounds(splashBounds(display.workArea));
  };
  const retire = () => {
    window = null;
    screen.removeListener('display-metrics-changed', onDisplayMetrics);
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
    const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const active = window = new BrowserWindow({
      ...splashBounds(display.workArea),
      frame: false, transparent: false, resizable: false,
      alwaysOnTop: true, skipTaskbar: true,
      backgroundColor: '#0b0c0e', show: false,
      webPreferences: {
        preload: path.join(srcDir, 'splash-preload.js'),
        contextIsolation: true, nodeIntegration: false, sandbox: false,
      },
    });
    screen.on('display-metrics-changed', onDisplayMetrics);
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

module.exports = { createStartupSplash, splashBounds };
