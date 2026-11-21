'use strict';
/* 兼容模式端到端验证：走产品代码路径 boot（API 34 Play 镜像）→ abilist → 装 ARM APK → 启动 */
// node --test may discover this file; only an explicit manual run may change the live profile.
if (process.argv[2] !== '--live') {
  console.log('跳过实机诊断；手动执行请传入 --live。');
  process.exit(0);
}
process.env.ANDROID_ADB_SERVER_PORT = process.env.ANDROID_ADB_SERVER_PORT || '5038';
const fs = require('fs');
const path = require('path');
const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');

const ROOT = path.join(__dirname, '..');
const APK = process.argv[3];

(async () => {
  if (APK && !fs.existsSync(APK)) throw new Error(`未找到指定 APK：${APK}`);
  const original = store.getSettings().runtime.compatImage;
  store.saveSettings({ runtime: { compatImage: true } });
  try {
    const rt = new Runtime(ROOT);

    console.log('[1] ensure()（兼容模式 → 应启动 Google Play / API 34 镜像）');
    const r = await rt.ensure({ onLog: (m) => console.log('    [boot]', m) });
    if (!r.ok) throw new Error(r.error || '安卓未就绪');
    console.log('    engine =', r.engine, r.reused ? '(复用已有实例)' : '');

    const c = rt.client();
    console.log('[2] release =', await c.shell('getprop ro.build.version.release'));
    console.log('    sdk     =', await c.shell('getprop ro.build.version.sdk'));
    console.log('    abilist =', await c.shell('getprop ro.product.cpu.abilist'));
    console.log('    tag     =', await c.shell('getprop ro.build.tags'));

    if (APK) {
      const { package: packageName } = require('../src/core/apk').parseApk(APK);
      const ins = await c.install(APK);
      console.log('[3] install =', ins);
      await c.startApp(packageName);
      const pids = await c.appProcessIds(packageName);
      if (!pids.length) throw new Error('应用启动后没有运行中的进程');
      console.log('[4] pid =', pids.join(', '));
    }
  } finally {
    // Do not overwrite a setting the user changed during a manual run.
    if (store.getSettings().runtime.compatImage === true && original !== true) {
      store.saveSettings({ runtime: { compatImage: original } });
    }
  }
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
