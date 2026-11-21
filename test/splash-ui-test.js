'use strict';

// Run with `electron test/splash-ui-test.js`. Only the real splash renderer is loaded.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, ipcMain } = require('electron');
const { version } = require('../package.json');
const { splashBounds } = require('../src/desktop/startup-splash');

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('mute-audio');
const src = path.join(__dirname, '..', 'src');
const status = '正在准备 Android 运行时，请保留这个窗口。组件检查完毕后会自动进入下一步，无需重复安装或手动重启。';

let fixture;
ipcMain.handle('splash:version', () => version);
ipcMain.handle('splash:isFirstRun', () => fixture.firstRun);
ipcMain.handle('splash:bundled', () => fixture.bundled);

function getLayout() {
  const rect = (selector) => {
    const el = document.querySelector(selector);
    const { x, y, width, height, bottom, right } = el.getBoundingClientRect();
    return { x, y, width, height, bottom, right };
  };
  return {
    viewport: { w: innerWidth, h: innerHeight },
    content: document.querySelector('.splash-content') ? rect('.splash-content') : null,
    logo: rect('.logo'), brand: rect('.brand'), tagline: rect('.tagline'),
    progress: rect('.progress-wrap'), status: rect('.status'), footer: rect('.footer'),
    card: document.querySelector('#firstRun').hidden ? null : rect('#firstRun'),
    items: document.querySelector('#firstRun').hidden ? [] : Array.from(document.querySelectorAll('#firstRun li'), (el) => {
      const { x, y, width, height, bottom, right } = el.getBoundingClientRect();
      return { x, y, width, height, bottom, right };
    }),
    statusText: document.querySelector('#status').textContent,
    title: document.querySelector('#firstRunTitle').textContent,
    version: document.querySelector('#ver').textContent,
    percent: document.querySelector('#progressBar').style.width,
  };
}

function within(rect, { w, h }) {
  return rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0
    && rect.right <= w + 0.5 && rect.bottom <= h + 0.5;
}

async function verify(options) {
  fixture = options;
  const { width, height } = splashBounds(options.workArea);
  const win = new BrowserWindow({
    frame: false, show: false, useContentSize: true, width, height,
    webPreferences: {
      preload: path.join(src, 'splash-preload.js'), contextIsolation: true,
      offscreen: true, backgroundThrottling: false,
    },
  });
  try {
    win.webContents.setAudioMuted(true);
    await win.loadFile(path.join(src, 'ui', 'splash.html'));
    win.webContents.send('splash:progress', { percent: 63, message: status });
    if (process.env.APKSTART_SPLASH_CAPTURE_DIR) await delay(1900);
    else {
      // Wait for preload responses and inspect the stable layout, not a particular animation frame.
      for (let i = 0; i < 20; i++) {
        const ready = await win.webContents.executeJavaScript(`Boolean(document.querySelector('#ver').textContent && document.querySelector('#progressBar').style.width && document.querySelector('#firstRun').hidden === ${!options.firstRun})`);
        if (ready) break;
        await delay(50);
      }
      await win.webContents.executeJavaScript(`document.getAnimations().forEach(a => { if (a.effect.getTiming().iterations === Infinity) a.cancel(); else a.finish(); });`);
    }
    const report = await win.webContents.executeJavaScript(`(${getLayout.toString()})()`);
    if (process.env.APKSTART_SPLASH_CAPTURE_DIR) {
      fs.writeFileSync(path.join(process.env.APKSTART_SPLASH_CAPTURE_DIR, `${options.name}.png`), (await win.webContents.capturePage()).toPNG());
    }
    // Windows can round the DIP content bounds by one CSS pixel at fractional DPI.
    assert.ok(Math.abs(report.viewport.w - width) <= 1 && Math.abs(report.viewport.h - height) <= 1,
      `unexpected native viewport: ${JSON.stringify(report.viewport)}`);
    assert.equal(report.version, version);
    assert.equal(report.percent, '63%');
    assert.equal(report.statusText, status);
    assert.equal(Boolean(report.card), options.firstRun);
    if (options.firstRun) {
      assert.match(report.title, options.bundled ? /无需联网/ : /自动配置/);
      assert.equal(report.items.length, 4);
    }
    const stack = [report.logo, report.brand, report.tagline, report.progress, report.status, report.card, report.footer].filter(Boolean);
    assert.ok(stack.every((r) => within(r, report.viewport)), `${options.name} has cropped elements: ${JSON.stringify(report)}`);
    assert.ok(stack.slice(1).every((r, i) => stack[i].bottom <= r.y + 0.5), `${options.name} has overlapping elements: ${JSON.stringify(report)}`);
    if (report.content) {
      assert.ok(stack.slice(0, -1).every((r) => r.y >= report.content.y - 0.5 && r.bottom <= report.content.bottom + 0.5),
        `${options.name} has clipped content inside its splash row`);
    }
    if (report.card) {
      assert.ok(report.items.every((item) => item.y >= report.card.y && item.bottom <= report.card.bottom));
    }
    console.log(`${options.name} (${report.viewport.w}x${report.viewport.h}): logo y=${report.logo.y.toFixed(1)}, card bottom=${report.card?.bottom.toFixed(1) ?? '-'}, footer top=${report.footer.y.toFixed(1)}`);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

app.on('window-all-closed', () => {});
app.whenReady().then(async () => {
  let failures = 0;
  const states = [
    { name: 'normal', firstRun: false, bundled: false },
    { name: 'downloads', firstRun: true, bundled: false },
    { name: 'bundled', firstRun: true, bundled: true },
  ];
  for (const [resolution, width, height] of [['720p', 1280, 680], ['1080p', 1920, 1040], ['2K', 2560, 1400], ['4K', 3840, 2120]]) {
    for (const state of states) {
      try { await verify({ ...state, name: `${resolution}-${state.name}`, workArea: { x: 0, y: 0, width, height } }); }
      catch (err) { failures++; console.error(err); }
    }
  }
  app.exit(failures ? 1 : 0);
}).catch((err) => { console.error(err); app.exit(1); });
