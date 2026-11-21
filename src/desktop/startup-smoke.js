'use strict';

// Opt-in screenshot harness used by the packaged startup tests.
function registerStartupSmoke({ argv, window, writeFile, requestQuit }) {
  if (argv.includes('--smoke') && window) {
    const out = argv[argv.indexOf('--smoke') + 1] || 'smoke.png';
    window.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        try {
          if (argv.includes('--setup')) {
            // 运行时面板已并入设置：--setup 与 --settings 等价，直接打开设置截图
            await window.webContents.executeJavaScript(
              "document.getElementById('btnSettings').click(); true;",
            );
            await new Promise((r) => setTimeout(r, 2500));
          }
          if (argv.includes('--settings')) {
            const opened = await window.webContents.executeJavaScript(`
              (async () => {
                document.getElementById('btnSettings').click();
                for (let i = 0; i < 50; i++) {
                  await new Promise((r) => setTimeout(r, 100));
                  if (document.getElementById('settingsMask').classList.contains('on')) return true;
                }
                return false;
              })()
            `);
            console.log('[smoke] settings opened =', opened);
            await new Promise((r) => setTimeout(r, 600));
            const dbg = await window.webContents.executeJavaScript(
              "JSON.stringify({ on: document.getElementById('settingsMask').classList.contains('on'), qr: !!document.querySelector('#aboutGroup img'), qrH: (document.querySelector('#aboutGroup img')||{}).naturalHeight, ver: (document.getElementById('aboutVer')||{}).textContent, note: (document.getElementById('setupNote')||{}).textContent })",
            );
            console.log('[smoke] dom =', dbg);
          }
          // 窗口可能被遮挡导致拿到旧帧：强制重绘 + 连拍两帧取后一帧
          const snap = async (file) => {
            window.webContents.invalidate();
            await window.webContents.capturePage().catch(() => null);
            await new Promise((r) => setTimeout(r, 400));
            const im = await window.webContents.capturePage();
            writeFile(file, im.toPNG());
            console.log('[smoke] saved', file);
          };
          await snap(out);
          if (argv.includes('--perf')) {
            // 拍一张「性能与资源占用」区（设置页里控件最多的一块）
            await window.webContents.executeJavaScript(
              "document.getElementById('perfGroup').scrollIntoView({ block: 'start' }); true;",
            );
            await snap(out.replace(/\.png$/i, '-perf.png'));
          }
          if (argv.includes('--download')) {
            // 拍一张「下载与更新源」区
            await window.webContents.executeJavaScript(
              "document.getElementById('downloadGroup').scrollIntoView({ block: 'start' }); true;",
            );
            await snap(out.replace(/\.png$/i, '-download.png'));
          }
          if (argv.includes('--settings')) {
            // 再拍一张「关于」区（二维码 / GitHub / Powered by）
            await window.webContents.executeJavaScript(
              "document.getElementById('aboutGroup').scrollIntoView({ block: 'center' }); true;",
            );
            await snap(out.replace(/\.png$/i, '-about.png'));
          }
        } catch (e) {
          console.error('[smoke] 截图失败', e);
        }
        requestQuit();
      }, 6500);
    });
  }
}

module.exports = { registerStartupSmoke };
