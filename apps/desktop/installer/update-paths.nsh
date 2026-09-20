!ifndef PI_WM_UPDATE_PATHS_INCLUDED
!define PI_WM_UPDATE_PATHS_INCLUDED
!include LogicLib.nsh

Var piWmOriginalTemp
Var piWmOriginalTmp
Var piWmExtendedTemp
Var piWmTempActive
Var piWmPathError
Var piWmLogPath
Var piWmLogHandle
Var piWmScanRoot
Var piWmMaxRelative
Var piWmLongestPath

Function PiWmLog
  Exch $0
  ${if} $piWmLogHandle != ""
    FileWriteUTF16LE $piWmLogHandle "$0$\r$\n"
  ${endif}
  Pop $0
FunctionEnd

; Keep the user's existing TEMP directory and its ACLs. Only the child path syntax changes.
Function PiWmExtendPath
  Exch $0
  Push $1
  StrCpy $piWmPathError ""
  StrCpy $1 $0 4
  ${if} $1 == "\\?\"
    StrCpy $1 $0 4 4
    ${if} $1 == "UNC\"
      Goto valid
    ${endif}
    StrCpy $1 $0 2 5
    ${if} $1 == ":\"
      Goto valid
    ${endif}
    Goto invalid
  ${endif}
  ${if} $1 == "\\.\"
    Goto invalid
  ${endif}
  StrCpy $1 $0 2 1
  ${if} $1 == ":\"
    StrCpy $0 "\\?\$0"
    Goto valid
  ${endif}
  StrCpy $1 $0 2
  ${if} $1 == "\\"
    StrCpy $0 $0 "" 2
    StrCpy $0 "\\?\UNC\$0"
    Goto valid
  ${endif}
  invalid:
    StrCpy $piWmPathError "unsupported-temp-path"
  valid:
    Pop $1
    Exch $0
FunctionEnd

Function PiWmRestoreTemp
  Push $0
  ${if} $piWmTempActive == "1"
    ${if} $piWmOriginalTemp == ""
      System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", p 0) i .r0'
    ${else}
      System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w "$piWmOriginalTemp") i .r0'
    ${endif}
    ${if} $piWmOriginalTmp == ""
      System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", p 0) i .r0'
    ${else}
      System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w "$piWmOriginalTmp") i .r0'
    ${endif}
    StrCpy $piWmTempActive "0"
    Push "temporary-environment-restored"
    Call PiWmLog
  ${endif}
  Pop $0
FunctionEnd

; Consumes a TEMP directory from the stack. Environment changes stay in this process and its child.
Function PiWmPrepareTemp
  Exch $0
  Push $1
  ${if} $piWmTempActive == "1"
    Goto done
  ${endif}
  ReadEnvStr $piWmOriginalTemp TEMP
  ReadEnvStr $piWmOriginalTmp TMP
  Push $0
  Call PiWmExtendPath
  Pop $piWmExtendedTemp
  ${if} $piWmPathError != ""
    Goto done
  ${endif}
  ; GetTempFileName and the legacy NSIS string buffer have separate size limits.
  StrLen $0 $piWmExtendedTemp
  ${if} $0 > 230
    StrCpy $piWmPathError "temp-root-too-long"
    Goto done
  ${endif}
  ClearErrors
  GetTempFileName $1 "$piWmExtendedTemp"
  ${if} ${Errors}
    StrCpy $piWmPathError "temp-not-writable"
    Goto done
  ${endif}
  Delete "$1"
  StrCpy $piWmTempActive "1"
  System::Call 'kernel32::SetEnvironmentVariableW(w "TEMP", w "$piWmExtendedTemp") i .r0'
  ${if} $0 == 0
    StrCpy $piWmPathError "temp-environment-failed"
    Call PiWmRestoreTemp
    Goto done
  ${endif}
  System::Call 'kernel32::SetEnvironmentVariableW(w "TMP", w "$piWmExtendedTemp") i .r0'
  ${if} $0 == 0
    StrCpy $piWmPathError "tmp-environment-failed"
    Call PiWmRestoreTemp
    Goto done
  ${endif}
  Push "legacy-uninstaller-temp=$piWmExtendedTemp"
  Call PiWmLog
  done:
    Pop $1
    Pop $0
FunctionEnd

; Read-only preflight: refuse paths the old uninstaller cannot read before moving any file.
Function PiWmScanInstalledPaths
  Exch $0
  Push $1
  Push $2
  Push $3
  Push $4
  StrLen $1 "$piWmScanRoot$0"
  ${if} $1 > 247
    StrCpy $piWmPathError "installed-directory-too-long"
    StrCpy $piWmLongestPath "$piWmScanRoot$0"
    Goto done
  ${endif}
  StrCpy $3 "$piWmScanRoot$0"
  System::Call 'kernel32::GetFileAttributesW(w r3) i .r4'
  ${if} $4 == -1
    StrCpy $piWmPathError "installed-directory-not-readable"
    StrCpy $piWmLongestPath $3
    Goto done
  ${endif}
  IntOp $4 $4 & 0x400
  ${if} $4 != 0
    StrCpy $piWmPathError "installed-reparse-point"
    StrCpy $piWmLongestPath $3
    Goto done
  ${endif}
  ClearErrors
  FindFirst $1 $2 "$piWmScanRoot$0\*.*"
  ${if} ${Errors}
    StrCpy $piWmPathError "installed-directory-not-readable"
    StrCpy $piWmLongestPath "$piWmScanRoot$0"
    Goto done
  ${endif}
  loop:
    ${if} $2 == ""
      Goto close
    ${endif}
    ${if} $2 == "."
    ${orif} $2 == ".."
      Goto next
    ${endif}
    StrCpy $3 "$piWmScanRoot$0\$2"
    StrLen $4 $3
    ${if} $4 > 259
      StrCpy $piWmPathError "installed-file-too-long"
      StrCpy $piWmLongestPath $3
      Goto close
    ${endif}
    System::Call 'kernel32::GetFileAttributesW(w r3) i .r4'
    ${if} $4 == -1
      StrCpy $piWmPathError "installed-path-not-readable"
      StrCpy $piWmLongestPath $3
      Goto close
    ${endif}
    IntOp $3 $4 & 0x400
    ${if} $3 != 0
      StrCpy $piWmPathError "installed-reparse-point"
      StrCpy $piWmLongestPath "$piWmScanRoot$0\$2"
      Goto close
    ${endif}
    IntOp $3 $4 & 0x10
    ${if} $3 != 0
      Push "$0\$2"
      Call PiWmScanInstalledPaths
      Pop $3
      ${if} $piWmPathError != ""
        Goto close
      ${endif}
    ${else}
      StrLen $3 "$0\$2"
      ${if} $3 > $piWmMaxRelative
        StrCpy $piWmMaxRelative $3
        StrCpy $piWmLongestPath "$piWmScanRoot$0\$2"
      ${endif}
    ${endif}
    next:
      FindNext $1 $2
      Goto loop
  close:
    FindClose $1
  done:
    Pop $4
    Pop $3
    Pop $2
    Pop $1
    Exch $0
FunctionEnd

Function PiWmCloseLog
  Call PiWmRestoreTemp
  ${if} $piWmLogHandle != ""
    FileClose $piWmLogHandle
    StrCpy $piWmLogHandle ""
  ${endif}
FunctionEnd
!endif
