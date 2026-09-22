!ifndef BUILD_UNINSTALLER
!include "${__FILEDIR__}\update-paths.nsh"
!include "${__FILEDIR__}\update-ui.nsh"
!include "getProcessInfo.nsh"
Var pid
Var piWmUninstallResult
Var piWmLaunchFailed

!macro customInit
  !insertmacro piWmInitUpdateUI
  CreateDirectory "$LOCALAPPDATA\Pi-Wm\installer-logs"
  ClearErrors
  GetTempFileName $piWmLogPath "$LOCALAPPDATA\Pi-Wm\installer-logs"
  FileOpen $piWmLogHandle "$piWmLogPath" w
  ${if} ${Errors}
    MessageBox MB_OK|MB_ICONSTOP "Cannot create the installation log. The existing application has not been changed."
    SetErrorLevel 20
    Quit
  ${endif}
  FileWriteUTF16LE /BOM $piWmLogHandle ""
  Push "installer-version=${VERSION}"
  Call PiWmLog
  Push "visual-update=$piWmVisualUpdate"
  Call PiWmLog
!macroend

!macro piWmPreflightRegistry ROOT
  ReadRegStr $0 ${ROOT} "${UNINSTALL_REGISTRY_KEY}" UninstallString
  ${if} $0 != ""
    Push $0
    Call GetInQuotes
    Call GetFileParent
    Pop $piWmScanRoot
    ${if} $piWmScanRoot != ""
      StrCpy $piWmMaxRelative 0
      Push ""
      Call PiWmScanInstalledPaths
      Pop $0
      Push "existing-root=$piWmScanRoot; longest-relative=$piWmMaxRelative; longest-path=$piWmLongestPath"
      Call PiWmLog
      ${if} $piWmPathError != ""
        Call PiWmFailPreflight
      ${endif}
    ${endif}
  ${endif}
!macroend

Function PiWmFailPreflight
  Push "preflight-failed=$piWmPathError; path=$piWmLongestPath"
  Call PiWmLog
  Call PiWmCloseLog
  MessageBox MB_OK|MB_ICONSTOP "Update preparation failed ($piWmPathError). No old files were removed.$\r$\nDiagnostic log: $piWmLogPath"
  SetErrorLevel 21
  Quit
FunctionEnd

; This hook is after elevation and before uninstallOldVersion. Preserve builder's process checks.
!macro customCheckAppRunning
  !insertmacro piWmUpdateStage "Checking the existing installation..." "正在检查现有安装和运行中的应用…"
  ; Keep this in sync with the 190-character build-time relative-path budget.
  StrLen $0 "$INSTDIR"
  ${if} $0 > 68
    StrCpy $piWmPathError "new-install-directory-too-long"
    StrCpy $piWmLongestPath "$INSTDIR"
    Call PiWmFailPreflight
  ${endif}
  !insertmacro IS_POWERSHELL_AVAILABLE
  !insertmacro _CHECK_APP_RUNNING
  !insertmacro piWmPreflightRegistry SHELL_CONTEXT
  ${if} $installMode == "all"
    !insertmacro piWmPreflightRegistry HKCU
  ${endif}
  Push $TEMP
  Call PiWmPrepareTemp
  ${if} $piWmPathError != ""
    Call PiWmFailPreflight
  ${endif}
  !insertmacro piWmUpdateStage "Replacing the previous version. Please do not open Pi-Wm yet." "正在替换旧版本，请暂时不要打开 Pi-Wm。"
!macroend

!macro piWmCheckUninstallResult
  StrCpy $piWmLaunchFailed 0
  ${if} ${Errors}
    StrCpy $piWmLaunchFailed 1
  ${endif}
  StrCpy $piWmUninstallResult $R0
  Push "old-uninstaller-exit=$piWmUninstallResult; launch-failed=$piWmLaunchFailed"
  Call PiWmLog
  ${if} $piWmUninstallResult != 0
  ${orif} $piWmLaunchFailed == 1
    Call PiWmCloseLog
    MessageBox MB_OK|MB_ICONSTOP "The previous version could not be replaced (exit $piWmUninstallResult). Your application data was not deleted.$\r$\nDiagnostic log: $piWmLogPath"
    SetErrorLevel 2
    Quit
  ${endif}
  !insertmacro piWmUpdateStage "Installing version ${VERSION}..." "正在安装 ${VERSION} 版本…"
!macroend

!macro customUnInstallCheck
  !insertmacro piWmCheckUninstallResult
!macroend
!macro customUnInstallCheckCurrentUser
  !insertmacro piWmCheckUninstallResult
!macroend

!macro customInstall
  !insertmacro piWmUpdateStage "Verifying installed files..." "正在校验安装文件…"
  ; The builder's temporary extraction can silently omit long paths before CopyFiles.
  ; Verify all staged files and recover directly into the bounded installation root.
  nsExec::ExecToStack /TIMEOUT=120000 '"$INSTDIR\resources\runtime\node.exe" "$INSTDIR\resources\runtime\verify-install.cjs"'
  Pop $R0
  Pop $R1
  Push "runtime-inventory-exit=$R0; details=$R1"
  Call PiWmLog
  ${if} $R0 != 0
    !insertmacro piWmUpdateStage "Repairing and verifying installed files..." "正在补全并重新校验安装文件…"
    Push "runtime-repair=direct-extraction"
    Call PiWmLog
    SetOutPath "$INSTDIR"
    ClearErrors
    Nsis7z::Extract "$PLUGINSDIR\app-$packageArch.7z"
    nsExec::ExecToStack /TIMEOUT=120000 '"$INSTDIR\resources\runtime\node.exe" "$INSTDIR\resources\runtime\verify-install.cjs"'
    Pop $R0
    Pop $R1
    Push "runtime-repair-exit=$R0; details=$R1"
    Call PiWmLog
    ${if} $R0 != 0
      Call PiWmCloseLog
      MessageBox MB_OK|MB_ICONSTOP "Application files are incomplete. Please run the installer again.$\r$\nDiagnostic log: $piWmLogPath"
      SetErrorLevel 22
      Quit
    ${endif}
  ${endif}
  Push "installation-completed"
  Call PiWmLog
  StrCpy $piWmInstallVerified "1"
  ; Do not pass extended TEMP syntax to the restarted app or its future tools.
  Call PiWmRestoreTemp
  ${if} $piWmVisualUpdate != "1"
    Call PiWmCloseLog
  ${endif}
!macroend

Function .onInstFailed
  Push "installation-failed"
  Call PiWmLog
  Call PiWmCloseLog
FunctionEnd

Function .onGUIEnd
  Call PiWmCloseLog
FunctionEnd
!endif
