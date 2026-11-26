; Tauri's installer keeps the install folder in HKCU\Software\<publisher>\<product>, and finds an earlier install, and
; its uninstaller, through it. The publisher was "autonomous" up to 0.1.14, so the folder an older install wrote moves
; to the new publisher's key before the installer reads it. Only 0.1.14 and older write the old key and every newer
; install removes it, so it holds the last install's folder even over a folder the new key kept from before. Tauri
; includes this file before it defines its own key names, hence the names written out here.
!define HARNESS_OLD_VENDOR_KEY "Software\autonomous"
!define HARNESS_OLD_PRODUCT_KEY "Software\autonomous\Harness Device"
!define HARNESS_PRODUCT_KEY "Software\Autonomous Inc.\Harness Device"

!macro HARNESS_MOVE_INSTALL_FOLDER
  Push $0
  ReadRegStr $0 HKCU "${HARNESS_OLD_PRODUCT_KEY}" ""
  ${If} $0 != ""
    WriteRegStr HKCU "${HARNESS_PRODUCT_KEY}" "" $0
    StrCpy $INSTDIR $0
    DeleteRegKey HKCU "${HARNESS_OLD_PRODUCT_KEY}"
    DeleteRegKey /ifempty HKCU "${HARNESS_OLD_VENDOR_KEY}"
  ${EndIf}
  Pop $0
!macroend

; A GUI or passive (/P, the updater's) install: after .onInit has read the key, before the reinstall page runs the
; old uninstaller on the folder the key holds.
!define MUI_CUSTOMFUNCTION_GUIINIT HarnessMoveInstallFolder
Function HarnessMoveInstallFolder
  !insertmacro HARNESS_MOVE_INSTALL_FOLDER
FunctionEnd

; A silent (/S) install runs no .onGUIInit. The section has already made the output folder from $INSTDIR: when the move
; changes it, the output folder follows and the one made, still empty, goes (RMDir removes no folder with files).
!macro NSIS_HOOK_PREINSTALL
  Push $0
  StrCpy $0 $INSTDIR
  !insertmacro HARNESS_MOVE_INSTALL_FOLDER
  ${If} $0 != $INSTDIR
    SetOutPath $INSTDIR
    RMDir $0
  ${EndIf}
  Pop $0
!macroend
