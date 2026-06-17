!macro customInstall
  SetOutPath "$INSTDIR"
  File "/oname=$INSTDIR\uninstall-claude-hooks.ps1" "${BUILD_RESOURCES_DIR}\uninstall-claude-hooks.ps1"
  FileOpen $0 "$INSTDIR\.clawd-install-user-home" w
  FileWrite $0 "$PROFILE"
  FileClose $0
!macroend

!macro customUnInstall
  StrCpy $1 "$PROFILE"
  IfFileExists "$INSTDIR\.clawd-install-user-home" 0 clawd_node_cleanup_home_done
    FileOpen $0 "$INSTDIR\.clawd-install-user-home" r
    FileRead $0 $1
    FileClose $0
  clawd_node_cleanup_home_done:

  StrCpy $2 "$INSTDIR\MiniCPM Desk Pet.exe"
  IfFileExists "$2" clawd_node_cleanup_have_exe 0
  ; Legacy upstream executable name, kept only so uninstall cleanup can run
  ; when a local install dir still contains older migrated artifacts.
  StrCpy $2 "$INSTDIR\Clawd on Desk.exe"
  IfFileExists "$2" clawd_node_cleanup_have_exe clawd_node_cleanup_done

  clawd_node_cleanup_have_exe:
  IfFileExists "$INSTDIR\resources\app.asar.unpacked\hooks\cleanup-integrations.js" 0 clawd_node_cleanup_done
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i("ELECTRON_RUN_AS_NODE", "1").r0'
    nsExec::ExecToLog '"$2" "$INSTDIR\resources\app.asar.unpacked\hooks\cleanup-integrations.js" --apply --user-home "$1" --source nsis --fail-open'
    Pop $0
    System::Call 'Kernel32::SetEnvironmentVariable(t, t)i("ELECTRON_RUN_AS_NODE", "").r0'
  clawd_node_cleanup_done:

  IfFileExists "$INSTDIR\uninstall-claude-hooks.ps1" 0 clawd_uninstall_hooks_done
    nsExec::ExecToLog 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "$INSTDIR\uninstall-claude-hooks.ps1" -InstallDir "$INSTDIR"'
    Pop $0
  clawd_uninstall_hooks_done:
!macroend
