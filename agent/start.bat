@echo off
REM TestFlow Desktop Agent — launcher only. Self-contained: prod node_modules, compiled dist and
REM Chromium all ship inside the ZIP you unzipped, so there is NOTHING to install or unpack.
setlocal
cd /d "%~dp0"
set "AGENT_HOME=%CD%"
set "PLAYWRIGHT_BROWSERS_PATH=%CD%\browsers"

REM Legacy: bundles downloaded before the flat-archive change carry a nested runtime.zip. Current
REM downloads never do — the ZIP you unzipped is already the complete agent. Remove after one release.
if exist "%CD%\runtime.zip" (
  if not exist "dist\index.js" (
    echo Preparing the TestFlow Agent runtime ^(one time^)...
    powershell -NoProfile -ExecutionPolicy Bypass -Command "Expand-Archive -LiteralPath '%CD%\runtime.zip' -DestinationPath '%CD%' -Force"
    if errorlevel 1 (
      echo The bundled runtime could not be extracted. Re-download the agent and try again.
      pause
      exit /b 1
    )
  )
  del /q "%CD%\runtime.zip"
)

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
