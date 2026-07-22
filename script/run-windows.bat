@echo off
setlocal

cd /d "%~dp0\.."

where npm >nul 2>nul
if errorlevel 1 (
  echo Error: npm was not found. Install Node.js 22.19 or newer.
  exit /b 1
)

if not exist "node_modules\.bin\electron.cmd" goto :install_dependencies
if not exist "node_modules\node-pty\package.json" goto :install_dependencies
goto :dependencies_ready

:install_dependencies
echo Installing npm dependencies...
call npm ci --ignore-scripts
if errorlevel 1 exit /b 1

:dependencies_ready

if not exist "node_modules\electron\dist\electron.exe" (
  echo Installing the reviewed Electron runtime...
  node node_modules\electron\install.js
  if errorlevel 1 exit /b 1
)

echo Starting Agent K in Electron development mode...
call npm run dev -- %*
exit /b %errorlevel%
