'use strict';

function createWindowsFeaturesHandlers({ enableWhpxFeatures, fs, live, MSIX_ACCEL_HINT, path, send, shell, store }) {
  // 微软 VC++ 2015-2022 x64 运行库：安卓模拟器（Qt6）与 qemu 都依赖它。
  // 缺了在「其他电脑」上会直接起不来（0xc0000135 / MSVCP140 缺失）。
  function vcRedistInstaller() {
    const p = live.runtime.provisioner.paths();
    const cands = [
      path.join(p.root, 'vc_redist.x64.exe'),
      path.join(process.resourcesPath || '', 'runtime', 'vc_redist.x64.exe'),
    ];
    return cands.find((c) => c && fs.existsSync(c)) || null;
  }

  // Both paths reach the same archive verification before elevation.
  const enableAehd = () => live.runtime.provisioner.enableAehd(
    (progress) => send('provision:progress', { ...progress, component: 'aehd' }),
  );

  return {
    'runtime:vcRedist': () => {
      const doctor = require('../../core/doctor');
      return { ok: doctor.vcRedistOk(), path: vcRedistInstaller() };
    },

    'runtime:installVcRedist': async () => {
      const file = vcRedistInstaller();
      if (!file) return { ok: false, reason: 'no-installer' };
      const { spawn } = require('child_process');
      await new Promise((resolve) => {
        // 用 RunAs 提权安装（VC++ 是系统级组件，需要管理员）；/quiet 静默 /norestart 不重启
        const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
          `Start-Process -FilePath "${file}" -ArgumentList '/quiet','/norestart' -Verb RunAs -Wait`],
        { windowsHide: true, stdio: 'ignore' });
        ps.on('exit', () => resolve());
        ps.on('error', () => resolve());
      });
      const doctor = require('../../core/doctor');
      return { ok: doctor.vcRedistOk() };
    },

    /** 提权安装 AEHD 驱动：弹出 UAC，用户确认后静默安装 */
    'provision:enableAccel': async () => {
      try {
        if (store.STORE_BUILD) {
          return { ok: false, error: '商店版不支持安装 AEHD，请在「Windows 功能」中启用硬件加速。' };
        }
        await enableAehd();
        const accel = await live.runtime.provisioner.emulatorAccel();
        return { ok: accel.ok, accel, error: accel.ok ? '' : accel.note };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    /**
     * 自动开启虚拟化：用户无需手动去「Windows 功能」面板。
     * 优先启用系统自带的「虚拟机平台」（WHPX）功能；若该 DLL 都不存在（老系统），
     * 退而安装并启用 Google 的 AEHD 驱动。两种方式都需要管理员提权。
     */
    'provision:enableVirtualization': async () => {
      try {
        const accel = await live.runtime.provisioner.emulatorAccel();
        if (accel.ok) return { ok: true, already: true, accel, note: '硬件加速已可用，无需额外操作' };

        // ---------------- 商店（MSIX）版：只能走系统自带的 WHPX ----------------
        // MSIX 包由 AppX 部署模型拉起，固定 mediumIL，既不能装内核驱动（AEHD），
        // 通常也拿不到管理员授权。所以这里只尝试 WHPX，拿不到就退回「手动开启」
        // 的引导 —— 以前的实现直接用 Start-Process -Verb RunAs，商店用户点了
        // 注定失败，横幅上的「未启用硬件加速」永远消不掉。
        if (store.STORE_BUILD) {
          const whpx = await enableWhpxFeatures();
          live.runtime.provisioner.invalidateEnvCache?.();
          if (whpx.ok) {
            return {
              ok: true, restartNeeded: true, steps: whpx.steps,
              accel: await live.runtime.provisioner.emulatorAccel().catch(() => accel),
              note: '已请求开启「Windows 虚拟机监控程序平台」，重启电脑后硬件加速才会生效',
            };
          }
          return {
            ok: false,
            manual: true,
            settingsUri: 'ms-settings:optionalfeatures',
            steps: whpx.steps,
            accel,
            note: MSIX_ACCEL_HINT,
          };
        }

        // ---------------- 安装版 / 便携版 ----------------
        // 先试 WHPX（系统自带，无需下载）；失败（用户点了否 / 系统不支持）再退 AEHD 驱动。
        // AEHD 需要联网拿驱动包，所以放在后面。
        const whpx = await enableWhpxFeatures();
        live.runtime.provisioner.invalidateEnvCache?.();
        if (whpx.ok) {
          return {
            ok: true, restartNeeded: true, steps: whpx.steps,
            accel: await live.runtime.provisioner.emulatorAccel().catch(() => accel),
            note: '已开启「Windows 虚拟机监控程序平台」，重启电脑后生效',
          };
        }
        if (whpx.cancelled) {
          return {
            ok: false,
            cancelled: true,
            error: '你取消了管理员授权，硬件加速没有改动。可以再点一次「修复」，或手动开启「Windows 虚拟机监控程序平台」。',
          };
        }

        // WHPX 开不起来：改用 Google 的 AEHD 驱动（装完即用，不用重启）
        await enableAehd();
        const after = await live.runtime.provisioner.emulatorAccel();
        return { ok: after.ok, accel: after, note: after.ok ? 'AEHD 硬件加速已启用' : after.note };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },

    /**
     * 打开「启用或关闭 Windows 功能」对话框。
     *
     * 为什么不用 ms-settings:optionalfeatures：Win11 那个页面是「可选功能」列表，
     * 里面**没有**「Windows 虚拟机监控程序平台」，用户会白找一圈。经典对话框
     * optionalfeatures.exe 才有那一项（WHPX 真正需要的功能）。
     * 打开它本身不需要管理员权限，点「确定」时才 UAC。
     */
    'provision:openWindowsFeatures': () => {
      try {
        const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'optionalfeatures.exe');
        const { spawn } = require('child_process');
        spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
        return { ok: true };
      } catch (e) {
        // 极少见：被组策略挡住 / 文件缺失。退到设置页，至少给用户一个入口
        shell.openExternal('ms-settings:optionalfeatures').catch(() => {});
        return { ok: false, error: e.message };
      }
    },
  };
}

module.exports = { createWindowsFeaturesHandlers };
