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
      $('setDisplayMode').addEventListener('change', async (e) => {
        const mode = e.target.value;
        $('portraitField').hidden = mode === 'fullscreen';
        state.settings = await api.setSettings({ display: { mode } });
        toast({ title: mode === 'fullscreen' ? '已切全屏' : '已切竖屏窗口', type: 'ok' });
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
        state.settings = await api.setSettings({ display: { portrait: e.target.value } });
        toast({ title: '画面大小已更新', body: '下次打开应用或切换应用时生效', type: 'ok' });
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
