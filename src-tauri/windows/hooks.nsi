; Aether NSIS installer hooks (Tauri `bundle.windows.nsis.installerHooks`).
;
; Audit T1-14: the VC++ 2015-2022 x64 redistributable was copied into the
; install directory as a resource but never executed, so a fresh machine
; without the CRT failed at first launch. Run it silently after install.

!macro NSIS_HOOK_POSTINSTALL
  IfFileExists "$INSTDIR\Requirements\vcredist\VC_redist.x64.exe" 0 +4
    DetailPrint "Installing Microsoft Visual C++ Redistributable..."
    ExecWait '"$INSTDIR\Requirements\vcredist\VC_redist.x64.exe" /install /quiet /norestart' $0
    DetailPrint "VC++ Redistributable exit code: $0"
!macroend
