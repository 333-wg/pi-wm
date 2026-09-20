!ifndef BUILD_UNINSTALLER
!include "${__FILEDIR__}\update-paths.nsh"
!include "getProcessInfo.nsh"
Var pid
Var piWmUninstallResult
Var piWmLaunchFailed

!macro customInit
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
!macroend

!macro customUnInstallCheck
  !insertmacro piWmCheckUninstallResult
!macroend
!macro customUnInstallCheckCurrentUser
  !insertmacro piWmCheckUninstallResult
!macroend

!macro customInstall
  Push "installation-completed"
  Call PiWmLog
  ; Do not pass extended TEMP syntax to the restarted app or its future tools.
  Call PiWmCloseLog
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
