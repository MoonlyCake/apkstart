'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

function hasStockDataTemplate(imageDir) {
  if (!imageDir) return false;
  const dir = path.join(imageDir, 'data');
  return !!fs.lstatSync(dir, { throwIfNoEntry: false })?.isDirectory()
    && !fs.lstatSync(path.join(dir, 'empty_data_disk'), { throwIfNoEntry: false });
}

function adbKeyToken(text) {
  const m = /^([A-Za-z0-9+/]{699}=)(?:[ \t][^\r\n]*)?\r?\n?$/.exec(text);
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64');
  return decoded.length === 524 && decoded.readUInt32LE(0) === 64
    && decoded.toString('base64') === m[1] ? m[1] : null;
}

function readPublicKey(file) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  return stat?.isFile() && stat.size <= 4096 ? adbKeyToken(fs.readFileSync(file, 'utf8')) : null;
}

function derivePublicKey(adbPath, keyPath) {
  const { status, stdout } = spawnSync(adbPath, ['pubkey', keyPath], {
    encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 16384,
  });
  return status === 0 ? adbKeyToken(stdout) : null;
}

/** 仅为全新的自管 AVD 准备官方 Emulator 读取的公钥，不复制私钥或改写 guest。 */
function stageBootPublicKey(emulatorHome, adbPath, {
  hostHome = process.platform === 'win32' ? os.userInfo().homedir : os.homedir(),
  publicFromPrivate = derivePublicKey,
} = {}) {
  if (!adbPath || !path.isAbsolute(hostHome)) return false;
  // 官方 ADB 在 Windows 用账户的 CSIDL_PROFILE，而不是 ANDROID_EMULATOR_HOME。
  const keyPath = path.join(hostHome, '.android', 'adbkey');
  const publicToken = readPublicKey(`${keyPath}.pub`);
  if (!publicToken || !fs.lstatSync(keyPath, { throwIfNoEntry: false })?.isFile()
    || publicFromPrivate(adbPath, keyPath) !== publicToken) return false;

  const dest = path.join(emulatorHome, 'adbkey.pub');
  if (fs.lstatSync(dest, { throwIfNoEntry: false })) return readPublicKey(dest) === publicToken;
  fs.writeFileSync(dest, `${publicToken} apkstart-host\n`, { flag: 'wx', mode: 0o600 });
  return true;
}

module.exports = { hasStockDataTemplate, stageBootPublicKey };
