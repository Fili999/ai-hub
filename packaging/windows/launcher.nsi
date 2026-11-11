; "AI Hub.exe": a tiny launcher with no window. It runs the bundled Node on the hub launcher, hidden (no black console
; window), and stays alive as long as the hub runs. Compiled by packaging/build.mjs with makensis; it sits next to the
; "node" and "hub" folders. Defines: VERSION (x.y.z.w), ICON, OUTFILE.
Unicode true
CRCCheck off
RequestExecutionLevel user
SilentInstall silent
ShowInstDetails nevershow
AutoCloseWindow true

Name "AI Hub"
Caption "AI Hub"
Icon "${ICON}"
OutFile "${OUTFILE}"

VIProductVersion "${VERSION}"
VIAddVersionKey "ProductName" "AI Hub"
VIAddVersionKey "FileDescription" "AI Hub"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "LegalCopyright" "AI Hub"

Section
  SetOutPath "$EXEDIR"
  nsExec::Exec '"$EXEDIR\node\node.exe" "$EXEDIR\hub\scripts\app-launcher.mjs"'
  Pop $0
SectionEnd
