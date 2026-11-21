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
const { spawn } = require('child_process');
const { download, downloadParallel, sha256File } = require('./download');
const { ZipFile, resolveZipEntry } = require('./zip');
const { cmpVer } = require('./version');
const {
  UpdateChannel, OWNER, REPO, CHANNEL, RELEASES_URL, releasePageUrl, releaseAssetUrl, versionFromTag,
} = require('./update-channel');
const inc = require('./incremental');

/** PowerShell 单引号字符串：内部的 ' 要写成 '' */
function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
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

    if (isZip) {
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      await this._extract(file, out);
      this._markPayloadReady(out, it.version);
      this.onProgress({ stage: 'ready', percent: 100, message: '更新包已解压完成' });
      return { mode: 'zip', payload: out, version: it.version };
    }
    this.onProgress({ stage: 'ready', percent: 100, message: '安装包已下载完成' });
    return { mode: 'setup', payload: file, version: it.version };
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
    if (this._payloadReady(payload, it.version, 'app')) {
      this.onProgress({ stage: 'ready', percent: 100, message: '已有下载好的增量包，直接复用' });
      return { mode: 'app', payload, version: it.version, manifest };
    }
    fs.rmSync(payload, { recursive: true, force: true });
    fs.mkdirSync(payload, { recursive: true });
    await this._extract(appFile, payload);
    // 逐文件校验：防止不完整或不匹配的代码层落盘。
    const bad = await inc.verifyExtracted({ payload, files: manifest.app.files });
    if (bad.length) throw new Error(`增量代码包有 ${bad.length} 个文件校验不通过`);

    this._markPayloadReady(payload, it.version, 'app');
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
  _readyFile(payload) { return path.join(payload, '.apkstart-ready'); }

  _markPayloadReady(payload, version, mode = 'zip') {
    try {
      fs.writeFileSync(this._readyFile(payload), JSON.stringify({ channel: CHANNEL, version, at: Date.now(), mode }), 'utf8');
    } catch (_) { /* 标记写不了就下次重下，不影响正确性 */ }
  }

  _payloadReady(payload, version, mode = 'zip') {
    try {
      if (!fs.existsSync(this._readyFile(payload))) return false;
      const m = JSON.parse(fs.readFileSync(this._readyFile(payload), 'utf8'));
      if (m.channel !== CHANNEL || m.version !== version || m.mode !== mode) return false;
      if (mode === 'app') {
        // 增量载荷没有 exe；它的「主文件」是 resources/app/package.json
        return fs.existsSync(path.join(payload, 'resources', 'app', 'package.json'));
      }
      // 完整载荷：程序主 exe 必须在。没有说明解压中断/被杀软删过。
      const exeName = path.basename(this.exePath || 'ApkStart.exe');
      return !!findInDir(payload, exeName);
    } catch (_) {
      return false;
    }
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

  /**
   * 生成并启动「替换 + 重启」脚本，然后调用方负责退出应用。
   * @param {{mode:'zip'|'app'|'setup', payload:string, version:string}} job
   * @param {{waitPid?:number, spawn?:boolean}} [opts] 测试时可指定别的 pid / 不真启动
   */
  apply(job, opts = {}) {
    const exe = this.exePath;
    const dir = this.installDir;
    const logFile = path.join(this.updateDir, 'update.log');
    fs.mkdirSync(this.updateDir, { recursive: true });
    const waitPid = opts.waitPid || process.pid;

    const lines = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$log = ${psq(logFile)}`,
      `function Note($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }`,
      `Note 'updater start'`,
      `$applyOk = $true`,
      // 等本进程真正退出（最多 90 秒），否则 exe/dll 仍被占用
      `try { Wait-Process -Id ${waitPid} -Timeout 90 } catch { }`,
      `Start-Sleep -Milliseconds 700`,
    ];

    if (job.mode === 'zip') {
      // issue #98：旧脚本只测「目标 exe 是否存在」——它本来就存在，于是 copy
      // 失败也被当成成功，接着删掉载荷、重启旧版本 → 下次开机又检测到更新 → 死循环。
      // 改成：复制前先把目标 exe 改名成 .old，复制后确认新 exe 真的落盘且字节数
      // 与载荷一致；失败则回滚 .old，并**保留载荷**交给下次启动续做。
      const exeName = path.basename(exe);
      lines.push(
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$exeName = ${psq(exeName)}`,
        `$target = Join-Path $dst $exeName`,
        `$srcExe = Join-Path $src $exeName`,
        `$expected = (Get-Item $srcExe).Length`,
        `$backup = "$target.old"`,
        `$hasBackup = $false`,
        `if (Test-Path $target) {`,
        `  try { Move-Item -LiteralPath $target -Destination $backup -Force; $hasBackup = $true } catch { Note "backup failed: $_" }`,
        `}`,
        `$ok = $false`,
        `for ($i = 1; $i -le 12; $i++) {`,
        `  Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force`,
        `  if ((Test-Path $target) -and ((Get-Item $target).Length -eq $expected)) { $ok = $true; Note "copy pass $i ok"; break }`,
        `  Note "copy pass $i failed, retry"; Start-Sleep -Milliseconds 600`,
        `}`,
        `if (-not $ok) {`,
        `  Note 'copy FAILED - keeping payload for next launch'`,
        `  $applyOk = $false`,
        `  if ($hasBackup) { try { Move-Item -LiteralPath $backup -Destination $target -Force } catch {} }`,
        `} else {`,
        `  if ($hasBackup) { try { Remove-Item -LiteralPath $backup -Force } catch {} }`,
        // 只有确认复制成功，才清掉载荷与就绪标记；否则留给 findResumableJob 续做。
        `  try { Remove-Item -LiteralPath (Join-Path $src '.apkstart-ready') -Force } catch {}`,
        `  Remove-Item -Path $src -Recurse -Force`,
        `}`,
      );
    } else if (job.mode === 'app') {
      // 增量替换：只覆盖 resources\app（我们的 JS / 资源 / node_modules）。
      // Electron 外壳（exe / dll / locales）一律不动 —— 所以更新从 ~100MB 降到几 MB。
      // 同样先改名备份 + 校验新 package.json 版本，失败回滚并保留载荷供续做。
      const appRel = path.join('resources', 'app');
      lines.push(
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$appRel = ${psq(appRel)}`,
        `$appDst = Join-Path $dst $appRel`,
        `$appSrc = Join-Path $src $appRel`,
        `$pkgDst = Join-Path $appDst 'package.json'`,
        `$backup = "$appDst.old"`,
        `$hasBackup = $false`,
        `if (Test-Path $appDst) {`,
        `  try { Move-Item -LiteralPath $appDst -Destination $backup -Force; $hasBackup = $true } catch { Note "app backup failed: $_" }`,
        `}`,
        `$ok = $false`,
        `for ($i = 1; $i -le 12; $i++) {`,
        `  New-Item -ItemType Directory -Force -Path $appDst | Out-Null`,
        `  Copy-Item -Path (Join-Path $appSrc '*') -Destination $appDst -Recurse -Force`,
        `  if (Test-Path $pkgDst) {`,
        `    try {`,
        `      $pv = (Get-Content -LiteralPath $pkgDst -Raw | ConvertFrom-Json).version`,
        `      if ($pv -eq ${psq(job.version)}) { $ok = $true; Note "app copy pass $i ok"; break }`,
        `    } catch { Note "app version check: $_" }`,
        `  }`,
        `  Note "app copy pass $i failed, retry"; Start-Sleep -Milliseconds 500`,
        `}`,
        `if (-not $ok) {`,
        `  Note 'app copy FAILED - rollback and keep payload'`,
        `  $applyOk = $false`,
        // 增量替换真失败了（不是瞬时占用）：留个标记，下次启动强制走完整包，
        // 避免resumable 无限重放同一个坏载荷 —— 这是 issue #98 死循环的增量版。
        `  try { New-Item -ItemType File -Force -Path ${psq(path.join(this.updateDir, job.version, '.apkstart-force-full'))} | Out-Null } catch {}`,
        `  if (Test-Path $appDst) { try { Remove-Item -LiteralPath $appDst -Recurse -Force } catch {} }`,
        `  if ($hasBackup) { try { Move-Item -LiteralPath $backup -Destination $appDst -Force } catch {} }`,
        `} else {`,
        `  if ($hasBackup) { try { Remove-Item -LiteralPath $backup -Recurse -Force } catch {} }`,
        `  try { Remove-Item -LiteralPath (Join-Path $src '.apkstart-ready') -Force } catch {}`,
        `}`,
      );
    } else {
      lines.push(
        `Note 'run installer'`,
        `$p = Start-Process -FilePath ${psq(job.payload)} -ArgumentList '/S' -PassThru -Wait`,
        `Note ("installer exit " + $p.ExitCode)`,
        `Start-Sleep -Milliseconds 800`,
      );
    }

    lines.push(
      // issue #98：只 Start-Process 一次、失败就无声无息 → 用户看到「关了但没重启」。
      // 加 -WorkingDirectory（便携版相对路径资源），失败再退回 cmd /c start，并写日志。
      `if (Test-Path ${psq(exe)}) {`,
      `  try {`,
      `    Start-Process -FilePath ${psq(exe)} -WorkingDirectory ${psq(dir)} -ErrorAction Stop`,
      `    Note 'relaunched via Start-Process'`,
      `  } catch {`,
      `    Note ("Start-Process failed: " + $_.Exception.Message + "; fallback to cmd start")`,
      `    try {`,
      `      Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','start','""',${psq(exe)} -WorkingDirectory ${psq(dir)} -WindowStyle Hidden`,
      `      Note 'relaunched via cmd start'`,
      `    } catch { Note ("cmd start failed: " + $_.Exception.Message) }`,
      `  }`,
      `} else { Note 'relaunch skipped: exe missing' }`,
      `Note 'updater done'`,
      `Start-Sleep -Milliseconds 400`,
      // 复制失败时保留整个版本目录（载荷 + 就绪标记），交给下次启动续做；
      // 否则会前脚说「保留载荷」后脚又把它删掉，续做永远拿不到文件。
      `if ($applyOk) { Remove-Item -Path ${psq(path.join(this.updateDir, job.version))} -Recurse -Force }`,
      `else { Note 'version dir kept for resume on next launch' }`,
      // 收尾的清理语句失败（目录已被删/被杀软占用）不应该让调用方以为更新失败
      `exit 0`,
    );

    const script = lines.join('\r\n');
    fs.writeFileSync(path.join(this.updateDir, 'apply.log.ps1'), script, 'utf8');
    if (opts.spawn === false) return script;
    // -EncodedCommand 走 UTF-16LE base64：脚本里出现中文路径也不会被 GBK 解码搞坏
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // 这里**不能**用 detached：某些安全软件 / 沙箱策略会直接拦掉「分离的控制台进程」，
    // 表现为脚本一声不响地根本没跑（更新界面卡在「正在替换程序并重启」）。
    // Windows 上父进程退出并不会杀掉普通子进程，所以用「普通子进程 + unref」同样能在
    // 我们退出之后继续干活，兼容性还更好。
    const child = spawn(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-EncodedCommand', b64,
    ], { stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  }

  /** 打不开 UI 的场景（或没有可自动安装的资产）时，把发布页丢给浏览器 */
  static repoUrl() {
    return RELEASES_URL;
  }

  static releasePageUrl(url) { return releasePageUrl(url); }
}

module.exports = { Updater, cmpVer, OWNER, REPO, findUninstaller };
