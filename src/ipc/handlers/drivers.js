'use strict';

const { reportIpcFailure } = require('../failure');

function createDriversHandlers({ APP_ROOT, appLog, dialog, fs, live, path, send, shell, store }) {
  // 一个驱动就是一份 JSON：声明「匹配哪些机器」+「命中后改哪些启动参数」。
  // 这里只做「读目录 / 校验 / 匹配 / 导入 / 导出模板 / 开关」，不执行任何代码。

  /** 组装当前机器画像 + 全部驱动 + 匹配结果（给设置页用） */
  async function driverOverview() {
    const drv = require('../../core/drivers');
    const doctor = require('../../core/doctor');
    const os = require('os');
    const s = store.getSettings();
    const disabled = (s.drivers && s.drivers.disabled) || [];
    const state = (s.drivers && s.drivers.state) || {};
    let accel = { ok: false, kind: 'none' };
    try { accel = await live.runtime.provisioner.emulatorAccel(); } catch (_) { /* 没装运行时 */ }
    let emulatorVersion = '';
    try { emulatorVersion = (await live.runtime.provisioner.emulatorVersion()).version || ''; } catch (_) { /* ignore */ }
    let osBuild = 0;
    try {
      const m = /(\d+)\s*$/.exec(os.release() || '');
      osBuild = m ? Number(m[1]) : 0;
    } catch (_) { /* ignore */ }
    const host = drv.hostContext({
      info: { ...doctor.hostInfo(), cpuVendor: (os.cpus() || [])[0]?.model || '' },
      gpuVendor: doctor.detectGpuVendor(),
      osBuild,
      accel: accel && accel.ok ? (accel.kind || 'whpx') : 'none',
      emulatorVersion,
    });
    const dirs = { user: drv.userDir(store), bundled: drv.bundledDir(APP_ROOT) };
    const loaded = drv.loadAll([dirs.bundled, dirs.user]);
    const resolved = drv.resolve({ drivers: loaded.drivers, host, state, disabled });
    const hit = new Map(resolved.applied.map((d) => [d.id, d]));
    return {
      host,
      dirs,
      errors: loaded.errors,
      effect: resolved.effect,
      drivers: loaded.drivers.map((d) => {
        const forced = typeof state[d.id] === 'boolean' ? state[d.id] : null;
        return {
          id: d.id,
          name: d.name,
          version: d.version,
          author: d.author,
          description: d.description,
          priority: d.priority,
          builtin: d.dir === dirs.bundled,
          file: d.file,
          enabled: forced !== null ? forced : d.enabled !== false,
          matched: hit.has(d.id),
          hits: (hit.get(d.id) || {}).hits || [],
        };
      }),
    };
  }

  return {
    // 探测能自动做的（内存、核心、画质、渲染后端）就自动做；
    // 必须管理员权限的（开 Windows 功能、装 AEHD）给按钮；只能进 BIOS 的说清楚怎么改。
    'preflight:run': async () => {
      const preflight = require('../../core/preflight');
      let accel = { ok: false, kind: 'none' };
      try { accel = await live.runtime.provisioner.emulatorAccel(); } catch (_) { /* 运行时还没部署 */ }
      const hw = await preflight.collect({ accel });
      const edition = store.STORE_BUILD ? 'store' : 'installer';
      const report = preflight.evaluate({ hw, settings: store.getSettings(), edition });
      return { ok: true, hw, report, edition };
    },

    /**
     * 应用体检推荐：写设置 + 把这台机器的补丁落成一份驱动。
     * 只写 preflight 明确列出的几个安全项（内存 / 核心 / 画质 / 渲染后端 / 是否锁软件模拟）。
     */
    'preflight:apply': async () => {
      const preflight = require('../../core/preflight');
      const drv = require('../../core/drivers');
      let accel = { ok: false, kind: 'none' };
      try { accel = await live.runtime.provisioner.emulatorAccel(); } catch (_) { /* ignore */ }
      const hw = await preflight.collect({ accel });
      const edition = store.STORE_BUILD ? 'store' : 'installer';
      const report = preflight.evaluate({ hw, settings: store.getSettings(), edition });
      const next = store.saveSettings(report.patch);

      // 把这台机器的参数固化成驱动：以后每次开机都按它来，不用重复体检。
      // 校验一遍再落盘 —— 体检生成的内容同样不能绕过白名单。
      let driverFile = '';
      let driverError = '';
      try {
        const v = drv.validateDriver(report.driver);
        if (!v.ok) throw new Error(v.errors.join('；'));
        const dir = drv.userDir(store);
        fs.mkdirSync(dir, { recursive: true });
        driverFile = path.join(dir, `${v.driver.id}.json`);
        fs.writeFileSync(driverFile, `${JSON.stringify(report.driver, null, 2)}\n`, 'utf8');
        const prev = (next.drivers && next.drivers.state) || {};
        store.saveSettings({ drivers: { state: { ...prev, [v.driver.id]: true } } });
      } catch (e) {
        reportIpcFailure(e);
        driverError = e.message;
      }

      appLog(`体检自动配置：驱动${driverFile ? '已写入' : '未写入'}`);
      return {
        ok: true,
        settings: store.getSettings(),
        driverFile,
        driverError,
        summary: report.summary,
        recommended: report.recommended,
      };
    },

    'drivers:list': () => driverOverview(),

    'drivers:openFolder': async () => {
      const dir = require('../../core/drivers').userDir(store);
      fs.mkdirSync(dir, { recursive: true });
      await shell.openPath(dir);
      return { ok: true, dir };
    },

    'drivers:import': async () => {
      const drv = require('../../core/drivers');
      const r = await dialog.showOpenDialog(live.mainWindow, {
        title: '选择驱动文件（.json）',
        filters: [{ name: '驱动 JSON', extensions: ['json'] }],
        properties: ['openFile'],
      });
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
      const out = drv.importDriver(r.filePaths[0], drv.userDir(store));
      if (out.ok) {
        // 导入即启用：用户特意导入的补丁，默认应该立刻生效
        const s = store.getSettings();
        store.saveSettings({ drivers: { state: { ...(s.drivers.state || {}), [out.driver.id]: true } } });
        send('runtime:log', `已导入驱动：${out.driver.name} v${out.driver.version}`);
      }
      return { ...out, overview: await driverOverview() };
    },

    'drivers:exportTemplate': async () => {
      const drv = require('../../core/drivers');
      const overview = await driverOverview();
      const tpl = drv.templateFromHost(overview.host);
      const r = await dialog.showSaveDialog(live.mainWindow, {
        title: '导出本机驱动模板',
        defaultPath: path.join(drv.userDir(store), `${tpl.id}.json`),
        filters: [{ name: '驱动 JSON', extensions: ['json'] }],
      });
      if (r.canceled || !r.filePath) return { ok: false, canceled: true };
      fs.mkdirSync(path.dirname(r.filePath), { recursive: true });
      fs.writeFileSync(r.filePath, `${JSON.stringify(tpl, null, 2)}\n`, 'utf8');
      return { ok: true, file: r.filePath, template: tpl };
    },

    'drivers:setEnabled': async (_e, { id, enabled } = {}) => {
      const did = String(id || '');
      if (!did) return { ok: false, error: '缺少驱动 id' };
      const s = store.getSettings();
      const prev = (s.drivers && s.drivers.state) || {};
      store.saveSettings({ drivers: { state: { ...prev, [did]: !!enabled } } });
      return { ok: true, overview: await driverOverview() };
    },
  };
}

module.exports = { createDriversHandlers };
