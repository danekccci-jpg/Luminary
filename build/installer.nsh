; Custom NSIS branding for Luminary Cinema installer
; Loaded via electron-builder nsis.include

!macro customHeader
  !system "echo Building Luminary Cinema NSIS installer..."
!macroend

!macro customWelcomePage
  ; Keep default modern UI welcome; branding comes from installerIcon / header icon
!macroend

!macro customInstallMode
  ; oneClick:false + allowToChangeInstallationDirectory handled by electron-builder
!macroend
