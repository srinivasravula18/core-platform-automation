@echo off
REM TestFlow Desktop Agent — launcher. Self-contained: prod node_modules + compiled dist ship inside,
REM so there is NOTHING to install. Just double-click this file.
setlocal
cd /d "%~dp0"
set "AGENT_HOME=%CD%"
set "PLAYWRIGHT_BROWSERS_PATH=%CD%\browsers"

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
