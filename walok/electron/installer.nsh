!macro preInit
  StrCpy $0 "$EXEPATH"
  StrCpy $1 $0 3
  StrCpy $INSTDIR "$1Example-Cafe"
!macroend

!macro customInstall
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayName" "EXAMPLE CAFE"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion" ""
!macroend

!macro customUnInit
  RMDir /r "$INSTDIR\example-cafe-data"
  RMDir /r "$INSTDIR\example-cafe-assets"
  Delete "$INSTDIR\example-cafe-settings.json"
!macroend
