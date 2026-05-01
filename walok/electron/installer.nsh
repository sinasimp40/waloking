; =====================================================================
; REBRAND CHECKLIST FOR THIS FILE
; ---------------------------------------------------------------------
; NSIS scripts cannot share constants with the JS launcher (see
; BRAND_SLUG in walok/electron/main.js). When you rebrand, you MUST
; hand-edit the strings below to match the new BRAND_SLUG / display name.
;
; If new BRAND_SLUG = 'denfi' and display name = 'DENFI', change:
;   * preInit:        StrCpy $INSTDIR "$1Denfi"        (was Example-Cafe)
;   * customInstall:  DisplayName "DENFI"               (was EXAMPLE CAFE)
;   * customUnInit:   denfi-data, denfi-assets, denfi-settings.json
;                                                        (was example-cafe-*)
;
; Folder names here MUST match the launcher's BRAND_SLUG + suffix
; (BRAND_SLUG + '-data', BRAND_SLUG + '-assets',
;  BRAND_SLUG + '-settings.json'), otherwise the uninstaller will leave
; orphaned customer data behind on uninstall.
; =====================================================================

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
