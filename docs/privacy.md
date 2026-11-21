# Apk Start --Q 隐私政策 / Privacy Policy

最后更新 / Last updated：2026-11-22

## 简体中文

Apk Start --Q 是由 MoonlyCake 维护、在本机运行的 Android 应用运行器。我们的原则很简单：**不收集、不上传、不分享你的个人数据。**

### 1. 我们不收集什么

- 不收集账号、姓名、邮箱、手机号等身份信息（本应用没有账号系统）。
- 不收集设备标识符、广告 ID、位置信息。
- 不集成任何统计、埋点、崩溃上报或广告 SDK。
- 不向我们的服务器发送任何数据（本应用没有自有服务器）。

### 2. 本机保存的数据

以下数据只保存在你自己的电脑上，不会离开设备：

| 位置 | 内容 |
|---|---|
| `%USERPROFILE%\ApkStart\data`（Microsoft Store 版）或 `%APPDATA%\apkstart`（安装版 / 便携版） | 默认运行时与安卓数据位置；包括系统镜像、已安装应用、应用数据和快照 |
| `%USERPROFILE%\ApkStartShared` | 与安卓 `/sdcard/ApkStartShared` 双向同步的共享文件夹 |

卸载 Microsoft Store 版本不会自动删除上述目录；你可以随时手动删除。

### 3. 联网行为

- **Microsoft Store 版**：安装包已内置全部运行时，首次启动只做本地解压，不下载任何可执行内容；应用更新由 Microsoft Store 负责。
- **安装版 / 便携版**：启动后或主动检查时，向本分支的 GitHub Releases 查询软件更新。部署缺失的 Android 运行时时，可能从上游发行源、镜像站或 Google 官方 Android SDK 源下载运行时组件。
- 安卓应用自身的网络访问由该应用决定，走 QEMU 用户态 NAT 复用主机网络，ApkStart 不做内容审查或转发留存。

### 4. 第三方

你通过 ApkStart 运行的安卓应用由各自的开发者提供，其数据处理行为适用各自的隐私政策。ApkStart 不控制也不代表这些第三方应用。

### 5. 儿童

本应用不面向 13 岁以下儿童，也不会有意收集儿童信息。

### 6. 变更与联系

政策如有变更，会更新本页面并修改「最后更新」日期。
问题请提交 issue 到 https://github.com/MoonlyCake/apkstart/issues

---

## English

Apk Start --Q is a locally running Android app runner maintained by MoonlyCake. Our principle is simple: **we do not collect, upload, or share your personal data.**

- No account system, no identity data, no device identifiers, no advertising ID, no location.
- No analytics, telemetry, crash-reporting, or advertising SDKs.
- No data is sent to any server operated by us — we do not operate one.

Local data (never leaves your device):

| Path | Content |
|---|---|
| `%USERPROFILE%\ApkStart\data` (Microsoft Store) or `%APPDATA%\apkstart` (installer / portable) | Default runtime and Android data locations, including system images, installed apps, app data, and snapshots |
| `%USERPROFILE%\ApkStartShared` | Shared folder synced with `/sdcard/ApkStartShared` inside Android |

Network behaviour:
- **Microsoft Store build**: all runtime components are bundled; first launch only extracts locally. Updates are delivered by Microsoft Store.
- **Installer / portable build**: The app checks GitHub Releases for this fork after startup or when requested. Provisioning a missing Android runtime can download runtime components from upstream releases, mirrors, or the official Google Android SDK distribution.
- Network access from Android apps is decided by those apps. Traffic uses QEMU user-mode NAT over the host network; ApkStart does not inspect or retain it.

Third-party apps you run are provided by their own developers and governed by their own privacy policies.

Contact: open an issue at https://github.com/MoonlyCake/apkstart/issues
