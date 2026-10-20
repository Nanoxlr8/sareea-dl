; Extra steps for the Sareea DL per-user installer (electron-builder NSIS include).

; Finish page: two optional checkboxes, launch the app and create a desktop shortcut.
; Silent installs skip this page, so a silent install creates no desktop shortcut and does not launch the app.
!macro customFinishPage
  Function SareeaStartApp
    Exec '"$INSTDIR\Sareea DL.exe"'
  FunctionEnd
  Function SareeaDesktopShortcut
    CreateShortCut "$DESKTOP\Sareea DL.lnk" "$INSTDIR\Sareea DL.exe" "" "$INSTDIR\Sareea DL.exe" 0
  FunctionEnd
  !define MUI_FINISHPAGE_RUN
  !define MUI_FINISHPAGE_RUN_TEXT "Launch Sareea DL"
  !define MUI_FINISHPAGE_RUN_FUNCTION SareeaStartApp
  !define MUI_FINISHPAGE_SHOWREADME ""
  !define MUI_FINISHPAGE_SHOWREADME_TEXT "Create a desktop shortcut"
  !define MUI_FINISHPAGE_SHOWREADME_FUNCTION SareeaDesktopShortcut
  !insertmacro MUI_PAGE_FINISH
!macroend

; Uninstall: remove the browser integration registry keys (HKCU only). User downloads and settings are never touched.
!macro customUnInstall
  DeleteRegKey HKCU "Software\Google\Chrome\NativeMessagingHosts\com.sareea.dl"
  DeleteRegKey HKCU "Software\Microsoft\Edge\NativeMessagingHosts\com.sareea.dl"
  Delete "$DESKTOP\Sareea DL.lnk"
!macroend
