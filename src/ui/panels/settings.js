'use strict';

(() => {
  const panels = window.apkstartUiPanels ||= {};
  panels.createSettingsPanel = function createSettingsPanel({ api, $, state, toast, refreshStatus, refreshAndroid, navigation, diagnostics, preflight }) {
    // The panel selectors share one renderer; each domain owns its DOM bindings and state.
    const { createRuntimeSettings, createDisplaySettings, createStorageSettings } = window.apkstartUiPanels;
    const save = async (patch) => { state.settings = await api.setSettings(patch); };
    const fill = (next) => {
      state.settings = next;
      fillSettings(next);
      runtime.refreshResources();
    };
    const runtime = createRuntimeSettings({ api, $, state, save, toast, fillSettings: fill, refreshStatus });
    const display = createDisplaySettings({ api, $, state, save, toast });
    const storage = createStorageSettings({ api, $, save, toast });

    function fillSettings(s) {
      $('setAdbPath').value = s.adbPath || '';
      $('setSystemImage').value = s.runtime.isoPath || '';
      $('setMemory').value = s.engine.memoryMB;
      $('setCores').value = s.engine.cores;
      $('setIdle').value = s.engine.idleShutdownMinutes;
      if ($('setSourcePref')) $('setSourcePref').value = (s.runtime && s.runtime.sourcePreference) || 'auto';
      if ($('setAutoMirror')) $('setAutoMirror').checked = (s.runtime && s.runtime.autoMirror) !== false;
      if ($('setGiteeToken')) $('setGiteeToken').value = (s.runtime && s.runtime.giteeToken) || '';
      if ($('setMirrorPrefix')) $('setMirrorPrefix').value = (s.runtime && s.runtime.mirrorPrefix) || '';
      if ($('setConnections')) $('setConnections').value = Number((s.runtime && s.runtime.downloadConnections) || 8);
      $('setAudio').checked = s.engine.audio !== false;
      $('setHostMicrophone').checked = s.engine.hostMicrophone === true;
      $('setLiteMode').checked = s.engine.liteMode !== false;
      $('setPrewarm').checked = s.engine.prewarm !== false;
      $('setPriorityMode').value = ['performance', 'game'].includes(s.engine.priorityMode)
        ? s.engine.priorityMode : 'balanced';
      $('setDeepTrim').checked = !!s.engine.deepTrim;
      $('setMouseRightBack').checked = s.engine.mouseRightBack !== false;
      $('setMouseWheelMode').value = ['smooth', 'native', 'off'].includes(s.engine.mouseWheelMode)
        ? s.engine.mouseWheelMode : 'smooth';
      $('setMouseSideButtons').checked = !!s.engine.mouseSideButtons;
      if ($('setKeymapEnabled')) $('setKeymapEnabled').checked = s.engine.keymapEnabled !== false;
      // 实验室：原生多窗口多开（实验性）
      if ($('setMultiWindow')) $('setMultiWindow').checked = !!s.engine.multiWindow;
      if ($('setKeepBackground')) $('setKeepBackground').value = String(
        Number(s.engine.keepBackground) >= 0 ? Number(s.engine.keepBackground) : 1,
      );
      $('setCompat').checked = !!(s.runtime && s.runtime.compatImage);
      $('setAutoShortcut').checked = !!s.createShortcutOnInstall;
      $('setStartMenuShortcut').checked = s.createStartMenuShortcut !== false;
      $('setShortcutDir').value = s.shortcutDir || '';
      $('setSharedDir').value = s.sharedDir || '';
      $('setDeviceSharedDir').value = s.deviceSharedDir || '';
      const d = s.display || {};
      $('setAutoStart').checked = s.autoStart !== false;
      const eng = s.engine || {};
      if ($('setResourceMode')) $('setResourceMode').value = eng.resourceMode || 'balanced';
      if ($('setRenderSize')) $('setRenderSize').value = eng.renderSize || 'auto';
      if ($('setDataGB')) $('setDataGB').value = String(Number(eng.dataPartitionGB || 0));
      if ($('setFastDns')) $('setFastDns').checked = eng.fastDns !== false;
      if ($('setLocale')) $('setLocale').value = eng.locale || 'zh-CN';
      if ($('setChineseIme')) $('setChineseIme').checked = eng.chineseIme !== false;
      if ($('setKeepSnapshot')) $('setKeepSnapshot').checked = eng.keepSnapshot !== false;
      $('setDisplayMode').value = d.mode === 'fullscreen' ? 'fullscreen' : 'window';
      if ($('setAutoFullscreen')) $('setAutoFullscreen').value = d.autoFullscreenOnLaunch === true ? 'on' : 'off';
      if ($('setLandscape')) $('setLandscape').value = d.landscape === true ? 'landscape' : 'portrait';
      if ($('setOrientationMode')) $('setOrientationMode').value = d.orientationMode || 'auto';
      if ($('setAutoRotate')) $('setAutoRotate').value = d.autoRotate === false ? 'off' : 'on';
      if ($('setTabletMode')) $('setTabletMode').value = d.tabletMode === false ? 'off' : 'on';
      $('setPortrait').value = d.portrait || '900x1600';
      // 0.6.0 起默认原生窗口：只有显式 true 才是嵌入模式（旧配置里 undefined 视为原生）
      if ($('setWindowEmbed')) $('setWindowEmbed').value = d.windowEmbed === true ? 'embed' : 'detached';
      $('portraitField').hidden = $('setDisplayMode').value === 'fullscreen';
    }

    async function openSettings() {
      fill(await api.getSettings());
      preflight.refreshDrivers().catch(() => {});
      diagnostics.fillPreferences((state.settings && state.settings.debug) || {});
      const info = await api.info();
      $('hostMicField').hidden = info.platform !== 'win32';
      $('setRuntimeDir').value = info.runtimeDir || info.dataDir;
      if ($('setAvdDir')) {
        const di = await api.dataInfo().catch(() => null);
        $('setAvdDir').value = (di && di.avdDir) || '';
      }
      if (info.productName) $('aboutProductName').textContent = info.productName;
      if (info.version) $('aboutVer').textContent = info.version;
      const curVerEl = document.getElementById('updateCurrent');
      if (curVerEl && info.version) curVerEl.textContent = `v${info.version}`;
      const assoc = await api.assocStatus();
      const btn = $('btnAssoc');
      btn.textContent = assoc.registered ? '已关联 · 点击取消' : '未关联 · 点击开启';
      btn.dataset.on = assoc.registered ? '1' : '0';

      api.doctorProfile().then((r) => {
        if (r && r.text) $('autoProfileText').textContent = r.text;
      }).catch(() => { $('autoProfileText').textContent = '自动模式'; });
      api.runtimeUsage().then((u) => {
        $('usageText').textContent = u
          ? `共 ${u.totalText}${u.reclaimable ? ` · 可回收 ${u.reclaimableText}（${u.count} 项）` : ' · 已是精简状态'}`
          : '统计不可用';
      }).catch(() => { $('usageText').textContent = '统计不可用'; });

      $('settingsMask').classList.add('on');
      refreshAndroid();
      storage.refreshDataInfo();
      navigation.refresh();
      // 先把上一次的检测结果铺上（别让面板空着等），再后台刷新一份
      api.autodebugState().then((r) => { if (r) diagnostics.render(r); }).catch(() => {});
    }

    function closeSettings() {
      $('settingsMask').classList.remove('on');
    }

    function bind() {
      runtime.bind();
      display.bind();
      storage.bind();
    }

    return { bind, open: openSettings, close: closeSettings, fill };
  };
})();
