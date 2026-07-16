@echo off
REM TestFlow Desktop Agent — one-click installer.
REM Installs Node dependencies and Playwright browsers into this folder. No global changes.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo Node.js is required but was not found on PATH.
  echo Please install Node.js 18 or newer from https://nodejs.org and re-run install.bat
  echo.
  pause
  exit /b 1
)

echo ============================================
echo   Installing TestFlow Agent dependencies...
echo ============================================
call npm install --no-audit --no-fund
if errorlevel 1 goto :err

echo.
echo ============================================
echo   Installing Playwright browsers...
echo ============================================
call npx playwright install
if errorlevel 1 goto :err

echo.
echo Installation complete. Double-click start.bat to launch the agent.
echo.
pause
exit /b 0

:err
echo.
echo Installation failed. See the messages above.
pause
exit /b 1
