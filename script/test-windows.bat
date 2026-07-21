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

call :run npm ci --ignore-scripts || goto :failed
call :run npm run check || goto :failed
call :run npm test || goto :failed
call :run npm run build || goto :failed
call :run cargo fmt --manifest-path src-tauri/Cargo.toml -- --check || goto :failed
call :run cargo check --manifest-path src-tauri/Cargo.toml || goto :failed
call :run cargo test --manifest-path src-tauri/Cargo.toml --lib || goto :failed

echo.
echo All AgentK Windows tests passed.
exit /b 0

:run
echo.
echo ==^> %*
call %*
exit /b %errorlevel%

:failed
echo.
echo AgentK tests failed.
exit /b 1
