@echo off
REM TestFlow Desktop Agent — launcher. Self-contained: prod node_modules + compiled dist ship inside,
REM so there is NOTHING to install. Just double-click this file.
setlocal
cd /d "%~dp0"
set "AGENT_HOME=%CD%"
set "PLAYWRIGHT_BROWSERS_PATH=%CD%\browsers"

REM The personalized ZIP is tiny. Fetch the shared Playwright + Chromium runtime once from the
REM immutable URL supplied by the server; curl resumes interrupted downloads automatically.
if exist "%CD%\dist\index.js" goto runtime_ready
if exist "%CD%\runtime.zip" goto extract_runtime
if not exist "%CD%\runtime.url" goto runtime_ready

set /p "RUNTIME_URL="<"%CD%\runtime.url"
if "%RUNTIME_URL%"=="" (
  echo The agent runtime URL is missing. Re-download the agent and try again.
  pause
  exit /b 1
)
echo Downloading the TestFlow Agent runtime ^(Playwright + Chromium, one time^)...
curl.exe --fail --location --retry 3 --retry-delay 2 --continue-at - --output "%CD%\runtime.zip.part" "%RUNTIME_URL%"
if errorlevel 1 (
  echo curl could not download the runtime; retrying with PowerShell...
  powershell -NoProfile -ExecutionPolicy Bypass -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '%RUNTIME_URL%' -OutFile '%CD%\runtime.zip.part'"
)
if errorlevel 1 (
  echo The agent runtime download failed. Check your connection and run start.bat again to retry.
  pause
  exit /b 1
)
move /y "%CD%\runtime.zip.part" "%CD%\runtime.zip" >nul

:extract_runtime
echo Preparing the TestFlow Agent runtime ^(one time^)...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%CD%\runtime.zip' -DestinationPath '%CD%' -Force"
if errorlevel 1 (
  echo The agent runtime could not be extracted. Run start.bat again to retry.
  pause
  exit /b 1
)
del /q "%CD%\runtime.zip"

:runtime_ready

REM Prefer a bundled portable Node if present, so Node need not be installed on this machine.
if exist "%CD%\node\node.exe" set "PATH=%CD%\node;%PATH%"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found and no portable Node is bundled.
  echo Install Node.js 18+ from https://nodejs.org and run this again.
  pause
  exit /b 1
)

if not exist "dist\index.js" (
  echo This bundle is missing dist\index.js ^(not built^). Re-download the agent from TestFlow AI.
  pause
  exit /b 1
)

echo Starting TestFlow Agent on http://localhost:2424 ...
echo Close this window or run stop.bat to stop the agent.
node dist\index.js
