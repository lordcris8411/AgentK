@echo off
setlocal

set "PROJECT_ROOT=%~dp0"
set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"

cd /d "%PROJECT_ROOT%pi-visual-client"
call npm run tauri -- dev

endlocal
