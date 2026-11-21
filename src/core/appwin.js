'use strict';
/**
 * 应用窗口：一个正在运行的安卓应用 = 一个干净的 Windows 窗口。
 *
 * 窗口里只有顶部一条 38px 的标题栏（旋转 / 最小化 / 最大化 / 关闭），
 * 下面的整块画面是嵌进来的模拟器窗口（SetParent），所以看不到安卓桌面、
 * 看不到模拟器自带的侧边工具栏，也不会多出第二个任务栏图标。
 */
const { BrowserWindow, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { hookOptions } = require('./pointer');
const store = require('./store');
const { physicalScreenRect } = require('./geometry');
const { windowBounds } = require('./display');

const TITLEBAR_H = 38;
/**
 * 模拟器窗口四周自带 8px 的灰色内边距（Qt 的边框留白），
 * 而真正的 LCD 画面是从 +8px 开始的。把子窗口整体放大 16px 并向左上偏移 8px，
 * 这圈灰边就正好被推到客户区外面，画面干净地贴满四周。
 */
const EMU_PAD = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function iconUrl(p) {
  if (!p || !fs.existsSync(p)) return '';
  return `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}?v=${fs.statSync(p).mtimeMs}`;
}

class AppWindow {
  constructor({ agent, setOrientation, mouseHook = false, pointerConfig = null, windowTargets = null }) {
    this.agent = agent;
    this.setOrientation = setOrientation || null;
    // 画面窗口的候选句柄来源：现在只有一个底座，恒为 null，
    // 由窗口代理按进程作用域自己找（这些窗口都是我们拉起的 emulator 创建的）。
    this.windowTargets = typeof windowTargets === 'function' ? windowTargets : null;
    // 全局鼠标钩子只在「应用窗口前台 + 至少一项映射开启」时安装。
    // pointerConfig 传函数：设置页改了开关，下一次 focus 就生效，不用重启。
    this.mouseHook = mouseHook;
    this.pointerConfig = pointerConfig;
    this.win = null;
    this.pkg = null;
    this.session = null;
    this.state = { label: '', tip: '', ready: false, landscape: false };
    this._fitTimer = null;
    this._windowLifecycle = null;
    this._pendingPark = Promise.resolve();
    this._pendingAttachment = Promise.resolve();
    this._layoutRequest = 0;
  }

  get isOpen() { return !!(this.win && !this.win.isDestroyed()); }

  _area(point) {
    const d = point ? screen.getDisplayNearestPoint(point)
      : this.isOpen ? screen.getDisplayMatching(this.win.getBounds())
        : screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const a = d.workArea || d.bounds;
    return { x: a.x, y: a.y, w: a.width, h: a.height, sf: d.scaleFactor || 1 };
  }

  _areaForNative(rect) {
    if (rect?.w > 0 && rect?.h > 0 && typeof screen.screenToDipPoint === 'function') {
      try {
        return this._area(screen.screenToDipPoint({
          x: Math.round(rect.x + rect.w / 2), y: Math.round(rect.y + rect.h / 2),
        }));
      } catch (_) { /* Fall back to the shell's display. */ }
    }
    return this._area();
  }

  _scale() {
    try {
      const b = this.win ? this.win.getBounds() : this._area();
      return screen.getDisplayMatching(b).scaleFactor || 1;
    } catch (_) {
      return 1;
    }
  }

  /**
   * 把一块 DIP（逻辑像素）矩形换算成物理像素，供窗口代理的 SetWindowPos 使用。
   * Electron 的 screen/BrowserWindow 坐标一律是 DIP；而 agent.ps1 顶层声明了
   * per-monitor v2 DPI 感知，Win32 的 SetWindowPos 收到的是物理像素。二者混用
   * 混用缩放的显示器上，屏幕全局坐标不能直接乘缩放比。
   */
  _physical(rect, sf) {
    return physicalScreenRect(rect, sf || this._scale(), typeof screen.dipToScreenRect === 'function'
      ? (bounds) => screen.dipToScreenRect(null, bounds) : undefined);
  }

  /**
   * 打开（或复用）应用窗口。
   * @param {object} o { pkg, label, iconPath, portrait, fullscreen, detached,
   *                     rememberedBounds, showWhileWaiting, session, onClosed }
   *        detached=true 时走「独立窗口模式」：壳窗口只加载不显示，画面在模拟器原生窗口里。
   *        showWhileWaiting=true 时，**在等待期间**先把壳窗口显示出来（带提示文案），
   *        等模拟器窗口接上后由 openDetached() 收起。切换应用到另一个方向的 App
   *        需要重启运行时（约 40 秒），这段时间以前屏幕上什么都没有，用户以为崩了。
   */
  open(o) {
    const { pkg, label, iconPath, portrait, fullscreen, detached, session = null } = o;
    this.detachedMode = !!detached;
    this.waitingForRestart = false;
    this._showWhileWaiting = !!o.showWhileWaiting;
    if (this.isOpen && this.pkg === pkg && this.session === session) {
      this._windowLifecycle.onClosed = o.onClosed || null;
      // 独立窗口模式下壳窗口永远不该露脸（它没有内容，只是一块黑）。
      // 这时候用户再点一次同一个应用，想要的是「把正在看的窗口拿到前面」，
      // 交给窗口代理去抬模拟器原生窗口。
      if (this.detachedMode) this.agent.show().catch(() => {});
      else {
        this.win.show();
        this.win.focus();
      }
      return this.win;
    }
    this.close({ keepApp: true }).catch(() => {});

    this.pkg = pkg;
    this.session = session;
    // 记住原始图标文件路径：独立窗口模式下要把它设给模拟器原生窗口（Win32
    // LoadImage 只认文件路径，不认 HTML 用的 data URL）。
    this.iconFilePath = iconPath || '';
    this.portrait = portrait || { w: 540, h: 960 };
    // 独立窗口模式下「全屏」要作用在模拟器窗口上（我们这层壳是隐藏的，
    // maximize 一个隐藏窗口没有任何视觉效果，openDetached 会读这个标记）。
    this._wantFullscreen = !!fullscreen;
    this._layoutFullscreen = !!fullscreen;
    this._preFullscreenRect = null;
    this._surfaceAttached = false;
    this._rememberedBounds = o.rememberedBounds || null;
    this.state = { label: label || '应用', tip: '正在启动安卓运行时…', ready: false, landscape: false };

    const area = this._area();
    const size = windowBounds(this.portrait, area, { fullscreen, caption: TITLEBAR_H,
      landscape: this.portrait.w > this.portrait.h, remembered: this._rememberedBounds });

    const iconFile = iconPath && fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

    this.win = new BrowserWindow({
      width: size.w,
      height: size.h,
      minWidth: Math.min(320, size.w),
      minHeight: Math.min(420, size.h),
      x: size.x,
      y: size.y,
      show: false,
      frame: false,
      thickFrame: true,
      resizable: true,
      maximizable: true,
      backgroundColor: '#0b0c0e',
      title: label || 'ApkStart',
      icon: iconFile,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    const win = this.win;
    const lifecycle = { onClosed: o.onClosed || null };
    this._windowLifecycle = lifecycle;
    const current = () => this.win === win;
    win.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
    // 页面标题会把窗口标题改成 shell.html 的 <title>，任务栏就认不出是哪个应用了，
    // 这里挡住，让 OS 标题一直等于应用名（任务栏悬浮提示、Alt+Tab 都靠它）。
    win.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      if (current()) win.setTitle(label || 'ApkStart');
    });
    win.once('ready-to-show', () => {
      // 独立窗口模式下，安卓画面在模拟器自己的原生窗口里，我们这层壳没有内容可显示，
      // 留着只会多一个黑色空窗口。所以只加载、不显示（外壳仍存在，供状态/关闭逻辑用）。
      // 例外：showWhileWaiting（切换应用时没有开机动画兜底）—— 这时宁可先显示这块
      // 「正在打开 xxx…」的壳，也不要让用户对着空桌面等 40 秒。
      if (!current()) return;
      if (this.detachedMode && !this._showWhileWaiting) return;
      win.show();
      this._push();
    });

    // Electron 最大化时窗口尺寸会分好几步才稳定（OS 动画、DPI 重算），
    // 单次 40ms 防抖的 fit 常常抓到中间态，结果嵌入画面只占左上角一条，
    // 右边一大片空白 —— 就是用户截图里「最大化后没填满」。
    // 改成连续多轮贴合收敛，每轮都按最新的 getContentBounds 重算。
    const refit = () => { if (current()) this.scheduleFit(6); };
    win.on('resize', refit);
    win.on('move', refit);
    win.on('maximize', refit);
    win.on('unmaximize', refit);
    win.on('restore', () => {
      if (!current()) return;
      this.agent.show().catch(() => {});
      this.scheduleFit(6);
    });
    win.on('minimize', () => { if (current()) this.agent.hide().catch(() => {}); });
    win.on('closed', () => {
      // close() clears the reference before destroy(); an old window cannot close its successor.
      if (!current()) return;
      this._syncHook(false);
      this._cancelFit();
      this.win = null;
      this.pkg = null;
      this.session = null;
      this._windowLifecycle = null;
      this.waitingForRestart = false;
      this.lastEmbedOk = false;
      this._parkThen(() => lifecycle.onClosed?.(pkg, session)).catch(() => {});
      if (pkg && this._onCloseApp) {
        try { this._onCloseApp(pkg, session); } catch (_) { /* 通知失败不打断窗口收尾 */ }
      }
    });
    // 只在「应用窗口真正处于前台」且至少一项鼠标映射开启时装全局钩子；
    // 失焦/关闭立即卸载，绝不让 ApkStart 在后台拖慢整个系统的鼠标。
    win.on('focus', () => { if (current()) this._syncHook(true); });
    win.on('blur', () => { if (current()) this._syncHook(false); });

    return this.win;
  }

  _pointerOptions() {
    const getter = this.pointerConfig || this.mouseHook;
    const raw = typeof getter === 'function' ? getter() : getter;
    return hookOptions(raw);
  }

  _syncHook(active) {
    const opts = this._pointerOptions();
    // 游戏/低延迟模式下完全不装全局鼠标钩子：WH_MOUSE_LL 对桌面每个鼠标事件
    // 都同步回调，会明显增加指针延迟；FPS 需要的是 Qt 窗口直接收到原始输入。
    const game = !!(store.getSettings().engine && store.getSettings().engine.priorityMode === 'game');
    const on = !!active && opts.enabled && !game;
    if (this.agent && typeof this.agent.setHook === 'function') {
      this.agent.setHook(on, opts).catch(() => {});
    }
  }

  /** 设置页改了鼠标映射：按当前焦点重新同步一次（不重装钩子线程） */
  refreshPointer() {
    const focused = this.isOpen && !!this.win.isFocused();
    if (!focused) {
      // 窗口没在前台：只卸载，别让钩子在后台空转
      if (this.agent && typeof this.agent.setHook === 'function') {
        this.agent.setHook(false).catch(() => {});
      }
      return;
    }
    this._syncHook(true);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this._push();
  }

  /**
   * 独立窗口模式下「临时把壳窗口亮出来」。
   *
   * 场景：切换到一个横竖屏不同的应用时要重启安卓运行时（约 40 秒），这期间
   * 模拟器原生窗口会被销毁、新窗口还没建出来。如果壳窗口此刻是隐藏的，屏幕上
   * 什么都没有 —— 用户会以为程序退出了。启动阶段靠 showWhileWaiting 露一次，
   * 但那时候 pre-attach 一成功就会把它收起来；等到真正重启时反而没人再显示。
   *
   * 所以重启前后显式调用一次：先亮出带提示的壳，等新窗口接上后由
   * openDetached() 确认原生窗口出现后收掉。
   */
  showWaiting(tip) {
    if (!this.isOpen) return false;
    // 标记「正在等待重启」：启动阶段那条 pre-attach 轮询看到它会主动让路，
    // 新面板未就绪前，不能让旧面板的接管轮询收掉等候提示。
    this.waitingForRestart = true;
    this._surfaceAttached = false;
    if (tip) this.state = { ...this.state, tip, ready: false };
    this._push();
    return this.showWaitSurface();
  }

  showWaitSurface({ activate = true } = {}) {
    if (!this.isOpen || this.state.ready) return false;
    this._showWhileWaiting = true;
    try {
      if (activate) {
        this.win.show();
        this.win.moveTop();
      } else {
        this.win.showInactive();
      }
    } catch (_) {
      return false;
    }
    return true;
  }

  _push() {
    if (!this.isOpen) return;
    try {
      this.win.webContents.send('shell:state', {
        ...this.state,
        iconUrl: this.iconUrl || '',
      });
    } catch (_) { /* 窗口可能刚关闭 */ }
  }

  setIcon(p) { this.iconUrl = iconUrl(p); this._push(); }

  /**
   * 把模拟器窗口嵌进当前窗口，并铺满标题栏以下的区域。
   * 常驻压制不关闭：它会跳过「已经嵌进我们窗口」的那一个，其余窗口（含 qemu /
   * netsimd 的控制台黑窗）继续压住 —— 关了反而会给它们再露一次脸的机会。
   * 模拟器窗口偶尔还没创建好（快照恢复太快的机器上），这里重试两次。
   */
  /**
   * 独立窗口模式：**不**把模拟器嵌进我们窗口，而是让它开自己的原生窗口。
   *
   * 为什么要有这条路：嵌入（SetParent）虽然观感统一，但会带来一整串麻烦 ——
   * 前后台 Z 序、黑边、坐标映射错位、最大化后不铺满、Qt 面板方向与宿主比例打架。
   * 这些都是「把一个别人的窗口塞进自己窗口」固有的代价。
   *
   * 独立窗口下，模拟器窗口是系统原生窗口：方向、缩放、输入全由它自己管，
   * 上面那一整类问题从根上不存在。代价是多一个任务栏图标、观感不完全统一。
   *
   * @returns {Promise<boolean>} 是否成功切到独立窗口
   */
  openDetached(isCurrent) {
    return this._attachSurface((context) => this._openDetached(context), isCurrent);
  }

  async _openDetached({ shell, agent, current }) {
    // 壳窗口已经关掉（用户点了关闭 / 启动过程中被收掉）时没有可承载的对象。
    // 把原因记下来：否则上层日志只能打一个 "unknown"，完全看不出是「窗口没了」
    // 还是「模拟器窗口找不到」。
    if (!this.isOpen) { this.lastEmbedError = 'shell-closed'; return false; }
    // 真正开始接管，等待标记到此为止（下一轮 pre-attach 可以正常重试）
    this.waitingForRestart = false;
    // 先确保它没被嵌在里面（从嵌入切过来时 _emu 的父窗口还是宿主）。
    // keep=true：告诉代理这是「切独立窗口」，不是「结束嵌入」——否则它会把
    // 用户正在看的模拟器窗口当成杂物藏掉。
    const dt = await agent.detach(true).catch((e) => ({ ok: false, error: e.message }));
    if (!current()) return false;
    this._detachedDebug = `detach=${JSON.stringify(dt)}`;
    // 标题必须在 show 之前设。
    // 代理进程是常驻的，里面缓存着「上次设过的标题」（_ourTitle）；新模拟器窗口
    // 一 show 出来就会先被套上那个旧标题 —— 切换应用时窗口会以**上一个应用的
    // 名字**闪 0.5 秒，首次启动则先显示 "Android Emulator - apkstart:5554"。
    // 以前的顺序是 show() → setTitle()，所以那半秒一定看得到。
    const title = this.state && this.state.label ? this.state.label : 'ApkStart';
    await agent.setTitle(title).catch(() => {});
    if (!current()) return false;
    // 图标和标题都在窗口 show 之前设好，等代理回包即可，不再人为暂停每次接管。
    // 图标只影响任务栏/Alt+Tab，设给已存在的 Qt 窗口，不依赖它 show 过。
    const icoForNative = this.iconFilePath
      ? this.iconFilePath.replace(/\.png$/i, '.ico')
      : '';
    if (icoForNative && fs.existsSync(icoForNative)) {
      try { await agent.setIcon(icoForNative); } catch (_) { /* ignore */ }
    } else if (this.iconFilePath) {
      try { await agent.setIcon(this.iconFilePath); } catch (_) { /* ignore */ }
    }
    if (!current()) return false;
    // 让模拟器窗口真的可见
    const shown = await agent.show().catch((e) => ({ ok: false, error: e.message }));
    if (!current()) return false;
    this._detachedDebug += ` show=${JSON.stringify(shown)}`;
    if (shown?.ok !== true) { this.lastEmbedError = this._detachedDebug; return false; }
    const area = this._area();
    const bounds = this._displayBounds(area, this._wantFullscreen);
    const lay = await agent.layout(this._physical(bounds, area.sf))
      .catch((e) => ({ ok: false, error: e.message }));
    if (!current()) return false;
    this._detachedDebug += ` layout=${JSON.stringify(lay)}`;
    this.lastEmbedOk = false;
    if (lay?.ok !== true) { this.lastEmbedError = this._detachedDebug; return false; }
    this.lastEmbedError = '';
    this.detachedMode = true;
    this._surfaceAttached = true;
    this._layoutFullscreen = this._wantFullscreen;
    this._showWhileWaiting = false;
    // A failed native lookup must leave the waiting shell visible.
    try { shell.hide(); } catch (_) { /* The native window has already been shown. */ }
    return true;
  }

  embed(isCurrent) {
    return this._attachSurface((context) => this._embed(context), isCurrent);
  }

  async _embed({ agent, current }) {
    let last = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!current()) return false;
      const hwnd = this._hwnd();
      if (!hwnd) return false;
      // 外部若提供了候选句柄（历史接口，当前恒为 null）；拿不到就等一下再试
      // —— 句柄是每次开机重新分配的，缓存一份旧的会把窗口嵌错地方。
      let targets = null;
      if (typeof this.windowTargets === 'function') {
        // eslint-disable-next-line no-await-in-loop
        targets = await Promise.resolve(this.windowTargets()).catch(() => null);
        if (!current()) return false;
        if (Array.isArray(targets) && !targets.length) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(attempt < 2 ? 400 : 1000);
          continue;
        }
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await agent.embed(hwnd, this._rect(), targets).catch((e) => ({ ok: false, error: e.message }));
      if (!current()) return false;
      last = r;
      if (r?.ok === true) {
        this.lastEmbedOk = true;
        this.lastEmbedError = '';
        this.detachedMode = false;
        this._surfaceAttached = true;
        return true;
      }
      // eslint-disable-next-line no-await-in-loop
      await sleep(attempt < 2 ? 300 : 800);
    }
    // 把失败原因带出去：上层会写进 app.log，出问题时一眼能看出是「没找到模拟器窗口」
    // 还是「SetParent 失败」，不用再靠猜。
    if (current()) this.lastEmbedError = last ? (last.error || `emu=${last.emu}`) : 'no-response';
    return false;
  }

  _attachSurface(effect, isCurrent = () => true) {
    const shell = this.win;
    const ticket = this.session;
    const agent = this.agent;
    const parked = this._pendingPark.catch(() => {});
    const current = () => this.isOpen && this.win === shell && this.session === ticket
      && this.agent === agent && isCurrent();
    // An older native call can already be in flight when close() runs. Park must
    // follow it; a replacement window must in turn wait for that park.
    const pending = this._pendingAttachment.then(async () => {
      await parked;
      return current() ? effect({ shell, agent, current }) : false;
    });
    this._pendingAttachment = pending.catch(() => false);
    return pending;
  }

  async fitNow() {
    if (!this.isOpen) return;
    await this.agent.fit(this._rect()).catch(() => {});  }

  /** 模拟器子窗口应该占据的矩形（物理像素，已把 8px 内边距推出可视区） */
  _rect() {
    const sf = this._scale();
    const b = this.win.getContentBounds();
    const top = Math.round(TITLEBAR_H * sf);
    return {
      x: -EMU_PAD,
      y: top - EMU_PAD,
      w: Math.round(b.width * sf) + EMU_PAD * 2,
      h: Math.round((b.height - TITLEBAR_H) * sf) + EMU_PAD * 2,
      // 上面那条 -EMU_PAD 会压到标题栏上，交给窗口代理裁掉（见 agent.fit 的 clipTop）
      clipTop: EMU_PAD,
    };
  }

  /**
   * @param {number} rounds 连续贴合几轮（窗口尺寸变化时每轮都重算最新 bounds）
   */
  scheduleFit(rounds = 1) {
    if (!this.isOpen) return;
    this._cancelFit();
    const window = this.win;
    const run = async (left) => {
      if (this.win !== window || !this.isOpen) return;
      await this.fitNow().catch(() => {});
      if (this.win !== window || !this.isOpen) return;
      if (left > 1) {
        this._fitTimer = setTimeout(() => run(left - 1), 160);
      } else {
        this._fitTimer = null;
      }
    };
    this._fitTimer = setTimeout(() => run(Math.max(1, rounds)), 40);
  }

  _cancelFit() {
    if (this._fitTimer) clearTimeout(this._fitTimer);
    this._fitTimer = null;
  }

  _hwnd() {
    try {
      const buf = this.win.getNativeWindowHandle();
      const v = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
      return v.toString();
    } catch (_) {
      return null;
    }
  }

  /**
   * 横竖屏切换（标题栏旋转按钮）= 真正把「物理面板」换成横屏或竖屏。
   *
   * 为什么必须这么做（踩过的坑）：
   *   - 改 wm size：只改 Android 逻辑分辨率，模拟器的物理 LCD 仍是竖的，
   *     Qt 把画面贴在左上角 -> 画面躺倒 90°、只占一条、四周黑边、点击坐标错位；
   *   - 改 wm density：framebuffer 尺寸不变，画面不会铺满，最大化后右侧一大片空；
   *   - adb emu rotate：只转画面内容，系统里还是竖屏。
   * 唯一能得到「正立 + 铺满」横屏的办法，就是把 hw.lcd.width/height 换成
   * 1280x720 并重启模拟器。重启约 30~60 秒，所以这里只做一次、并给出明确提示。
   *
   * @param {(next:boolean)=>Promise<boolean>} [onRestart] 由上层注入的重启实现
   * @param {boolean} [explicitNext] 目标方向。传入时直接用它，不再取反 ——
   *        旋转入口统一算好方向后传进来，避免这里和上层各算各的导致
   *        「写进 apps.json 的覆盖值」与「实际切过去的面板方向」相反。
   */
  async rotate(onRestart, explicitNext) {
    if (!this.isOpen) return this.state.landscape;
    const win = this.win;
    const previous = this.state.landscape;
    const next = explicitNext === undefined || explicitNext === null
      ? !previous : !!explicitNext;
    this.setState({ tip: next ? '正在切换到横屏（重启安卓运行时，约 30-60 秒）…' : '正在切回竖屏（重启安卓运行时，约 30-60 秒）…', ready: false });
    if (typeof onRestart === 'function') {
      const ok = await onRestart(next).catch(() => false);
      if (this.win !== win) return previous;
      if (!ok) {
        // A failed physical restart must not pretend that a logical rotation changed the panel.
        this.setState({ ready: true, tip: '' });
        return previous;
      }
      this.state.landscape = next;
      this._push();
      // 面板尺寸变了，窗口宽高比跟着换；贴合几轮收敛。
      for (let i = 0; i < 5; i += 1) {
        await sleep(400);
        if (this.win !== win) return previous;
        await this.fitNow();
      }
      if (this.win === win) this.setState({ ready: true, tip: '' });
      return next;
    }
    // 只有未提供物理重启的路径才执行逻辑排版切换。
    if (this.setOrientation) await this.setOrientation(next).catch(() => {});
    if (this.win !== win) return previous;
    this.state.landscape = next;
    this.setState({ ready: true, tip: '' });
    return next;
  }

  /** 需要时切到指定面板方向；Windows 全屏不会修改它。 */
  async setLandscape(want) {
    if (!this.isOpen) return this.state.landscape;
    if (!!this.state.landscape === !!want) return this.state.landscape;
    return this.rotate();
  }

  _displayBounds(area, fullscreen, caption = 0) {
    return windowBounds(this.portrait, area, {
      fullscreen, caption, landscape: this.state.landscape, remembered: this._rememberedBounds,
    });
  }

  async toggleMaximize(fullscreen = !this._layoutFullscreen) {
    return this.applyWindowSize(this.portrait, { fullscreen });
  }

  /** Only change the Windows surface; an Android framebuffer change is a separate setting. */
  async applyWindowSize(portrait, { fullscreen } = {}) {
    const request = ++this._layoutRequest;
    const presetChanged = !!portrait && (portrait.w !== this.portrait?.w || portrait.h !== this.portrait?.h);
    if (portrait) this.portrait = portrait;
    if (presetChanged) {
      this._rememberedBounds = null;
      this._preFullscreenRect = null;
    }
    if (typeof fullscreen === 'boolean') this._wantFullscreen = fullscreen;
    if (!this.isOpen || !this._surfaceAttached || this.waitingForRestart
      || (fullscreen === undefined && this._layoutFullscreen)) return false;
    const targetFullscreen = fullscreen ?? this._layoutFullscreen;
    return this._attachSurface(async ({ shell, agent, current }) => {
      let accepted = false;
      if (this.detachedMode) {
        const probe = await agent.probe().catch(() => null);
        if (!current()) return false;
        const area = this._areaForNative(probe);
        const prior = this._preFullscreenRect;
        // Probe rectangles already are physical pixels. Keep a dragged size when exiting fullscreen.
        const target = !targetFullscreen && this._layoutFullscreen && prior
          ? prior : this._physical(this._displayBounds(area, targetFullscreen), area.sf);
        const result = await agent.layout(target).catch(() => null);
        if (!current() || result?.ok !== true) return false;
        if (targetFullscreen && !this._layoutFullscreen && probe?.w > 0 && probe?.h > 0) {
          this._preFullscreenRect = { x: probe.x, y: probe.y, w: probe.w, h: probe.h };
        } else if (!targetFullscreen) this._preFullscreenRect = null;
        accepted = true;
      } else {
        const area = this._area();
        const { x, y, w, h } = this._displayBounds(area, targetFullscreen, TITLEBAR_H);
        if (shell.isMaximized()) shell.unmaximize();
        shell.setBounds({ x, y, width: w, height: h });
        const result = await agent.fit(this._rect()).catch(() => null);
        accepted = current() && result?.ok === true;
      }
      if (accepted) this._layoutFullscreen = targetFullscreen;
      return accepted;
    }, () => request === this._layoutRequest).catch(() => false);
  }

  minimize() {
    if (!this.isOpen) return;
    // 独立窗口模式：最小化的是模拟器原生窗口（agent.hide 会藏它），
    // 而不是那个看不见的壳窗口。
    if (this.detachedMode) { this.agent.hide().catch(() => {}); return; }
    this.win.minimize();
  }

  /**
   * 关闭窗口。默认同时停掉这个安卓应用（省内存），但保留引擎，下次点开是秒开。
   *
   * 顺序很重要：必须先把模拟器窗口从宿主窗口上「摘下并藏好」，再销毁宿主。
   * 反过来的话 Windows 会把跨进程的子窗口重新挂到桌面、并保持它原来的可见状态，
   * 用户桌面上就会凭空多出一个 "Android Emulator - apkstart5554" 的黑窗。
   */
  close({ keepApp = false } = {}) {
    if (!this.isOpen) return this._pendingPark;
    const win = this.win;
    const pkg = this.pkg;
    const session = this.session;
    const lifecycle = this._windowLifecycle;
    this._syncHook(false);
    this._cancelFit();
    this.lastEmbedOk = false;
    this.win = null;
    this.pkg = null;
    this.session = null;
    this._windowLifecycle = null;
    this.waitingForRestart = false;
    const pending = this._parkThen(() => {
      try { win.destroy(); } catch (_) { /* ignore */ }
      lifecycle?.onClosed?.(pkg, session);
    });
    if (!keepApp && pkg && this._onCloseApp) this._onCloseApp(pkg, session);
    return pending;
  }

  waitForPark() { return this._pendingPark.catch(() => {}); }

  _parkThen(done) {
    const attachment = this._pendingAttachment;
    const pending = this._pendingPark.catch(() => {}).then(() => attachment)
      .then(async () => {
        try {
          const result = await this.agent?.park(0);
          if (result?.ok === false) throw new Error('窗口代理未确认已停放安卓窗口');
        } finally {
          done();
        }
      });
    this._pendingPark = pending;
    return pending;
  }

  onCloseApp(cb) { this._onCloseApp = cb; }
}

module.exports = { AppWindow, TITLEBAR_H };
