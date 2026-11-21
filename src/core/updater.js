'use strict';
/**
 * 在线更新：从 GitHub Releases（MoonlyCake/apkstart）取最新版本，下载并原地替换。
 *
 * 三个形态都要照顾到：
 *   - 安装版（NSIS）：下载 `ApkStart-x.y.z-Setup.exe`，静默安装（/S）；
 *   - 轻量版（便携 zip，运行时按需下载）：下载 `ApkStart-vX-win64-portable.zip`，
 *     解压后覆盖程序目录 —— 运行时目录（%APPDATA%\apkstart\runtime）与已装应用、
 *     快照全都在用户目录里，替换程序文件不会动它们；
 *   - 完整版（便携但带 runtime）：同轻量版，只是目录里多了 resources\runtime。
 *
 * 替换不能在本进程里做（exe 正被占用），所以生成一段 PowerShell 脚本，
 * 用 EncodedCommand 交给独立进程：等本进程退出 → 复制文件 → 重新拉起。
 * 用 base64 传脚本而不是写 .ps1 文件，是为了绕开「路径含中文时脚本被按 GBK 解码」
 * 这类老问题（PowerShell 5.1 读无 BOM 脚本会按 ANSI 解释）。
 */
const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { spawn } = require('child_process');
const { download, downloadParallel, sha256File } = require('./download');
const { ZipFile, resolveZipEntry } = require('./zip');
const { cmpVer } = require('./version');
const {
  UpdateChannel, OWNER, REPO, CHANNEL, RELEASES_URL, releasePageUrl, releaseAssetUrl, versionFromTag,
} = require('./update-channel');
const inc = require('./incremental');

const READY = '.apkstart-ready';
const APPLIED = '.apkstart-apply-attempted';
const FAILURE = '.apkstart-apply-failure';
const SHA256 = /^[a-f0-9]{64}$/i;

function safeRelative(rel) {
  return typeof rel === 'string' && rel.split('/').every((part) => part
    && !/[<>:"|?*\\\x00-\x1f]/.test(part) && !/[. ]$/.test(part));
}

/** Update payloads must be regular, self-contained files; never follow junctions out of them. */
function listPayloadFiles(payload, base = '', items = new Map()) {
  const dir = path.join(payload, base);
  if (!fs.lstatSync(dir).isDirectory()) throw new Error('更新载荷目录无效');
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!base && item.name === READY) continue;
    const rel = base ? `${base}/${item.name}` : item.name;
    if (!safeRelative(rel)) throw new Error('更新包文件名无效');
    if (item.isDirectory()) listPayloadFiles(payload, rel, items);
    else if (item.isFile()) items.set(rel, fs.lstatSync(path.join(payload, rel)).size);
    else throw new Error('更新包包含非普通文件');
  }
  return items;
}

/** 在目录第一层里按名字（大小写不敏感）找文件，返回实际名字或 null */
function findInDir(dir, name) {
  try {
    const lower = name.toLowerCase();
    return fs.readdirSync(dir).find((n) => n.toLowerCase() === lower) || null;
  } catch (_) {
    return null;
  }
}

/**
 * 在程序目录里找 NSIS 卸载器，找不到返回 null。
 * electron-builder 的默认命名是 `Uninstall <productName>.exe`（updater.flavor 认这个），
 * 老版本/自定义打包也可能叫 `uninstaller.exe`（main.js 旧代码只认这个）。
 * 两处必须用同一套规则，否则安装版点「一键卸载」会被误判成便携版（issue #51）。
 */
function findUninstaller(installDir) {
  try {
    const names = fs.readdirSync(installDir);
    return names.find((n) => /^Uninstall .*\.exe$/i.test(n))
      || names.find((n) => /^uninstall(er)?\.exe$/i.test(n))
      || null;
  } catch (_) {
    return null;
  }
}

class Updater {
  /**
   * @param {{currentVersion:string, exePath:string, isPackaged:boolean, dataDir:string,
   *          electronVersion?:string, onProgress?:Function, fetchRelease?:Function}} o
   */
  constructor(o) {
    this.current = o.currentVersion || '0.0.0';
    this.exePath = o.exePath;
    this.installDir = path.dirname(o.exePath || '');
    this.isPackaged = !!o.isPackaged;
    this.dataDir = o.dataDir;
    this.onProgress = o.onProgress || (() => {});
    // 增量更新的前提：本机 Electron 版本与发版时一致（外壳 ABI 没变）。
    // Electron 运行时由调用方（main.js）传 process.versions.electron；测试里可注入。
    this.electronVersion = o.electronVersion || '';
    this.settings = typeof o.settings === 'function' ? o.settings : () => (o.settings || {});
    this.channel = new UpdateChannel(o.fetchRelease);
    this.latest = null;
  }

  /** 安装形态：安装版（有卸载器）还是便携包 */
  get flavor() {
    return findUninstaller(this.installDir) ? 'setup' : 'portable';
  }

  get updateDir() {
    // 旧版的 update 目录可能留有上游载荷；保留原目录但不读取。
    return path.join(this.dataDir, 'update-q');
  }

  /** 检查本 fork 的正式发布，主动检查可绕过短期缓存。 */
  async check(opts = {}) {
    const release = await this.channel.latest({ force: !!opts.force });
    const assets = release?.assets || [];
    const flavor = this.flavor;
    const pick = (re) => assets.find((a) => re.test(a.name));
    // 运行时、增量代码包等辅助资产不能当作可独立运行的整包。
    const packages = assets.filter((a) => !inc.isAuxAsset(a.name));
    const asset = flavor === 'setup'
      ? (packages.find((a) => /Setup\.exe$/i.test(a.name)) || packages.find((a) => /\.exe$/i.test(a.name)))
      : (packages.find((a) => /portable.*\.zip$/i.test(a.name))
        || packages.find((a) => /win64.*\.zip$/i.test(a.name)) || packages.find((a) => /\.zip$/i.test(a.name)));

    const manifestAsset = pick(inc.MANIFEST_RE);
    const appAsset = pick(inc.APP_PACK_RE);
    this.latest = {
      version: release?.version || '',
      tag: release?.tag || '',
      name: release?.name || '',
      notes: release?.notes || '',
      htmlUrl: release?.htmlUrl || RELEASES_URL,
      publishedAt: release?.publishedAt || '',
      releasePublished: !!release,
      asset: asset || null,
      assets,
      sources: release ? [{ source: 'github', name: 'GitHub', tag: release.tag }] : [],
      flavor,
      hasUpdate: !!release && cmpVer(release.version, this.current) > 0,
      current: this.current,
      canAutoApply: !!asset,
      // 只有便携版尝试增量；完整包始终保留为兜底。
      incremental: flavor === 'portable' && manifestAsset && appAsset
        ? { manifest: manifestAsset, app: appAsset }
        : null,
    };
    return this.latest;
  }

  /**
   * 下载并准备载荷：便携版解压到 update-q/<ver>/payload，安装版保留 Setup.exe。
   * @returns {Promise<{mode:'zip'|'app'|'setup', payload:string, version:string}>}
   */
  async prepare(info) {
    const it = info || this.latest;
    if (!it?.asset) throw new Error('这个版本没有可自动安装的安装包，请到 GitHub 发布页手动下载');
    const url = releaseAssetUrl(it.asset, it.tag);
    if (!url || versionFromTag(it.tag) !== it.version || cmpVer(it.version, this.current) <= 0) {
      throw new Error('此安装包不属于可用的 Apk Start --Q 更新，请到 GitHub 发布页下载');
    }
    const dir = path.join(this.updateDir, it.version);
    fs.mkdirSync(dir, { recursive: true });

    // 优先尝试增量：只下清单 + 代码包（几 MB），本机 Electron 版本一致、逐文件
    // 哈希都对得上才采用。任何一步不满足就当作没增量，无缝退回下面的完整包下载。
    // 上次增量替换失败过 → 这次直接走完整包，别再重放坏载荷（resumable 也认这个标记）
    const forcedFull = fs.existsSync(path.join(dir, '.apkstart-force-full'));
    if (it.incremental && it.hasUpdate !== false && !forcedFull) {
      try {
        const job = await this._prepareApp(it, dir);
        if (job) return job;
      } catch (e) {
        this.onProgress({
          stage: 'download', percent: 1,
          message: `增量更新不可用（${e.message}），改用完整包…`,
        });
      }
    }
    return this._prepareFull(it, dir, url);
  }

  /** 下载并准备便携版或 NSIS 安装包。 */
  async _prepareFull(it, dir, url) {
    const file = path.join(dir, it.asset.name);
    const out = path.join(dir, 'payload');
    const isZip = /\.zip$/i.test(file);
    if (isZip && this._payloadReady(out, it.version)) {
      this.onProgress({ stage: 'ready', percent: 100, message: '已有下载好的更新包，直接复用' });
      return { mode: 'zip', payload: out, version: it.version };
    }
    const total = it.asset.size || 0;
    const connections = Math.max(1, Math.min(16, Number((this.settings().runtime || {}).downloadConnections) || 8));

    this.onProgress({ stage: 'download', percent: 1, message: `正在下载 ${it.asset.name}…` });
    await downloadParallel(url, file, {
      connections,
      onProgress: (pr) => {
        const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
        const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
        const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
        this.onProgress({
          stage: 'download',
          percent: Math.max(1, Math.min(99, pct)),
          message: `下载中 ${mb}${sp}`,
          speed: pr.speed,
        });
      },
    });
    if (total > 0 && fs.statSync(file).size !== total) throw new Error('安装包长度与发布记录不符');

    if (isZip) {
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      await this._extract(file, out);
      await this._markPayloadReady(out, it.version);
      this.onProgress({ stage: 'ready', percent: 100, message: '更新包已解压完成' });
      return { mode: 'zip', payload: out, version: it.version };
    }
    this.onProgress({ stage: 'ready', percent: 100, message: '安装包已下载完成' });
    return { mode: 'setup', payload: file, version: it.version, sha256: await sha256File(file) };
  }

  /**
   * 增量更新：下载清单 + 代码包，校验通过后解压成 app 载荷。
   * 返回 null 表示「这次不走增量」（调用方改走完整包）；抛异常也等价，由 prepare 兜底。
   * @returns {Promise<{mode:'app', payload:string, version:string}|null>}
   */
  async _prepareApp(it, dir) {
    if (!it.incremental || !it.incremental.manifest || !it.incremental.app) return null;

    const fetchAsset = async (asset, name, label) => {
      const url = releaseAssetUrl(asset, it.tag);
      if (!url) throw new Error(label + '不在 Apk Start --Q 发布中');
      const target = path.join(dir, name);
      this.onProgress({ stage: 'download', percent: 1, message: `正在获取${label}…` });
      await download(url, target);
      return target;
    };

    const manifestFile = await fetchAsset(it.incremental.manifest, `manifest-${it.version}.json`, '更新清单');
    const manifest = inc.parseManifest(fs.readFileSync(manifestFile, 'utf8'));
    if (String(manifest.version).replace(/^v/i, '') !== String(it.version).replace(/^v/i, '')) {
      throw new Error('清单版本与发行版不一致');
    }
    // 清单声明的 app 资产必须真的是这次 release 里那个（防止挂错旧包）
    const appAsset = it.assets && it.assets.find((a) => a && a.name === manifest.app.asset);
    const choice = inc.chooseMode({
      flavor: this.flavor,
      electronVersion: this.electronVersion,
      manifest,
      assets: appAsset ? [appAsset] : [],
      current: this.current,
    });
    if (choice.mode !== 'app') return null;

    const appFile = await fetchAsset(choice.appAsset, manifest.app.asset, '增量代码包');
    const gotHash = await sha256File(appFile);
    if (String(gotHash).toLowerCase() !== String(manifest.app.sha256).toLowerCase()) {
      throw new Error('增量代码包校验失败（sha256 不符）');
    }

    const payload = path.join(dir, 'app-payload');
    // 上次下载解压成功但替换失败：直接复用（和完整包的 .apkstart-ready 同理）
    if (this._payloadReady(payload, it.version, 'app', manifest.app.files)) {
      this.onProgress({ stage: 'ready', percent: 100, message: '已有下载好的增量包，直接复用' });
      return { mode: 'app', payload, version: it.version, manifest };
    }
    fs.rmSync(payload, { recursive: true, force: true });
    fs.mkdirSync(payload, { recursive: true });
    await this._extract(appFile, payload);
    await this._markPayloadReady(payload, it.version, 'app', manifest.app.files);
    this.onProgress({ stage: 'ready', percent: 100, message: '增量包已校验完成' });
    return { mode: 'app', payload, version: it.version, manifest };
  }

  async _extract(zipPath, dest) {
    const zf = new ZipFile(zipPath);
    try {
      const names = zf.names().filter((n) => !n.endsWith('/'));
      let i = 0;
      for (const n of names) {
        i += 1;
        // 防 zip-slip：统一走 zip.js 的守卫（挡 ../、绝对路径、盘符、反斜杠绕过）
        const target = resolveZipEntry(dest, n);
        if (!target) continue;
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await zf.pipeTo(n, fs.createWriteStream(target));
        if (i % 20 === 0) {
          this.onProgress({
            stage: 'extract',
            percent: Math.min(99, Math.round((i / names.length) * 100)),
            message: `正在解压 ${i}/${names.length}`,
          });
        }
      }
    } finally {
      try { zf.close(); } catch (_) { /* ignore */ }
    }
  }

  /** 载荷就绪标记文件：解压完整落盘后才写，供跨进程复用判断 */
  _readyFile(payload) { return path.join(payload, READY); }

  _checkPayloadStructure(payload, version, mode, entries) {
    const pkg = `${inc.APP_DIR}/package.json`;
    const m = JSON.parse(fs.readFileSync(path.join(payload, pkg), 'utf8'));
    if (m.version !== version || !safeRelative(m.main) || !entries.get(`${inc.APP_DIR}/${m.main}`)) {
      throw new Error('更新包缺少正确版本的应用入口');
    }
    if (mode === 'app') {
      if ([...entries.keys()].some((p) => !p.startsWith(`${inc.APP_DIR}/`))) {
        throw new Error('增量更新包含有应用目录以外的文件');
      }
    } else {
      const exe = path.basename(this.exePath || 'ApkStart.exe');
      if (!entries.get(exe) || !entries.get('resources.pak') || !entries.get('icudtl.dat')) {
        throw new Error('更新包缺少 Electron 运行文件');
      }
    }
  }

  async _markPayloadReady(payload, version, mode = 'zip', expected) {
    const entries = listPayloadFiles(payload);
    this._checkPayloadStructure(payload, version, mode, entries);
    if (expected && Object.keys(expected).length !== entries.size) throw new Error('增量包文件数与清单不符');
    const files = [];
    for (const [rel, size] of entries) {
      const sha256 = await sha256File(path.join(payload, rel));
      if (expected && (expected[rel]?.size !== size || expected[rel]?.sha256?.toLowerCase() !== sha256)) {
        throw new Error('增量包文件与发布清单不符');
      }
      files.push({ rel, size, sha256 });
    }
    fs.writeFileSync(this._readyFile(payload), JSON.stringify({ schema: 2, channel: CHANNEL, version, mode, files }), 'utf8');
  }

  _readPayload(payload, version, mode, expected) {
    if (!fs.lstatSync(this._readyFile(payload)).isFile()) throw new Error('更新载荷清单不是普通文件');
    const raw = fs.readFileSync(this._readyFile(payload));
    const m = JSON.parse(raw);
    if (m.schema !== 2 || m.channel !== CHANNEL || m.version !== version || m.mode !== mode || !Array.isArray(m.files)) {
      throw new Error('更新载荷没有当前版本的完整文件清单');
    }
    if (expected && Object.keys(expected).length !== m.files.length) throw new Error('增量包文件数与清单不符');
    const entries = listPayloadFiles(payload);
    this._checkPayloadStructure(payload, version, mode, entries);
    for (const { rel, size, sha256 } of m.files) {
      if (!safeRelative(rel) || !SHA256.test(sha256) || !Number.isSafeInteger(size) || entries.get(rel) !== size) {
        throw new Error('已下载的更新载荷不完整');
      }
      if (expected && (expected[rel]?.size !== size || expected[rel]?.sha256?.toLowerCase() !== sha256)) {
        throw new Error('增量包文件与发布清单不符');
      }
      entries.delete(rel);
    }
    if (entries.size) throw new Error('更新载荷有不在文件清单中的内容');
    return { digest: createHash('sha256').update(raw).digest('hex'), files: m.files };
  }

  _payloadReady(payload, version, mode = 'zip', expected) {
    try { this._readPayload(payload, version, mode, expected); return true; }
    catch (_) { return false; }
  }

  /**
   * 启动时调用：找回「上次已下载解压、但替换/重启失败」的更新并续做。
   * 直接走本地载荷，不再重新下载（issue #98 的死循环根治）。
   * @returns {{mode:'zip'|'app', payload:string, version:string}|null}
   */
  findResumableJob() {
    try {
      if (!fs.existsSync(this.updateDir)) return null;
      const versions = fs.readdirSync(this.updateDir)
        .filter((n) => versionFromTag(n) === n && cmpVer(n, this.current) > 0)
        .sort((a, b) => cmpVer(b, a));
      for (const v of versions) {
        // An automatic restart must never replay a job whose helper has already been attempted.
        if (fs.existsSync(path.join(this.updateDir, v, APPLIED))) continue;
        // 完整包载荷
        const payload = path.join(this.updateDir, v, 'payload');
        if (this._payloadReady(payload, v)) return { mode: 'zip', payload, version: v };
        // 增量载荷（上次增量替换失败标记了强制完整包 → 不重放）
        const appPayload = path.join(this.updateDir, v, 'app-payload');
        if (!fs.existsSync(path.join(this.updateDir, v, '.apkstart-force-full'))
            && this._payloadReady(appPayload, v, 'app')) {
          return { mode: 'app', payload: appPayload, version: v };
        }
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  takeApplyFailure() {
    try {
      const versions = fs.readdirSync(this.updateDir)
        .filter((v) => versionFromTag(v) === v && cmpVer(v, this.current) > 0)
        .sort((a, b) => cmpVer(b, a));
      for (const version of versions) {
        const file = path.join(this.updateDir, version, FAILURE);
        if (!fs.existsSync(file)) continue;
        fs.unlinkSync(file);
        return { version, error: `更新至 v${version} 未完成。可在设置中手动重试，详情见更新日志。` };
      }
    } catch (_) { /* Missing cache or an inaccessible marker must not block startup. */ }
    return null;
  }

  /**
   * Start the staged Windows apply helper; the caller quits only after it has spawned.
   * With spawn:false return the generated script for isolated tests.
   */
  apply(job, opts = {}) {
    if (!job || versionFromTag(job.version) !== job.version || cmpVer(job.version, this.current) <= 0
        || !['zip', 'app', 'setup'].includes(job.mode)) {
      throw new Error('更新任务无效或不比当前版本新');
    }
    const dir = path.resolve(this.updateDir, job.version);
    const payload = path.resolve(job.payload);
    const mode = job.mode;
    let expected;
    let files;
    if (mode === 'setup') {
      if (path.dirname(payload) !== dir || !/^ApkStart[^\\/]+\.exe$/i.test(path.basename(payload))
          || !SHA256.test(job.sha256 || '') || !fs.lstatSync(payload).isFile()) {
        throw new Error('缺少已校验的安装包');
      }
      expected = job.sha256;
    } else {
      if (payload !== path.join(dir, mode === 'app' ? 'app-payload' : 'payload')) {
        throw new Error('更新载荷目录与任务不符');
      }
      const proof = this._readPayload(payload, job.version, mode);
      expected = proof.digest;
      files = proof.files;
    }
    const waitPid = opts.waitPid ?? process.pid;
    if (!Number.isSafeInteger(waitPid) || waitPid < 0) throw new Error('更新进程 ID 无效');

    const spec = {
      install: fs.realpathSync(this.installDir), exe: path.basename(this.exePath),
      mode, payload, expected, waitPid, version: job.version,
      failure: path.join(dir, FAILURE),
      log: path.join(this.updateDir, 'update.log'),
      forceFull: path.join(dir, '.apkstart-force-full'),
      relaunch: opts.spawn !== false || opts.relaunch !== false,
    };
    const config = Buffer.from(JSON.stringify(spec), 'utf8').toString('base64');
    const script = "$spec = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"
      + config + "')) | ConvertFrom-Json\r\n"
      + fs.readFileSync(path.join(__dirname, 'update-apply.ps1'), 'utf8');
    fs.writeFileSync(path.join(this.updateDir, 'apply.log.ps1'), script, 'utf8');
    if (opts.spawn === false) return script;
    if (this._applyPromise) throw new Error('更新已交给安装程序，正在等待退出');

    // Record the attempt before letting a helper or app restart race another launch.
    fs.writeFileSync(path.join(dir, APPLIED), '', { flag: opts.resume ? 'wx' : 'w' });
    fs.rmSync(spec.failure, { force: true });
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    this._applyPromise = (async () => {
      // Reject corrupted cached content before asking the running app to exit.
      try {
        for (const file of files || [{ rel: '', sha256: expected }]) {
          if (await sha256File(path.join(payload, file.rel)) !== file.sha256.toLowerCase()) {
            throw new Error('更新包校验失败，请重新下载安装包');
          }
        }
      } catch (err) {
        if (mode === 'app') fs.writeFileSync(spec.forceFull, '');
        else if (mode === 'zip') fs.rmSync(this._readyFile(payload), { force: true });
        throw err;
      }
      await new Promise((resolve, reject) => {
        const child = spawn(ps, [
          '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-WindowStyle', 'Hidden', '-EncodedCommand', b64,
        ], { stdio: 'ignore', windowsHide: true });
        child.once('spawn', () => { child.unref(); resolve(true); });
        child.once('error', reject);
      });
      return true;
    })().catch((err) => {
      this._applyPromise = null;
      throw err;
    });
    return this._applyPromise;
  }

  /** 打不开 UI 的场景（或没有可自动安装的资产）时，把发布页丢给浏览器 */
  static repoUrl() {
    return RELEASES_URL;
  }

  static releasePageUrl(url) { return releasePageUrl(url); }
}

module.exports = { Updater, cmpVer, OWNER, REPO, findUninstaller };
