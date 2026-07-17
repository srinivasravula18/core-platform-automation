@echo off
REM ============================================================================
REM TestFlow Agent — bundle builder (MAINTAINER step, run ONCE on the END-USER OS: Windows).
REM Produces a self-contained agent folder: node_modules + Chromium browser bundled in ./browsers,
REM so end users need to install NOTHING — they just run start.bat.
REM
REM After this finishes:
REM   - Zip this whole folder (it now contains node_modules + browsers), OR
REM   - Copy it to the server and set  AGENT_BUNDLE_DIR=<path-to-this-folder>  so the cloud
REM     Download Agent serves this self-contained bundle (with a fresh config.json injected).
REM ============================================================================
setlocal
cd /d "%~dp0"
set "PLAYWRIGHT_BROWSERS_PATH=%CD%\browsers"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18+ is required to BUILD the bundle. Install it from https://nodejs.org
  pause & exit /b 1
)

echo ============================================
echo   Installing agent dependencies (incl. tsx runtime)...
echo ============================================
call npm install --no-audit --no-fund
if errorlevel 1 goto :err

echo.
echo ============================================
echo   Bundling Chromium into .\browsers ...
echo ============================================
call npx playwright install chromium
if errorlevel 1 goto :err

echo.
echo Bundle ready in "%CD%". It now contains node_modules + browsers.
echo End users can run start.bat with no install. To distribute via the cloud, set
echo   AGENT_BUNDLE_DIR=%CD%
echo on the server and use Download Agent.
echo.
pause
exit /b 0

:err
echo.
echo Bundle build failed. See the messages above.
pause
exit /b 1
