# ApkStart 商店上架 · 一键打开所需窗口
# 用法：右键 → 使用 PowerShell 运行
# 作用：把上架需要的 4 个东西一次摆到桌面上，省去翻目录

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
# 版本号从 package.json 现取，别在脚本里写死 —— 每次抬版本都改这里迟早会改漏。
# MSIX 的版本是四段式（0.5.2 → 0.5.2.0），和 build/msix.js 的规则保持一致。
try {
    # 必须显式 -Encoding UTF8：Windows PowerShell 5.1 的默认编码是 ANSI，
    # 而 package.json 里有中文 description，按 ANSI 读会得到乱码 → ConvertFrom-Json 直接抛错。
    $pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
    $ver = ('{0}.0' -f $pkg.version)
} catch {
    throw '读不到本仓库的 package.json，无法定位商店包。'
}
$msix = Join-Path $root ('dist\store\ApkStart_{0}_x64.msix' -f $ver)
$guide = Join-Path $root 'docs\store-upload-walkthrough.md'
$listing = Join-Path $root 'docs\store-listing.md'

Write-Host ''
Write-Host '  Apk Start --Q 上架助手 · MoonlyCake' -ForegroundColor Green
Write-Host '  ─────────────────────────────' -ForegroundColor DarkGray

if (-not (Test-Path $msix)) {
    Write-Host "  [!] 找不到安装包：$msix" -ForegroundColor Red
    Write-Host '      先配置本产品的 Partner Center 身份，再跑 node build/msix.js --store。' -ForegroundColor DarkGray
} else {
    $mb = [math]::Round((Get-Item $msix).Length / 1MB, 1)
    Write-Host "  [1] 安装包  $mb MB" -ForegroundColor Cyan
    Write-Host '      已选中在资源管理器里，上传时直接拖进去' -ForegroundColor DarkGray
    Start-Process explorer.exe "/select,`"$msix`""
}

Write-Host '  [2] Partner Center（浏览器打开，需你登录）' -ForegroundColor Cyan
Start-Process 'https://partner.microsoft.com/dashboard/apps-and-games'

if (Test-Path $guide) {
    Write-Host '  [3] 本分支上架操作单' -ForegroundColor Cyan
    Start-Process $guide
}

if (Test-Path $listing) {
    Write-Host '  [4] 上游历史 listing，仅参考，请按当前构建重新核对' -ForegroundColor Cyan
    Start-Process $listing
}

Write-Host ''
Write-Host '  顺序：新建产品 → 上传包 → 粘 listing → 提交' -ForegroundColor Yellow
Write-Host '  隐私政策：https://github.com/MoonlyCake/apkstart/blob/main/docs/privacy.md' -ForegroundColor DarkGray
Write-Host ''
