; ApkStart 自定义 NSIS 脚本
; 只检测本安装目录下的运行时；不按进程名结束系统上的其它模拟器。
; 从程序内卸载时，应用会先通过自己的运行时所有权检查正常关闭虚拟机。
; 否则提示用户退出后重试；不能确认时安全停止，不删除正在使用的安装。
!macro customCheckAppRunning
  Push $0
  ${Do}
    System::Call 'kernel32::SetEnvironmentVariableW(w "APKSTART_INSTALL_CHECK_ROOT", w "$INSTDIR") i .r0'
    ${If} $0 == 0
      StrCpy $0 "error"
    ${Else}
      ; 通过进程环境传入路径，避免将用户选择的安装路径拼进 PowerShell 源码。
      nsExec::Exec /TIMEOUT=8000 `"$PowerShellPath" -NoProfile -NonInteractive -Command "$$ErrorActionPreference='Stop'; try { $$root=[IO.Path]::GetFullPath($$env:APKSTART_INSTALL_CHECK_ROOT).TrimEnd([char]92)+[char]92; foreach($$p in (Get-CimInstance Win32_Process)) { if($$p.Name -notmatch '^(ApkStart|adb|emulator(?:-check|-headless)?|qemu-system-[-a-z0-9_]+|netsimd)\.exe$$'){continue}; if(!$$p.ExecutablePath){exit 2}; if([IO.Path]::GetFullPath($$p.ExecutablePath).StartsWith($$root,[StringComparison]::OrdinalIgnoreCase)){exit 1} }; exit 0 } catch { exit 2 }"`
      Pop $0
      System::Call 'kernel32::SetEnvironmentVariableW(w "APKSTART_INSTALL_CHECK_ROOT", p 0)'
    ${EndIf}
    ${If} $0 == 0
      ${Break}
    ${EndIf}
    MessageBox MB_RETRYCANCEL|MB_ICONEXCLAMATION "无法确认本安装目录已释放。请从托盘退出 Apk Start，并关闭它的 Android 窗口，然后重试。" /SD IDCANCEL IDRETRY +3
    SetErrorLevel 1
    Quit
  ${Loop}
  Pop $0
!macroend

; 安装收尾：再兜一层桌面图标。
; electron-builder 的 createDesktopShortcut 走的是它自己的 CreateShortcuts 流程，
; 个别环境（桌面被 OneDrive 重定向、快捷方式被安全软件回滚）里会生成失败，
; 用户装完发现桌面上什么都没有。这里用 NSIS 原生的 CreateShortcut 再写一次：
; $DESKTOP 走 SHGetFolderPath，能正确跟随桌面的重定向路径；写成幂等操作，
; 和 electron-builder 的重复执行也只是覆盖同一个 .lnk。
!macro customInstall
  DetailPrint "正在创建桌面快捷方式…"
  CreateShortcut "$DESKTOP\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 \
    SW_SHOWNORMAL "" "${PRODUCT_NAME} — 在电脑上直接运行安卓应用"
  CreateDirectory "$SMPROGRAMS\ApkStart"
  CreateShortcut "$SMPROGRAMS\ApkStart\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 \
    SW_SHOWNORMAL "" "${PRODUCT_NAME} — 在电脑上直接运行安卓应用"
!macroend

!macro customUnInstall
  ; 先删自己写的快捷方式入口（未安装 ApkStart 时也应无残留）
  Delete "$DESKTOP\ApkStart.lnk"
  Delete "$SMPROGRAMS\ApkStart\ApkStart.lnk"
  RMDir "$SMPROGRAMS\ApkStart"

!macroend
