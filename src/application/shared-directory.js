'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');

const io = fs.promises;

async function exists(target) {
  try { return await io.lstat(target); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function directory(input) {
  if (typeof input !== 'string' || !path.isAbsolute(input)) throw new Error('请选择一个绝对路径作为共享目录');
  const tail = [];
  let parent = path.resolve(input);
  for (;;) {
    const entry = await exists(parent);
    if (entry) {
      const real = await io.realpath(parent);
      if (!(await io.stat(real)).isDirectory()) throw new Error('共享路径不是目录：' + input);
      return { path: path.join(real, ...tail), present: tail.length === 0 };
    }
    tail.unshift(path.basename(parent));
    const next = path.dirname(parent);
    if (next === parent) throw new Error('找不到共享路径所在的磁盘：' + input);
    parent = next;
  }
}

function inside(parent, child) {
  const rel = path.relative(parent, child);
  return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
}

async function digest(file) {
  const hash = createHash('sha256');
  for await (const data of fs.createReadStream(file)) hash.update(data);
  return hash.digest('hex');
}

async function planCopy(from, to, plan) {
  for (const entry of await io.readdir(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    const existing = await exists(target);
    if (entry.isDirectory()) {
      if (existing && !existing.isDirectory()) throw new Error('目标目录已存在同名文件或链接：' + target);
      plan.dirs.push(target);
      await planCopy(source, target, plan);
    } else if (entry.isFile()) {
      if (!existing) { plan.files.push({ source, target }); continue; }
      if (!existing.isFile() || existing.size !== (await io.stat(source)).size || await digest(source) !== await digest(target)) {
        throw new Error('目标目录已有不同内容的同名文件，未覆盖：' + target);
      }
      plan.unchanged++;
    } else {
      throw new Error('共享目录含链接或不支持的文件类型，未自动复制：' + source);
    }
  }
}

async function prepareSharedDirectory({ from, to, migrate = false }) {
  const target = await directory(to);
  const plan = { dirs: [], files: [], unchanged: 0 };
  if (migrate) {
    const source = await directory(from);
    if (!path.relative(source.path, target.path)) return { path: target.path, copied: 0, unchanged: 0 };
    if (inside(source.path, target.path) || inside(target.path, source.path)) {
      throw new Error('新旧共享目录不能互为上级或子目录');
    }
    if (source.present) await planCopy(source.path, target.path, plan);
  }

  let copied = 0;
  try {
    // 先查完所有冲突再写。COPYFILE_EXCL 也防止扫描后新出现的同名文件被覆盖。
    await io.mkdir(target.path, { recursive: true });
    for (const dir of plan.dirs) {
      try { await io.mkdir(dir); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      if (!(await io.lstat(dir)).isDirectory()) throw new Error('目标目录已被替换：' + dir);
    }
    for (const { source, target: file } of plan.files) {
      const parent = path.dirname(file);
      if (path.relative(parent, await io.realpath(parent)) || !(await io.lstat(source)).isFile()) {
        throw new Error('文件或目标目录在迁移时被替换');
      }
      await io.copyFile(source, file, fs.constants.COPYFILE_EXCL);
      copied++;
    }
  } catch (error) {
    throw new Error('共享目录未切换，原目录未修改。目标目录已复制 ' + copied + ' 个文件：' + error.message, { cause: error });
  }
  return { path: target.path, copied, unchanged: plan.unchanged };
}

module.exports = { prepareSharedDirectory };
