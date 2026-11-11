; AI-Hub-Setup.exe: installs AI Hub for the current user only (no administrator rights needed), creates the Start menu and
; desktop shortcuts and an entry in "Installed apps". Compiled by packaging/build.mjs with makensis.
; Defines: VERSION (x.y.z), VERSION4 (x.y.z.w), STAGE (folder with "AI Hub.exe", node\ and hub\), ICON, OUTFILE.
; Uninstalling never touches the user's own hub folder ("AI Hub" in their user folder).
Unicode true
SetCompressor /SOLID lzma
RequestExecutionLevel user
ManifestDPIAware true

!include "MUI2.nsh"
!include "LogicLib.nsh"

Name "AI Hub"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\Programs\AI Hub"
InstallDirRegKey HKCU "Software\AI Hub" "InstallDir"

VIProductVersion "${VERSION4}"
VIAddVersionKey "ProductName" "AI Hub"
VIAddVersionKey "FileDescription" "AI Hub installer"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "AI Hub"

!define UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\AI Hub"

!define MUI_ICON "${ICON}"
!define MUI_UNICON "${ICON}"
!define MUI_ABORTWARNING
!define MUI_FINISHPAGE_RUN "$INSTDIR\AI Hub.exe"
!define MUI_FINISHPAGE_RUN_TEXT "$(RunText)"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "English"

LangString RunText ${LANG_ENGLISH} "Start AI Hub"

Function StopRunningHub
  ${If} ${FileExists} "$INSTDIR\node\node.exe"
  ${AndIf} ${FileExists} "$INSTDIR\hub\scripts\app-launcher.mjs"
    nsExec::Exec '"$INSTDIR\node\node.exe" "$INSTDIR\hub\scripts\app-launcher.mjs" --stop'
    Pop $0
    Sleep 700
  ${EndIf}
FunctionEnd

Section "AI Hub"
  Call StopRunningHub

  ; a clean copy of the program: files dropped by a newer version must not linger
  RMDir /r "$INSTDIR\hub"
  RMDir /r "$INSTDIR\node"

  SetOutPath "$INSTDIR"
  File "${STAGE}\AI Hub.exe"
  File "${STAGE}\ai-hub.ico"
  SetOutPath "$INSTDIR\node"
  File /r "${STAGE}\node\*"
  SetOutPath "$INSTDIR\hub"
  File /r "${STAGE}\hub\*"

  SetOutPath "$INSTDIR"
  WriteUninstaller "$INSTDIR\Uninstall.exe"

  CreateShortCut "$SMPROGRAMS\AI Hub.lnk" "$INSTDIR\AI Hub.exe" "" "$INSTDIR\ai-hub.ico" 0
  CreateShortCut "$DESKTOP\AI Hub.lnk" "$INSTDIR\AI Hub.exe" "" "$INSTDIR\ai-hub.ico" 0

  WriteRegStr HKCU "Software\AI Hub" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayName" "AI Hub"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "DisplayIcon" "$INSTDIR\ai-hub.ico"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "InstallLocation" "$INSTDIR"
  WriteRegStr HKCU "${UNINSTALL_KEY}" "UninstallString" '"$INSTDIR\Uninstall.exe"'
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoModify" 1
  WriteRegDWORD HKCU "${UNINSTALL_KEY}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ${If} ${FileExists} "$INSTDIR\node\node.exe"
    nsExec::Exec '"$INSTDIR\node\node.exe" "$INSTDIR\hub\scripts\app-launcher.mjs" --stop'
    Pop $0
    Sleep 700
  ${EndIf}

  Delete "$SMPROGRAMS\AI Hub.lnk"
  Delete "$DESKTOP\AI Hub.lnk"

  ; only what the installer put there: the folder may have been chosen by the user and hold other things
  RMDir /r "$INSTDIR\hub"
  RMDir /r "$INSTDIR\node"
  Delete "$INSTDIR\AI Hub.exe"
  Delete "$INSTDIR\ai-hub.ico"
  Delete "$INSTDIR\Uninstall.exe"
  RMDir "$INSTDIR"

  DeleteRegKey HKCU "${UNINSTALL_KEY}"
  DeleteRegKey HKCU "Software\AI Hub"
SectionEnd
