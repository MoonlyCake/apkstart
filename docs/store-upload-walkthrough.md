# Apk Start --Q：Microsoft Store 上架操作单

MoonlyCake 维护的分支尚未确认独立的 Microsoft Store 产品身份。下面是准备与核对流程，不表示已经上架；常规 Windows 构建仍从 [GitHub Releases](https://github.com/MoonlyCake/apkstart/releases) 分发。

## 1. 创建独立产品

在 [Partner Center](https://partner.microsoft.com/dashboard) 创建新的 MSIX 产品，预留产品名。不要复用上游的产品或包身份。使用本分支的[隐私政策](https://github.com/MoonlyCake/apkstart/blob/main/docs/privacy.md)和[反馈入口](https://github.com/MoonlyCake/apkstart/issues)。

## 2. 用本产品身份打包

打开 Product management → Product identity，逐字复制本产品的包名、发布者字段和发布者显示名：

~~~powershell
$env:APKSTART_MSIX_IDENTITY = Read-Host 'Package/Identity/Name'
$env:APKSTART_MSIX_PUBLISHER = Read-Host 'Package/Identity/Publisher'
$env:APKSTART_MSIX_PUBLISHER_DISPLAY = Read-Host 'Package/Properties/PublisherDisplayName'
$env:APKSTART_MSIX_DISPLAY = Read-Host '预留的产品显示名'
node build/msix.js --store --print-manifest
node build/msix.js --store
~~~

第一条命令仅检查生成的清单，第二条才打包。细节及前置工具见 [MSIX 构建说明](store-msix.md)。不带 --store 的默认包使用 MoonlyCake 的本地测试身份，只能试装，不能提交；本地测试包与商店待提交包分别放在 dist/store-local 和 dist/store。

## 3. 准备并上传

- 把 dist/store 下与当前版本匹配的 MSIX 上传到上述独立产品，核对清单身份和商店校验结果。
- 填写当前版本的产品说明、系统要求、年龄分级与审核备注；用当前构建生成截图。
- [上游旧上架资料](store-listing.md)只可参考，不能照抄旧版本的身份、功能或兼容性承诺。
- 确认账号、显示名、实际包与文案一致后再提交审核。
