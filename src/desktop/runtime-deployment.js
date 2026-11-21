'use strict';

const COOLDOWN_MS = 30 * 60 * 1000;
const missingComponents = (env) => [
  !env.adb.ok && 'adb 工具链',
  !env.emulator.ok && 'Android 运行时',
  !env.sysimg.ok && '系统镜像',
].filter(Boolean);

function createRuntimeDeployment({ settings, provisioner, bundledDir, recordFailure, progress, log, now = Date.now }) {
  let inFlight = null;

  async function prepare(prefs) {
    let failedAt = 0;
    try {
      const target = provisioner();
      const bundled = bundledDir();
      let env = await target.checkEnv();
      if (!missingComponents(env).length) {
        if (bundled) log(`运行时组件已随安装包内置（${bundled}），无需联网`);
        return { ok: true, source: bundled ? 'bundled' : 'existing', needsExtract: !!env.needsExtract };
      }
      // An incomplete bundled installation should be repaired, not silently replaced by a download.
      if (bundled) {
        log(`内置运行时缺少组件（${bundled}），未联网下载`);
        return { ok: false, code: 'BUNDLED_INCOMPLETE', error: `内置运行时缺少 ${missingComponents(env).join('、')}，请修复或重新安装程序。` };
      }
      if ((!env.emulator.ok || !env.sysimg.ok) && prefs.runtime.preferGithubRuntime !== false) {
        try {
          progress({ message: '正在从 GitHub 下载运行时…' });
          await target.installRuntimePack(progress);
          env = await target.checkEnv();
          if (!missingComponents(env).length) return { ok: true, source: 'github' };
          progress({ message: '运行时整包不完整，改用官方源补齐…' });
        } catch (error) {
          progress({ message: `GitHub 运行时不可用（${error.message}），改用官方源…` });
        }
      }
      if (!env.adb.ok) {
        progress({ message: '正在准备 adb…' });
        await target.installAdb(progress);
      }
      if (!env.emulator.ok) {
        progress({ message: '正在准备 Android 运行时…' });
        await target.installEmulator(progress);
      }
      if (!env.sysimg.ok) {
        progress({ message: '正在准备 Android 系统镜像…' });
        await target.installSystemImage(progress);
      }
      const missing = missingComponents(await target.checkEnv());
      if (missing.length) throw new Error(`仍缺少 ${missing.join('、')}，请到设置中查看诊断。`);
      return { ok: true, source: 'components' };
    } catch (error) {
      failedAt = now();
      return { ok: false, code: 'DEPLOY_FAILED', error: error.message };
    } finally {
      // An existing installation, or a bundled install the user must repair, is not a failed download.
      try { recordFailure(failedAt); } catch (_) { /* Deployment completed independently of the cooldown record. */ }
    }
  }

  return async function deploy({ force = false } = {}) {
    const prefs = settings();
    if (!force && !prefs.autoDeploy) return { ok: false, skipped: true, code: 'AUTO_DEPLOY_DISABLED' };
    // Only one job may write to the runtime files; manual requests can wait for a running job.
    if (inFlight) return inFlight;
    const lastFailure = Number(prefs.runtime.deployFailedAt || 0);
    if (!force && lastFailure && now() - lastFailure < COOLDOWN_MS) {
      log('自动部署仍在失败冷却期，等待下次检查或手动重试');
      return { ok: false, skipped: true, code: 'DEPLOY_COOLDOWN' };
    }
    inFlight = prepare(prefs).finally(() => { inFlight = null; });
    return inFlight;
  };
}

module.exports = { createRuntimeDeployment };
