Unicode true
Name "Pi-Wm isolated update progress"
OutFile "${PROBE_OUTPUT}"
RequestExecutionLevel user
!include "${BUILDER_HEADER}"
!include "${UPDATE_PATHS}"
!define allowToChangeInstallationDirectory
!include "${UPDATE_UI}"
Var installMode
Var isForceMachineInstall
Var isForceCurrentInstall
Var fixtureMode

!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro customFinishPage
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro customHeader

Function instFilesPre
  ; The production builder sanitizes new-install paths here. Updates must skip it.
  StrCpy $INSTDIR "$INSTDIR\UpdateFixture"
FunctionEnd

Function .onInit
  ReadEnvStr $0 PI_WM_TEST_ROOT
  StrCmp $0 "" guardFailed
  IfFileExists "$0\fixture.marker" 0 guardFailed
  StrCpy $INSTDIR "$0"
  ReadEnvStr $fixtureMode PI_WM_TEST_MODE
  ReadEnvStr $LANGUAGE PI_WM_TEST_LANGUAGE
  StrCpy $piWmLogPath "$INSTDIR\installer.log"
  FileOpen $piWmLogHandle "$piWmLogPath" w
  FileWriteUTF16LE /BOM $piWmLogHandle ""
  !insertmacro piWmInitUpdateUI
  ReadEnvStr $installMode PI_WM_TEST_SCOPE
  !insertmacro customInstallMode
  Push "visual=$piWmVisualUpdate; machine=$isForceMachineInstall; user=$isForceCurrentInstall"
  Call PiWmLog
  ${if} ${Silent}
    Push "silent=1"
  ${else}
    Push "silent=0"
  ${endif}
  Call PiWmLog
  Return
  guardFailed:
    SetErrorLevel 90
    Quit
FunctionEnd

Section
  ${if} $piWmVisualUpdate != "1"
    Call PiWmCloseLog
    SetErrorLevel 0
    Quit
  ${endif}
  System::Call 'user32::IsWindowVisible(p $HWNDPARENT) i .r0'
  Push "visible=$0"
  Call PiWmLog
  System::Call 'user32::GetWindowTextW(p $mui.Header.Text, w .r0, i ${NSIS_MAX_STRLEN})'
  Push "title=$0"
  Call PiWmLog
  SetOutPath "$INSTDIR"
  File /oname=UpdateFixture.exe "${PROBE_APP}"
  ${if} $fixtureMode == "unverified"
    Call PiWmFinishUpdate
    Push "unverified-returned"
    Call PiWmLog
    Call PiWmCloseLog
    SetErrorLevel 0
    Quit
  ${endif}
  !insertmacro piWmUpdateStage "Verifying installed files..." "正在校验安装文件…"
  System::Call 'user32::GetWindowTextW(p $mui.Header.SubText, w .r0, i ${NSIS_MAX_STRLEN})'
  Push "stage=$0"
  Call PiWmLog
  ReadEnvStr $0 PI_WM_TEST_HOLD_MS
  ${if} $0 == ""
    StrCpy $0 250
  ${endif}
  Sleep $0
  StrCpy $piWmInstallVerified "1"
SectionEnd

Function .onGUIEnd
  Call PiWmCloseLog
FunctionEnd
