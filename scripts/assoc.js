#!/usr/bin/env node
'use strict';

const path = require('node:path');
const { registerAssociation, unregisterAssociation } = require('../src/core/assoc');

const action = process.argv[2] || 'on';
const appDir = path.join(__dirname, '..');
// 这个脚本由 npm 在源码树内运行，不能把运行脚本的 node.exe 注册为打包版。
const exe = path.join(appDir, 'node_modules', 'electron', 'dist', 'electron.exe');
const extraArgs = '"' + appDir + '"';

async function main() {
  let result;
  if (action === 'on') {
    const icon = path.join(appDir, 'src', 'ui', 'assets', 'appicon.ico');
    result = await registerAssociation(exe, icon, extraArgs);
    if (result.ok && result.effective) {
      console.log('已验证：资源管理器中的 .apk 由这份 Apk Start 打开。');
      return;
    }
  } else if (action === 'off') {
    result = await unregisterAssociation(exe, extraArgs);
    if (result.ok) {
      console.log(result.removed ? '已取消这份 Apk Start 的 .apk 关联。' : '当前安装未持有关联，没有更改。');
      return;
    }
  } else {
    console.error('用法：node scripts/assoc.js [on|off]');
    process.exitCode = 1;
    return;
  }
  console.error(result.error || '未能确认 .apk 默认应用。');
  if (result.settingsUri) console.error(result.settingsUri);
  process.exitCode = 1;
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
