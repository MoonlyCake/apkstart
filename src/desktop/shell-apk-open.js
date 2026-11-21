'use strict';

const path = require('node:path');
const { validPackageName } = require('../core/pkgname');

function isWindowsShellApk(filePath, platform = process.platform) {
  return platform === 'win32' && typeof filePath === 'string' && path.win32.extname(filePath).toLowerCase() === '.apk';
}

function createShellApkOpener({ runInstall, runLaunch }) {
  const pending = new Map();
  return function openShellApk(filePath) {
    if (pending.has(filePath)) return pending.get(filePath);
    const operation = (async () => {
      const result = await runInstall(filePath, { shellOpen: true });
      const pkg = result?.app?.package;
      if (result?.ok !== true || !validPackageName(pkg) || pkg !== pkg.trim()) {
        return result?.ok === false ? result : { ok: false, error: '安装未确认有效的安卓应用包名' };
      }
      // Both operations queue work in the same guest. Do not launch from inside the install task.
      return runLaunch(pkg);
    })().finally(() => pending.delete(filePath));
    pending.set(filePath, operation);
    return operation;
  };
}

module.exports = { isWindowsShellApk, createShellApkOpener };
