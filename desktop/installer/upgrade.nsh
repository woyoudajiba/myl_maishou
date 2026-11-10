!include LogicLib.nsh
!define PC_UPGRADE_HELPER "${__FILEDIR__}\close-installed-app.ps1"
Var PCPolicySaved
Var PCPreviousExecutionPolicy
Var PCWindowsPowerShell

; Run the check for every installer, including updates launched by an old desktop
; version. Never skip it merely because the installer parent is the application.
!macro customCheckAppRunning
  ; Old uninstallers fall back to killing every process with the same image name
  ; when their PowerShell probe sees Process=Restricted. Keep the path-based
  ; branch available only in this installer process and its uninstaller child.
  ${If} $PCPolicySaved != "1"
    ReadEnvStr $PCPreviousExecutionPolicy "PSExecutionPolicyPreference"
    System::Call 'kernel32::SetEnvironmentVariableW(w "PSExecutionPolicyPreference", w "Bypass")i.r0'
    StrCpy $PCPolicySaved "1"
  ${EndIf}
  InitPluginsDir
  File /oname=$PLUGINSDIR\pc-close-installed-app.ps1 "${PC_UPGRADE_HELPER}"
  CreateDirectory "$LOCALAPPDATA\ProductComparison\installer-logs"
  ; NSIS is 32-bit. Use native PowerShell on 64-bit Windows so executable paths
  ; of 64-bit Electron processes remain readable during the scoped check.
  StrCpy $PCWindowsPowerShell "$SYSDIR\WindowsPowerShell\v1.0\powershell.exe"
  ${If} ${RunningX64}
    StrCpy $PCWindowsPowerShell "$WINDIR\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
  ${EndIf}
  nsExec::ExecToStack /TIMEOUT=30000 '"$PCWindowsPowerShell" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$PLUGINSDIR\pc-close-installed-app.ps1" -InstallDir "$INSTDIR" -RegistryKey "${INSTALL_REGISTRY_KEY}" -LogFile "$LOCALAPPDATA\ProductComparison\installer-logs\upgrade.log"'
  Pop $R0
  Pop $R1
  ${If} $R0 != 0
    MessageBox MB_OK|MB_ICONEXCLAMATION "找商品未能完全退出，安装已停止，旧版本保留。请关闭软件后重试。$\r$\n日志：$LOCALAPPDATA\ProductComparison\installer-logs\upgrade.log" /SD IDOK
    SetErrorLevel 10
    Quit
  ${EndIf}
!macroend

!macro customInstall
  ${If} $PCPolicySaved == "1"
    ${If} $PCPreviousExecutionPolicy == ""
      System::Call 'kernel32::SetEnvironmentVariableW(w "PSExecutionPolicyPreference", p 0)i.r0'
    ${Else}
      System::Call 'kernel32::SetEnvironmentVariableW(w "PSExecutionPolicyPreference", w "$PCPreviousExecutionPolicy")i.r0'
    ${EndIf}
  ${EndIf}
!macroend

!ifndef BUILD_UNINSTALLER
  ; The stock uninstaller restores moved files on error. Keep that failure gate:
  ; never ignore exit code 2 or overwrite an installation with locked files.
  !macro PC_HANDLE_UNINSTALL_RESULT
    ${If} ${Errors}
      FileOpen $R2 "$LOCALAPPDATA\ProductComparison\installer-logs\upgrade.log" a
      FileWrite $R2 "Old uninstaller could not be launched. Target: $INSTDIR$\r$\n"
      FileClose $R2
      MessageBox MB_OK|MB_ICONEXCLAMATION "旧版卸载程序无法启动，安装已停止。请保留原安装目录并联系管理员检查安装日志。$\r$\n$LOCALAPPDATA\ProductComparison\installer-logs\upgrade.log" /SD IDOK
      SetErrorLevel 11
      Quit
    ${EndIf}
    ${If} $R0 != 0
      FileOpen $R2 "$LOCALAPPDATA\ProductComparison\installer-logs\upgrade.log" a
      FileWrite $R2 "Old uninstaller failed. exit=$R0 target=$INSTDIR$\r$\n"
      FileClose $R2
      MessageBox MB_OK|MB_ICONEXCLAMATION "旧程序文件仍被占用或无法移除，安装已停止（卸载返回码：$R0）。$\r$\n请先退出找商品；如果仍失败，重启 Windows 后再安装。不要删除商品资料或账号数据。$\r$\n日志：$LOCALAPPDATA\ProductComparison\installer-logs\upgrade.log" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  !macroend
  !macro customUnInstallCheck
    !insertmacro PC_HANDLE_UNINSTALL_RESULT
  !macroend
  !macro customUnInstallCheckCurrentUser
    !insertmacro PC_HANDLE_UNINSTALL_RESULT
  !macroend
!endif
