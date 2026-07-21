@echo off
setlocal

cd /d "%~dp0\.."

where npm >nul 2>nul
if errorlevel 1 (
  echo Error: npm was not found. Install Node.js 22.19 or newer.
  exit /b 1
)

where cargo >nul 2>nul
if errorlevel 1 if exist "%USERPROFILE%\.cargo\bin\cargo.exe" (
  set "PATH=%USERPROFILE%\.cargo\bin;%PATH%"
)

where cargo >nul 2>nul
if errorlevel 1 (
  echo Error: cargo was not found. Install the Rust stable MSVC toolchain with rustup.
  exit /b 1
)

if not exist "node_modules\.bin\tauri.cmd" (
  echo Installing npm dependencies...
  call npm ci --ignore-scripts
  if errorlevel 1 exit /b 1
)

echo Starting AgentK in Windows development mode...
call npm run tauri -- dev %*
exit /b %errorlevel%
