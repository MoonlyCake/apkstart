'use strict';

const { createHash } = require('node:crypto');
const { promises: fs } = require('node:fs');
const path = require('node:path');
const { ZipArchive, resolveZipEntry } = require('./zip');

// Google 的 SDK 附加组件索引 addon2-3.xml 发布的是 SHA-1，不是 SHA-256。
// 固定版本、大小、摘要和官方 HTTPS 地址；不给将以管理员权限运行的包使用镜像源。
const GOOGLE_AEHD = Object.freeze({
  filename: 'aehd-windows_v2.2.zip',
  url: 'https://dl.google.com/android/repository/aehd-windows_v2.2.zip',
  size: 175928,
  sha1: 'b3f53739d1395b19276195466a2fcf95d86a031e',
});

function verifyArchive(bytes, pin) {
  if (!Buffer.isBuffer(bytes) || bytes.length !== pin.size) throw new Error('AEHD 驱动包大小不符');
  const digest = createHash('sha1').update(bytes).digest('hex');
  if (digest !== pin.sha1) throw new Error('AEHD 驱动包 SHA-1 校验失败');
  return bytes;
}

async function readCache(dir, pin) {
  try {
    const file = path.join(dir, pin.filename);
    const info = await fs.lstat(file);
    if (!info.isFile() || info.size !== pin.size) return null;
    return verifyArchive(await fs.readFile(file), pin);
  } catch (_) { return null; } // 旧提取文件和损坏的 ZIP 都不能取代官方字节。
}

async function fetchOfficialArchive(pin, request) {
  let response;
  try {
    response = await request(pin.url, { redirect: 'error', signal: AbortSignal.timeout(45000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > pin.size) throw new Error('响应超过预期的文件大小');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, size);
  } catch (error) {
    throw new Error(`无法从 Google 官方源下载 AEHD：${error.message}`, { cause: error });
  }
}

function packageEntries(bytes) {
  const zip = new ZipArchive(bytes);
  const files = zip.names().filter((name) => !name.endsWith('/'));
  const installer = files.find((name) => /^silent_install\.bat$/i.test(name));
  if (!installer || !files.some((name) => /^aehd\.sys$/i.test(name))) {
    throw new Error('AEHD 驱动包缺少安装脚本或驱动文件');
  }
  return { installer, files: files.map((name) => [name, zip.read(name)]) };
}

async function writePackageFiles({ files }, dir) {
  for (const [name, bytes] of files) {
    const target = resolveZipEntry(dir, name);
    if (!target || target === path.resolve(dir)) throw new Error('AEHD 驱动包包含无效路径');
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes, { flag: 'wx' });
  }
}

async function createStaging(tmp) {
  await fs.mkdir(tmp, { recursive: true });
  return fs.mkdtemp(path.join(path.resolve(tmp), 'aehd-'));
}

async function removeStaging(dir) {
  await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }).catch(() => {
    // Windows 暂时锁住文件时保留在独立暂存目录，不影响安装结果且不会被下一次复用。
  });
}

function createAehdPackage({ pin = GOOGLE_AEHD, request = (...args) => fetch(...args) } = {}) {
  async function load(paths, onProgress) {
    const dirs = new Set([paths.aehdDir, path.join(paths.root, 'aehd')]);
    for (const dir of dirs) {
      const cached = await readCache(dir, pin);
      if (cached) return cached;
    }
    onProgress({ stage: 'download', message: '从 Google 官方源下载 AEHD 驱动…', percent: 10 });
    return verifyArchive(await fetchOfficialArchive(pin, request), pin);
  }

  return {
    async prepare(paths, onProgress = () => {}) {
      const bytes = await load(paths, onProgress);
      // 保留原有离线打包所需的解压目录，同时将可复核的原包一并保存。
      const archive = packageEntries(bytes);
      const dir = await createStaging(paths.aehdDir);
      try {
        await writePackageFiles(archive, dir);
        await fs.writeFile(path.join(dir, pin.filename), bytes, { flag: 'wx' });
        // 源和目标属于同一目录，将已写完的文件替换出去；原包最后发布。
        for (const name of [...archive.files.map(([name]) => name), pin.filename]) {
          const target = resolveZipEntry(paths.aehdDir, name);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.rename(resolveZipEntry(dir, name), target);
        }
      } finally { await removeStaging(dir); }
      return { ok: true, dir: paths.aehdDir, installer: path.join(paths.aehdDir, archive.installer) };
    },
    async withInstaller(paths, onProgress, run) {
      // 用已校验的同一个 Buffer 解压，绝不执行运行时目录或旧版本留下的解压脚本。
      const archive = packageEntries(await load(paths, onProgress));
      const dir = await createStaging(paths.tmp);
      try {
        await writePackageFiles(archive, dir);
        onProgress({ stage: 'done', message: 'AEHD 已校验，等待管理员授权', percent: 100 });
        return await run(path.join(dir, archive.installer));
      } finally { await removeStaging(dir); }
    },
  };
}

module.exports = { GOOGLE_AEHD, createAehdPackage };
