Unicode true
Name "Isolated legacy uninstaller fixture"
OutFile "${PROBE_OUTPUT}"
RequestExecutionLevel user
SilentInstall silent
!include LogicLib.nsh
!define UNINSTALL_FILENAME "legacy-uninstaller.exe"
!include "${LEGACY_FUNCTIONS}"
Var report
Var fixture
Section
  WriteUninstaller "$EXEDIR\legacy-uninstaller.exe"
SectionEnd
Section "Uninstall"
  ReadEnvStr $fixture PI_WM_TEST_ROOT
  StrCmp $fixture "" guardFailed
  IfFileExists "$fixture\fixture.marker" 0 guardFailed
  StrCpy $INSTDIR "$fixture\app"
  FileOpen $report "$fixture\child.log" w
  InitPluginsDir
  FileWriteUTF16LE /BOM $report 'temp=$TEMP$\r$\nplugins=$PLUGINSDIR$\r$\n'
  ; The old uninstaller also loads plugins and invokes PowerShell from the inherited TEMP.
  nsExec::ExecToStack '"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -Command "[IO.Path]::GetTempPath()"'
  Pop $0
  Pop $1
  FileWriteUTF16LE $report 'powershellExit=$0$\r$\npowershellTemp=$1$\r$\n'
  CreateDirectory "$PLUGINSDIR\old-install"
  Push ""
  Call un.atomicRMDir
  Pop $0
  FileWriteUTF16LE $report 'failure=$0$\r$\n'
  FileClose $report
  ${if} $0 != 0
    Push ""
    Call un.restoreFiles
    Pop $0
    Abort "Fixture rollback failed"
  ${endif}
  SetErrorLevel 0
  Quit
  guardFailed:
    SetErrorLevel 90
    Quit
SectionEnd
