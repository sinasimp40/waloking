; =====================================================================
; REBRAND CHECKLIST FOR THIS FILE
; ---------------------------------------------------------------------
; NSIS scripts cannot share constants with the JS launcher (see
; BRAND_SLUG in walok/electron/main.js). When you rebrand, you MUST
; hand-edit the strings below to match the new BRAND_SLUG / display name.
;
; If new BRAND_SLUG = 'o-brien-cafe' and display name = 'O'BRIEN CAFE', change:
;   * preInit:        StrCpy $INSTDIR "$1O'brien-Cafe"        (was O'brien-Cafe)
;   * customInstall:  DisplayName "O'BRIEN CAFE"               (was O'BRIEN CAFE)
;   * customUnInit:   o-brien-cafe-data, o-brien-cafe-assets, o-brien-cafe-settings.json
;                                                        (was o-brien-cafe-*)
;
; Folder names here MUST match the launcher's BRAND_SLUG + suffix
; (BRAND_SLUG + '-data', BRAND_SLUG + '-assets',
;  BRAND_SLUG + '-settings.json'), otherwise the uninstaller will leave
; orphaned customer data behind on uninstall.
; =====================================================================

!macro preInit
  StrCpy $0 "$EXEPATH"
  StrCpy $1 $0 3
  StrCpy $INSTDIR "$1O'brien-Cafe"
!macroend

!macro customInstall
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayName" "O'BRIEN CAFE"
  WriteRegStr SHCTX "Software\Microsoft\Windows\CurrentVersion\Uninstall\${UNINSTALL_APP_KEY}" "DisplayVersion" ""
!macroend

!macro customUnInit
  RMDir /r "$INSTDIR\o-brien-cafe-data"
  RMDir /r "$INSTDIR\o-brien-cafe-assets"
  Delete "$INSTDIR\o-brien-cafe-settings.json"
!macroend
