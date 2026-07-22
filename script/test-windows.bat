@echo off
setlocal

cd /d "%~dp0\.."

where npm >nul 2>nul
if errorlevel 1 (
  echo Error: npm was not found. Install Node.js 22.19 or newer.
  exit /b 1
)

call :run npm ci --ignore-scripts || goto :failed
call :run npm run prepare:native || goto :failed
call :run npm run check || goto :failed
call :run npm test || goto :failed
call :run npm run build || goto :failed

echo.
echo All Agent K Windows tests passed.
exit /b 0

:run
echo.
echo ==^> %*
call %*
exit /b %errorlevel%

:failed
echo.
echo Agent K tests failed.
exit /b 1
