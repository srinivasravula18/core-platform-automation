@echo off
REM TestFlow Desktop Agent — launcher. Runs the agent on http://localhost:2424 and connects to the cloud.
setlocal
cd /d "%~dp0"
set AGENT_HOME=%CD%

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js not found on PATH. Run install.bat first.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Dependencies are not installed yet. Running install.bat first...
  call install.bat
)

echo Starting TestFlow Agent on http://localhost:2424 ...
echo Close this window or run stop.bat to stop the agent.
call npx tsx src/index.ts
