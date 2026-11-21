'use strict';
/**
 * 运行时引擎：ApkStart 自带的 QEMU + Android-x86 虚拟机
 *
 * 设计原则：
 *  - 默认完全自持（builtin）：adb / QEMU / 系统镜像都由 ApkStart 自己管理，不依赖任何第三方模拟器
 *  - 所有对安卓的操作统一走 adb，因此引擎可替换
 *  - 虚拟机按需启动，空闲自动回收；启动后常驻复用，装/开应用几乎零等待
 */
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { isUnauthorizedError } = require('./adb');
const store = require('./store');
const { Provisioner } = require('./provision');
const { EmulatorEngine } = require('./emulator');
const doctor = require('./doctor');
const { isImageName } = require('./userdata');
const container = require('./container');
const { RuntimeLifecycle } = require('../application/runtime-lifecycle');
const backends = require('./backends');
const {
  AVD_NAME, processAlive, readAvdOwner, isConsolePort, readConsoleName, findOwnedEmulator,
  readLoopbackOwners, ownsPort,
} = require('./runtime-ownership');

const LOG_DIR = path.join(store.DATA_DIR, 'logs');
const MONITOR_PORT = 5556;
const EMU_PORT = 5554;
const EMU_SERIAL = `emulator-${EMU_PORT}`;
const QEMU_ADB_PORT = 5555;
const QEMU_SERIAL = `127.0.0.1:${QEMU_ADB_PORT}`;
const OWNER_UNKNOWN = '无法确认运行中的安卓模拟器属于 ApkStart。请先关闭 ApkStart 的安卓窗口后重试。';
const ADB_CONSENT_MESSAGE = '请在安卓模拟器窗口点「允许 USB 调试」。确认后 ApkStart 会自动继续。';

function waitForGuestExit(proc, timeout = 3000) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const finish = (exited) => {
      clearTimeout(timer);
      proc.off('exit', onExit);
      resolve(exited);
    };
    const onExit = () => finish(true);
    const timer = setTimeout(() => finish(false), timeout);
    proc.once('exit', onExit);
  });
}

const IDLE_SYSTEM_PACKAGES = new Set([
  'com.android.launcher3', 'com.google.android.apps.nexuslauncher',
  'com.android.systemui', 'com.android.settings',
  'com.android.inputmethod.latin', 'com.google.android.inputmethod.latin',
]);

class Runtime {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.emulator = new EmulatorEngine(appRoot, { provisioner: this.provisioner });
    this.vmProc = null;
    this.vmStarting = false;
    this._adbConsentPending = false;
    this.installing = false;
    this.lastActivity = Date.now();
    this._watchdog = null;
    this._freeformReady = false;
    this._client = null;
    this._bootLog = [];
    // 最近一次网络体检结果。状态栏要显示「网络正常/未联网」，但状态是高频轮询的，
    // 不能每次都去 guest 里跑一遍 shell；这里只缓存结论，过期（>5 分钟）就不采信。
    this._lastNetwork = null;
    this.emuSerial = EMU_SERIAL;   // 端口是动态挑的，serial 跟着变
    /**
     * 后端适配层：把「安卓从哪来」从本类里抽出去。
     *
     * 0.5.6 起这里**只有一个实现**：builtin（自带 emulator + 系统镜像）。
     * 不再有 mumu / fydeos / attach 这些分支 —— 任何机器、任何设置、任何残留配置
     * 都只会拿到自带运行时，保证 ApkStart 永远独立运行、与第三方模拟器无关。
     */
    this._backend = null;
    this._backendId = '';
    store.ensureDirs();
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  /**
   * 当前后端实例（只有一个：builtin）。
   * @returns {import('./backends/base').Backend}
   */
  get backend() {
    if (!this._backend) {
      const made = backends.create({
        appRoot: this.appRoot, settings: this.settings, runtime: this, store, log: (l) => this.log(l),
      });
      this._backend = made.backend;
      this._backendId = made.id;
    }
    return this._backend;
  }

  /**
   * 设置里要的底座本机到底有没有。
   *
   * 现在只有自带运行时，它永远可用（缺镜像那是 provision 阶段的事，不是「底座不存在」）。
   * 保留这个方法是为了不改上层调用点。
   */
  async backendAvailable() {
    return { ok: true, id: 'builtin' };
  }

  /** 后端 id，永远是 'builtin'；界面和日志用 */
  get backendId() { return this.backend.id; }

  /** 丢掉旧的连接与端口假设（换运行时目录、重置数据后调用） */
  resetBackend() {
    if (this._backend && this._backend.dispose) {
      try { this._backend.dispose(); } catch (_) { /* ignore */ }
    }
    this._backend = null;
    this._backendId = '';
  }

  get settings() { return store.getSettings(); }

  /** emulator 引擎是否在运行 */
  get emuRunning() { return this.emulator.running(); }

  // ---------------- 基础 ----------------

  adbPath() { return this.provisioner.adbPath(); }

  adbClient(serial, adbPath = this.adbPath()) {
    return this.provisioner.adbClient({ adbPath, serial, port: this.emulator.adbPort });
  }

  client(serial) {
    const useSerial = serial || this.emuSerial;
    const adbPath = this.adbPath();
    if (!this._client || this._client.serial !== useSerial || this._client.adbPath !== adbPath
      || this._client.serverPort !== this.emulator.adbPort) {
      // Releasing the old input pipe matters when the selected executable changes.
      this._client?.disposeInput?.();
      this._client = this.adbClient(useSerial, adbPath);
    }
    return this._client;
  }

  touch() { this.lastActivity = Date.now(); }

  log(line) {
    this._bootLog.push({ t: Date.now(), line });
    if (this._bootLog.length > 300) this._bootLog.shift();
  }

  // ---------------- 状态 ----------------

  /**
   * 给状态栏用的网络快照（最近一次体检结论）。
   * 超过 5 分钟就不采信：中间可能断过网，宁可显示「未知」也不要骗用户说还行。
   */
  _networkSnapshot() {
    const n = this._lastNetwork;
    if (!n) return null;
    if (Date.now() - n.at > 5 * 60 * 1000) return null;
    return { ok: n.ok, ip: n.ip, reason: n.reason };
  }

  /**
   * 后台补一次网络体检（不阻塞 status 返回）。
   * 状态栏要显示网络状态，但 status() 是高频轮询的，不能每次都去 guest 里跑 shell。
   * 所以第一次（或过期后）在后台跑一遍，结论缓存进 _lastNetwork，下一次轮询就能显示。
   */
  _probeNetworkInBackground() {
    const generation = this.guestGeneration;
    if (this._netProbing === generation || this._networkTransitioning()) return;
    const n = this._lastNetwork;
    if (n && Date.now() - n.at < 60000) return;  // 一分钟内刚查过，别重复
    this._netProbing = generation;
    this.checkNetwork()
      .then((r) => {
        if (generation !== this.guestGeneration || this._networkTransitioning()) return;
        this._lastNetwork = { ok: !!(r && r.ok), ip: (r && r.ip) || '', reason: (r && r.reason) || '', at: Date.now() };
      })
      .catch(() => { /* 查不到就保持原样，下一轮再试 */ })
      .finally(() => { if (this._netProbing === generation) this._netProbing = undefined; });
  }

  async status() {
    const backend = this.backend;
    const env = await this.provisioner.checkEnv();
    const s = this.settings;
    const client = this.client();
    const result = {
      mode: s.engine.mode,
      backend: backend.id,
      backendLabel: backend.label,
      installed: !!s.runtime.installed,
      env,
      engineKind: env.engine,
      emulatorOk: env.emulator.ok,
      emulatorVersion: env.emulator.version,
      sysimgOk: env.sysimg.ok,
      sysimgNote: env.sysimg.note,
      accel: env.accel,
      vmRunning: this.emulator.running() || !!(this.vmProc && !this.vmProc.killed),
      vmStarting: this.vmStarting,
      installing: this.installing,
      adbOk: env.adb.ok,
      adbVersion: env.adb.version,
      qemuOk: env.qemu.ok,
      qemuVersion: env.qemu.version,
      deviceOnline: false,
      android: '',
      sdk: 0,
      freeform: false,
      ready: false,
      needsSetup: null,
      error: '',
      phase: this._adbConsentPending ? 'awaiting-auth' : this.installing ? 'installing' : 'idle',
      authorizationRequired: !!this._adbConsentPending,
      authorizationMessage: this._adbConsentPending ? ADB_CONSENT_MESSAGE : '',
      serial: this.emuSerial,
      network: this._networkSnapshot(),
      autoProfile: this.emulator.profile ? doctor.describeProfile(this.emulator.profile) : '',
      diagnosis: this.emulator.lastDiagnosis || null,
      attempts: this.emulator.attempts || [],
      // 「上次为什么没起来」：内存里没有就回落到落盘记录，设置页/诊断都能显示真实原因
      lastFailure: (this.emulator.lastFailure ? this.emulator.lastFailure() : null),
    };

    if (!env.adb.ok) {
      result.needsSetup = 'adb';
      result.error = '缺少 adb：点击「一键部署」自动下载';
      return result;
    }

    if (result.authorizationRequired) return result;
    try {
      result.deviceOnline = await client.deviceState() === 'device';
      // ADB 的 transport 就绪不代表 Android 开机或包管理器已就绪。
      result.ready = result.deviceOnline && !result.vmStarting && !result.installing
        && await this.reuseProbe(client) === true && !this.vmStarting && !this.installing;
      if (result.ready) {
        const [android, sdk, ff] = await Promise.all([
          client.androidVersion().catch(() => ''),
          client.sdkInt().catch(() => 0),
          client.shell('settings get global enable_freeform_support').catch(() => '0'),
        ]);
        result.android = android;
        result.sdk = sdk;
        result.freeform = String(ff).trim() === '1' || this._freeformReady;
        this._probeNetworkInBackground();
      }
    } catch (e) {
      result.error = e.message;
    }

    if (!result.ready) {
      // 不再把「没有硬件加速」当成阻塞步骤：doctor 会自动回退软件模拟。
      result.needsSetup = !env.emulator.ok ? 'emulator' : !env.sysimg.ok ? 'sysimg' : 'boot';
    }

    result.phase = result.installing ? 'installing' : result.ready ? 'ready'
      : result.vmStarting || result.vmRunning || result.deviceOnline ? 'booting' : 'idle';

    return result;
  }

  /**
   * 本机 adb 已连上的设备清单（只读诊断用）。
   *
   * 0.5.6 起不再有「连接已有运行时」模式：这里不会去主动 connect 别的模拟器端口，
   * 只把 adb 当前看到的设备如实列出来，方便排障时确认「是不是我们的 emulator-5554」。
   */
  async probe() {
    try {
      const devices = await this.client().devices();
      return devices
        .filter((d) => d.state === 'device')
        .map((d) => ({ name: d.serial, serial: d.serial }));
    } catch (_) {
      return [];
    }
  }

  // ---------------- 启动 / 停止虚拟机 ----------------

  buildArgs({ install = false, headless = false } = {}) {
    const s = this.settings;
    const p = this.provisioner.paths();
    const hv = this._hv || { whpx: false };
    const disk = s.runtime.diskPath || p.disk;
    const iso = s.runtime.isoPath || p.iso;
    const accel = hv.whpx ? 'whpx' : 'tcg';

    const args = [
      '-name', 'ApkStart Runtime',
      '-machine', `q35,accel=${accel}`,
      '-cpu', hv.whpx ? 'host' : 'max',
      '-smp', String(Math.max(2, s.engine.cores || 4)),
      '-m', String(s.engine.memoryMB || 4096),
      '-rtc', 'base=localtime',
      '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:5555-:5555',
      '-device', 'virtio-net-pci,netdev=net0',
      '-vga', 'std',
      '-usb', '-device', 'usb-tablet',
      '-monitor', `tcp:127.0.0.1:${MONITOR_PORT},server,nowait`,
    ];

    if (headless || s.runtime.headless) args.push('-display', 'none');

    if (install) {
      args.push('-boot', 'order=d');
      args.push('-cdrom', iso);
    } else {
      args.push('-boot', 'order=c');
    }
    args.push('-drive', `file=${disk},if=virtio,format=qcow2,cache=writeback`);
    return args;
  }

  async _boot({ install = false, env, onLog = () => {} }) {
    this._retireGuest();
    this._hv = env.hypervisor;

    // 首选：官方 emulator（自带设备模型与 GPU 转译，体验最好）
    if (env.emulator.ok && env.sysimg.ok) {
      return this.bootEmulator({ env, onLog });
    }

    return this.bootQemu({ install, env, onLog });
  }

  /**
   * 用官方 emulator 启动 Android。
   * 与 QEMU+ISO 不同，这里没有"安装系统"这一步：镜像本身就是系统，首次启动即开机。
   */
  async bootEmulator({ env, onLog = () => {} } = {}) {
    const accel = env && env.accel ? env.accel : await this.provisioner.emulatorAccel();
    if (!accel.ok) {
      onLog('未检测到硬件加速：将自动回退软件模拟（首次开机会明显变慢，无需手动设置）');
    }

    this.vmStarting = true;
    try {
      // probe 交给 EmulatorEngine 的开机循环：进程退出/致命日志时它会换一组参数重试
      // 每轮只发一次 adb 命令：以前是 get-state + getprop + pm path 三次进程拉起，
      // 快照恢复时一轮就差 300~500ms，正好卡在「点开应用」的观感上。
      let probeStart = Date.now();
      let errStreak = 0;
      let lastHeal = 0;
      let probeIdentity = null;
      let nextOwnerCheck = 0;
      let consentIdentity = null;
      let consentReadyIdentity = null;
      const diagUnauthorized = () => ({
        code: 'ADB_UNAUTHORIZED',
        title: '安卓尚未授权本机的 ADB 调试连接',
        hint: '请使用可见的安卓模拟器窗口，确认「允许 USB 调试」后再重试。'
          + '不需要删除本机 ADB 密钥或清空安卓数据。',
      });
      const probe = async ({ serial, port, awaitingAuthorization = false }) => {
        if (!this.emulator.running()) return 'fatal';
        if (awaitingAuthorization && (consentIdentity?.serial !== serial || !await consentIdentity.revalidate())) return 'fatal';
        // 启动轮询只读：缓存短期的归属校验，避免每 200ms 拉起 netstat。
        if (probeIdentity?.port !== port || Date.now() >= nextOwnerCheck) {
          if (probeIdentity?.port !== port || !await probeIdentity.revalidate()) {
            probeIdentity = await this.ownedEmulator();
          }
          if (probeIdentity?.serial !== serial) return 'pending';
          nextOwnerCheck = Date.now() + 2500;
        }
        const adbPath = this.adbPath();
        if (!this._probeClient || this._probeClient.serial !== serial || this._probeClient.adbPath !== adbPath
          || this._probeClient.serverPort !== this.emulator.adbPort) {
          this._probeClient = this.adbClient(serial, adbPath);
        }
        const c = this._probeClient;
        try {
          const out = String(await c.shell('getprop sys.boot_completed; pm path android', { timeout: 8000 }));
          const lines = out.split(/\r?\n/).map((l) => l.trim());
          const booted = lines[0] === '1' || /^1$/.test(lines[0] || '');
          const pmReady = lines.some((l) => /^package:/.test(l));
          errStreak = 0;
          if (booted && pmReady) {
            if (awaitingAuthorization) {
              if (!await consentIdentity?.revalidate()) return 'fatal';
              consentReadyIdentity = consentIdentity;
            }
            return 'ok';
          }
          return booted ? 'pending' : 'booting';
        } catch (e) {
          errStreak += 1;
          // 自愈会写快照/改连接，不能沿用只读探测的缓存。
          if (!await probeIdentity?.revalidate()) {
            probeIdentity = null;
            return 'pending';
          }
          // 区分尚未开机和未授权：get-state 不可靠，必要时读 devices 的状态列。
          const raw = String((e && (e.raw || e.stdout || e.message)) || '');
          let unauthorized = isUnauthorizedError(raw);
          if (!unauthorized) {
            const st = await c.deviceState().catch(() => '');
            unauthorized = st === 'unauthorized';
          }
          if (unauthorized) {
            this.emulator.lastDiagnosis = diagUnauthorized();
            return 'unauthorized';
          }
          // 其它 adb 传输异常：重新检查监听，必要时补启动服务。
          const now = Date.now();
          if (!awaitingAuthorization && errStreak >= 6 && now - probeStart > 25000 && now - lastHeal > 30000) {
            lastHeal = now;
            onLog('adb 连接异常，检查 ADB 服务后继续等待…');
            await this.emulator.ensureAdbServer().catch(() => {});
            this._probeClient = null;
          }
          return 'pending';
        }
      };

      const onAuthorizationRequired = typeof this.presentAdbConsent === 'function' ? async ({ serial, port, signal }) => {
        // Reuse the exact lock generation that returned unauthorized, not a newer guest on the same port.
        const identity = probeIdentity;
        if (identity?.serial !== serial || identity.port !== port || !await identity.revalidate() || signal.aborted) return null;
        const hide = await this.presentAdbConsent(identity);
        if (typeof hide !== 'function') return null;
        if (!await identity.revalidate() || signal.aborted) { await hide(); return null; }
        consentIdentity = identity;
        this._adbConsentPending = true;
        return async () => {
          try { await hide(); } finally {
            this._adbConsentPending = false;
            consentIdentity = null;
          }
        };
      } : undefined;

      const st = await this.emulator.start({
        headless: this.settings.engine.headless !== false,
        onLog,
        probe,
        networkProbe: (startupSerial, options) => this._checkNetwork({ ...options, startupSerial }),
        stopOwnedAttempt: (port) => this.stopOwnedAttempt(port),
        onAuthorizationRequired,
      });
      // start() 失败时是「返回 {ok:false}」而不是抛异常（磁盘不足、多次重试仍失败等）。
      // 老实现不看这个字段，直接把 ok:true 往上返回 —— 上层于是认为「已经就绪」，
      // 接着 adb 一顿报 device not found，用户看到的是「点开没反应」而不是真实原因。
      if (!st || st.ok === false) {
        return {
          ok: false,
          error: (st && st.error) || '安卓运行时未能启动',
          needsSpace: !!(st && st.needsSpace),
          attempts: (st && st.attempts) || [],
          diagnosis: this.emulator.lastDiagnosis,
          exitCode: st && st.exitCode,
        };
      }
      const identity = await this.ownedEmulator();
      if (!identity || identity.serial !== (st.serial || this.emulator.serial)) return { ok: false, error: OWNER_UNKNOWN };
      if (consentReadyIdentity && (identity.pid !== consentReadyIdentity.pid || !await consentReadyIdentity.revalidate())) {
        return { ok: false, error: OWNER_UNKNOWN };
      }
      this.lastActivity = Date.now();
      this.emuSerial = identity.serial;
      const client = this.client(this.emuSerial);
      await this.prepare(client);
      const performance = this.settings.engine.priorityMode === 'performance';
      await this.setGuestPriority(performance ? 'normal' : 'below', identity).catch(() => {});
      // 快照改成「空闲时再存」：立刻存要写 1~3GB，会和用户刚点开的应用抢磁盘 I/O
      this._armSnapshotSave(20000);
      return { ok: true, client, engine: 'emulator', serial: this.emuSerial, profile: st.profile, network: st.network || null };
    } catch (e) {
      // 把自动重试/诊断结论原样抛给 UI，避免再包一层含糊的「启动失败」
      return { ok: false, error: e.message, diagnosis: e.diagnosis, report: e.report, attempts: e.attempts };
    } finally {
      this.vmStarting = false;
    }
  }

  // ---------------- 预热（像 WSA 一样让环境常驻） ----------------

  /** 空闲时保存 quickboot 快照：只在没有应用窗口时写盘，避免和应用启动抢 I/O */
  _armSnapshotSave(delay = 20000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave({
      delay,
      isIdle: () => this.sessionActivity?.isIdle ?? true,
      resolveGuest: () => this._emulatorGuest(),
    });
  }

  /** 供安装器等外部调用：装完应用后重新存一份快照，下次开机仍是秒进 */
  scheduleSnapshotSave(delay = 12000) { this._armSnapshotSave(delay); }

  /**
   * 强制存一份快照，**不等空闲**。
   *
   * 什么时候需要：刚修好网络、马上就要启动应用的时候。正常的
   * scheduleSnapshotSave 只在没有应用窗口时才写盘，而应用一起来就永远不空闲，
   * 于是「网络已连上」这个状态从来没被存下来 —— 下次开机又从旧快照恢复成
   * 断网状态，每次都要重连一遍。这里显式绕过空闲判断，一次写盘换之后次次省。
   */
  forceSnapshotSave(delay = 3000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave({
      delay, resolveGuest: () => this._emulatorGuest(),
    });
  }

  async saveOwnedSnapshot(timeout = 45000) {
    const guest = await this._emulatorGuest();
    return !!guest && this.emulator.saveSnapshotNow({ ...guest, timeout });
  }

  /**
   * 预热：在用户点开应用之前，先把安卓环境在后台引导好。
   * WSA / 应用宝电脑版都是这个思路 —— 环境常驻，点图标时只剩一次 am start。
   *  - 完全静默：不弹窗、不报错，失败不影响正常打开应用；
   *  - 幂等：正在开机或已就绪时复用同一个 Promise，不会重复拉起第二台；
   *  - 省资源：开机完成后把 qemu 降到最低优先级停放。
   */
  prewarm({ onLog = () => {} } = {}) {
    if (this._prewarmPromise) return this._prewarmPromise;
    if (this.sessionActivity?.isIdle === false) return Promise.resolve({ ok: true, skipped: 'busy' });
    const t0 = Date.now();
    const p = (async () => {
      try {
        const env = await this.provisioner.checkEnv();
        if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) return { ok: false, skipped: 'not-ready' };
        const r = await this.ensure({ onLog: (m) => onLog(`预热：${m}`) });
        if (r && r.ok) {
          // 预热期间用户可能已经点开了应用：这时不能把它摁到 idle 优先级
          if (this.sessionActivity?.isIdle !== false) await this.setGuestPriority('idle').catch(() => {});
          const ms = Date.now() - t0;
          this.log(`预热完成（${Math.round(ms / 1000)}s）`);
          return { ok: true, bootMs: ms };
        }
        return { ok: false, error: r && r.error };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })();
    this._prewarmPromise = p;
    const clear = () => { if (this._prewarmPromise === p) this._prewarmPromise = null; };
    p.then(clear, clear);
    return p;
  }

  async bootQemu({ install = false, env, onLog = () => {} } = {}) {
    if (!env.qemu.ok) throw new Error('未安装 QEMU，请先完成运行时部署');
    if (install && !env.iso.ok) throw new Error('系统镜像（ISO）未就绪');

    const p = this.provisioner.paths();
    const disk = this.settings.runtime.diskPath || p.disk;
    if (!install && !fs.existsSync(disk)) throw new Error('尚未安装 Android 系统到虚拟磁盘');

    const args = this.buildArgs({ install });
    const logFile = path.join(LOG_DIR, install ? 'qemu-install.log' : 'qemu.log');
    const out = fs.openSync(logFile, 'a');
    let proc;
    try {
      fs.writeSync(out, `\n\n=== ${new Date().toISOString()} ${install ? 'INSTALL' : 'BOOT'} ===\n${env.qemu.path} ${args.join(' ')}\n`);

      onLog(`启动运行时（${env.hypervisor.whpx ? 'WHPX 硬件加速' : '纯软件模拟'}）…`);
      if (!env.hypervisor.whpx) onLog(env.hypervisor.note);
      proc = spawn(env.qemu.path, args, {
        cwd: path.dirname(env.qemu.path),
        windowsHide: true,
        stdio: ['ignore', out, out],
      });
    } finally {
      fs.closeSync(out); // The child owns the inherited handle; the parent must close its descriptor.
    }
    this.vmStarting = true;
    this.vmProc = proc;
    this.installing = install;
    this.lastActivity = Date.now();

    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      onLog(`启动失败：${e.message}`);
      if (this.vmProc === proc) {
        this.vmProc = null;
        this.vmStarting = false;
        this.installing = false;
      }
    });
    proc.on('exit', (code) => {
      this.log(`qemu exit ${code}`);
      onLog(`运行时已退出（code=${code}）`);
      if (this.vmProc === proc) {
        this.vmProc = null;
        this.vmStarting = false;
        this.installing = false;
      }
    });

    await new Promise((r) => setTimeout(r, 1500));
    this.vmStarting = false;
    if (this.vmProc !== proc) throw new Error(`QEMU 启动失败，详见日志：${logFile}`);

    // 装机模式：ISO 里是 Linux 安装程序，没有 adb，不能按「等 adb」处理
    if (install) {
      onLog('安装程序已启动，请在虚拟机窗口里按引导完成安装');
      return { ok: true, install: true, needsManualInstall: true };
    }

    const client = await this.trackedQemuClient();
    if (!client) return { ok: false, error: '无法确认 QEMU 占有调试端口 5555，未连接到未知设备。' };
    const timeout = env.hypervisor.whpx ? 180000 : 900000;
    const linked = await this.waitAdb(client, timeout, onLog);
    if (!linked) {
      return {
        ok: false,
        error: '虚拟机已启动，但 adb 未能连接：请在虚拟机里开启「开发者选项 → ADB over network」后重试',
      };
    }
    const ready = await this.waitAndroidReady(client, Math.max(60000, timeout / 2), onLog);
    if (!ready.ok) {
      return {
        ok: false,
        error: ready.stage === 'kernel'
          ? 'Android 内核未完成引导，请查看运行时日志（可能镜像损坏或加速未生效）'
          : 'Android 已引导但系统服务未就绪（可能停在首次开机设置界面，请在虚拟机窗口里完成向导）',
      };
    }
    if (!await this.trackedQemuClient()) return { ok: false, error: 'QEMU 已断开，未连接到未知设备。' };
    await this.prepare(client);
    this.emuSerial = QEMU_SERIAL;
    return { ok: true, client };
  }

  /**
   * 等待 Android 真正可用：adb 在线 ≠ 系统可用。
   * 必须等到 sys.boot_completed=1 且包管理器可响应，否则 am start 会直接失败。
   */
  async waitAndroidReady(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let bootCompleted = false;
    let lastNotice = 0;
    while (Date.now() - start < timeoutMs) {
      /* eslint-disable no-await-in-loop */
      const online = await client.isOnline();
      if (!online) {
        await client.connect().catch(() => false);
      } else {
        if (!bootCompleted) {
          const v = await client.shell('getprop sys.boot_completed').catch(() => '');
          if (String(v).trim() === '1') {
            bootCompleted = true;
            onLog(`Android 内核已启动，等待系统服务就绪…（${Math.round((Date.now() - start) / 1000)}s）`);
          }
        }
        if (bootCompleted) {
          const pm = await client.shell('pm path android').catch(() => '');
          if (/package:/.test(pm)) {
            onLog(`Android 已就绪（${Math.round((Date.now() - start) / 1000)}s）`);
            return { ok: true, ms: Date.now() - start };
          }
        }
      }
      if (Date.now() - lastNotice > 15000) {
        lastNotice = Date.now();
        onLog(bootCompleted
          ? `正在等待系统服务… ${Math.round((Date.now() - start) / 1000)}s`
          : `正在引导 Android… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      /* eslint-enable no-await-in-loop */
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, stage: bootCompleted ? 'services' : 'kernel', ms: Date.now() - start };
  }

  async waitAdb(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let lastNotice = 0;
    const needConnect = String(client.serial || '').includes(':')
      && !/^emulator-/.test(client.serial);
    while (Date.now() - start < timeoutMs) {
      // emulator-5554 这类由 emulator 自己注册，不需要 adb connect
      if (needConnect) {
        // eslint-disable-next-line no-await-in-loop
        await client.connect().catch(() => false);
      }
      // eslint-disable-next-line no-await-in-loop
      if (await client.isOnline()) return true;
      if (Date.now() - lastNotice > 20000) {
        lastNotice = Date.now();
        onLog(`等待 Android 启动… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async prepare(client) {
    if (!this._freeformReady) {
      try { this._freeformReady = await client.ensureFreeform(); } catch (_) { /* ignore */ }
    }
    // 中文环境（系统语言 + 中文输入法）每次**开机**只做一次。
    // 系统语言靠 emulator -prop 注入（SELinux 保护，运行时改不了），这里补的是
    // 应用级 locale / 时区，以及静默装好并启用随包带的谷歌拼音输入法。
    // 用户可在设置里关掉自动配置（engine.chineseIme=false）。
    if (!this._chineseReady && this.settings.engine.chineseIme !== false) {
      try {
        const locale = this.settings.engine.locale || 'zh-CN';
        await client.ensureChineseLocale(locale);
        const path = require('path');
        const apk = path.join(this.appRoot, 'assets', 'PinyinIME.apk');
        const r = await client.ensureChineseIme(apk, {
          setDefault: this.settings.engine.chineseImeDefault !== false,
        });
        // 只有真的成功了才置位。失败时允许下一次 prepare() 重试 ——
        // 否则一次偶发的 adb 抖动就会让这台机器永远没有中文输入法。
        if (r && r.ok) this._chineseReady = true;
        this.log(`中文输入法：${r.ok ? (r.installed ? '已安装并启用' : '已就绪') : (r.reason || '未就绪')}`);
        // -change-locale 只在「全量引导」时执行并重启 framework；从 quickboot 快照
        // 恢复时会被跳过。旧快照是英文的，所以检测到系统语言不对就作废快照、
        // 让下次开机冷启动一次（带 -change-locale）。之后存的新快照就是中文的，
        // 不用再重启。marker 保证一生只纠正一次。
        await this._ensureSystemLocale(client, locale);
      } catch (e) {
        this.log(`中文环境初始化跳过：${e.message}`);
      }
    }
    this.startWatchdog();
  }

  /**
   * 系统 UI 语言校正（一次性）。
   *
   * 实测结论（很容易踩错）：-change-locale 生效后**不会**写 persist.sys.locale，
   * ro.product.locale 也仍是镜像的 en-US；它真正改的是
   * `settings system system_locales`（语言设置页显示「中文（中国）」，系统 UI 全中文）。
   * 所以判断「中文是否已经生效」要看 system_locales，不是 getprop。
   *
   * -change-locale 只在「全量引导」时执行并重启 framework；从 quickboot 快照恢复时
   * 会被跳过。旧快照是英文的，所以检测到不对就作废快照、让下次开机冷启动一次。
   * 之后存的新快照就是中文的，不用再重启。marker 保证一生只纠正一次。
   */
  async _ensureSystemLocale(client, locale) {
    const fs = require('fs');
    const path = require('path');
    const want = String(locale || 'zh-CN');
    if (want === 'off' || want === 'en-US') return;
    // 已经生效（system_locales 是目标语言，或语言列表里第一项是它）
    const cur = await client.shell('settings get system system_locales', { timeout: 8000 }).catch(() => '');
    const s = String(cur).trim();
    if (s === want || s.indexOf(want) === 0 || /^zh[-_]/.test(s)) return;
    const marker = path.join(store.DATA_DIR, 'locale-' + want.replace(/[^a-zA-Z0-9_-]/g, '_') + '.done');
    if (fs.existsSync(marker)) return;
    try {
      fs.writeFileSync(marker, String(Date.now()));
      this.log(`系统语言仍为 ${s || '(空)'}，作废旧快照，下次开机冷启动切到 ${want}`);
      this.emulator.invalidateSnapshot();
      this.emulator.forceColdBootOnNextStart();
    } catch (e) {
      this.log(`系统语言校正跳过：${e.message}`);
    }
  }

  /** 只停止已确认属于当前 AVD 的 Emulator，或本进程直接启动的 QEMU。 */
  async _stopInner({ graceful = true, shouldStop } = {}) {
    if (!shouldStop) this._retireGuest();
    const ownership = await this.inspectEmulatorOwnership();
    if (shouldStop) {
      if (!shouldStop()) return false;
      this._retireGuest();
    }
    const identity = ownership.emulator;
    if (identity) {
      const stopped = await this.emulator.stop({ client: this.client(this._emulatorGuestSerial(identity)), identity });
      return stopped ? this._recordGuestStopped() : false;
    }
    const proc = this.vmProc;
    if (!proc) return ownership.state === 'absent' && !this.emulator.running() && this._recordGuestStopped();
    const monitorOwned = async () => this.vmProc === proc && !proc.killed
      && ownsPort(await this.loopbackOwners(), MONITOR_PORT, proc.pid) && this.vmProc === proc;
    if (graceful && await monitorOwned().catch(() => false)) {
      try { await this.monitorCmd('system_powerdown'); } catch (_) { /* ignore */ }
      for (let i = 0; i < 16 && this.vmProc === proc; i++) {
        await new Promise((r) => setTimeout(r, 500));
      }
      if (await monitorOwned().catch(() => false)) {
        try { await this.monitorCmd('quit'); } catch (_) { /* ignore */ }
        await new Promise((r) => setTimeout(r, 800));
      }
    }
    if (this.vmProc !== proc) return this._recordGuestStopped();
    try {
      // ChildProcess.kill confirms signal delivery, not that the disk is free.
      if (!proc.killed && !proc.kill()) return false;
      if (!await waitForGuestExit(proc)) return false;
      if (this.vmProc === proc) this.vmProc = null;
      this.installing = false;
      return this._recordGuestStopped();
    } catch (_) { return false; }
  }

  _recordGuestStopped() {
    this._lastNetwork = null;
    this.sessionActivity?.guestStopped();
    return true;
  }

  // ---------------- QEMU monitor ----------------

  monitorCmd(cmd, { timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: MONITOR_PORT });
      let buf = '';
      let sent = false;
      const done = (err, data) => {
        try { sock.destroy(); } catch (_) { /* ignore */ }
        if (err) reject(err); else resolve(data);
      };
      sock.setTimeout(timeout, () => done(new Error('monitor 超时')));
      sock.on('error', (e) => {
        // QEMU 执行 quit 等命令后会主动断开连接（ECONNRESET/EPIPE），属于正常现象
        if (sent && /ECONNRESET|EPIPE/i.test(e.code || String(e))) done(null, buf);
        else done(e);
      });
      sock.on('data', (c) => {
        buf += c.toString();
        if (!sent && buf.includes('(qemu)')) {
          sent = true;
          sock.write(`${cmd}\n`);
          setTimeout(() => done(null, buf), 300);
        }
      });
      sock.on('connect', () => {
        if (!cmd) setTimeout(() => done(null, buf), 250);
      });
    });
  }

  async sendKey(keys, delay = 140) {
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      await this.monitorCmd(`sendkey ${k}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // ---------------- 安装系统到虚拟磁盘 ----------------

  startInstaller(options) {
    return this.lifecycle.maintain(() => this._startInstaller(options));
  }

  async _startInstaller({ onLog = () => {} } = {}) {
    if (this.installing && this.vmProc) return { ok: true, install: true, needsManualInstall: true };
    if (this.vmRunning || ['live', 'unknown'].includes(this.avdOwner().state)) {
      throw new Error('请先关闭旧安卓运行时，再启动 ISO 安装程序。');
    }
    const env = await this.provisioner.checkEnv();
    if (!env.iso.ok) {
      throw new Error(env.iso.reason || '请先下载/导入 Android 系统镜像（ISO）');
    }
    if (!env.disk.ok) await this.provisioner.createDisk(this.settings.runtime.diskSizeGB || 24, () => {});
    const r = await this._boot({ install: true, env, onLog });
    if (!r.ok) throw new Error(r.error || '安装环境启动失败');
    this.installing = true;
    return r;
  }

  /** 安装完成后：关掉安装程序 → 写标记 → 之后直接从磁盘启动 */
  markInstalled() {
    return this.lifecycle.maintain(async () => {
      if (this.installing && !await this._stopInner()) {
        throw new Error('无法确认安装程序已关闭，没有标记系统安装完成。');
      }
      store.saveSettings({ runtime: { installed: true } });
      this.installing = false;
      return true;
    });
  }

  // ---------------- ensure ----------------

  avdOwner() {
    return readAvdOwner(this.provisioner.paths().avdHome);
  }

  loopbackOwners() { return readLoopbackOwners(); }

  inspectEmulatorOwnership() {
    return findOwnedEmulator({
      readOwner: () => this.avdOwner(),
      readListeners: () => this.loopbackOwners(),
      // 控制台不经过 adb server，单独的客户端也不会替换 guest 的常驻输入会话。
      consoleClient: (serial) => this.adbClient(serial),
    });
  }

  async ownedEmulator() {
    const result = await this.inspectEmulatorOwnership();
    return result.emulator || null;
  }

  async stopOwnedAttempt(port) {
    const identity = await this.ownedEmulator();
    if (identity?.port !== port || !await identity.revalidate()) return false;
    try {
      const { stdout } = await identity.client.exec(['emu', 'kill'], { timeout: 8000 });
      if (/^\s*KO\b/im.test(stdout)) return false;
      const deadline = Date.now() + 30000;
      while (processAlive(identity.pid)) {
        if (Date.now() >= deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return true;
    } catch (_) { return false; }
  }

  async _ownsQemuAdb(proc) {
    if (!proc?.pid || proc.killed) return false;
    try {
      const listeners = await this.loopbackOwners();
      return this.vmProc === proc && !proc.killed && ownsPort(listeners, QEMU_ADB_PORT, proc.pid);
    } catch (_) { return false; }
  }

  async trackedQemuClient() {
    return await this._ownsQemuAdb(this.vmProc) ? this.client(QEMU_SERIAL) : null;
  }

  _emulatorGuestSerial(identity) {
    const alias = '127.0.0.1:' + (identity.port + 1);
    // A previously verified TCP transport is useful for guest commands only, never 'adb emu'.
    return this.emuSerial === alias ? alias : identity.serial;
  }

  async _emulatorGuest(startupSerial) {
    const identity = await this.ownedEmulator();
    if (!identity || (startupSerial && identity.serial !== startupSerial)) return null;
    const serial = startupSerial || this._emulatorGuestSerial(identity);
    return {
      identity,
      client: this.client(serial),
      revalidate: () => identity.revalidate({ adbPort: serial !== identity.serial }),
    };
  }

  async adoptExisting({ onLog = () => {} } = {}) {
    const result = await this.inspectEmulatorOwnership();
    if (result.state === 'absent') return null;
    if (result.state !== 'owned') return { ok: false, error: OWNER_UNKNOWN };
    const { emulator } = result;
    let client = this.client(emulator.serial);
    let probe = await this.reuseProbe(client);
    let tcp = false;
    // adb server 可能晚于模拟器启动，非默认端口不会自动登记。只补连已证明属于
    // 同一 PID 的端口，不重启 adb server，也不用 TCP 别名发控制台命令。
    if (probe === null && await emulator.revalidate({ adbPort: true })) {
      tcp = true;
      const serial = `127.0.0.1:${emulator.port + 1}`;
      client = this.client(serial);
      await client.exec(['connect', serial], { withSerial: false, timeout: 4500 }).catch(() => {});
      if (!await emulator.revalidate({ adbPort: true })) return { ok: false, error: OWNER_UNKNOWN };
      probe = await this.reuseProbe(client);
    }
    if (probe !== true) {
      return { ok: false, error: 'ApkStart 的安卓运行时尚未就绪。请稍后重试；若停在调试授权对话框，请先在安卓窗口确认。' };
    }
    if (!await emulator.revalidate({ adbPort: tcp })) return { ok: false, error: OWNER_UNKNOWN };
    await this.prepare(client);
    if (!await emulator.revalidate({ adbPort: tcp })) return { ok: false, error: OWNER_UNKNOWN };
    this.emuSerial = client.serial;
    this.emulator.port = emulator.port;
    onLog(`已复用 ApkStart 的安卓运行时（${client.serial}）`);
    return { ok: true, client, engine: 'emulator', reused: true };
  }

  /** 一次 shell 同时验证真实连接、开机完成和包管理器就绪。 */
  async reuseProbe(client) {
    try {
      const stdout = await client.shell('getprop sys.boot_completed; pm path android', { timeout: 4500 });
      const lines = String(stdout).trim().split(/\r?\n/);
      return lines[0].trim() === '1' && lines.slice(1).some((l) => l.trim().startsWith('package:'));
    } catch (_) { return null; }
  }

  async emulatorPorts() {
    return [...(await this.loopbackOwners()).keys()].filter(isConsolePort);
  }

  async pidOnPort(port) {
    const owners = (await this.loopbackOwners()).get(port);
    return owners?.size === 1 ? [...owners][0] : 0;
  }

  get guestGeneration() { return this._guestGeneration ?? 0; }

  _retireGuest() {
    this._guestGeneration = this.guestGeneration + 1;
    this._lastNetwork = null;
  }

  _networkTransitioning() {
    return ['stopping', 'restarting', 'maintaining'].includes(this._lifecycle?.phase);
  }

  get lifecycle() {
    return this._lifecycle ??= new RuntimeLifecycle({
      ensure: async (options) => {
        const result = await this._ensureInner(options);
        // Publish the guest lease before the next queued operation can stop it.
        return result?.ok ? { ...result, generation: this.guestGeneration } : result;
      },
      stop: (options) => this._stopInner(options),
    });
  }

  ensure(options) { return this.lifecycle.ensure(options); }

  stop(options) { return this.lifecycle.stop(options); }

  restart({ graceful = true, onLog } = {}) {
    return this.lifecycle.restart({ graceful, onLog });
  }

  repanel(landscape, { onLog } = {}) {
    return this.lifecycle.restart({
      graceful: false,
      onLog,
      // A failed stop must not publish a panel that the live guest doesn't use.
      beforeBoot: () => store.saveSettings({ display: { landscape: !!landscape } }),
    });
  }

  compatImageChangeError() {
    if (this.emulator.canUseCompatImage()) return null;
    return '已有安卓数据依赖当前镜像，未切换 ARM 兼容镜像。请先备份；确需切换时下载兼容镜像，并在设置中单独确认重置安卓数据。';
  }

  useCompatImage({ onLog } = {}) {
    return this.lifecycle.restart({
      onLog,
      check: () => {
        const error = this.compatImageChangeError();
        return error ? { ok: false, error, code: 'APP_COMPAT_REQUIRED' } : null;
      },
      beforeBoot: () => this.emulator.invalidateSnapshot(),
    });
  }

  async _ensureInner({ onLog = () => {} } = {}) {
    const adopted = await this.adoptExisting({ onLog });
    if (adopted) return adopted;
    if (this.emulator.running()) return { ok: false, error: OWNER_UNKNOWN };
    if (this.vmProc) {
      const client = await this.trackedQemuClient();
      if (!client || await this.reuseProbe(client) !== true || this.installing) {
        return { ok: false, error: 'QEMU 尚未就绪，请先在安卓窗口完成启动或关闭后重试。' };
      }
      this.emuSerial = client.serial;
      await this.prepare(client);
      return { ok: true, client, engine: 'builtin', reused: true };
    }

    const s = this.settings;

    // 唯一路径：自带运行时
    // 单文件发行版的镜像是压缩的，先展开（已展开过就秒过）。
    // 展开失败不要把错误吞掉：否则后面 checkEnv() 只会说「还差系统镜像」，
    // 用户会以为是没下载，而不是解压失败（磁盘满 / 文件损坏）。
    await this.provisioner.materializeImages(onLog).catch((e) => {
      onLog(`系统镜像展开失败：${e.message}`);
      this.log(`materialize failed: ${e.message}`);
    });
    const env = await this.provisioner.checkEnv();

    // emulator 路径：镜像即系统，没有"安装到磁盘"这一步
    if (env.emulator.ok && env.sysimg.ok) {
      try {
        const r = await this._boot({ env, onLog });
        if (r.ok) return { ok: true, client: r.client, engine: 'emulator', profile: r.profile, network: r.network || null };
        return {
          ok: false, error: r.error, env,
          diagnosis: r.diagnosis, report: r.report, attempts: r.attempts, exitCode: r.exitCode,
        };
      } catch (e) {
        return { ok: false, error: e.message, env };
      }
    }

    // QEMU 路径（用户自备 ISO 并已装到虚拟磁盘）
    if (!s.runtime.installed) {
      return {
        ok: false,
        needsSetup: env.emulator.ok ? 'sysimg' : 'provision',
        error: env.emulator.ok
          ? '还差系统镜像：点「下载系统镜像」即可'
          : '运行时组件尚未部署完成',
        env,
      };
    }

    try {
      const r = await this._boot({ env, onLog });
      if (r.ok) return { ok: true, client: r.client, engine: 'builtin' };
      return { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /** 供设置页切换「深度裁剪」时恢复被禁用的系统包 */
  async restoreSystemApps() {
    const cmds = container.buildRestoreCommands();
    await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
    return true;
  }

  async setGuestPriority(level, identity = null) {
    if (process.platform !== 'win32') return 0;
    return this.emulator.setPriority(level, identity || await this.ownedEmulator());
  }

  // ---------------- 空闲回收 ----------------

  /**
   * 方向自愈：保证「逻辑显示空间」和「物理面板」方向一致。
   *
   * 判断依据（实机 dumpsys window displays）：
   *   init=1280x720 ... cur=1280x720   → 正常（横屏面板 + 横屏逻辑）
   *   init=1280x720 ... cur=720x1280   → 躺倒：逻辑空间被旋转了 90°
   * 一旦看到 cur 与 init 的宽高顺序相反，就说明有应用/系统把方向改回去了，
   * 此时重新锁方向并忽略应用的方向请求即可纠正，不用重启虚拟机。
   *
   * 只在真的不一致时写 settings，正常情况下每 60 秒只有一次只读 shell。
   */
  async _healOrientation() {
    if (!this.emulator || !this.emulator.running()) return;
    const wantLand = !!this.settings.display.landscape;
    const panelLand = typeof this.emulator.panelLandscape === 'function'
      ? this.emulator.panelLandscape() : null;
    // 面板方向和设置不一致 → 该重启，不是这里能修的（runLaunch.beforeStart 会处理）
    if (panelLand !== null && panelLand !== wantLand) return;
    const c = this.client();
    const out = await c.shell('dumpsys window displays', { timeout: 12000 }).catch(() => '');
    const init = /init=(\d+)x(\d+)/.exec(out);
    const cur = /cur=(\d+)x(\d+)/.exec(out);
    if (!init || !cur) return;
    const initLand = Number(init[1]) > Number(init[2]);
    const curLand = Number(cur[1]) > Number(cur[2]);
    if (initLand !== curLand) {
      // 真躺倒了：重新锁方向 + 忽略应用方向请求 + 恢复 density
      this.log(`方向自愈：init=${init[1]}x${init[2]} cur=${cur[1]}x${cur[2]} 已躺倒，重新收敛`);
      await c.resetDisplayOverrides(wantLand).catch(() => {});
      await c.setOrientation(wantLand, { sendBackKey: false }).catch(() => {});
      return;
    }
    // 没躺倒 ≠ 状态就对。平板排版依赖两个易丢的运行时状态：
    //   - mSetIgnoreOrientationRequest（横屏时必须为 true，否则面板会被应用方向带歪）
    //   - wm density 覆盖为 190（720 宽 → sw606dp ≥ 600dp 才走平板排版）
    // 这两项一旦丢失，会退回手机形态 —— 正是「平板模式不稳定」的表现。
    // 这里做一次轻量校验，缺哪个补哪个（都是幂等命令，正常情况不写）。
    const densityWanted = (this.settings.display || {}).tabletMode !== false ? 190 : null;
    let ignoreOk = true;
    if (wantLand) {
      const win = await c.shell('dumpsys window | grep -oE "mSetIgnoreOrientationRequest=(true|false)"', { timeout: 8000 }).catch(() => '');
      ignoreOk = /mSetIgnoreOrientationRequest=true/.test(String(win));
    }
    let densityOk = true;
    if (densityWanted) {
      const dens = await c.shell('wm density', { timeout: 6000 }).catch(() => '');
      // 「Override density: N」行存在且等于目标值才算对
      const m = /Override density:\s*(\d+)/.exec(String(dens));
      densityOk = !!m && Number(m[1]) === densityWanted;
    }
    if (!ignoreOk || !densityOk) {
      this.log(`显示状态收敛：ignore-orientation=${ignoreOk} density=${densityOk} → 补齐`);
      if (!ignoreOk) await c.shell('wm set-ignore-orientation-request true', { timeout: 8000 }).catch(() => {});
      // density 只在**没有应用在前台**时才补。
      // 改密度会触发配置变更 + Activity 重建，而缓存了 DisplayMetrics 的应用
      // （墨读）会按旧密度重算一遍 dp，画面缩成左上角一小块、右边全是空白 ——
      // 用户看到的就是「墨读没有填满窗口」。有应用在跑时留给下一次启动路径，
      // installer.launch 的 resetDisplayOverrides 会在 am start 之前设好。
      if (!densityOk) {
        if (this.sessionActivity?.isIdle !== false) {
          await c.shell(`wm density ${densityWanted}`, { timeout: 8000 }).catch(() => {});
        } else {
          this.log(`density=${densityWanted} 缺失但有应用在前台：跳过，等下次启动时设置（避免画面缩水）`);
        }
      }
    }
  }

  startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(async () => {
      const s = this.settings;
      // 方向自愈：应用启动 / Activity 重建 / 系统弹窗都可能把 user-rotation 或
      // 「忽略应用方向请求」改回去。一旦被改回去，横屏面板上的画面就会躺倒 90°
      // （用户说的「平板模式软件总是 90 度躺着」）。这里每轮巡检读一次真实状态，
      // 只有在**确实不一致**时才纠正，正常情况零写入。
      await this._healOrientation().catch(() => {});
      const limit = (s.engine.idleShutdownMinutes || 0) * 60000;
      if (!limit) return;
      // 接管来的模拟器没有本地 proc 句柄，vmRunning 会是 false：
      // 以前这里直接 return，导致容器永不回收。改成同时看 adb 是否在线。
      if (!this.vmRunning) {
        const online = await this.client().isOnline().catch(() => false);
        if (!online) return;
      }
      await this._stopIfIdle(limit);
    }, 60000);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  async _stopIfIdle(limit) {
    const generation = this.guestGeneration;
    const lastActivity = this.lastActivity;
    const stillIdle = () => generation === this.guestGeneration && lastActivity === this.lastActivity
      && !this.installing && this.sessionActivity?.isIdle !== false && Date.now() - lastActivity >= limit;
    if (!stillIdle()) return false;
    try {
      const resumed = await this.client().runningPackages({ strict: true });
      if (!stillIdle()) return false;
      if (resumed.some((pkg) => !IDLE_SYSTEM_PACKAGES.has(pkg))) {
        this.touch();
        return false;
      }
      // The probe is a snapshot; an app may have opened while this stop was queued.
      return await this.lifecycle.maintain(() => stillIdle() ? this._stopInner({ shouldStop: stillIdle }) : false);
    } catch (_) {
      return false; // Unreadable Android activity state is not an idle result.
    }
  }

  get vmRunning() { return this.emulator.running() || !!(this.vmProc && !this.vmProc.killed); }

  // ---------------- 诊断 / 瘦身（供 UI 调用） ----------------

  async diagnostics() {
    const env = this.provisioner.paths();
    const checked = await this.provisioner.checkEnv();
    const profile = this.emulator.profile || doctor.autoProfile({
      settings: this.settings,
      accel: checked.accel,
      emulatorVersion: checked.emulator.version || '',
      diskMB: doctor.freeDiskMB(store.DATA_DIR),
    });
    // 内存里的 attempts 只在本次会话有效；用户重启后再导出报告时它是空的。
    // 这时改用上次落盘的失败记录，并把 emulator.log 的尾部带上 —— 否则报告
    // 只有一句 UNKNOWN，看不到真正原因（issue #20/#25 都栽在这里）。
    const persisted = this.emulator.lastFailure ? this.emulator.lastFailure() : null;
    const liveAttempts = this.emulator.attempts || [];
    const attempts = liveAttempts.length ? liveAttempts : ((persisted && persisted.attempts) || []);
    const diagnosis = this.emulator.lastDiagnosis || (persisted && persisted.diagnosis) || null;
    const exitCode = this.emulator.lastExitCode != null ? this.emulator.lastExitCode
      : (persisted ? persisted.exitCode : null);
    let logLines = this.emulator.recentLog(300);
    if (!logLines.length && this.emulator.tailLogFile) logLines = this.emulator.tailLogFile(300);
    return doctor.writeReport({
      dataDir: store.DATA_DIR,
      profile,
      logLines,
      extra: {
        attempts,
        diagnosis,
        exitCode,
        exitMeaning: persisted && persisted.exitMeaning ? persisted.exitMeaning : '',
        lastFailure: persisted,
        runtimeDir: env.root,
        serial: this.emuSerial,
        bootLog: this.bootLog,
      },
    });
  }

  usage() { return require('./layers').summary(this.provisioner.paths().root); }

  /** 预览只读；实际回收时不能清理任何仍可能被运行时使用的文件。 */
  cleanup(options = {}) {
    return options.apply
      ? this.lifecycle.maintain(() => this._cleanup(options))
      : this._cleanup(options);
  }

  async _cleanup({ apply = false, aggressive = false, includeSnapshots = false } = {}) {
    const busy = () => this.vmStarting || this.installing;
    const occupied = () => this.vmRunning || ['live', 'unknown'].includes(this.avdOwner().state);
    const blocked = { ok: false, error: '无法确认安卓运行时已关闭；请先停止运行时，再进行清理。' };
    let stoppedVm = false;
    if (apply) {
      if (busy()) return blocked;
      if (occupied()) {
        if (!includeSnapshots || !await this._stopInner()) return blocked;
        stoppedVm = true;
      }
      // stop 期间状态可能变化；这里重读后同步执行删除，不保留过期的盘点状态。
      if (busy() || occupied()) return blocked;
    }
    const report = require('./layers').prune(this.provisioner.paths().root, {
      apply, aggressive, keepSnapshots: !includeSnapshots,
    });
    return { ...report, ok: true, apply, stoppedVm };
  }

  /** 停稳虚拟机与就地扩容共用生命周期队列；启动不能插在中间。 */
  resizeDataPartition(dataMB) {
    return this.lifecycle.maintain(async () => {
      if (!dataMB) {
        store.saveSettings({ engine: { dataPartitionGB: 0 } });
        return { ok: true, auto: true, ...this.emulator.dataInfo() };
      }
      const occupied = this.vmRunning || ['live', 'unknown'].includes(this.avdOwner().state);
      if (occupied && !await this._stopInner()) {
        return { ok: false, error: '无法确认旧安卓运行时已关闭，未调整数据分区。' };
      }
      store.saveSettings({ engine: { dataPartitionGB: Math.round(dataMB / 1024) } });
      const result = this.emulator.resizeDataPartition(dataMB);
      return { ...result, stopped: occupied, ...this.emulator.dataInfo() };
    });
  }

  /**
   * 彻底重置安卓数据（清空 /data 用户分区 + 已装应用 + 快速启动快照），
   * 把 AVD 还原成「刚装好系统、没有任何第三方 app」的干净状态。
   * 这一项会真实删除 8–16GB 的用户数据镜像，必须二次确认（UI 负责），且只动
   * 当前活动 AVD（apkstart.avd），不动只读基础镜像、不动其它 AVD。
   * 保留 config.ini / hardware-qemu.ini，AVD 仍有效，下次点开应用会重新冷启动建数据。
   * @returns {{ok:boolean, reclaimed:number, avdDir:string, error?:string}}
   */
  resetAndroidData({ dataPartitionGB } = {}) {
    return this.lifecycle.maintain(async () => {
      const result = await this._resetAndroidData();
      if (!result.ok || dataPartitionGB === undefined) return result;
      try {
        store.saveSettings({ engine: { dataPartitionGB } });
        return result;
      } catch (error) {
        return { ...result, ok: false, error: `安卓数据已重置，但未能保存新容量：${error.message}` };
      }
    });
  }

  async _resetAndroidData() {
    let reclaimed = 0;
    let avdDir = '';
    const busy = () => this.vmStarting || this.installing;
    const unknownGuest = () => new Error('无法确认当前安卓运行时已停止，未清除数据。请先关闭 ApkStart 的安卓窗口再重试。');
    try {
      // 清空前确认应用清单可读。不能在删除镜像后才发现清单已损坏。
      store.getApps();
      if (busy()) throw unknownGuest();
      this._retireGuest();
      const { avdHome } = this.provisioner.paths();
      avdDir = path.join(avdHome, `${AVD_NAME}.avd`);
      const root = fs.lstatSync(avdDir, { throwIfNoEntry: false }) ? fs.realpathSync(avdDir) : null;
      if (root) {
        const relative = path.relative(fs.realpathSync(avdHome), root);
        if ((process.platform === 'win32' ? relative.toLowerCase() : relative) !== `${AVD_NAME}.avd`) {
          throw new Error('安卓数据目录不在当前 AVD 位置，未清除数据');
        }
      }
      const activeOwner = () => {
        const owner = readAvdOwner(avdHome);
        if (owner.state === 'unknown') throw unknownGuest();
        return owner.state === 'live' ? owner.pid : 0;
      };
      const avdName = async (consoleClient) => (await readConsoleName(consoleClient)).toLowerCase();
      // 接管的 guest 没有本地进程句柄。用 AVD 自身的锁 PID 关联监听端口，
      // 再检查控制台名称。不能仅凭 ADB 在线或端口号调用兜底清理（它会扫其它进程）。
      const owner = activeOwner();
      const ports = (await this.emulatorPorts()).filter(isConsolePort);
      if (owner) {
        let ownedPort = 0;
        for (const port of ports) {
          if (await this.pidOnPort(port) === owner) {
            if (ownedPort) throw unknownGuest();
            ownedPort = port;
          }
        }
        if (!ownedPort) throw unknownGuest();
        const consoleClient = this.client(`emulator-${ownedPort}`);
        if (await avdName(consoleClient) !== AVD_NAME || await this.pidOnPort(ownedPort) !== owner
          || activeOwner() !== owner || busy()) throw unknownGuest();
        this.emulator.cancelSnapshotSave();
        const { stdout } = await consoleClient.exec(['emu', 'kill'], { timeout: 10000 });
        if (/^KO:/im.test(stdout)) throw unknownGuest();
        const deadline = Date.now() + 30000;
        while (processAlive(owner) || this.vmRunning) {
          if (Date.now() >= deadline) throw unknownGuest();
          await new Promise((resolve) => setTimeout(resolve, 250));
        }
        this._lastNetwork = null;
        this.sessionActivity?.guestStopped();
      } else {
        if (this.vmRunning || await this.client().isOnline()) throw unknownGuest();
        for (const port of ports) {
          // 无法判断属于哪一个 AVD 的本地控制台，不冒险删除。
          const name = await avdName(this.client(`emulator-${port}`)).catch(() => '');
          if (!name || name === AVD_NAME) throw unknownGuest();
        }
      }
      // 禁止在等待关机/识别期间有新启动者接管目标；重读等待期间可能变化的清单。
      if (busy() || this.vmRunning || activeOwner()) throw unknownGuest();
      store.getApps();
      if (root) {
        for (const e of fs.readdirSync(root, { withFileTypes: true })) {
          const p = path.join(root, e.name);
          // 只清用户数据、快照和残留锁，保留 AVD 配置与基础镜像。
          const isUserdata = isImageName(e.name);
          const isSnapshot = /^snapshots(\.stale-\d+)?$/.test(e.name);
          const isLock = /\.lock$/.test(e.name);
          if (!isUserdata && !isSnapshot && !isLock) continue;
          try {
            if ((isUserdata && !e.isFile()) || (isSnapshot && !e.isDirectory())) {
              throw new Error('条目类型不符');
            }
            let size;
            if (e.isDirectory()) {
              const target = fs.realpathSync(p);
              if (path.relative(root, target) !== e.name) throw new Error('条目不在当前 AVD 内');
              size = require('./layers').dirSize(target);
              fs.rmSync(target, { recursive: true, force: true });
            } else {
              size = fs.lstatSync(p).size;
              fs.rmSync(p, { force: true });
            }
            if (fs.lstatSync(p, { throwIfNoEntry: false })) throw new Error('条目仍存在');
            reclaimed += size;
          } catch (e2) {
            if (isUserdata || isSnapshot) {
              throw new Error(`安卓数据清理未完成，应用清单未清除：${e.name}（${e2.message}）`);
            }
          }
        }
      }
      try {
        store.saveApps([]);
      } catch (e) {
        // 磁盘操作已经执行，不应把清单写入失败误报为成功或承诺数据仍在。
        return { ok: false, reclaimed, avdDir, error: `已执行安卓数据清理，但应用清单未能更新：${e.message}` };
      }
      return { ok: true, reclaimed, avdDir };
    } catch (e) {
      return { ok: false, reclaimed, avdDir, error: e.message };
    }
  }

  /**
   * 把「已保存但不会自动连」的 AndroidWifi 连上（非破坏性，不重启、不清数据）。
   * 具体实现与实机原因见 emulator.repairWifi。
   *
   * @returns {Promise<boolean>} 是否已连上
   */
  async _networkEndpoint(startupSerial) {
    if (!startupSerial && this.vmProc) {
      const proc = this.vmProc;
      if (!await this._ownsQemuAdb(proc)) return null;
      return { client: this.client(QEMU_SERIAL), revalidate: () => this._ownsQemuAdb(proc) };
    }
    return this._emulatorGuest(startupSerial);
  }

  checkNetwork() { return this._checkNetwork(); }

  async _checkNetwork({ startupSerial, waitMs, interval } = {}) {
    const generation = this.guestGeneration;
    const current = () => generation === this.guestGeneration && (!!startupSerial || !this._networkTransitioning());
    const replaced = { ok: false, reason: 'guest-changed' };
    if (!current()) return replaced;
    const guest = await this._networkEndpoint(startupSerial);
    if (!current()) return replaced;
    if (!guest) return { ok: false, reason: 'device-offline' };
    const canProbe = async () => current() && await guest.revalidate() && current();
    const result = await this.emulator.checkNetwork(guest.client, { waitMs, interval, canProbe });
    return result.reason !== 'guest-changed' && await canProbe() ? result : replaced;
  }

  async repairWifi() {
    const generation = this.guestGeneration;
    const current = () => generation === this.guestGeneration && !this._networkTransitioning();
    if (!current()) return false;
    const guest = await this._networkEndpoint();
    if (!guest) return false;
    const canMutate = async () => current() && await guest.revalidate() && current();
    if (!await canMutate()) return false;
    const repaired = await this.emulator.repairWifi(guest.client, { canMutate }).catch(() => false);
    return repaired && await canMutate();
  }

  /**
   * 等待虚拟机联网。
   *
   * 实测：`sys.boot_completed` 只代表系统起来了，Wi-Fi 关联 + DHCP 还要再等
   * 十几秒到一分多钟才会拿到 10.0.2.16。红果这类应用一进去就拉首页数据，
   * 没网时页面渲染成一整块黑底（隐私弹窗是本地页面所以正常显示），
   * 用户看到的就是「点同意并继续之后一直黑屏」。所以拉起应用前先等网络就绪。
   *
   * @returns {Promise<{ok:boolean,reason:string,ip?:string,gateway?:string}>}
   */
  async waitForNetwork({ timeoutMs = 90000, onLog = () => {} } = {}) {
    const generation = this.guestGeneration;
    const changed = () => generation !== this.guestGeneration || this._networkTransitioning();
    const replaced = { ok: false, reason: 'guest-changed' };
    const done = (r) => {
      // An old ADB response can arrive after stop even if the next guest reuses that serial.
      if (changed()) return replaced;
      this._lastNetwork = { ok: !!(r && r.ok), ip: (r && r.ip) || '', reason: (r && r.reason) || '', at: Date.now() };
      return r;
    };
    // 速度优化：热启动 / 旋转重启后，启动路径上会连续调用本函数
    // （restartForOrientation 等一次、installer.launch 又等一次）。
    // 网络就绪是稳定的，8 秒内刚确认过就直接用结论，省掉整轮 adb 往返
    // （每次 isOnline + checkNetwork 都是两次 shell，实测要几百毫秒到 1 秒）。
    // 窗口取 8 秒：足够覆盖连续调用，又不会在真的断网后长时间骗用户。
    // 注意 stop() 会清掉 _lastNetwork，所以重启后不会误用关机前的旧状态。
    if (changed()) return replaced;
    const cached = this._lastNetwork;
    if (cached && cached.ok && Date.now() - cached.at < 8000) return cached;
    const t0 = Date.now();
    let last = null;
    let lastNotice = 0;
    let offlineSince = 0;
    let notConnectedStreak = 0;
    while (Date.now() - t0 < timeoutMs) {
      if (changed()) return replaced;
      last = await this.checkNetwork().catch(() => null);
      if (changed() || last?.reason === 'guest-changed') return replaced;
      if (last?.reason === 'device-offline') {
        // 刚重启的虚拟机会有一段时间连 adb 都还没上线，不能一看到 offline 就放弃
        // （之前就是这样：重置数据后立刻返回 device-offline，判定「修复失败」）。
        if (!offlineSince) offlineSince = Date.now();
        if (Date.now() - offlineSince > 45000) return done({ ok: false, reason: 'device-offline' });
      } else {
        offlineSince = 0;
        if (last && last.ok) return done(last);
        // `wifi-not-connected` 是「Wi-Fi 压根没关联上」，不是「关联了还在等 DHCP」。
        // 这种状态下死等超时纯属浪费：本轮开机它不会自己连上（实机上 AndroidWifi
        // 常落成「已保存但不会自动连接」）。连续几次都是这个原因就提前收工，
        // 让调用方赶紧去做真正有效的重连，别把 20 秒耗在原地。
        // 取 3 次（≈9 秒）而不是 2 次：刚开机时 Wi-Fi 本来就要几秒关联，
        // 判太早会去点设置页，反而打断它自己连上的过程。
        if (last && last.reason === 'wifi-not-connected') {
          notConnectedStreak += 1;
          if (notConnectedStreak >= 3) return done(last);
        } else {
          notConnectedStreak = 0;
        }
      }
      if (Date.now() - lastNotice > 10000) {
        lastNotice = Date.now();
        onLog(`正在等待安卓虚拟机联网… ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 3000));
    }
    return done(last || { ok: false, reason: 'timeout' });
  }

  /**
   * 修复「安卓虚拟机没有网络」。
   * 绝大多数情况只是 Wi-Fi 关联比开机完成慢，重启并等一会儿就能好，
   * **不需要**清掉用户数据；只有在等待超时后才提示用户走「重置安卓数据」。
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, error?:string}>}
   */
  /**
   * 确保虚拟机联网：先等，等不到就冷启动一次（绕开可能「没网」的快照）再等。
   * 这是「红果点同意后黑屏」的根治手段：应用一定要在网络就绪后才启动。
   *
   * @returns {Promise<{ok:boolean,reason?:string,ip?:string,gateway?:string}>}
   */
  async ensureNetwork({ onLog = () => {}, firstWaitMs = 25000, secondWaitMs = 90000 } = {}) {
    let net = await this.waitForNetwork({ onLog, timeoutMs: firstWaitMs });
    if (net?.ok || net?.reason === 'guest-changed') return net;
    // 先试便宜的办法：把「已保存但不会自动连」的 AndroidWifi 点一下。
    // 这一步比冷启动、比清数据都轻几个数量级——不重启虚拟机、不动用户数据。
    // 实机上这才是绝大多数「虚拟机没网」的真正原因（见 emulator.repairWifi 注释）。
    if (!this._wifiRepairTried) {
      this._wifiRepairTried = true;
      onLog('虚拟机连不上 Wi-Fi，正在尝试重新连接…');
      try {
        const fixed = await this.repairWifi();
        if (fixed) {
          net = await this.waitForNetwork({ onLog, timeoutMs: 15000 });
          if (net && net.ok) {
            onLog(`网络已恢复（${net.ip || ''}），正在保存可用状态，下次直接就好。`);
            try { await this.saveOwnedSnapshot(90000); } catch (_) { /* ignore */ }
            return net;
          }
        }
      } catch (_) { /* 修复失败就走下面的重路径 */ }
    }
    // 冷启动很贵（几十秒），一个进程里只做一次：否则每次点开应用都要重来一遍，
    // 用户感受到的就是「点开要等好几分钟」。
    if (this._netColdBootTried) return net;
    this._netColdBootTried = true;
    onLog('网络仍未就绪，正在冷启动一次虚拟机（不加载快照）后重试…');
    try {
      const boot = await this.lifecycle.restart({
        graceful: false, onLog, beforeBoot: () => this.emulator.forceColdBootOnNextStart(),
      });
      if (!boot.ok) return { ok: false, reason: boot.reason === 'stop-failed' ? 'owner-still-running' : 'boot-failed' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    net = await this.waitForNetwork({ onLog, timeoutMs: secondWaitMs });
    if (net && net.ok) {
      // 网络正常后立刻存快照，下次恢复时网卡状态一起还原
      try { await this.saveOwnedSnapshot(90000); } catch (_) { /* ignore */ }
    }
    return net;
  }

  /**
   * 修复「安卓虚拟机没有网络」。
   * 只重连 Wi-Fi 或冷启动。重置数据必须另走显式确认的操作。
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, wiped?:boolean, error?:string}>}
   */
  async repairNetwork({ onLog = () => {} } = {}) {
    try {
      // 阶梯式修复，从最便宜的开始，能不丢数据就绝不丢：
      //   1) 重新连一次 Wi-Fi（不重启、不动数据）
      //   2) 冷启动（不加载快照，仍不动数据）
      onLog('正在修复虚拟机网络：先尝试重新连接 Wi-Fi（不影响已装应用）…');
      if (!this.vmRunning) {
        const boot0 = await this.ensure({ onLog });
        if (!boot0 || !boot0.ok) {
          return { ok: false, error: (boot0 && boot0.error) || '虚拟机没能启动', boot: false };
        }
      }
      this._wifiRepairTried = true;
      let fixed = false;
      try { fixed = await this.repairWifi(); } catch (_) { fixed = false; }
      if (fixed) {
        const net1 = await this.waitForNetwork({ onLog, timeoutMs: 30000 });
        if (net1 && net1.ok) {
          try { await this.saveOwnedSnapshot(90000); } catch (_) { /* ignore */ }
          onLog(`网络已恢复（${net1.ip || ''}），已存好可用快照。`);
          return { ok: true, network: net1, boot: true, wiped: false };
        }
      }
      // 第 2 步：冷启动，绕开可能「没网」的快照
      onLog('重新连接没成功，正在冷启动一次虚拟机（不加载快照，数据保留）…');
      const boot = await this.lifecycle.restart({
        graceful: false, onLog,
        beforeBoot: async () => {
          await new Promise((r) => setTimeout(r, 2500));
          this.emulator.forceColdBootOnNextStart();
        },
      });
      if (!boot || !boot.ok) {
        return { ok: false, error: (boot && boot.error) || '虚拟机没能启动', boot: false };
      }
      const network = await this.waitForNetwork({ onLog, timeoutMs: 90000 });
      if (network && network.ok) {
        try { await this.saveOwnedSnapshot(90000); } catch (_) { /* ignore */ }
        onLog(`网络已恢复（${network.ip || ''}），已存好可用快照。`);
        return { ok: true, network, boot: true, wiped: false };
      }

      // 自动诊断也会调用这个入口，不能把网络失败变成清空用户数据。
      return {
        ok: false, network, boot: true, wiped: false,
        error: '网络仍未恢复，安卓数据未改动。请先检查 Windows 网络、防火墙或代理；确需重置时，请备份后单独选择「重置安卓数据」。',
      };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  dispose() {
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._client && this._client.disposeInput) this._client.disposeInput();
    // 后端适配层只有自带运行时；dispose 只做自己的清理，不会去动任何外部模拟器
    if (this._backend && this._backend.dispose) {
      try { this._backend.dispose(); } catch (_) { /* ignore */ }
    }
    this.emulator.cancelSnapshotSave();
    // 这里【绝对不能】强杀 qemu：
    //  1) 强杀会把正在写盘的 quickboot 快照截断，只留下几 GB 的 ram.img 空壳，
    //     下次开机加载失败 → 全量冷启动，这就是「每次打开都要等两分钟」的直接原因；
    //  2) 留着它，下次打开 ApkStart 可以直接接管，点应用秒开（WSA / 应用宝电脑版同款行为）。
    // 卸载时另走一条路（app:removeSelf 会显式清理进程）。
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
  }

  get bootLog() { return this._bootLog.slice(-60); }
}

module.exports = { Runtime, MONITOR_PORT };
