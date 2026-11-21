'use strict';

(() => {
  const panels = window.apkstartUiPanels ||= {};
  panels.createDisplaySettings = function createDisplaySettings({ api, $, state, save, toast }) {
    function bindInput() {
      const savePointer = async (patch) => {
        await save({ engine: patch });
        // 立刻按当前窗口焦点重装/卸载钩子，不用等下次切窗口
        api.refreshPointerMapping().catch(() => {});
      };
      $('setMouseRightBack').addEventListener('change', (e) => savePointer({ mouseRightBack: e.target.checked }));
      $('setMouseWheelMode').addEventListener('change', (e) => savePointer({ mouseWheelMode: e.target.value }));
      $('setMouseSideButtons').addEventListener('change', (e) => savePointer({ mouseSideButtons: e.target.checked }));
      if ($('setKeymapEnabled')) {
        $('setKeymapEnabled').addEventListener('change', async (e) => {
          await api.keymap.setEnabled(e.target.checked);
          toast({ title: e.target.checked ? '键盘映射已开启' : '键盘映射已关闭', type: 'ok' });
        });
      }
    }

    function bindWindow() {
      async function applyLayout(patch, label) {
        try {
          const r = await api.displaySet(patch);
          if (r?.ok !== true) throw new Error(r?.error || '没有收到窗口设置确认');
          const { ok: _ok, windowLayoutApplied, ...display } = r;
          state.settings = { ...state.settings, display };
          $('setDisplayMode').value = display.mode;
          $('portraitField').hidden = display.mode === 'fullscreen';
          $('setPortrait').value = display.portrait;
          toast({ title: windowLayoutApplied ? label : '窗口偏好已保存',
            body: windowLayoutApplied ? '仅调整 Windows 窗口，不重启安卓。' : '下次打开安卓应用窗口时应用。', type: 'ok' });
        } catch (e) {
          $('setDisplayMode').value = state.settings?.display?.mode || 'window';
          $('setPortrait').value = state.settings?.display?.portrait || '900x1600';
          $('portraitField').hidden = $('setDisplayMode').value === 'fullscreen';
          toast({ title: '窗口设置失败', body: e.message, type: 'error' });
        }
      }
      $('setDisplayMode').addEventListener('change', async (e) => {
        const mode = e.target.value;
        await applyLayout({ mode }, mode === 'fullscreen' ? '已切全屏' : '已切换为窗口模式');
      });
      if ($('setAutoFullscreen')) {
        $('setAutoFullscreen').addEventListener('change', async (e) => {
          const on = e.target.value === 'on';
          state.settings = await api.setSettings({ display: { autoFullscreenOnLaunch: on } });
          toast({ title: on ? '已开启自动全屏' : '已关闭自动全屏', body: '下次打开应用时生效', type: 'ok' });
        });
      }
      if ($('setOrientationMode')) {
        $('setOrientationMode').addEventListener('change', async (e) => {
          const mode = e.target.value;
          state.settings = await api.setSettings({ display: { orientationMode: mode } });
          toast({
            title: mode === 'auto' ? '已设为跟随应用' : (mode === 'landscape' ? '已强制横屏' : '已强制竖屏'),
            body: mode === 'auto'
              ? '下次打开应用时会按应用自己的方向选面板，方向不一致的话会重启一次运行时。'
              : '下次打开应用时会重启一次运行时把面板切到指定方向，之后不再重启。',
            type: 'ok',
          });
        });
      }
      if ($('setAutoRotate')) {
        $('setAutoRotate').addEventListener('change', async (e) => {
          const on = e.target.value === 'on';
          state.settings = await api.setSettings({ display: { autoRotate: on } });
          toast({
            title: on ? '已打开镜像自动旋转' : '已关闭镜像自动旋转',
            body: '下次打开应用时写进安卓镜像。画面方向仍由屏幕方向策略决定，不受此开关影响。',
            type: 'ok',
          });
        });
      }
      if ($('setTabletMode')) {
        $('setTabletMode').addEventListener('change', async (e) => {
          const on = e.target.value === 'on';
          state.settings = await api.setSettings({ display: { tabletMode: on } });
          toast({
            title: on ? '已打开平板排版' : '已关闭平板排版',
            body: '下次打开应用时生效（会重启一次运行时来改逻辑密度）。',
            type: 'ok',
          });
        });
      }
      if ($('setLandscape')) {
        $('setLandscape').addEventListener('change', async (e) => {
          const landscape = e.target.value === 'landscape';
          state.settings = await api.setSettings({ display: { landscape } });
          toast({
            title: landscape ? '面板已设为横屏' : '面板已设为竖屏',
            body: '下次打开应用时会重启一次运行时来切换物理面板方向（约十几秒），之后就不会再重启。',
            type: 'ok',
          });
        });
      }
      $('setPortrait').addEventListener('change', async (e) => {
        await applyLayout({ portrait: e.target.value }, 'Windows 窗口大小已调整');
      });
      $('setWindowEmbed').addEventListener('change', async (e) => {
        const embed = e.target.value === 'embed';
        // windowEmbedChosen 标记「用户自己选过」：之后升级不会再被默认值迁移覆盖。
        state.settings = await api.setSettings({
          display: { windowEmbed: embed, windowEmbedChosen: true },
        });
        toast({
          title: embed ? '已切回嵌入模式' : '已切到原生窗口',
          body: embed
            ? '下次打开应用时生效。嵌入模式观感统一、标题栏带旋转按钮，但缩放/旋转时更容易掉帧或出现黑边。'
            : '下次打开应用时生效。原生窗口由模拟器自己渲染与排布，帧率和缩放更稳，横屏可用托盘菜单或 Ctrl+Alt+R。',
          type: 'ok',
        });
      });
    }

    function bind() {
      bindInput();
      bindWindow();
    }

    return { bind };
  };
})();
