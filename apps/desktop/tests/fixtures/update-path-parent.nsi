Unicode true
Name "Isolated update path parent fixture"
OutFile "${PROBE_OUTPUT}"
RequestExecutionLevel user
SilentInstall silent
!include "${UPDATE_PATHS}"
Var fixture
Var mode
Var locked
Section
  ReadEnvStr $fixture PI_WM_TEST_ROOT
  StrCmp $fixture "" guardFailed
  IfFileExists "$fixture\fixture.marker" 0 guardFailed
  FileOpen $piWmLogHandle "$fixture\parent.log" w
  FileWriteUTF16LE /BOM $piWmLogHandle ""
  ReadEnvStr $mode PI_WM_TEST_MODE
  ${if} $mode == "normalize"
    ReadEnvStr $0 PI_WM_TEST_PATH
    Push $0
    Call PiWmExtendPath
    Pop $0
    FileWriteUTF16LE $piWmLogHandle 'normalized=$0$\r$\nerror=$piWmPathError$\r$\n'
    Goto finish
  ${endif}
  StrCpy $piWmScanRoot "$fixture\app"
  Push ""
  Call PiWmScanInstalledPaths
  Pop $0
  FileWriteUTF16LE $piWmLogHandle 'preflight=$piWmPathError$\r$\n'
  ${if} $piWmPathError != ""
    Goto finish
  ${endif}
  ${if} $mode != "control"
    ${if} $mode == "missing-temp"
      Push "$fixture\missing"
    ${else}
      Push $TEMP
    ${endif}
    Call PiWmPrepareTemp
  ${endif}
  FileWriteUTF16LE $piWmLogHandle 'prepare=$piWmPathError$\r$\n'
  ${if} $piWmPathError != ""
    Goto finish
  ${endif}
  ${if} $mode == "cancel"
    Goto finish
  ${endif}
  ${if} $mode == "locked"
    FileOpen $locked "$fixture\app\locked.txt" r
  ${endif}
  ExecWait '"$EXEDIR\legacy-uninstaller.exe" /S /KEEP_APP_DATA --updated _?=$fixture\app' $0
  FileWriteUTF16LE $piWmLogHandle 'childExit=$0$\r$\n'
  ${if} $locked != ""
    FileClose $locked
  ${endif}
  finish:
    Call PiWmRestoreTemp
    ReadEnvStr $0 TEMP
    ReadEnvStr $1 TMP
    FileWriteUTF16LE $piWmLogHandle 'restoredTEMP=$0$\r$\nrestoredTMP=$1$\r$\n'
    Call PiWmCloseLog
    SetErrorLevel 0
    Quit
  guardFailed:
    SetErrorLevel 90
    Quit
SectionEnd
