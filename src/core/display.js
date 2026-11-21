'use strict';
/**
 * 显示适配的纯计算部分（可单测，不依赖 Electron / adb）。
 * Windows 窗口的显示尺寸与安卓的渲染尺寸独立，调大窗口不要求重启安卓。
 */
function densityFor(w, h, manual) {
  if (manual > 0) return Math.max(120, Math.min(640, Math.round(manual)));
  return Math.max(200, Math.min(480, Math.round(Math.min(w, h) / 2.57)));
}

/** 保持平板布局的短边约 606dp，避免高分辨率面板仍用 190 DPI 而把控件缩小。 */
function tabletDensityFor(w, h, manual) {
  const preferred = Number(manual);
  const width = Number(w);
  const height = Number(h);
  const automatic = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
    ? (Math.min(width, height) * 190) / 720
    : 190;
  return Math.max(120, Math.min(640, Math.round(Number.isFinite(preferred) && preferred > 0 ? preferred : automatic)));
}

function portraitSize(str) {
  const m = /^(\d{3,4})x(\d{3,4})$/i.exec(String(str || ''));
  if (!m) return { w: 900, h: 1600 };
  const w = Number(m[1]);
  const h = Number(m[2]);
  return (h > w && w >= 320 && h >= 480) ? { w, h } : { w: 900, h: 1600 };
}

const WINDOW_PRESETS = [
  [720, 0.64],
  [900, 0.78],
  [1080, 0.89],
  [1440, 0.97],
];

function positive(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

/**
 * Compute the outer desktop window in work-area DIP (not framebuffer pixels).
 * Old width×height presets still select small through extra large by their short edge.
 */
function windowBounds(portrait, area = {}, { landscape = false, fullscreen = false, caption = 0, remembered } = {}) {
  const panel = typeof portrait === 'string' ? portraitSize(portrait) : portrait || {};
  const pw = positive(panel.w, 900);
  const ph = positive(panel.h, 1600);
  const short = Math.min(pw, ph);
  const long = Math.max(pw, ph);
  const ratio = landscape ? long / short : short / long;
  const scale = fullscreen ? 1 : (WINDOW_PRESETS.find(([edge]) => short <= edge) || WINDOW_PRESETS.at(-1))[1];
  const aw = Math.max(1, Math.round(positive(area.w, 1920)));
  const ah = Math.max(1, Math.round(positive(area.h, 1080)));
  const x0 = Number.isFinite(area.x) ? area.x : 0;
  const y0 = Number.isFinite(area.y) ? area.y : 0;
  const rememberedW = remembered?.w ?? remembered?.width;
  const rememberedH = remembered?.h ?? remembered?.height;
  const validRemembered = !fullscreen && remembered && Number.isFinite(remembered.x) && Number.isFinite(remembered.y)
    && positive(rememberedW, 0) > 0 && positive(rememberedH, 0) > 0;
  const maxW = Math.max(1, validRemembered ? Math.min(aw, Math.round(rememberedW)) : Math.floor(aw * scale));
  const maxH = Math.max(1, validRemembered ? Math.min(ah, Math.round(rememberedH)) : Math.floor(ah * scale));
  const frame = Math.min(maxH - 1, Math.round(positive(caption, 0)));
  const contentH = Math.min(maxH - frame, maxW / ratio);
  const w = Math.max(1, Math.min(maxW, Math.floor(contentH * ratio)));
  const h = Math.max(1, Math.min(maxH, Math.floor(contentH) + frame));
  return {
    x: Math.round(validRemembered ? Math.min(x0 + aw - w, Math.max(x0, remembered.x)) : x0 + (aw - w) / 2),
    y: Math.round(validRemembered ? Math.min(y0 + ah - h, Math.max(y0, remembered.y)) : y0 + (ah - h) / 2),
    w, h,
  };
}

function defaultBounds(area) {
  return windowBounds('900x1600', area);
}

/**
 * 全屏 = 铺满屏幕高度并水平居中。
 * 模拟器窗口的宽高比在开机时被 LCD 锁死（9:16），直接 SW_MAXIMIZE 只会得到
 * 一个贴在左边、宽度不变的窗口；按比例算出高度铺满、再居中，视觉上就是
 * 「应用占满屏幕」，且画面不会变形。
 */
function fullscreenBounds(portrait, area) {
  return windowBounds(portrait, area, { fullscreen: true });
}

/**
 * Android 侧分辨率：两种模式都保持竖屏预设。
 * 原因：模拟器窗口的宽高比在开机时就被 LCD 尺寸锁死了（实测改成 1920x1080 后
 * 窗口仍然只接受 9:16，画面被塞进去会留黑边或变形）。所以「全屏」= 把窗口
 * 最大化铺满屏幕，「窗口」= 竖屏可自由拉伸，两者共用同一份 Android 分辨率，
 * 切换时不需要重启运行时，也不会让应用重新布局。
 */
function sizeFor(mode, portrait, area) {
  return portraitSize(portrait);
}

module.exports = { densityFor, tabletDensityFor, portraitSize, defaultBounds, fullscreenBounds, sizeFor, windowBounds };
