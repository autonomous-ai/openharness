; Tauri's installer keeps the install folder in HKCU\Software\<publisher>\<product>, and finds an earlier install, and
; its uninstaller, through it. The publisher was "autonomous" up to 0.1.14, so the folder an older install wrote moves
; to the new publisher's key before the installer reads it. Tauri includes this file before it defines its own key
; names, hence the names written out here.
!define HARNESS_OLD_VENDOR_KEY "Software\autonomous"
!define HARNESS_OLD_PRODUCT_KEY "Software\autonomous\Harness Device"
!define HARNESS_PRODUCT_KEY "Software\Autonomous Inc.\Harness Device"

!macro HARNESS_MOVE_INSTALL_FOLDER
  Push $0
  Push $1
  ReadRegStr $0 HKCU "${HARNESS_PRODUCT_KEY}" ""
  ReadRegStr $1 HKCU "${HARNESS_OLD_PRODUCT_KEY}" ""
  ${If} $0 == ""
  ${AndIf} $1 != ""
    WriteRegStr HKCU "${HARNESS_PRODUCT_KEY}" "" $1
    StrCpy $INSTDIR $1
    DeleteRegKey HKCU "${HARNESS_OLD_PRODUCT_KEY}"
    DeleteRegKey /ifempty HKCU "${HARNESS_OLD_VENDOR_KEY}"
  ${EndIf}
  Pop $1
  Pop $0
!macroend

; A GUI or passive (/P, the updater's) install: after .onInit has read the key, before the reinstall page runs the
; old uninstaller on the folder the key holds.
!define MUI_CUSTOMFUNCTION_GUIINIT HarnessMoveInstallFolder
Function HarnessMoveInstallFolder
  !insertmacro HARNESS_MOVE_INSTALL_FOLDER
FunctionEnd

; A silent (/S) install runs no .onGUIInit. The section has already set the output folder from $INSTDIR, so it is set
; again in case the move changed it.
!macro NSIS_HOOK_PREINSTALL
  !insertmacro HARNESS_MOVE_INSTALL_FOLDER
  SetOutPath $INSTDIR
!macroend
