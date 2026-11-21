'use strict';

function createDiagnosticsHandlers({
  app, appLog, autodebugConfig, fs, leftovers, live, MSIX_ACCEL_HINT, path, runAutodebug,
  scheduleAutodebug, shell, store,
}) {
  return {
    'doctor:profile': async () => {
      const doctor = require('../../core/doctor');
      // 已经开机就用实跑参数；没开机也要按「真实引擎版本 + 真实加速状态」推导，
      // 否则设置页会显示已弃用的 swiftshader_indirect / 软件模拟，和实跑不一致。
      let p = live.runtime.emulator.profile;
      if (!p) {
        const env = await live.runtime.provisioner.checkEnv();
        p = doctor.autoProfile({
          settings: store.getSettings(),
          accel: env.accel,
          emulatorVersion: env.emulator.version || '',
          diskMB: doctor.freeDiskMB(store.DATA_DIR),
        });
      }
      return { profile: p, text: doctor.describeProfile(p) };
    },

    'doctor:report': async () => {
      const r = await live.runtime.diagnostics();
      shell.showItemInFolder(r.file);
      return r;
    },

    /**
     * 系统问题自动校验：启动前/运行中自动检查常见导致「装不上、起不来」的根因，
     * 并给出可操作的修复建议（在首页横幅 + 设置面板里展示，按问题一键修复）。
     */
    'doctor:selfCheck': async () => {
      const doctor = require('../../core/doctor');
      const issues = [];
      // 这两个值在 try 内赋值、在 try 外返回，必须在作用域外声明
      let accel = { ok: false };
      let free = 0;
      try {
        if (!doctor.vcRedistOk()) {
          issues.push({
            code: 'vcRedist', severity: 'error', title: '缺少 VC++ 运行库（x64）',
            // 这一条是实测 dll 文件不存在才报，可信。但要说清：0xC0000135 不等于
            // 一定是缺 VC++——商店版从 WindowsApps 起子进程也会报同码。装完若仍
            // 起不来，按内置手册 6.8 继续定位，别反复重装运行库。
            hint: '实测系统缺少微软 VC++ 2015-2022（x64），安卓运行时依赖它。'
              + '可一键安装；若装完仍报 0xC0000135，见内置手册 6.8——商店版还可能是子进程 DLL 路径问题。', fix: 'vcRedist',
          });
        }
        accel = await live.runtime.provisioner.emulatorAccel().catch(() => ({ ok: false }));
        if (!accel.ok) {
          // 商店版和安装版的补救路径完全不同，提示必须分开写：
          //   - 商店（MSIX）版不能装内核驱动、也通常拿不到管理员授权 → 只能引导用户
          //     自己去「启用或关闭 Windows 功能」里勾「Windows 虚拟机监控程序平台」；
          //   - 安装版/便携版可以一键提权开启（失败还能退 AEHD 驱动）。
          // 以前两种版本共用一句话，商店用户看到的是「建议安装 AEHD 驱动」——
          // 而商店版根本装不了驱动，等于指了一条死路。
          issues.push(store.STORE_BUILD
            ? {
              code: 'accel',
              severity: 'error',
              title: '需要开启「Windows 虚拟机监控程序平台」',
              hint: '没有它只能跑纯软件模拟，开机会慢到几分钟。'
                + MSIX_ACCEL_HINT
                + '（商店版无法代你提权，需要你手动操作一次，之后重启。）',
              fix: 'virtualization',
            }
            : {
              code: 'accel',
              severity: 'warn',
              title: '未启用硬件加速',
              hint: `${accel.note || '将回退软件模拟（能跑但很慢）。'}`
                + '点右侧「修复」会自动开启（需要管理员授权，可能要重启一次）；'
                + '失败时会自动改装 AEHD 驱动。',
              fix: 'virtualization',
            });
        }
        free = doctor.freeDiskMB(live.runtime.provisioner.paths().root);
        if (free && free < 8192) {
          issues.push({
            code: 'disk', severity: free < 2048 ? 'error' : 'warn', title: '运行时磁盘空间紧张',
            hint: `「${live.runtime.provisioner.paths().root}」所在盘仅剩 ${free} MB，运行时与镜像可能撑爆硬盘。`, fix: 'disk',
          });
        }
        const rtDir = live.runtime.provisioner.paths().root;
        if (!doctor.isAsciiPath(rtDir)) {
          issues.push({
            code: 'pathRuntime', severity: 'warn', title: '运行时目录含中文/特殊字符',
            hint: '部分运行时组件对中文路径敏感，可能引发启动失败。建议改到纯英文目录。', fix: 'path',
          });
        }
        const env = await live.runtime.provisioner.checkEnv().catch(() => ({}));
        if (!env.adb || !env.adb.ok) {
          issues.push({ code: 'adb', severity: 'error', title: 'adb 工具链缺失', hint: '无法连接安卓运行时。', fix: 'deploy' });
        }
        if (!env.emulator || !env.emulator.ok) {
          issues.push({ code: 'emulator', severity: 'error', title: '运行时引擎未安装', hint: '需要先部署运行时引擎（约 440MB）。', fix: 'deploy' });
        }
        if (!env.sysimg || !env.sysimg.ok) {
          issues.push({ code: 'sysimg', severity: 'warn', title: '系统镜像未就绪', hint: '需要先下载 Android 系统镜像（约 1.5GB）。', fix: 'deploy' });
        }
        // 残留锁文件：会让下一次启动被判定为「AVD 已被占用」而 FATAL
        const avdHome = live.runtime.provisioner.paths().avdHome;
        let locked = false;
        try { for (const f of fs.readdirSync(avdHome)) { if (/\.lock$/i.test(f)) { locked = true; break; } } } catch (_) { /* ignore */ }
        if (locked) {
          issues.push({ code: 'lock', severity: 'warn', title: '检测到上次残留的锁文件', hint: '可能导致下一次启动被判定为「AVD 已被占用」。', fix: 'lock' });
        }
      } catch (_) { /* 自检失败不阻断使用 */ }
      return { issues, accel, free };
    },

    /** 立即跑一次检测（设置页「立即检测」按钮 / 定时任务都走这里） */
    'autodebug:run': () => runAutodebug({ force: true }),

    /** 取上一次的结果（打开设置页时先渲染旧的，别让界面空着等） */
    'autodebug:state': () => live.autodebugState,

    /** 开关与间隔 */
    'autodebug:config': (_e, patch = {}) => {
      const cur = autodebugConfig();
      const next = {
        auto: patch.auto === undefined ? cur.auto : !!patch.auto,
        intervalMin: patch.intervalMin === undefined ? cur.intervalMin : Number(patch.intervalMin) || cur.intervalMin,
        notify: patch.notify === undefined ? cur.notify : !!patch.notify,
      };
      store.saveSettings({ debug: next });
      scheduleAutodebug();
      if (next.auto) runAutodebug().catch(() => {});
      return next;
    },

    /** 只扫描、不删除：先把「能找到什么」原样给界面，由用户决定 */
    'leftovers:scan': () => {
      try {
        const installDir = path.dirname(app.getPath('exe'));
        const dataDir = store.DATA_DIR;
        let avdHome = '';
        try { avdHome = live.runtime.provisioner.paths().avdHome; } catch (_) { avdHome = ''; }
        return { ok: true, ...leftovers.scan({ installDir, dataDir, avdHome }) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    'leftovers:clean': (_e, items) => {
      try {
        const installDir = path.dirname(app.getPath('exe'));
        const r = leftovers.clean(Array.isArray(items) ? items : [], { installDir });
        appLog(`leftovers cleaned: ${r.removed.length} removed, ${r.failed.length} failed`);
        return { ok: true, ...r, freedMB: Math.round(r.freedBytes / 1048576) };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
  };
}

module.exports = { createDiagnosticsHandlers };
