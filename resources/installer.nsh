# Included by electron-builder into the NSIS installer and uninstaller.

!macro customUnInstall
  # An update runs the old uninstaller first: keep everything then. The new
  # installer may even be running from the folder removed below.
  ${ifNot} ${isUpdated}
    # these folders are always per user, even for a per-machine install
    ${if} $installMode == "all"
      SetShellVarContext current
    ${endif}

    # The installer keeps a copy of itself here, which the stock uninstaller
    # leaves behind.
    RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}-updater"

    # Electron names its data folder after the package name. It holds
    # settings.json next to caches that are never worth keeping.
    StrCpy $R3 "$APPDATA\${APP_PACKAGE_NAME}"
    # $R4 is "1" when the settings stay
    StrCpy $R4 "1"
    ${GetParameters} $R0
    ClearErrors
    ${GetOptions} $R0 "--delete-app-data" $R1
    ${ifNot} ${Errors}
      StrCpy $R4 "0"
    ${elseIf} ${FileExists} "$R3\settings.json"
      # a silent uninstall keeps the settings unless --delete-app-data is passed
      ${if} ${Cmd} `MessageBox MB_YESNO|MB_ICONQUESTION|MB_DEFBUTTON2 "Do you also want to remove your ${PRODUCT_NAME} settings and recent scans?$\r$\n$\r$\nChoose No to keep them for a later install." /SD IDNO IDYES`
        StrCpy $R4 "0"
      ${endIf}
    ${endIf}

    ${if} $R4 == "0"
      RMDir /r "$R3"
    ${else}
      FindFirst $R5 $R6 "$R3\*.*"
      ${doUntil} $R6 == ""
        ${if} $R6 != "."
        ${andIf} $R6 != ".."
        ${andIf} $R6 != "settings.json"
          ${if} ${FileExists} "$R3\$R6\*.*"
            RMDir /r "$R3\$R6"
          ${else}
            Delete "$R3\$R6"
          ${endIf}
        ${endIf}
        FindNext $R5 $R6
      ${loop}
      FindClose $R5
      # goes only if there were no settings to keep
      RMDir "$R3"
    ${endIf}

    ${if} $installMode == "all"
      SetShellVarContext all
    ${endif}
  ${endif}
!macroend
