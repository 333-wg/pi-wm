!ifndef PI_WM_UPDATE_UI_INCLUDED
!define PI_WM_UPDATE_UI_INCLUDED
!include MUI2.nsh
!include LogicLib.nsh

Var piWmVisualUpdate
Var piWmInstallVerified
Var piWmLaunchAttempted

!macro piWmUpdateStage ENGLISH CHINESE
  ${if} $piWmVisualUpdate == "1"
    SetDetailsPrint textonly
    ${if} $LANGUAGE == 2052
    ${orif} $LANGUAGE == 1028
      !insertmacro MUI_HEADER_TEXT "正在更新 Pi-Wm" "${CHINESE}"
      DetailPrint "${CHINESE}"
    ${else}
      !insertmacro MUI_HEADER_TEXT "Updating Pi-Wm" "${ENGLISH}"
      DetailPrint "${ENGLISH}"
    ${endif}
    SetDetailsPrint none
  ${endif}
!macroend

!macro piWmInitUpdateUI
  ; Only the consented in-app handoff becomes visible, including older /S callers.
  ; Ordinary /S installations and uninstalls keep their original behavior.
  ${if} ${isUpdated}
  ${andif} ${isForceRun}
    StrCpy $piWmVisualUpdate "1"
    SetSilent normal
  ${endif}
!macroend

!macro customInstallMode
  ${if} $piWmVisualUpdate == "1"
    ; Reuse the recorded install scope; builder still handles UAC for all-users.
    ${if} $installMode == "all"
      StrCpy $isForceMachineInstall "1"
    ${else}
      StrCpy $isForceCurrentInstall "1"
    ${endif}
  ${endif}
!macroend

!macro customPageAfterChangeDir
  !ifdef MUI_PAGE_CUSTOMFUNCTION_PRE
    !undef MUI_PAGE_CUSTOMFUNCTION_PRE
  !endif
  !define MUI_PAGE_CUSTOMFUNCTION_PRE PiWmInstFilesPre
  !define MUI_PAGE_CUSTOMFUNCTION_SHOW PiWmShowUpdateProgress
!macroend

!macro customFinishPage
  !define MUI_PAGE_CUSTOMFUNCTION_PRE PiWmFinishUpdate
  !insertmacro MUI_PAGE_FINISH
!macroend

; Builder registers its external plugins after reading the custom include.
!macro customHeader
Function PiWmInstFilesPre
  ; Never append an application subfolder to an existing custom update location.
  ${if} $piWmVisualUpdate != "1"
    !ifdef allowToChangeInstallationDirectory
      Call instFilesPre
    !endif
  ${endif}
FunctionEnd

Function PiWmShowUpdateProgress
  !insertmacro piWmUpdateStage "Preparing version ${VERSION}. Please keep this window open." "正在准备 ${VERSION} 版本，请保持此窗口打开。"
FunctionEnd

Function PiWmFinishUpdate
  ${if} $piWmVisualUpdate == "1"
  ${andif} $piWmInstallVerified == "1"
  ${andif} $piWmLaunchAttempted != "1"
    StrCpy $piWmLaunchAttempted "1"
    !insertmacro piWmUpdateStage "Files verified. Starting Pi-Wm..." "文件校验完成，正在启动 Pi-Wm…"
    Call PiWmRestoreTemp
    ; Launch the verified executable, not a possibly stale or removed shortcut.
    ${StdUtils.ExecShellAsUser} $0 "$INSTDIR\${PRODUCT_FILENAME}.exe" "open" "--updated"
    Push "updated-app-launch=$0"
    Call PiWmLog
    ${if} $0 == "ok"
    ${orif} $0 == "fallback"
      Call PiWmCloseLog
      SetErrorLevel 0
      Quit
    ${endif}
    Call PiWmCloseLog
    ${if} $LANGUAGE == 2052
    ${orif} $LANGUAGE == 1028
      MessageBox MB_OK|MB_ICONEXCLAMATION "更新已安装，但未能自动启动 Pi-Wm。请从开始菜单打开应用。$\r$\n诊断日志：$piWmLogPath"
    ${else}
      MessageBox MB_OK|MB_ICONEXCLAMATION "The update is installed, but Pi-Wm could not start automatically. Open it from the Start menu.$\r$\nDiagnostic log: $piWmLogPath"
    ${endif}
  ${endif}
FunctionEnd
!macroend
!endif
