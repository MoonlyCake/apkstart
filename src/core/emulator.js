'use strict';
/**
 * Emulator 引擎：驱动 Google 官方 Android Emulator 作为 ApkStart 的运行时。
 *
 * 与旧版最大的不同：这里不再假设「一套参数在所有电脑上都能跑」。
 *  1. 用 doctor.chooseProfile() 按内存/CPU/磁盘/加速状态/引擎版本自动推导参数；
 *  2. 启动失败时按 planVariants() 自动降级重试（GPU 后端 → 软件模拟 → 最小内存冷启动）；
 *  3. 动态挑空闲端口、清 AVD 锁、中文路径转短路径、镜像变更后自动作废快照；
 *  4. quickboot 快照 + 小数据分区，做到「像容器一样」共享只读基础层、秒级恢复。
 *
 * probe 回调由上层（Runtime）提供，用于判断 Android 是否真正就绪。
 */
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('./store');
const { Provisioner } = require('./provision');
const doctor = require('./doctor');
const drivers = require('./drivers');
const userdata = require('./userdata');
const audio = require('./audio-policy');
const { adbEnvironment, resolveAdbPort } = require('./adb');
const { AVD_NAME, readAvdOwner } = require('./runtime-ownership');
const SNAPSHOT_NAME = 'apkstart';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Windows 上把 emulator/qemu 的退出码翻译成人话。
 * 0xC0000005（3221225477）是崩溃里最常见的那个：访问冲突，实测多由
 * 显卡驱动 / Vulkan 后端在 guest 启动瞬间崩掉引起，换软件渲染即可绕过。
 */
function describeExitCode(code) {
  // 被信号结束时 code 是 null（Windows 上走 taskkill / adb emu kill 都会这样），
  // 不能当成 0 报「正常退出」，但也谈不上异常，返回空串让调用方原样显示。
  if (code == null) return '';
  switch (Number(code)) {
    case 0: return '正常退出';
    case 1: return '启动参数或环境错误';
    case 3221225477: return '0xC0000005 访问冲突，渲染后端崩溃';
    case 3221225725: return '0xC00000FD 栈溢出';
    // 0xC0000135 只说明「某个依赖 DLL 没加载成功」，不能据此断定是 VC++ 没装
    // 或杀毒删文件：商店版从 WindowsApps 只读目录拉起子进程时同样会报这个码。
    // 具体是哪个 DLL，要看 WER 的 FaultingModuleName，别在 UI 上替用户下结论。
    case 3221225781: return '0xC0000135 依赖 DLL 加载失败（原因待查，见内置手册 6.8）';
    case 3221225506: return '0xC0000022 拒绝访问（驱动或权限问题）';
    case 3221225595: return '0xC000007B 镜像位数不匹配或 DLL 损坏';
    default: return '';
  }
}

class EmulatorEngine {
  constructor(appRoot, { provisioner = new Provisioner(appRoot) } = {}) {
    this.appRoot = appRoot;
    this.provisioner = provisioner;
    this.proc = null;
    this._log = [];
    this.port = 5554;
    this.adbPort = resolveAdbPort();
    this.profile = null;
    this.attempts = [];
    this.lastDiagnosis = null;
    this.lastExitCode = null;
    /**
     * 本次开机生效的驱动（兼容补丁）效果，以及命中的驱动清单。
     * 由 start() 里的 _resolveDrivers() 填；buildArgs / env / ensureAvd 只读它。
     */
    this._driverEffect = null;
    this._driversApplied = [];
    // 快照的 ram.bin ≈ 分配给虚拟机的内存（2-4GB）。
    // 冷启动本来就快的机器不该为它付出几个 GB 的磁盘，只在「真慢」时才保存。
    this.snapshotWorthSaving = null;
  }

  log(line) {
    this._log.push({ t: Date.now(), line });
    if (this._log.length > 600) this._log.shift();
  }

  get settings() { return store.getSettings(); }

  /**
   * 把「最后一次启动失败」落盘。
   * 旧版只放在内存里（this.attempts），用户重启 ApkStart 后再导出诊断报告，
   * 报告里就是 attempts: []、bootLog: [] 一片空白，只能在日志里翻 —— 这也是
   * issue #20/#25 里「附了报告却看不出原因」的直接原因。
   */
  _persistFailure(extra = {}) {
    try {
      const dir = path.join(store.DATA_DIR, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const data = {
        at: new Date().toISOString(),
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
        diagnosis: this.lastDiagnosis,
        attempts: this.attempts,
        ...extra,
      };
      fs.writeFileSync(path.join(dir, 'last-failure.json'), JSON.stringify(data, null, 2), 'utf8');
    } catch (_) { /* 落盘失败不影响主流程 */ }
  }

  /** 读回上一次失败记录（诊断报告 / 开机前提示用） */
  lastFailure() {
    try {
      return JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), 'utf8'));
    } catch (_) { return null; }
  }

  _clearFailure() {
    try { fs.rmSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), { force: true }); } catch (_) { /* ignore */ }
  }

  get serial() { return `emulator-${this.port}`; }

  /** emulator.exe 与系统镜像目录（优先用户运行时目录，回退到仓库内 engine/） */
  locate() {
    const p = this.provisioner.paths();
    const emuCandidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    const emulatorExe = emuCandidates.find((c) => fs.existsSync(c)) || '';
    const img = this.provisioner.systemImageInfo();
    return { emulatorExe, sysImgDir: img.dir, sysImgOk: img.ok, root: emulatorExe ? path.dirname(path.dirname(emulatorExe)) : p.root };
  }

  _configuredImage(avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`)) {
    try {
      const config = fs.readFileSync(path.join(avdDir, 'config.ini'), 'utf8');
      const tag = /^tag\.id=(.+)$/m.exec(config)?.[1].trim();
      const image = /^image\.sysdir\.1=(.+)$/m.exec(config)?.[1].trim();
      return { tag, id: doctor.imageIdentity(image) };
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  _hasUserData(avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`)) {
    try { return fs.readdirSync(avdDir).some(userdata.isImageName); }
    catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
  }

  canUseCompatImage() {
    if (!this._hasUserData()) return true;
    const current = this._configuredImage();
    const play = this.provisioner.playImageInfo();
    return !!current?.id && current.id === doctor.imageIdentity(play.dir);
  }

  /** 下载了另一份镜像不代表同意迁移数据，已有 AVD 先继续用原来的镜像。 */
  imageChoice() {
    const play = this.provisioner.playImageInfo();
    const current = this._configuredImage();
    const playId = doctor.imageIdentity(play.dir);
    const compatible = { compat: true, api: play.api, tag: play.tag, dir: play.dir, abi: 'x86_64' };
    if (current?.id && current.id !== playId && this._hasUserData()) {
      const pinned = this.provisioner.systemImageInfo({ imageId: current.id });
      if (pinned.ok && doctor.imageIdentity(pinned.dir) === current.id) {
        return { compat: false, api: pinned.api, tag: pinned.tag, dir: pinned.dir, abi: pinned.abi || this.provisioner.paths().sysAbi };
      }
    }
    if (play.ok) return compatible;
    const base = this.provisioner.systemImageInfo();
    return { compat: false, api: base.api, tag: base.tag, dir: base.dir, abi: base.abi || this.provisioner.paths().sysAbi };
  }

  /**
   * 作废 quickboot 快照。
   * 快照同时保存内存和磁盘镜像，装完新应用/清了数据后如果还加载旧快照，
   * 用户会看到「刚刚装好的应用重启后又不见了」。
   */
  invalidateSnapshot() {
    this.cancelSnapshotSave();
    this._snapSaved = false;
    try {
      const snapDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots');
      fs.rmSync(snapDir, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  _avdOwner() {
    return readAvdOwner(this.provisioner.paths().avdHome);
  }

  _assertAvdWritable() {
    const { state } = this._avdOwner();
    // 不删模拟器持有的锁；已退出进程留下的锁由 Android Emulator 回收。
    if (state === 'live' || state === 'unknown') {
      throw new Error('ApkStart 安卓运行时仍占用数据目录，或无法确认锁归属；请先关闭该运行时再试。');
    }
  }

  /**
   * AVD 目录里是否真的有一份**完整**的 quickboot 快照。
   * 只判断「目录非空」是不够的：保存被中断时会留下一个只有 12 字节 snapshot.pb 的空壳，
   * emulator 会尝试加载、失败（日志 "does not have the requested snapshot"）再回退冷启动，
   * 白等几秒。这里按文件大小校验，顺手清掉空壳和旧版遗留的 default_boot（单个 3GB）。
   */
  hasSnapshot() {
    const base = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME);
    const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
    const pb = size(path.join(base, 'snapshot.pb'));
    // 新版 emulator（37.x）写的是 ram.bin，老版本写 ram.img。
    // 只认 ram.img 的后果非常严重：刚存好的 3GB 快照会被当成空壳删掉，
    // 于是每次都带 -no-snapshot-load，永远冷启动 —— 这是「打开很慢」的一半原因。
    const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
    if (pb > 1024 && ram > 1024 * 1024) return true;
    if (pb === 0 && ram === 0) return false;   // 目录本来就没有，别白删
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    this._cleanLegacySnapshots();
    return false;
  }

  /** 清掉旧版遗留/失败重命名留下的快照目录（default_boot 里的 ram.img 可达 3GB） */
  _cleanLegacySnapshots() {
    const dir = path.dirname(path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME));
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (name === SNAPSHOT_NAME) continue;
      if (/^default_boot$|\.stale-\d+$/i.test(name)) {
        try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    }
  }

  /**
   * 当前 AVD 面板是横的还是竖的。
   *
   * 为什么要问这个：横屏**只能靠物理面板**实现 —— `wm size` 只改逻辑分辨率，画面会
   * 躺倒 90°；`adb emu rotate` 只转内容，系统里还是竖屏。真正生效的是
   * `hw.lcd.width/height` 互换 + 重启。而 config.ini 是每次开机时按当时的设置写的，
   * 所以读它就知道**现在跑着的这台**是什么方向。
   *
   * @returns {boolean|null} true=横屏面板，false=竖屏面板，null=读不到
   */
  panelLandscape() {
    try {
      const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
      const cfg = fs.readFileSync(path.join(avdDir, 'config.ini'), 'utf8');
      const w = Number((/^hw\.lcd\.width=(\d+)$/m.exec(cfg) || [])[1]);
      const h = Number((/^hw\.lcd\.height=(\d+)$/m.exec(cfg) || [])[1]);
      if (!w || !h) return null;
      return w > h;
    } catch (_) {
      return null;
    }
  }

  /**
   * 给界面/诊断用的驱动报告：这次开机用了哪些、跳过了哪些、为什么。
   * @returns {{ applied:Array, effect:object|null, errors:Array, host:object|null }}
   */
  driverReport() {
    const pick = (d) => ({
      id: d.id, name: d.name, version: d.version, author: d.author || '',
      description: d.description || '', priority: d.priority, hits: d.hits || [],
      dir: d.dir || '', file: d.file || '',
    });
    return {
      applied: (this._driversApplied || []).map(pick),
      effect: this._driverEffect ? {
        gpuMode: this._driverEffect.gpuMode,
        forceTcg: this._driverEffect.forceTcg,
        notes: this._driverEffect.notes || [],
        ini: this._driverEffect.ini || {},
        env: this._driverEffect.env || {},
        args: (this._driverEffect.args || []).map((a) => (a.value ? `${a.flag}=${a.value}` : a.flag)),
      } : null,
      errors: this._driverErrors || [],
      host: this._driverHost || null,
    };
  }

  /**
   * 把驱动声明的 config.ini 覆盖项套到默认配置上。
   * 已存在的键就地替换（不产生重复行），不存在的追加在后面。
   * 只处理 drivers.js 白名单里的键，非法键在校验阶段就被拒了。
   */
  _iniWithDrivers(text) {
    const over = (this._driverEffect && this._driverEffect.ini) || {};
    const keys = new Set(Object.keys(over).filter((key) => !audio.isAudioIniKey(key)));
    if (!keys.size) return text;
    const seen = new Set();
    const out = String(text).split('\n').map((line) => {
      const m = /^([A-Za-z0-9_.]+)=/.exec(line);
      if (!m || !keys.has(m[1])) return line;
      seen.add(m[1]);
      return `${m[1]}=${over[m[1]]}`;
    });
    for (const k of keys) if (!seen.has(k)) out.push(`${k}=${over[k]}`);
    return out.join('\n');
  }

  /**
   * 读一遍驱动目录，挑出匹配这台机器的，存成本次开机的效果。
   *
   * 目录顺序即优先级：内置示例（只读，默认 enabled:false）在前，用户驱动在后，
   * 同 id 时用户目录覆盖内置 —— 用户改了示例就能直接生效，不用改安装目录。
   *
   * @returns {{ applied:Array, skipped:Array, errors:Array } | null}
   */
  _resolveDrivers({ accel, emulatorVersion }) {
    const s = this.settings || {};
    const disabled = (s.drivers && s.drivers.disabled) || [];
    const state = (s.drivers && s.drivers.state) || {};
    let gpuName = '';
    let osBuild = 0;
    try {
      const release = require('os').release() || '';
      const m = /(\d+)\s*$/.exec(release);
      osBuild = m ? Number(m[1]) : 0;
    } catch (_) { /* 拿不到就当 0，匹配条件里带 osBuild 的驱动不会生效 */ }
    const host = drivers.hostContext({
      info: { ...doctor.hostInfo(), cpuVendor: (require('os').cpus() || [])[0]?.model || '' },
      gpuVendor: doctor.detectGpuVendor(),
      gpuName,
      osBuild,
      accel: accel && accel.ok ? (accel.kind || 'whpx') : 'none',
      emulatorVersion,
    });
    const loaded = drivers.loadAll([
      drivers.bundledDir(this.appRoot),
      drivers.userDir(store),
    ]);
    const r = drivers.resolve({ drivers: loaded.drivers, host, disabled, state });
    this._driverEffect = r.effect;
    this._driversApplied = r.applied;
    this._driverErrors = loaded.errors;
    this._driverHost = host;
    return { ...r, errors: loaded.errors, host };
  }

  /**
   * 准备 AVD：写 config.ini。每次启动按当前自动配置重写，保证降级重试即时生效。
   */
  ensureAvd({
    memoryMB = 2048, cores = 2, gpu = 'software', dataMB = 4096,
    heapMB = 256, accel = 'auto', snapshot = true, wipe = false, lcd = null,
    audioPolicy = audio.resolve(this.settings?.engine),
  } = {}) {
    const p = this.provisioner.ensureDirs();
    const home = p.avdHome;
    const avdDir = path.join(home, `${AVD_NAME}.avd`);
    this._assertAvdWritable();
    fs.mkdirSync(avdDir, { recursive: true });

    // 屏幕分辨率：有硬件加速时 720x1280@320 画面清晰、文字不糊；
    // 纯软件模拟时降到 540x960，帧率优先（面积只有 56%，肉眼差距远小于流畅度差距）。
    const screen = lcd || doctor.lcdFor({ accelOk: this.profile ? this.profile.accelOk : accel !== 'off' });

    const choice = this.imageChoice();
    const tag = choice.tag;
    const api = choice.api;
    const tagDisplay = choice.compat ? 'Google Play (ARM 兼容)' : 'AOSP';

    const cfgPath = path.join(avdDir, 'config.ini');
    const wantImg = choice.dir
      ? `${choice.dir.replace(/\\/g, '/')}/`
      : `system-images/android-${api}/${tag}/${choice.abi}/`;
    const previous = this._configuredImage(avdDir);
    const hadConfig = previous !== null;
    const changed = (previous?.tag && previous.tag !== tag)
      || (previous?.id && previous.id !== doctor.imageIdentity(wantImg));
    if ((changed || !previous?.id) && this._hasUserData(avdDir)) {
      // Keep both the data and its original config intact until the user explicitly resets.
      throw Object.assign(new Error('无法用新安卓镜像打开现有数据。请恢复原镜像；确需换镜像时，先备份再从设置里明确重置安卓数据。'), {
        code: 'AVD_IMAGE_CHANGE_REQUIRES_RESET',
      });
    }
    this.wipePending = !!changed;
    fs.writeFileSync(
      path.join(home, `${AVD_NAME}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir.replace(/\\/g, '/')}\ntarget=android-${api}\n`,
    );

    // 配置指纹变化 → 旧 quickboot 快照必然加载失败或产生黑屏，主动作废。
    // 注意：这里只作废**快照**，绝不能顺手 -wipe-data —— 用户数据里是已装的应用和存档。
    const key = `${doctor.snapshotKey({
      dataMB, emulatorVersion: this._emuVersion || '', api, tag,
    }, choice.dir)}|${screen.w}x${screen.h}@${screen.dpi}|${audioPolicy.key}`;
    const keyFile = path.join(avdDir, 'snapshot.key');
    let prevKey = '';
    try { prevKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { /* 首次 */ }
    const snapshotStale = !!((prevKey || hadConfig) && prevKey !== key);
    let snapshotCleared = true;
    if (this.wipePending || snapshotStale || wipe) {
      // 删除可能被系统/安全软件拦截（快照目录常有几个 GB）。
      // 失败就改名让 emulator 不再加载它，绝不因为清理失败而中断启动。
      const snapDir = path.join(avdDir, 'snapshots');
      try {
        fs.rmSync(snapDir, { recursive: true, force: true });
      } catch (_) {
        try { fs.renameSync(snapDir, `${snapDir}.stale-${Date.now()}`); } catch (__) {
          // 旧快照仍在原位：本次不能加载，也不要用新指纹标记它。
          // 下次准备 AVD 时再尝试清理。
          snapshotCleared = false;
          this._coldBoot = true;
        }
      }
    }
    // 只有「镜像换了」（tag / sysdir 变化）才需要 -wipe-data：旧 userdata 与新镜像
    // 的 APEX 不兼容，不重建会一直卡在引导循环。改容量 / 改分辨率 / 换渲染后端都不算。
    if (snapshotCleared) fs.writeFileSync(keyFile, key, 'utf8');

    // hw.cpu.arch 必须是 ABI 本身（x86_64 不能截成 x86）
    const cpuArch = choice.abi === 'arm64-v8a' ? 'arm64'
      : choice.abi === 'armeabi-v7a' ? 'arm' : choice.abi;

    const cfg = [
      `AvdId=${AVD_NAME}`,
      'avd.ini.displayname=ApkStart',
      'avd.ini.encoding=UTF-8',
      `abi.type=${choice.abi}`,
      `hw.cpu.arch=${cpuArch}`,
      `hw.cpu.ncore=${cores}`,
      `hw.ramSize=${memoryMB}`,
      `vm.heapSize=${heapMB}`,
      `image.sysdir.1=${wantImg}`,
      `tag.id=${tag}`,
      `tag.display=${tagDisplay}`,
      // 旧版写死 16G，会在小硬盘/配额环境下生成巨型文件并拖慢首次开机
      `disk.dataPartition.size=${dataMB}M`,
      'hw.gpu.enabled=yes',
      `hw.gpu.mode=${gpu}`,
      'hw.keyboard=yes',
      // 虚拟 Wi-Fi 必须显式打开。API 34 的 Play Store 镜像上网走的是
      // wlan0（netsim 虚拟网卡），不是早期的 eth0。config.ini 里少了这一行，
      // 模拟器就不会给 wlan0 建链路——表现是 wlan0 一直 NO-CARRIER、
      // `dumpsys connectivity` 显示 Active default network: none，应用里就是
      // 一直「网络错误，请稍后再试」。命令行的 -netdelay/-netspeed/-dns-server
      // 都只是 QEMU 用户态 NAT 的参数，跟 guest 内部的网卡有没有被拉起来无关。
      'hw.wifi=yes',
      'hw.lcd.width=' + screen.w,
      'hw.lcd.height=' + screen.h,
      'hw.lcd.density=' + screen.dpi,
      'hw.mainKeys=no',
      'ShowDeviceFrame=no',
      `PlayStore.enabled=${choice.compat}`,
      // 快照完全由命令行 -snapshot apkstart 控制：用独立名字，绝不误加载
      // 旧版遗留的 default_boot（那是 API30 镜像的内存状态，加载必进引导循环）。
      'hw.sdCard=no',
      ...audioPolicy.ini,
      'hw.camera.back=none',
      'hw.camera.front=none',
      'hw.gps=no',
      // 方向/加速度传感器必须关：一旦开启，Android 会按传感器自动旋转，把竖屏
      // 内容转成横的（画面整体躺倒 90°、文字竖着、四周黑边）。排版切换现在只靠
      // wm density（改 smallestWidth），不需要也不允许传感器参与。
      'hw.sensors.orientation=no',
    ].join('\n') + '\n';
    fs.writeFileSync(cfgPath, this._iniWithDrivers(cfg));

    // /data 分区必须先「真的能用」，否则后面一切都是白等（见 ensureDataPartition 注释）
    const data = this.ensureDataPartition(avdDir, dataMB);

    return {
      home, avdDir, ini: path.join(home, `${AVD_NAME}.ini`), image: choice,
      wipePending: this.wipePending, screen, data,
    };
  }

  /**
   * 保证 userdata 分区是一个**真正可用**的 ext4 —— 这是「点开应用 30 秒进桌面」的地基。
   *
   * 为什么必须自己做（三条都是实测踩出来的）：
   *  1. 系统镜像包里的 userdata.img 是 1MB 全零占位，真正格式化靠 avdmanager 调 SDK 的
   *     mke2fs。ApkStart 直接写 config.ini 拉 emulator，跳过那一步 → /data 全零 →
   *     内核 "Invalid ext4 superblock on /dev/block/vdc" → guest 掉进 recovery 重启循环 →
   *     adbd 永远不上线 → 上层 probe 一直 pending，最后 240s 超时。原表现：点开要等好几分钟。
   *  2. emulator 自带的 e2fsck/resize2fs 是 cygwin 版 e2fsprogs 1.42.12，**不认识 encrypt
   *     特性**，带这个位它直接 exit 8 拒绝干活，所以「扩文件系统」必须排在补位之前。
   *  3. 文件系统必须 ≥ 分区大小：只给 64MB 的话，APEX 解压 + dexopt 立刻写满，
   *     之后所有 setxattr 返回 ENOSPC → SELinux 标签写不进去 → netd/media/tombstoned
   *     一起 exit 1 → 开机卡在启动动画，adb 永远 offline。
   */
  ensureDataPartition(avdDir, dataMB = 4096) {
    const emulatorExe = this.locate().emulatorExe;
    if (!emulatorExe || !fs.existsSync(emulatorExe)) return { ok: false, reason: 'no-emulator' };
    try { fs.mkdirSync(avdDir, { recursive: true }); } catch (_) { /* ignore */ }
    const emuDir = path.dirname(emulatorExe);
    const img = path.join(avdDir, 'userdata-qemu.img');
    const wantBytes = Math.max(1024, Math.round(dataMB || 4096)) * 1024 * 1024;
    let size = 0;
    try { size = fs.statSync(img).size; } catch (_) { /* 不存在 */ }

    if (size > 0 && userdata.hasExt4Superblock(img)) {
      // 文件够大 + 文件系统也真的长到了这个大小，才算「不用动」。
      // 只看文件大小会漏掉一种真实故障：qemu-img 撑开了文件、resize2fs 却失败了，
      // 于是文件 6GB、安卓只有 64MB —— 用户看到的就是「装游戏说空间不足」。
      const fsBytes = userdata.fsBytes(img);
      const fsOk = fsBytes >= Math.min(size, wantBytes) * 0.95;
      if (size >= wantBytes && fsOk) return { ok: true, created: false, size, fsBytes };
      // 容量配置变大了（或文件系统没长到位）：就地扩容，不重建、保留已装应用
      try {
        userdata.clearEncryptFlag(img);
        if (size < wantBytes) this._qemuImg('resize', img, wantBytes);
        this._resize2fs(img);
        userdata.setEncryptFlag(img);
        const grown = userdata.fsBytes(img);
        this.log(`userdata 扩容：文件 ${size} → ${wantBytes}，文件系统 ${fsBytes} → ${grown}`);
        return { ok: true, created: false, grown: true, size: wantBytes, fsBytes: grown };
      } catch (e) {
        this.log(`扩容 userdata 失败（继续用现有分区）：${e.message}`);
        // 老分区仍然可用，但必须如实告诉调用方「这次没扩成」，不能让设置页显示成功
        return { ok: false, created: false, size, fsBytes, error: e.message };
      }
    }

    // 首次 / 旧版留下的全零占位 / 镜像损坏：全新造一个
    try {
      fs.rmSync(img, { force: true });
      fs.rmSync(`${img}.qcow2`, { force: true });
      // 先不带 encrypt 位（老 e2fsck/resize2fs 才肯干活）
      fs.writeFileSync(img, userdata.buildEmptyExt4({ sizeMB: 64, encrypt: false }));
      this._qemuImg('resize', img, wantBytes);
      this._resize2fs(img);
      userdata.setEncryptFlag(img);
      this.log(`已重建 userdata：${(wantBytes / 1024 / 1024 / 1024).toFixed(1)}GB ext4（4K block，支持 FBE）`);
      return { ok: true, created: true, size: wantBytes };
    } catch (e) {
      // 尽力而为：哪怕扩容失败，也要把 encrypt 位补回去，让 FBE 能初始化（分区会偏小）
      try { userdata.setEncryptFlag(img); } catch (_) { /* ignore */ }
      this.log(`重建 userdata 失败：${e.message}`);
      return { ok: false, created: true, error: e.message };
    }
  }

  /** emulator 自带 qemu-img.exe：把原始镜像文件撑到目标大小（稀疏，瞬间完成）
   *  注意参数顺序：`qemu-img <命令> -f raw <文件> <大小>`。
   *  把 -f 放命令前面会被它当成全局参数直接报 unrecognized option。 */
  _qemuImg(op, ...rest) {
    const exe = path.join(path.dirname(this.locate().emulatorExe), 'qemu-img.exe');
    const r = spawnSync(exe, [op, '-f', 'raw', ...rest], {
      cwd: path.dirname(exe), windowsHide: true, encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`qemu-img ${op} 失败: ${(r.stderr || '').trim() || r.status}`);
  }

  /** emulator 自带 resize2fs.exe（cygwin 版，必须在 bin64 目录下跑才能找到 DLL） */
  _resize2fs(img) {
    const bin = path.join(path.dirname(this.locate().emulatorExe), 'bin64');
    const exe = path.join(bin, 'resize2fs.exe');
    if (!fs.existsSync(exe)) throw new Error('缺少 resize2fs.exe');
    const r = spawnSync(exe, [img], {
      cwd: bin, windowsHide: true, encoding: 'utf8', timeout: 180000,
    });
    if (r.status !== 0) throw new Error(`resize2fs 失败: ${(r.stderr || '').trim() || r.status}`);
  }

  /** emulator 依赖这些环境变量定位 SDK / AVD；中文路径一律转 8.3 短路径 */
  env(root, plan = {}) {
    const safeRoot = doctor.shortPath(root);
    // AVD 目录必须与 provisioner.paths().avdHome 一致：bundled 只读运行时（EXE 旁
    // resources/runtime）时 root/avd 不存在也不可写，AVD 要落到用户数据目录。
    const avdHome = doctor.shortPath(this.provisioner.paths().avdHome);
    const adbPort = plan.adbPort ?? this.adbPort;
    const env = adbEnvironment(adbPort, {
      ...process.env,
      ANDROID_EMULATOR_USE_SYSTEM_LIBS: '',
      ...(plan.accel === 'off' ? { ANDROID_I_WANT_MY_TCG: 'yes' } : {}),
      ...this._driverEffect?.env,
    });
    // 驱动可调整渲染，但不能更改归属检查使用的 SDK/AVD 目录。
    for (const key of Object.keys(env)) {
      if (/^ANDROID_(SDK_ROOT|HOME|AVD_HOME|EMULATOR_HOME)$/i.test(key)) delete env[key];
    }
    return Object.assign(env, {
      ANDROID_SDK_ROOT: safeRoot, ANDROID_HOME: safeRoot,
      ANDROID_AVD_HOME: avdHome, ANDROID_EMULATOR_HOME: avdHome,
    });
  }

  /**
   * 要注入的系统语言。默认简体中文；用户可在设置里改（engine.locale），
   * 设成 'en-US' 或 'off' 就回到镜像原生英文。
   */
  _guestLocale() {
    const v = String(this.settings?.engine?.locale || 'zh-CN').trim();
    if (!v || v === 'off' || /^false$/i.test(v)) return '';
    return v;
  }

  buildArgs({
    headless = true, accel = 'auto', port = 5554,
    gpu = 'software', memoryMB = 2048, cores = 2,
    snapshot = true, wipe = false, lcd = null,
    audioPolicy = audio.resolve(this.settings?.engine),
  } = {}) {
    // 驱动可以固定渲染后端 / 强制软件模拟。放在最前面算进 gpu/accel，
    // 这样后面所有逻辑（-accel off、config.ini 的 hw.gpu.mode）都跟着它走。
    const eff = this._driverEffect || null;
    const drvGpu = eff ? drivers.gpuModeToArg(eff.gpuMode) : '';
    if (drvGpu) gpu = drvGpu;
    if (eff && eff.forceTcg) accel = 'off';
    const args = [
      '-avd', AVD_NAME,
      '-port', String(port),
      ...audioPolicy.args,
      '-no-boot-anim',
      '-no-metrics',
      // 关掉崩溃上报：一旦历史崩溃报告存在，emulator 会弹「同意上传」模态框，
      // 主线程被卡住、永远不开机（日志表现为 Showing crashdialog to get consent）。
      '-crash-report-mode', 'disabled',
      '-gpu', gpu,
      // AMD + emulator 37.x：host 后端的 Vulkan 初始化会失败，进程起来十几秒
      // 后直接 exit 1，于是被记成「host 不可用」永久退回 swangle（软件渲染），
      // 视频/滑动全都掉帧。关掉 Vulkan 让它走 GL，才能真的吃到硬件加速。
      // 软件后端本来就不用 Vulkan，加上只会多一层不确定性，所以只对 host 生效。
      ...(gpu === 'host' && process.platform === 'win32' && doctor.detectGpuVendor() === 'amd'
        ? ['-feature', '-Vulkan'] : []),
      '-memory', String(memoryMB),
      '-cores', String(cores),
    ];
    // 网络：AOSP 模拟器默认走 QEMU 用户态 NAT（-netdev user），安卓侧拿到
    // 10.0.2.x 的虚拟地址，出口直接复用主机的物理网卡 NAT 出去。
    // 这种模式【不会】在 Windows 上创建任何虚拟网卡 / 虚拟交换机
    // （那必须 -netdev tap 或桥接才会发生，我们全程不启用）。
    // 所以安卓应用用的是"一台挂在主机 NAT 后面的设备"，主机网络栈完全不动，
    // 不需要装驱动、也不多一个网络适配器。
    // 显式声明不限速：默认值虽然是 full，但某些 -gpu / -net 组合下会被带上
    // 模拟器的保守配置，视频类应用（红果、抖音）首屏就会明显慢半拍。
    args.push('-netdelay', 'none', '-netspeed', 'full');
    // 系统语言：默认简体中文。
    // 实测 `-prop persist.sys.locale=zh-CN` 完全无效 —— 模拟器会拦截 persist.sys.*
    // 这类受保护属性，ro.product.locale 又被镜像 build.prop 覆盖；guest 里 getprop
    // 一个都看不到。官方专门给了 -change-locale：它会真正改系统语言并重启 framework，
    // 且会写进 /data，从快照恢复也能保留。
    // 用户可在设置里改成其它 locale 或关掉（engine.locale='off'）。
    const locale = this._guestLocale();
    if (locale) args.push('-change-locale', locale);
    // DNS：安卓默认用 10.0.2.3（转发到主机 DNS）。主机走 VPN / 公司网 / 某些运营商
    // 时，一次解析能拖到几百毫秒，表现为「页面转圈半天才开始加载」。给一份国内公共
    // DNS 作为首选，失败时系统仍会回退。用户可在设置里关掉（内网域名场景）。
    if (this.settings?.engine?.fastDns !== false) {
      args.push('-dns-server', '223.5.5.5,119.29.29.29');
    }
    if (lcd) args.push('-skin', `${lcd.w}x${lcd.h}`);
    if (headless) {
      args.push('-no-window');
    } else {
      // 注意：**不能再传 -no-skin**。它会覆盖上面的 -skin，让面板尺寸退回
      // config.ini 里的旧值 —— 表现就是「设置里切了横屏、实际还是竖屏」，
      // 以及「画面只占左上角一条」。面板尺寸必须由 -skin 决定。
      // 设备外壳本来就不会画（ShowDeviceFrame=no + 下面这组 style 参数）。
      // 注意：不能用 -qt-hide-window。它会让模拟器**根本不创建**那个 Qt 窗口，
      // 而窗口代理正是靠 SetParent 把这个窗口嵌进应用窗口来显示画面的 ——
      // 用了它之后 probe 永远找不到窗口，用户看到的是一个全黑的应用窗口。
      // 窗口的隐藏改由窗口代理常驻压制完成（见 win/agent.ps1 的 QuietSweep）。
    }
    // 只有快照真的存在才传 -snapshot：全新 AVD（或快照刚被作废）时传了它，
    // qemu 会一直等一份不存在的内存状态，进程活着但永远不开机——
    // 上层只看到「开机超时」，接着换参数重试，反而被 AVD 锁挡成
    // "Running multiple emulators with the same AVD"。
    // 快照参数决定「下次开机是 8 秒还是 90 秒」，这里是第二个致命点：
    // 老实现「没有快照就传 -no-snapshot」，而 -no-snapshot 同时禁掉了**退出时保存**，
    // 于是第一次冷启动结束后永远产生不了快照，用户每次点开都是全量引导。
    // 正确做法是 -no-snapshot-load：这次不加载（避免等一个不存在的快照），
    // 但退出时照常把内存状态写成 apkstart，下次就直接恢复。
    // 快照要占一份约 2~3GB 的 ram.bin（磁盘紧张的用户可以关掉，只影响启动速度）
    const wantSnapshot = this.settings?.engine?.keepSnapshot !== false;
    if (wipe) {
      // 重置数据时不能加载旧快照（数据都对不上了），但**必须允许保存新快照**：
      args.push('-no-snapshot-load');
    } else if (!wantSnapshot) {
      args.push('-no-snapshot');
    } else if (snapshot !== false) {
      args.push('-snapshot', SNAPSHOT_NAME);
      // 网络自愈要求这次冷启动：快照可能是在「没网」时存的，恢复出来依旧没网。
      if (!this.hasSnapshot() || this._coldBoot) args.push('-no-snapshot-load');
    } else {
      args.push('-no-snapshot');
    }
    if (wipe) args.push('-wipe-data');
    if (accel === 'off') args.push('-accel', 'off');
    // 驱动声明的其它参数：-gpu / -accel 已经由上面的 gpu/accel 统一处理，这里跳过，
    // 避免同一个参数出现两次（emulator 对重复参数的行为在不同版本上不一致）。
    let qemuArg;
    for (const a of ((eff && eff.args) || [])) {
      if (a.flag === '-gpu' || a.flag === '-accel' || audio.isAudioDriverArg(a.flag, a.value)) continue;
      if (a.flag === '-qemu') qemuArg = a.value;
      else if (a.value === '') args.push(a.flag);
      else args.push(a.flag, a.value);
    }
    // -qemu 将剩余参数全部交给 QEMU，必须放在 emulator 参数之后。
    if (qemuArg) args.push('-qemu', qemuArg);
    return args;
  }

  /** 拉起单个进程（不做开机等待，开机等待在 start() 的 probe 循环里） */
  spawnOnce(plan, { headless, onLog, logFile }) {
    const loc = this.locate();
    const env = this.env(loc.root, plan);
    const args = this.buildArgs({
      headless, accel: plan.accel, port: plan.port, gpu: plan.gpu,
      memoryMB: plan.memoryMB, cores: plan.cores,
      snapshot: plan.snapshot, wipe: plan.wipe, lcd: plan.lcd,
      audioPolicy: plan.audioPolicy,
    });
    this._logWrite(logFile, `\n--- ${new Date().toISOString()} ${plan.label} ---\n${loc.emulatorExe} ${args.join(' ')}\n`);

    const proc = spawn(loc.emulatorExe, args, {
      cwd: path.dirname(loc.emulatorExe),
      env,
      windowsHide: true,
      // detached: 让模拟器独立于 ApkStart 进程组。
      // Electron 退出时会把自己创建的 job 对象关掉，顺带把子进程一起杀掉——
      // 表现就是"关掉 ApkStart 再打开又要冷启动 20 多秒"。独立出去之后模拟器留着，
      // 下次启动直接接管（见 Runtime.adoptExisting），点开就是秒进。
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    try { proc.unref(); } catch (_) { /* ignore */ }

    const pipe = (stream) => {
      stream.setEncoding('utf8');
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (!l.trim()) continue;
          this.log(l.trim());
          this._logWrite(logFile, `${l.trim()}\n`);
        }
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.lastExitCode = code;
      const meaning = describeExitCode(code);
      this.log(`emulator exit ${code}${meaning ? `（${meaning}）` : ''}`);
      this._logWrite(logFile, `emulator exit ${code}${meaning ? `（${meaning}）` : ''}\n`);
      this.proc = null;
      onLog(`运行时已退出（code=${code}${meaning ? `，${meaning}` : ''}）`);
    });
    proc.on('error', (e) => {
      if (this.proc !== proc) return;
      this.log(`spawn error: ${e.message}`);
      this._logWrite(logFile, `spawn error: ${e.message}\n`);
      this.proc = null;
    });

    return { proc, args };
  }

  /** 写模拟器日志：带大小滚动，避免长期使用把磁盘写满 */
  _logWrite(file, text) {
    const limit = Math.max(2048, Number(this.settings?.engine?.logLimitKB || 2048) * 4);
    require('./logfile').append(file, text, limit);
  }

  /** 当前 /data 镜像的实际情况（设置页展示用，不启动安卓也能取） */
  dataInfo() {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    let bytes = 0;
    try { bytes = fs.statSync(img).size; } catch (_) { /* 还没建 */ }
    let fsBytesNow = 0;
    try { fsBytesNow = userdata.fsBytes(img); } catch (_) { /* 还没建或损坏 */ }
    const configuredGB = Number(this.settings?.engine?.dataPartitionGB || 0);
    const fsGB = fsBytesNow ? Number((fsBytesNow / 1073741824).toFixed(1)) : 0;
    return {
      avdDir: dir,
      imageBytes: bytes,
      imageGB: bytes ? Number((bytes / 1073741824).toFixed(1)) : 0,
      // 文件系统实际大小（≠ 镜像文件大小）：扩了镜像但 resize2fs 没到位时这两个数会不一样
      fsGB,
      configuredGB,
      // 用户设了目标、但文件系统还没长到目标
      pendingGB: configuredGB && fsGB ? Math.max(0, configuredGB - fsGB) : 0,
      // quickboot 会给 userdata 建一层 qcow2 覆盖层，guest 看到的是它，不是底座镜像
      overlay: this._hasDataOverlay(img),
    };
  }

  /** userdata 是否被 quickboot 的 qcow2 覆盖层接管（有它就只能重置，不能就地扩容） */
  _hasDataOverlay(img) {
    try { return fs.existsSync(`${img}.qcow2`); } catch (_) { return false; }
  }

  /**
   * 立即把 /data 分区扩容到指定大小（必须保证模拟器已停止，否则镜像被占用）。
   *
   * 两种路径，取舍是实测出来的：
   *  - 没有 quickboot 覆盖层：就地扩（qemu-img resize + resize2fs），不丢已装应用；
   *  - 有覆盖层：guest 真正挂载的是 `userdata-qemu.img.qcow2`，底座扩到 8GB、
   *    文件系统也长到 8GB，guest 里 `df /data` 依旧是 5.7GB（覆盖层还是旧大小），
   *    而覆盖层里的文件系统没有 root 权限改不了。这种时候必须如实返回「需要重置」，
   *    不能再像以前那样返回成功 —— 用户会以为扩好了，装 50GB 游戏依旧半路失败。
   */
  resizeDataPartition(dataMB) {
    this._assertAvdWritable();
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    const wantGB = Math.max(1, Math.round(Number(dataMB || 0) / 1024));
    if (this._hasDataOverlay(img)) {
      return {
        ok: false,
        needsReset: true,
        fsGB: this.dataInfo().fsGB,
        error: `安卓正在用快速启动的差量盘，就地扩容改不到它（目标 ${wantGB} GB）。`
          + '需要「重置安卓数据」后按新容量重建 /data —— 已装应用和存档会被清空，请先确认。',
      };
    }
    const r = this.ensureDataPartition(dir, dataMB);
    // ensureDataPartition 在 resize2fs 失败时会返回 ok:false；再核一次文件系统大小，
    // 防止「文件撑开了、文件系统没长」被当成功（用户看到的就是装游戏说空间不足）。
    let fsAfter = 0;
    try { fsAfter = userdata.fsBytes(img); } catch (_) { /* ignore */ }
    const wantBytes = Math.max(1024, Math.round(Number(dataMB || 0))) * 1048576;
    if (r && r.ok && fsAfter < wantBytes * 0.95) {
      return {
        ok: false,
        ...r,
        fsGB: Number((fsAfter / 1073741824).toFixed(1)),
        error: `镜像已扩到 ${wantGB} GB，但文件系统只到 ${(fsAfter / 1073741824).toFixed(1)} GB（resize2fs 没成功）。`
          + '可以再点一次「立即扩容」，或清理磁盘后重试。',
      };
    }
    return r;
  }

  /** 只调已确认的 QEMU PID，不启动 PowerShell 或按进程名称扫描。 */
  async setPriority(level = 'below', identity) {
    if (process.platform !== 'win32' || !Number.isInteger(identity?.pid) || identity.pid <= 0) return 0;
    const priorities = {
      idle: os.constants.priority.PRIORITY_LOW,
      below: os.constants.priority.PRIORITY_BELOW_NORMAL,
      normal: os.constants.priority.PRIORITY_NORMAL,
      game: os.constants.priority.PRIORITY_HIGH,
    };
    const priority = priorities[level];
    try {
      if (!Number.isInteger(priority) || !await identity.revalidate()) return 0;
      os.setPriority(identity.pid, priority);
      return 1;
    } catch (_) { return 0; }
  }

  /** 回收本轮启动；detached QEMU 只能由 Runtime 验明归属后关闭。 */
  async killAttempt(port = this.port, stopOwnedAttempt = async () => false) {
    const proc = this.proc;
    if (proc && proc.exitCode === null && proc.signalCode === null) {
      // 使用 ChildProcess 句柄，而不是按进程名或端口扫描后 taskkill。
      try { proc.kill(); } catch (_) { /* 已退出 */ }
    }
    for (let i = 0; i < 8 && proc && proc.exitCode === null && proc.signalCode === null; i += 1) {
      await sleep(100);
    }
    if (proc?.pid && proc.exitCode === null && proc.signalCode === null) return false;
    if (this.proc === proc) this.proc = null;
    const owner = this._avdOwner();
    if (owner.state === 'absent' || owner.state === 'stale') return true;
    return owner.state === 'live' && await stopOwnedAttempt(port);
  }

  _startAdbServer(port) {
    return this.provisioner.adbClient({ port }).startServer();
  }

  async ensureAdbServer(port = this.adbPort) {
    // 启动模拟器前先等 ADB 监听；占用端口不等于归属，不能向旧监听者发送 kill-server。
    if (await this._consoleAlive(port)) return true;
    try { await this._startAdbServer(port); } catch (_) { return false; }
    for (let i = 0; i < 25; i += 1) {
      if (await this._consoleAlive(port)) return true;
      await sleep(120);
    }
    return false;
  }

  /**
   * 等待「spawn 后马上退」的情况。
   * 参数错误/DLL 缺失时 emulator 通常 1 秒内就退；进程还在则立刻返回，
   * 不必再干等固定 2.5 秒 —— 快照恢复时这段时间足够开机跑完一半。
   */
  _waitSpawnSettled(ms = 900) {
    const proc = this.proc;
    if (!proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const onExit = () => fin(true);
      const fin = (exited) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { proc.removeListener('exit', onExit); } catch (_) { /* ignore */ }
        resolve(exited);
      };
      const timer = setTimeout(() => fin(false), ms);
      proc.once('exit', onExit);
    });
  }

  /**
   * 让「下一次启动」强制冷启动（不加载快速启动快照）。
   *
   * 快照里连网卡状态一起被保存：如果快照是在「没网」的时候存的，之后每次恢复都会
   * 继续没网。网络自愈时先冷启动一次能绕开这份坏快照。
   */
  forceColdBootOnNextStart() { this._coldBoot = true; }

  /**
   * 体检虚拟机内是否真的能联网。
   *
   * 为什么需要这一步：安卓虚拟机的 Wi-Fi 配置存在 /data 里，一旦写坏（典型表现是
   * `cmd wifi list-networks` 里同一个 AndroidWifi 出现两条、网络 id 撞车），
   * wlan0 就会一直 NO-CARRIER、拿不到 IP。这时「需要联网的页面」在应用里就是一块
   * 黑屏 —— 用户看到的「红果点同意后黑屏」就是这么来的，跟 GPU/渲染完全无关。
   *
   * @param {import('./adb').AdbClient} client 已由 Runtime 核验的目标 ADB 客户端
   * @returns {Promise<{ok:boolean, reason:string, gateway?:string, ip?:string}>}
   */
  async checkNetwork(client, { waitMs = 0, interval = 3000, canProbe = async () => true } = {}) {
    const sh = (cmd, timeout = 8000) => client.shell(cmd, { timeout });
    if (!await canProbe()) return { ok: false, reason: 'guest-changed' };
    // 安卓的多路由表会让 `ip route` 的主表看起来是空的（默认路由在 per-interface 表里），
    // 而且 shell 的 uid 不在应用的 network 组里，`ping` 经常误报 "Network is unreachable"，
    // 哪怕 Wi-Fi 其实已经连上、应用也能正常上网。所以这里只认「有没有拿到 IPv4 地址」，
    // 再叠加 `cmd wifi status` 的连接状态做交叉确认，不用 ping 判断。
    const addr = await sh('ip -o addr').catch(() => null);
    if (addr === null) return { ok: false, reason: 'device-offline' };
    const ips = [];
    const re = /inet ((?:\d{1,3}\.){3}\d{1,3})\//g;
    let m = re.exec(addr);
    while (m) {
      const ip = m[1];
      if (!/^127\./.test(ip)) ips.push(ip);
      m = re.exec(addr);
    }
    const wifi = await sh('cmd wifi status').catch(() => '');
    const connected = /Wifi is connected/i.test(wifi);
    if (!ips.length) {
      // Wi-Fi 关联 + DHCP 往往比 sys.boot_completed 晚几十秒才完成。
      // 调用方给了 waitMs 就继续等，不要在这一刻就断定「没有网络」。
      if (waitMs > 0) {
        const t0 = Date.now();
        while (Date.now() - t0 < waitMs) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, interval));
          // eslint-disable-next-line no-await-in-loop
          const again = await this.checkNetwork(client, { canProbe });
          if (again.ok || again.reason === 'guest-changed' || again.reason === 'device-offline') return again;
        }
      }
      return { ok: false, reason: connected ? 'no-ip-address' : 'wifi-not-connected', addrs: ips };
    }
    const ip = ips[0];
    const gw = /^10\.0\.2\./.test(ip) ? '10.0.2.2' : ip.replace(/\.\d+$/, '.1');
    // 有 IP 不等于能上网。实测拿到 10.0.2.16 但 DNS/路由被掐时，应用首页还是
    // 「网络错误」，而上层却以为网络正常。这里补一次真实 HTTP 探测。
    // 用 nc 直连 80 端口而不是 ping：QEMU 用户态 NAT 会拦 ICMP，ping 必然误报。
    // 只在「等待网络就绪」那条路径（waitMs>0）上做，快速轮询跳过——否则每 3 秒
    // 就要花 4 秒探测，反而把启动拖慢。结论放进 reachable，不改 ok：有 IP 就先
    // 让应用起来，一次 DNS 抖动不该卡住整个启动。
    let reachable = null;
    if (waitMs > 0 && await canProbe()) {
      const probe = await sh(
        "echo -e 'GET /generate_204 HTTP/1.0\\r\\nHost: connect.rom.miui.com\\r\\n\\r\\n' "
        + "| nc -w 4 connect.rom.miui.com 80 2>/dev/null | head -1",
        7000,
      ).catch(() => '');
      reachable = /HTTP\/1\.[01]\s+204/.test(probe);
    }
    return { ok: true, reason: '', gateway: gw, ip, wifiConnected: connected, reachable };
  }

  /**
   * 把「已保存但不会自动连」的 AndroidWifi 主动连上。
   *
   * 这是实机踩出来的：模拟器自带的虚拟热点 AndroidWifi 在配置库里可能落成
   * 两条记录（open + owe），系统据此判定为
   *   「Saved / Won't automatically connect」
   * 于是开机后 wlan0 永远 NO-CARRIER，应用里一直报网络错误。
   *
   * 麻烦的是 shell（uid 2000）没有 NETWORK_SETTINGS 权限，
   * `cmd wifi connect-network` 会直接抛 SecurityException，所以不能走命令行。
   * 这里改为拉起 Wi-Fi 设置页、点一下那条已保存的网络——和用户手动点的效果一样。
   *
   * @returns {Promise<boolean>} 是否已连上
   */
  async repairWifi(client, { canMutate = async () => true, pause = sleep } = {}) {
    const sh = (cmd, maxBuffer) => client.shell(cmd, { timeout: 10000, maxBuffer });
    const wifi = () => sh('cmd wifi status').catch(() => '');
    const write = async (cmd, bestEffort = false) => {
      // Waiting for Settings/UI can outlive the owned guest; recheck before each write.
      if (!await canMutate()) throw new Error('安卓运行时已更换，取消网络修复');
      return bestEffort ? sh(cmd).catch(() => '') : sh(cmd);
    };
    // 连上之后顺手把「联网验证」的探测地址换成国内可达的。
    // 安卓默认拿 connectifitycheck.gstatic.com 判断「是否真能上网」，国内连不上它，
    // 系统就一直给网络打「!」标记（已连接但无法访问互联网）。部分应用会因此
    // 自我判定为离线、拒绝加载内容。换成一个返回 204 的国内端点即可。
    const tune = async () => {
      await write('settings put global captive_portal_http_url http://connect.rom.miui.com/generate_204', true);
      await write('settings put global captive_portal_https_url https://connect.rom.miui.com/generate_204', true);
      await write('settings put global captive_portal_mode 0', true);
    };
    // 已经连上就别折腾了
    if (/Wifi is connected/i.test(await wifi())) {
      await tune();
      return true;
    }
    // 开关被关掉时（用户手滑 / 之前 -svc wifi disable）先打开
    await write('svc wifi enable', true);
    await pause(1500);

    // 打开 Wi-Fi 设置页，用 uiautomator 找到 AndroidWifi 那一行再点它。
    // 比按坐标点稳：不同分辨率 / 语言下坐标都不一样。
    await write('am start -a android.settings.WIFI_SETTINGS');
    await pause(2500);
    await write('uiautomator dump /sdcard/ui.xml');
    const xml = await sh('cat /sdcard/ui.xml', 8 * 1024 * 1024);
    // 节点形如 <node text="AndroidWifi" ... bounds="[x1,y1][x2,y2]" />
    const re = /<node[^>]*\btext="([^"]*)"[^>]*\bbounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/g;
    let m = re.exec(xml);
    while (m) {
      const label = m[1];
      if (/AndroidWifi/i.test(label)) {
        const cx = Math.round((Number(m[2]) + Number(m[4])) / 2);
        const cy = Math.round((Number(m[3]) + Number(m[5])) / 2);
        await write(`input tap ${cx} ${cy}`);
        await pause(6000);
        if (/Wifi is connected/i.test(await wifi())) {
          await tune();
          return true;
        }
      }
      m = re.exec(xml);
    }
    // 兜底：直接重连一次看看（有些版本 dump 里没有 text，只有 content-desc）
    await sh('svc wifi disable');
    await new Promise((r) => setTimeout(r, 1500));
    await sh('svc wifi enable');
    await new Promise((r) => setTimeout(r, 6000));
    const ok = /Wifi is connected/i.test(await sh('cmd wifi status'));
    if (ok) await tune();
    return ok;
  }

  /**
   * 启动 + 自动重试。
   * @param {Function} probe 异步回调，返回 'ok' | 'booting' | 'pending' | 'fatal' | 'unauthorized'
   */
  async start({ headless = false, onLog = () => {}, probe = null, networkProbe, maxAttempts = 4, stopOwnedAttempt } = {}) {
    // 已启动实例只由 Runtime 按 AVD 身份接管，监听端口本身不能作为归属证明。
    this._assertAvdWritable();
    if (this.running()) throw new Error('ApkStart 已有启动尝试在运行。');

    const loc = this.locate();
    if (!loc.emulatorExe) throw new Error('未安装运行时引擎，请先在「运行时」页完成部署');
    const choice = this.imageChoice();
    if (choice.compat ? !this.provisioner.playImageInfo().ok : !this.provisioner.systemImageInfo().ok) {
      throw new Error('系统镜像未就绪，请先在「运行时」页下载 Android 系统镜像');
    }

    const s = this.settings;
    // 同一次开机及重试共用音频配置，避免异步准备期间改设置导致 INI 和命令行不同步。
    const audioPolicy = audio.resolve(s?.engine);
    // 开机前先看一眼磁盘：模拟器写的是 AVD（数据分区 + 快照，几个 GB），
    // 只有它所在磁盘的余量才决定能不能开机；运行时目录只写日志，要求低得多。
    // 之前把两者的余量取最小值，结果「数据目录已经挪到 D 盘、C 盘只剩 400MB」
    // 会被误判成磁盘不足 —— 挪盘等于白挪。
    const avdHome = this.provisioner.paths().avdHome;
    const avdFreeMB = doctor.freeDiskMB(avdHome);
    const diskMB = doctor.freeDiskMB(loc.root);
    const needMB = 2500;
    if (avdFreeMB && avdFreeMB < needMB) {
      const msg = `磁盘空间不足：安卓数据目录（${avdHome}）所在磁盘只剩 ${(avdFreeMB / 1024).toFixed(1)} GB，`
        + `运行时至少要 ${(needMB / 1024).toFixed(1)} GB 可用。请在「设置 → 系统集成 → 安卓数据目录」`
        + '把它改到空间充足的盘（例如 D:），或先清理磁盘。你的应用与存档不会被自动删除。';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    if (diskMB && diskMB < 300) {
      const msg = `运行时目录（${loc.root}）所在磁盘只剩 ${(diskMB / 1024).toFixed(1)} GB，`
        + '连日志和临时文件都写不下。请清理磁盘，或把「运行时数据目录」也换到别的盘。';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    const adbPort = this.adbPort;

    // 硬件探测、端口选择和 ADB 启动互不依赖。
    const [accelInfo, verInfo, startPort, adbReady] = await Promise.all([
      this.provisioner.emulatorAccel(),
      this.provisioner.emulatorVersion(),
      doctor.freePortPair(5554),
      this.ensureAdbServer(adbPort),
    ]);
    if (!adbReady) throw new Error('无法启动 ApkStart 的 ADB 服务，请检查运行时组件和端口。');
    const emuVersion = verInfo.version || '';
    this._emuVersion = emuVersion;

    // 驱动（兼容补丁）：先看清这台机器是什么样，再看有没有人给它写过补丁。
    // 这一步只读 JSON，不执行任何代码；匹配不上就是空效果，行为和以前完全一致。
    let drv = { applied: [], skipped: [], errors: [], effect: null };
    try {
      drv = this._resolveDrivers({ accel: accelInfo, emulatorVersion: emuVersion });
    } catch (e) {
      this.log(`驱动加载失败：${e.message}`);
      onLog(`驱动加载失败（已忽略，按默认参数启动）：${e.message}`);
    }
    if (drv.applied.length) {
      onLog(`已应用驱动：${drv.applied.map((d) => `${d.name} v${d.version}`).join('、')}`);
      for (const n of (this._driverEffect.notes || []).slice(0, 4)) onLog(`· ${n}`);
    } else {
      onLog('未匹配到任何驱动，按默认参数启动');
    }
    if (drv.errors && drv.errors.length) {
      onLog(`有 ${drv.errors.length} 个驱动文件没加载成功（设置 → 驱动 里能看到原因）`);
    }

    // 与设置页 / 诊断报告共用同一个入口，保证「显示的」就是「实跑的」
    const profile = doctor.autoProfile({
      settings: s, accel: accelInfo, emulatorVersion: emuVersion, diskMB,
      port: startPort, adbPort,
    });
    this.profile = profile;
    let variants = doctor.planVariants(profile).slice(0, maxAttempts);
    // 驱动指定了渲染后端 / 要求软件模拟时，每一轮都按它来：
    // 用户装驱动的目的就是「这台机器只能用这一档」，继续先试崩过的后端只会白等。
    if (drv.applied.length && this._driverEffect) {
      const gpuFixed = drivers.gpuModeToArg(this._driverEffect.gpuMode);
      if (gpuFixed) {
        variants = variants.map((v) => ({ ...v, gpu: gpuFixed }));
        onLog(`驱动把渲染后端固定为 ${gpuFixed}`);
      }
      if (this._driverEffect.forceTcg) {
        variants = variants.map((v) => ({ ...v, accel: 'off', label: `${v.gpu} / 驱动要求软件模拟` }));
        onLog('驱动要求关闭硬件加速（走软件模拟）');
      }
    }

    // 记住「上次拉起就崩」的 GPU 后端，下次把它排到最后。
    // 实测：AMD Radeon 780M 上 `-gpu host` 能通过 emulator 自己的硬件检查，
    // 但 VM 起来十几秒后进程直接 exit 1（日志里只有 "AEHD is operational"），
    // 每次都要白等 20 多秒再退到 swangle。key 里带上 emulator 版本，
    // 升级运行时后自动重新给它一次机会。
    const badGpuKey = this.settings.engine.badGpu || '';
    const [badVer, badGpu] = badGpuKey.includes('|') ? badGpuKey.split('|') : ['', ''];
    // 关掉 Vulkan 之后 host 有机会真的可用：每个 emulator 版本重试一次，
    // 免得老记录把用户永久钉在软件渲染上（那是「一直卡」的根因之一）。
    const vulkanRetried = String(this.settings.engine.badGpuVulkanTried || '');
    const retryHostWithoutVulkan = badGpu === 'host' && badVer === emuVersion && vulkanRetried !== emuVersion;
    if (retryHostWithoutVulkan) {
      store.saveSettings({ engine: { badGpu: '', badGpuVulkanTried: emuVersion } });
      onLog('上次 host 渲染崩溃疑似 Vulkan 导致，本次以 -feature -Vulkan 重试硬件加速');
    } else if (badGpu && badVer === emuVersion) {
      const rank = (v) => (v.gpu === badGpu ? 1 : 0);
      variants.sort((a, b) => rank(a) - rank(b));
      if (variants[0] && variants[0].gpu === badGpu && variants.length > 1) {
        onLog(`上次 ${badGpu} 渲染后端启动即崩溃，本次改用 ${variants[1].gpu} 先试`);
      }
    }

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this._logWrite(logFile, `\n\n=== ${new Date().toISOString()} START ${doctor.describeProfile(profile)} ===\n`);
    this._logWrite(logFile, `drivers: ${drv.applied.length ? drv.applied.map((d) => `${d.id}@${d.version}`).join(', ') : '(none)'}\n`);

    // 屏幕规格在整个启动过程中保持一致，否则每次重试都换分辨率会狂清快照。
    // 分辨率来自 doctor 的 profile（设置里可改「画质」），auto 时按加速状态选。
    const screen = (profile && profile.lcd) || doctor.lcdFor({ accelOk: accelInfo.ok });
    this.attempts = [];
    this.lastDiagnosis = null;
    let lastError = '';
    let authColdRetried = false;

    for (let i = 0; i < variants.length; i += 1) {
      const base = variants[i];
      // 端口占用也会导致失败，每次重试重新探测一次
      // eslint-disable-next-line no-await-in-loop
      const port = i === 0 ? startPort : await doctor.freePortPair(startPort + (i * 2));
      const plan = { ...base, port, adbPort, lcd: screen, audioPolicy };
      this.port = port;
      // 每轮重置退出码：上一轮 0xC0000005 不能带进下一轮的诊断里
      this.lastExitCode = null;
      this.lastDiagnosis = null;
      // 日志也按轮切分：内存日志是跨轮累积的，第 1 轮的崩溃行若留在尾部，
      // 第 2 轮（比如换后端后端口冲突）会被误诊成同一个崩溃。
      const logStart = this._log.length;
      onLog(`启动运行时（第 ${i + 1}/${variants.length} 次：${plan.label}）…`);

      // eslint-disable-next-line no-await-in-loop
      const avd = this.ensureAvd({
        ...plan,
        wipe: plan.wipe,
      });
      // 埋点：上层（main）用它在拉起模拟器**之前**打开黑窗压制。
      // 控制台窗口在 spawn 之后几十毫秒就冒出来，事后再补一次扫描必然闪一下，
      // 所以这里必须先把它打开、再拉起进程。
      if (this.onBeforeSpawn) {
        // eslint-disable-next-line no-await-in-loop
        try { await this.onBeforeSpawn(); } catch (_) { /* ignore */ }
      }
      this._assertAvdWritable();
      // _coldBoot 只对这次 spawn 生效，避免之后每次开机都退化成长时间冷启动
      const { args } = this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending }, { headless, onLog, logFile });
      const mayLoadSnapshot = args.includes('-snapshot') && !args.includes('-no-snapshot-load');
      this._coldBoot = false;

      // 参数错误 / DLL 缺失会立刻退出
      // eslint-disable-next-line no-await-in-loop
      const dead = await this._waitSpawnSettled(2200);
      if (dead || !this.proc) {
        const d = doctor.diagnose(this._attemptLines(logStart, 60));
        this.attempts.push({ plan: plan.label, diagnosis: d.code, exitCode: this.lastExitCode });
        this.lastDiagnosis = d;
        lastError = `${d.title}：${d.hint}`;
        // 磁盘写满不是「换组参数就能好」的问题：继续重试只会反复失败，
        // 而且历史上最后那组参数带 wipe，会把用户数据一起抹掉。直接收工、如实报错。
        if (d.code === 'DISK_FULL') {
          onLog('磁盘空间不足，已停止重试（不会动你的应用与存档）。');
          this._persistFailure({ profile, why: 'disk-full' });
          return { ok: false, error: lastError, needsSpace: true, attempts: this.attempts, exitCode: this.lastExitCode };
        }
        // 加速/镜像类结论可能是缓存里的旧数据，作废掉，下次启动重新探测
        if (['ACCEL', 'GPU_INIT', 'GPU_MODE', 'IMAGE', 'DLL', 'ACCESS_VIOLATION'].includes(d.code)) {
          try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
        }
        onLog(`${d.title}，自动换一组参数重试…`);
        this._noteGpuFailure(plan);
        if (!await this.killAttempt(port, stopOwnedAttempt)) {
          throw new Error('本轮运行时未能安全关闭，已停止自动重试。');
        }
        continue;
      }

      if (!probe) {
        return { ok: true, serial: this.serial, port, accel: accelInfo, logFile, profile, attempts: this.attempts };
      }

      const started = Date.now();
      const timeout = plan.bootTimeoutMs || 240000;
      let ok = false;
      let fatal = false;
      let sawBooting = false;
      // 快照恢复往往几秒内就能起，固定 3 秒一次意味着平均要多等 1.5 秒才「发现」
      // 它已经好了。这里从 200ms 起步逐步放宽到 1.2 秒：开机早期能立刻抓到，
      // 长引导过程也不会把 CPU 花在轮询上。
      let interval = 200;
      let lastNotice = 0;
      // eslint-disable-next-line no-await-in-loop
      while (Date.now() - started < timeout) {
        if (!this.proc) { fatal = true; break; }
        let state = 'pending';
        try {
          // eslint-disable-next-line no-await-in-loop
          state = await probe({ serial: this.serial, port, adbPort });
        } catch (_) { state = 'pending'; }
        if (state === 'ok') { ok = true; break; }
        if (state === 'unauthorized') { fatal = true; break; }
        if (state === 'fatal') { fatal = true; break; }
        // 只要 adb 能执行 shell，说明内核已经在引导，日志里的普通 Vulkan/EGL 信息不算失败
        if (state === 'booting') sawBooting = true;
        // 45 秒仍完全没连上，且日志出现明确致命错误 → 提前换方案，不干等 4 分钟
        if (!sawBooting && Date.now() - started > 45000) {
          const d = doctor.diagnose(this._attemptLines(logStart, 80));
          if (['GPU_INIT', 'ACCEL', 'GPU_MODE', 'IMAGE', 'DLL', 'MEMORY', 'ACCESS_VIOLATION'].includes(d.code)) {
            this.lastDiagnosis = d;
            try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
            fatal = true;
            break;
          }
        }
        // 每 15 秒一条进度：以前用「取模」判断，自适应间隔下会连着打两三条重复的
        if (Date.now() - lastNotice > 15000) {
          lastNotice = Date.now();
          onLog(`正在开机… ${Math.round((Date.now() - started) / 1000)}s`);
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(interval);
        interval = Math.min(1200, Math.round(interval * 1.6));
      }

      if (ok) {
        const bootMs = Date.now() - started;
        // 这一次真的起来了：清掉上次的失败记录，避免以后「诊断」翻出旧账
        this._clearFailure();
        // 一定要存 quickboot 快照：模拟器进程会随 ApkStart 退出而结束（Electron 的
        // job 对象会连带杀掉子进程），下次打开有没有快照直接决定是 25 秒还是 7 秒。
        // 装完新应用时 installer 会作废快照，避免"重启后应用消失"。
        this.snapshotWorthSaving = true;
        onLog(`运行时就绪（${Math.round(bootMs / 1000)}s，${plan.label}）`);
        // 开机成功不等于能用：顺手体检网络。虚拟机没网时，需要联网的页面会一直黑屏，
        // 用户只会说「这个应用黑屏」，很难联想到是网络。这里主动查一次并说清楚。
        //
        // 但不能「查一次就下结论」：Wi-Fi 关联 + DHCP 普遍比 sys.boot_completed 晚
        // 5~20 秒，以前这里只调 checkNetwork() 一次，于是**每次冷启动**都会打一条
        // 「⚠ 没有网络，请重置安卓数据」，而 5 秒后网络就绪了 —— 用户照着做就会
        // 丢光已装应用。现在给它 12 秒等待窗口（就绪即返回），真超时才提示，
        // 而且不再建议破坏性操作。
        let network = null;
        try {
          network = await networkProbe?.(this.serial, { waitMs: 12000, interval: 3000 }) ?? null;
        } catch (_) { /* 体检失败不算启动失败 */ }
        if (['wifi-not-connected', 'no-ip-address'].includes(network?.reason)) {
          onLog('⚠ 安卓虚拟机暂时没连上网（Wi-Fi 未关联或没拿到地址）。'
            + '需要联网的应用打开后可能一直黑屏：稍后重开应用即可；'
            + '若持续无网，可在「设置 → 修复网络」重连（不会删除已装应用）。');
        }
        return {
          ok: true, serial: this.serial, port, accel: accelInfo, logFile,
          profile, attempts: this.attempts, bootMs, quickBoot: true, network,
        };
      }

      const attemptLines = this._attemptLines(logStart, 80);
      const d = fatal ? (this.lastDiagnosis || doctor.diagnose(attemptLines)) : doctor.diagnose(attemptLines);
      this.attempts.push({ plan: plan.label, diagnosis: d.code, timeout: !fatal, exitCode: this.lastExitCode });
      this.lastDiagnosis = d;
      lastError = fatal ? `${d.title}：${d.hint}` : '开机超时（可能是首次引导较慢或硬件加速未生效）';
      const authBlocked = d.code === 'ADB_UNAUTHORIZED';
      if (!authBlocked) {
        onLog(`${lastError}，自动换一组参数重试…`);
        this._noteGpuFailure(plan);
      }
      // eslint-disable-next-line no-await-in-loop
      if (!await this.killAttempt(port, stopOwnedAttempt)) {
        throw new Error('本轮运行时未能安全关闭，已停止自动重试。');
      }
      if (authBlocked) {
        // 未授权不是显卡故障。只有恢复过快照才值得用同一渲染器冷启一次；
        // 确认冷启仍未授权就停止，防止连续重开音频设备和隐藏窗口。
        if (!mayLoadSnapshot || authColdRetried || i + 1 >= maxAttempts) {
          onLog(`${lastError} 已停止自动重试。`);
          break;
        }
        authColdRetried = true;
        this.invalidateSnapshot();
        this._coldBoot = true;
        variants.splice(i + 1, 0, { ...base, label: `${base.label}（授权检查，冷启动）` });
        if (variants.length > maxAttempts) variants.length = maxAttempts;
        onLog('从快照启动后未获得 ADB 授权，仅用原渲染器冷启动一次。');
      }
    }

    const d = this.lastDiagnosis || doctor.diagnose(this.recentLog(120));
    const report = doctor.writeReport({
      dataDir: store.DATA_DIR, profile, logLines: this.recentLog(300),
      extra: {
        attempts: this.attempts,
        diagnosis: d,
        image: choice,
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
      },
    });
    const err = new Error(
      `${d.code === 'ADB_UNAUTHORIZED' ? '运行时启动已停止' : '运行时多次尝试仍未能启动'}（${d.title}）。\n${d.hint}\n\n`
      + `已尝试：${this.attempts.map((a) => `${a.plan} → ${a.diagnosis}`).join('；')}\n`
      + `诊断报告：${report.file}`,
    );
    err.diagnosis = d;
    err.report = report.file;
    err.attempts = this.attempts;
    this._persistFailure({ profile, why: 'boot-failed', report: report.file });
    throw err;
  }

  running() { return !!(this.proc && !this.proc.killed); }

  /**
   * 保存 quickboot 快照（下次开机直接恢复内存状态，像 WSA/应用宝的快速启动）。
   *
   * 时机很重要：以前的实现是开机后 6 秒就存，正好和用户点开应用抢磁盘 I/O
   * （快照要写 1~3GB），体感反而更慢。改成「空闲时再存」，并由 Runtime 在
   * 最后一个应用窗口关闭时触发；关机前若还没来得及存，也会补一次。
   */
  async saveSnapshotNow({ client, timeout = 45000, identity } = {}) {
    const ok = await this._saveViaAdb({ client, timeout, identity });
    // emulator 的 save 命令可能在写盘中途就回 OK，这里按文件完整性再确认一次，
    // 只有 snapshot.pb 真正落盘才算数（否则下次加载会失败并白等几秒）。
    if (!ok) return false;
    return this.hasSnapshot();
  }

  /**
   * 安排一次「空闲时保存快照」。
   * 只排一次；如果到点时容器还有应用在前台，就推迟到真正空闲。
   */
  scheduleSnapshotSave({ delay = 20000, isIdle = () => true, resolveGuest } = {}) {
    if (this._snapTimer) clearTimeout(this._snapTimer);
    const arm = (ms) => {
      this._snapTimer = setTimeout(async () => {
        this._snapTimer = null;
        if (!this.running()) return;
        if (!isIdle()) { arm(15000); return; }
        // 磁盘余量不够写快照（内存大小 + 1GB 余量）就跳过：硬写只会把磁盘写满，
        // 进而让下一次开机直接失败。快照只影响启动速度，不写也不影响数据。
        const freeMB = require('./doctor').freeDiskMB(store.DATA_DIR);
        const needMB = Math.round(Number(this.profile?.memoryMB || 3072) * 1.15) + 1024;
        if (freeMB && freeMB < needMB) {
          this.log(`跳过快照保存：磁盘剩余 ${(freeMB / 1024).toFixed(1)}GB < 需要 ${(needMB / 1024).toFixed(1)}GB`);
          return;
        }
        try {
          const guest = await resolveGuest();
          if (guest) this._snapSaved = await this.saveSnapshotNow(guest);
        } catch (_) { /* 下次空闲时可再试 */ }
      }, ms);
      if (this._snapTimer.unref) this._snapTimer.unref();
    };
    arm(delay);
  }

  cancelSnapshotSave() {
    if (this._snapTimer) clearTimeout(this._snapTimer);
    this._snapTimer = null;
  }

  /** 保存快照并关闭已经核验的实例，不把失败误报成退出成功。 */
  async stop({ client, identity } = {}) {
    if (!identity || !await identity.revalidate()) return false;
    this.cancelSnapshotSave();
    const healthy = await this._adbGuestHealthy(client, identity);
    if (healthy && this.snapshotWorthSaving !== false) {
      await this._saveViaAdb({ client, timeout: 60000, identity, healthy });
    }
    // 存盘可能耗时数十秒，关机前再次确认仍是同一份锁和监听者。
    if (!await identity.revalidate()) return false;
    try {
      const { stdout } = await identity.client.exec(['emu', 'kill'], { timeout: 10000 });
      if (/^KO\b/m.test(String(stdout || ''))) return false;
    } catch (_) { return false; }
    for (let i = 0; i < 100; i += 1) {
      const owner = this._avdOwner();
      if (owner.state === 'absent' || owner.state === 'stale') {
        if (!await this._consoleAlive(identity.port)) {
          const current = this._avdOwner();
          if (current.state !== 'absent' && current.state !== 'stale') return false;
          this.proc = null;
          // 未授权 guest 的自动快照会复现故障；等写盘进程退出后再作废。
          if (!healthy && this.snapshotWorthSaving !== false) this.invalidateSnapshot();
          return true;
        }
      } else if (owner.state === 'live' && owner.pid !== identity.pid) {
        return false;
      }
      await sleep(300);
    }
    return false;
  }

  /**
   * 记下「拉起就崩」的 GPU 后端，下次启动把它排到最后。
   * 只对 auto 模式生效：用户显式指定后端时尊重用户选择，不偷偷改。
   */
  _noteGpuFailure(plan) {
    try {
      const gpu = plan && plan.gpu;
      if (!gpu) return;
      // 软件渲染是兜底项，它已经是最慢/最稳的选择，没有更差的替代品可退
      if (/software|swiftshader|swangle/.test(gpu)) return;
      if ((this.settings.engine.gpuMode || 'auto') !== 'auto') return;
      store.saveSettings({ engine: { badGpu: `${this._emuVersion || ''}|${gpu}` } });
    } catch (_) { /* ignore */ }
  }

  /** 本实例的控制台端口（5554）上是否还有机器在跑 —— 判断「到底关干净了没有」 */
  _consoleAlive(port = this.port || 5554) {
    const net = require('net');
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(200, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
  }

  /**
   * guest 是否处于「可以安全存快照」的健康状态：adb authorized + boot 完成。
   * 冷启动时若「允许 USB 调试吗？」对话框还挂着，state 是 unauthorized —— 这时存下
   * 内存 + 磁盘，guest 里就没有 host 的 adbkey.pub，下次恢复还是 unauthorized，
   * 每轮探测的 shell 都抛异常，干等 240s 还被误诊成显卡/虚拟化问题。
   */
  async _adbGuestHealthy(client, identity) {
    if (!client || !identity || !await identity.revalidate({ adbPort: true })) return false;
    try {
      const state = await client.deviceState();
      const out = await client.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '');
      return state === 'device' && String(out).trim() === '1';
    } catch (_) {
      return false; // 读不到就按不健康处理
    }
  }

  /**
   * 用 adb 触发一次快照保存（失败返回 false，调用方决定要不要再试）。
   * 只有 guest 健康时才存，宁可下次冷启动 20 多秒，也不能存一份「开机必失败」的毒快照。
   */
  async _saveViaAdb({ client, timeout = 45000, identity, healthy } = {}) {
    if (!(healthy ?? await this._adbGuestHealthy(client, identity))) {
      this.log('跳过快照保存：guest 未授权或未开机完成（避免存入未授权的毒快照）');
      return false;
    }
    if (!identity || !await identity.revalidate()) return false;
    try {
      const { stdout } = await identity.client.exec(['emu', 'avd', 'snapshot', 'save', SNAPSHOT_NAME], { timeout });
      return !/^KO\b/m.test(String(stdout || ''));
    } catch (_) { return false; }
  }

  recentLog(n = 40) { return this._log.slice(-n).map((x) => x.line); }

  /**
   * 只取「本轮启动尝试」产生的日志行。
   * 内存日志是跨轮累积的（诊断报告要看到全部尝试），但诊断结论必须只看本轮：
   * 否则第 1 轮的 `emulator exit 3221225477` 会让第 2 轮的任何失败都被判成同一个崩溃。
   * 本轮一条日志都没有时（进程压根没起来）退回整体尾部，至少给个结论。
   */
  _attemptLines(from, max = 80) {
    const lines = this._log.slice(Math.max(0, from || 0)).map((x) => x.line);
    return lines.length ? lines.slice(-max) : this.recentLog(max);
  }

  /**
   * 从 emulator.log 文件尾部读最近 n 行（内存缓冲为空时用）。
   * 用户重启 ApkStart 再导出诊断报告时，内存里的 this._log 已经空了，
   * 旧版报告因此只剩一句 UNKNOWN —— 真实崩溃原因全在日志文件里。
   */
  tailLogFile(n = 300) {
    try {
      const file = path.join(store.DATA_DIR, 'logs', 'emulator.log');
      const size = fs.statSync(file).size;
      const take = Math.min(size, 2 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, size - take);
        const lines = buf.toString('utf8').split(/\r?\n/);
        // 从头读的话第一行可能被截断，丢掉它
        if (take < size) lines.shift();
        return lines.slice(-n);
      } finally { fs.closeSync(fd); }
    } catch (_) { return []; }
  }
}

module.exports = { EmulatorEngine, AVD_NAME, SNAPSHOT_NAME };
