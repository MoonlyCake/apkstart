'use strict';
// 手动桌面操作：node test/uiact.js --live click 800 40
// 无显式参数时不发送桌面输入，包含 node --test 自动发现。
if (process.argv[2] !== '--live') {
  console.log('跳过实机诊断；手动执行请传入 --live。');
  process.exit(0);
}
const { spawnSync } = require('child_process');
const path = require('path');

const exe = process.env.SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\' + 'power' + 'shell.exe';
const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'uiact.ps1')];
const [act, x, y] = process.argv.slice(3);
if (!act) throw new Error('缺少桌面操作参数');
args.push('-Act', act, '-X', String(x || 0), '-Y', String(y || 0));
const r = spawnSync(exe, args, { encoding: 'utf8', windowsHide: true });
process.stdout.write(r.stdout || '');
if (r.stderr) process.stderr.write(r.stderr);
