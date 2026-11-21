'use strict';

function createWindowHandlers({ live, rotateCurrentApp }) {
  return {
    'window:minimize': () => live.mainWindow?.minimize(),

    'window:maximize': () => {
      if (!live.mainWindow) return;
      if (live.mainWindow.isMaximized()) live.mainWindow.unmaximize();
      else live.mainWindow.maximize();
    },

    'window:close': () => live.mainWindow?.close(),

    'window:hide': () => live.mainWindow?.hide(),

    'shell:state': () => ({ ...live.appWin.state, iconUrl: live.appWin.iconUrl || '' }),

    // 独立窗口模式下画面在模拟器原生窗口里，壳窗口是隐藏的 —— 按钮必须作用到真正
    // 可见的那一扇。统一交给 appWin 判断模式处理，避免对隐藏窗口 maximize/minimize。
    'shell:minimize': () => live.appWin.minimize(),

    'shell:maximize': () => live.appWin.toggleMaximize(),

    // 关闭必须走 appWin.close()：它会先把模拟器窗口从宿主上摘下来、再停掉安卓应用。
    // 老实现直接 win.close()，绕过了这段收尾 —— 窗口是没了，但安卓侧的进程还在跑，
    // 就是用户说的「点关闭关不掉应用」。
    'shell:close': () => {
      if (live.appWin && live.appWin.isOpen) { live.appWin.close(); return { ok: true }; }
      return { ok: false };
    },

    // 标题栏的旋转按钮 = 「这个应用我要横着/竖着用」。
    // 统一走 rotateCurrentApp：以 wantLandscapeFor(pkg) 为唯一基准算目标方向，
    // 一次算出 next 后同时写 per-app 覆盖 + 切物理面板。以前这里和 appWin.rotate
    // 各算各的（一个看 display.landscape，一个看 state.landscape），两个值可能
    // 相反，于是「点了旋转 → 覆盖写成横屏 → 面板却切回竖屏 → 下次又被翻回竖屏」，
    // 红果这类应用就怎么都横不过来。
    'shell:rotate': () => rotateCurrentApp(),

    'app:foreground': () => {
      if (live.appWin && live.appWin.isOpen) { live.appWin.win.show(); live.appWin.win.focus(); return true; }
      return false;
    },
  };
}

module.exports = { createWindowHandlers };
