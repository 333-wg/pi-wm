Unicode true
Name "Isolated update launch fixture"
OutFile "${PROBE_OUTPUT}"
RequestExecutionLevel user
SilentInstall silent
!include FileFunc.nsh
Section
  FileOpen $0 "$EXEDIR\launch.log" a
  ${GetParameters} $1
  FileWriteUTF16LE $0 "launched=$1$\r$\n"
  FileClose $0
SectionEnd
