'use strict';

const { ipcFailure } = require('../failure');

function createAndroidHandlers({ getCurrentAppPkg, keymapEngine, KEYMAP_PRESETS, live, store }) {
  return {
    'shell:back': async () => { await live.runtime.client().keyBack(); },

    'shell:forward': async () => { await live.runtime.client().keyForward(); },

    'android:status': async () => {
      try { return { ok: true, ...(await live.androidSet.status()) }; } catch (e) { return ipcFailure(e); }
    },

    'android:set': async (_e, { key, value }) => {
      try {
        switch (key) {
          case 'wifi': return { ok: true, ...(await live.androidSet.setWifi(!!value)) };
          case 'airplane': return { ok: true, ...(await live.androidSet.setAirplane(!!value)) };
          case 'volume': return { ok: true, ...(await live.androidSet.setVolume(value)) };
          case 'animations': return { ok: true, ...(await live.androidSet.setAnimations(!!value)) };
          case 'fontScale': return { ok: true, ...(await live.androidSet.setFontScale(value)) };
          case 'density': return { ok: true, ...(await live.androidSet.setDensity(value)) };
          default: return { ok: false, error: `未知设置项 ${key}` };
        }
      } catch (e) { return ipcFailure(e); }
    },

    'android:open': async (_e, action) => {
      try { return { ok: true, ...(await live.androidSet.open(action)) }; } catch (e) { return ipcFailure(e); }
    },

    'android:tune': async (_e, pkg) => {
      try { return { ok: true, ...(await live.androidSet.tune({ pkg })) }; } catch (e) { return ipcFailure(e); }
    },

    'android:permissions': async (_e, pkg) => {
      try { return { ok: true, rows: await live.androidSet.permissions(pkg) }; } catch (e) { return ipcFailure(e); }
    },

    'android:grantAll': async (_e, pkg) => {
      try { return { ok: true, ...(await live.androidSet.grantAll(pkg)) }; } catch (e) { return ipcFailure(e); }
    },

    // ---- 按键映射 ----
    'shell:keyEvent': async (_e, key) => {
      if (!keymapEngine || !keymapEngine.enabled) return false;
      const pkg = getCurrentAppPkg();
      if (!pkg) return false;
      return keymapEngine.handleKey(key, pkg);
    },

    'keymap:getPresets': () => {
      return Object.entries(KEYMAP_PRESETS).map(([id, p]) => ({ id, label: p.label, desc: p.desc }));
    },

    'keymap:getMap': (_e, pkg) => keymapEngine ? keymapEngine.getMap(pkg) : [],

    'keymap:setMap': (_e, pkg, mappings) => {
      if (!keymapEngine) return { ok: false };
      keymapEngine.setMap(pkg, mappings);
      // 持久化到设置
      const maps = { ...(store.getSettings().engine.keymaps || {}) };
      if (mappings && mappings.length) maps[pkg] = mappings;
      else delete maps[pkg];
      store.saveSettings({ engine: { keymaps: maps } });
      return { ok: true };
    },

    'keymap:setEnabled': (_e, on) => {
      if (keymapEngine) keymapEngine.enable(!!on);
      store.saveSettings({ engine: { keymapEnabled: !!on } });
      return { ok: true };
    },

    'keymap:isEnabled': () => keymapEngine ? keymapEngine.enabled : false,

    'keymap:applyPreset': (_e, pkg, presetId) => {
      if (!keymapEngine || !KEYMAP_PRESETS[presetId]) return { ok: false };
      const mappings = KEYMAP_PRESETS[presetId].mappings;
      keymapEngine.setMap(pkg, mappings);
      const maps = { ...(store.getSettings().engine.keymaps || {}) };
      maps[pkg] = mappings;
      store.saveSettings({ engine: { keymaps: maps } });
      return { ok: true, mappings };
    },
  };
}

module.exports = { createAndroidHandlers };
