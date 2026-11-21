'use strict';

/** Screen sizing and AppWindow dispatch, without launching Electron or Android. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { windowBounds, tabletDensityFor } = require('../src/core/display');
const { physicalRect, physicalScreenRect } = require('../src/core/geometry');

test('uniform DPI scaling remains available without an Electron converter', () => {
  const rect = { x: 33, y: 41, w: 1001, h: 777 };
  assert.equal(physicalRect(rect, 1), rect);
  assert.deepEqual(physicalScreenRect(rect, 1.25), { x: 41, y: 51, w: 1251, h: 971 });
  assert.deepEqual(physicalRect({ x: -8, y: 22, w: 900, h: 500 }, 2), { x: -16, y: 44, w: 1800, h: 1000 });
});

test('mixed DPI converts the whole screen rectangle around the actual monitor origin', () => {
  const rect = { x: 2020, y: 100, w: 600, h: 1000 };
  assert.deepEqual(physicalScreenRect(rect, 1.5, (dip) => {
    assert.deepEqual(dip, { x: 2020, y: 100, width: 600, height: 1000 });
    return { x: 1920 + (dip.x - 1920) * 1.5, y: dip.y * 1.5, width: dip.width * 1.5, height: dip.height * 1.5 };
  }), { x: 2070, y: 150, w: 900, h: 1500 });
});

test('720p, 900p, 1080p and 1440p window presets have distinct visible sizes at 2560×1440', () => {
  const area = { x: 0, y: 0, w: 2560, h: 1392 };
  const panes = ['720x1280', '900x1600', '1080x1920', '1440x2560'].map((preset) => windowBounds(preset, area));
  assert.deepEqual(panes.map(({ h }) => h), [890, 1085, 1238, 1350]);
  assert.ok(panes[2].w > 680);
  for (const item of panes) {
    assert.ok(Math.abs(item.w - item.h * 9 / 16) < 1);
    assert.ok(item.x + item.w <= area.w && item.y + item.h <= area.h);
  }
});

test('landscape and portrait fullscreen fit even on tall or mixed-origin work areas', () => {
  const area = { x: -1000, y: 40, w: 900, h: 1600 };
  const land = windowBounds({ w: 1920, h: 1080 }, area, { landscape: true, fullscreen: true, caption: 38 });
  assert.equal(land.w, 900);
  assert.equal(land.x, -1000);
  assert.ok(Math.abs((land.h - 38) * 16 / 9 - land.w) < 2);
  const portrait = windowBounds('1080x1920', area, { fullscreen: true });
  assert.equal(portrait.h, 1600);
  assert.equal(portrait.y, 40);
});

test('saved windowed dimensions are preferred and brought back within the current display', () => {
  const fitted = windowBounds('1440x2560', { x: -1900, y: 24, w: 1800, h: 1040 }, {
    remembered: { x: -3000, y: -20, width: 450, height: 800 },
  });
  assert.deepEqual(fitted, { x: -1900, y: 24, w: 450, h: 800 });
});

test('tablet layout scales density with the physical short side and respects manual DPI', () => {
  assert.equal(tabletDensityFor(720, 1280), 190);
  assert.equal(tabletDensityFor(1080, 1920), 285);
  assert.equal(tabletDensityFor(1920, 1080), 285);
  assert.equal(tabletDensityFor(1080, 1920, 240), 240);
  assert.equal(tabletDensityFor(0, 0), 190);
});

function detachedFixture() {
  const screenArea = { x: 1920, y: 0, width: 1706, height: 928 };
  const secondary = { workArea: screenArea, scaleFactor: 1.5 };
  const primary = { workArea: { x: 0, y: 0, width: 1920, height: 1040 }, scaleFactor: 1 };
  const applied = [];
  const waits = [];
  const events = [];
  const fakeScreen = {
    getDisplayMatching: () => primary,
    getDisplayNearestPoint: ({ x }) => x >= 1920 ? secondary : primary,
    screenToDipPoint: ({ x, y }) => ({ x: 1920 + (x - 1920) / 1.5, y: y / 1.5 }),
    dipToScreenRect: (win, rect) => {
      assert.equal(win, null);
      return { x: Math.round(1920 + (rect.x - 1920) * 1.5), y: Math.round(rect.y * 1.5),
        width: Math.round(rect.width * 1.5), height: Math.round(rect.height * 1.5) };
    },
  };
  const filename = path.join(__dirname, '../src/core/appwin.js');
  const realRequire = createRequire(filename);
  const mod = { exports: {} };
  new Function('require', 'module', '__dirname', 'setTimeout', fs.readFileSync(filename, 'utf8'))(
    (id) => id === 'electron' ? { screen: fakeScreen } : realRequire(id), mod, path.dirname(filename),
    (fn, ms) => { waits.push(ms); fn(); },
  );
  const agent = {
    probe: async () => ({ x: 2000, y: 100, w: 500, h: 899 }),
    detach: async () => { events.push('detach'); return { ok: true }; },
    setTitle: async () => { events.push('title'); return { ok: true }; },
    show: async () => { events.push('show'); return { ok: true }; },
    layout: async (rect) => { applied.push(rect); events.push('layout'); return { ok: true }; },
  };
  const appWindow = new mod.exports.AppWindow({ agent });
  appWindow.win = {
    isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 600, height: 1000 }),
    hide: () => events.push('hide-shell'),
  };
  appWindow.detachedMode = true;
  appWindow._layoutFullscreen = false;
  appWindow._surfaceAttached = true;
  appWindow.portrait = { w: 720, h: 1280 };
  return { appWindow, agent, applied, waits, events };
}

test('current native window honors a larger preset on its monitor without guest operations', async () => {
  const { appWindow, applied } = detachedFixture();
  assert.equal(await appWindow.applyWindowSize({ w: 1080, h: 1920 }), true);
  assert.equal(applied.length, 1);
  assert.ok(applied[0].x >= 1920 && applied[0].h > 1200, JSON.stringify(applied[0]));
  assert.equal(appWindow.state.landscape, false);
});

test('fullscreen restores the actual dragged physical rectangle; failed resize is not acknowledged', async () => {
  const { appWindow, agent, applied } = detachedFixture();
  assert.equal(await appWindow.toggleMaximize(true), true);
  assert.equal(applied[0].h, 1392);
  assert.equal(await appWindow.toggleMaximize(false), true);
  assert.deepEqual(applied[1], { x: 2000, y: 100, w: 500, h: 899 });
  agent.layout = async () => ({ ok: false });
  assert.equal(await appWindow.applyWindowSize({ w: 1080, h: 1920 }), false);
});

test('native attachment preserves show/layout ordering without an unconditional delay', async () => {
  const { appWindow, events, waits } = detachedFixture();
  assert.equal(await appWindow.openDetached(), true);
  assert.deepEqual(events, ['detach', 'title', 'show', 'layout', 'hide-shell']);
  assert.deepEqual(waits, []);
});

test('only the latest queued Windows resize is acknowledged', async () => {
  const { appWindow, applied } = detachedFixture();
  const old = appWindow.applyWindowSize({ w: 900, h: 1600 });
  const current = appWindow.applyWindowSize({ w: 1080, h: 1920 });
  assert.deepEqual(await Promise.all([old, current]), [false, true]);
  assert.equal(applied.length, 1);
});
