@echo off
setlocal EnableExtensions

cd /d "%~dp0"
title Core Platform Testing Framework

echo.
echo ============================================================
echo  Core Platform Web Based Testing Framework
echo ============================================================
echo.

if exist ".env" (
  echo Loading .env
  for /f "usebackq eol=# tokens=1,* delims==" %%A in (".env") do (
    if not "%%A"=="" set "%%A=%%B"
  )
) else (
  echo .env was not found. Using defaults from the startup scripts.
)

if "%CORE_PLATFORM_ROOT%"=="" set "CORE_PLATFORM_ROOT=D:\core-platform"

if not exist "%CORE_PLATFORM_ROOT%\scripts\start-all.ps1" (
  echo.
  echo Core Platform app repo was not found at:
  echo   %CORE_PLATFORM_ROOT%
  echo.
  echo Paste the full path to your core-platform repo.
  echo Example: D:\core-platform
  echo.
  set /p "CORE_PLATFORM_ROOT=Core Platform path: "
)

set "CORE_PLATFORM_ROOT=%CORE_PLATFORM_ROOT:"=%"

if not exist "%CORE_PLATFORM_ROOT%\scripts\start-all.ps1" (
  echo.
  echo ERROR: This path is not a valid Core Platform repo:
  echo   %CORE_PLATFORM_ROOT%
  echo.
  echo It must contain:
  echo   scripts\start-all.ps1
  echo.
  pause
  exit /b 1
)

findstr /b /c:"CORE_PLATFORM_ROOT=" ".env" >nul 2>nul
if errorlevel 1 (
  echo CORE_PLATFORM_ROOT=%CORE_PLATFORM_ROOT%>>".env"
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "$p = '.env'; $v = 'CORE_PLATFORM_ROOT=' + $env:CORE_PLATFORM_ROOT; (Get-Content $p) -replace '^CORE_PLATFORM_ROOT=.*$', $v | Set-Content $p"
)

where node.exe >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: node.exe was not found on PATH.
  echo Install Node.js 20+ and reopen this terminal.
  pause
  exit /b 1
)

where npm.cmd >nul 2>nul
if errorlevel 1 (
  echo.
  echo ERROR: npm.cmd was not found on PATH.
  echo Install Node.js 20+ and reopen this terminal.
  pause
  exit /b 1
)

set "GITNEXUS_CMD=gitnexus.cmd"
call gitnexus.cmd --version >nul 2>nul
if errorlevel 1 (
  set "GITNEXUS_CMD=gitnexus"
  call gitnexus --version >nul 2>nul
)
if errorlevel 1 (
  echo.
  echo GitNexus CLI was not found. Installing globally with npm...
  call npm.cmd install -g gitnexus
  if errorlevel 1 (
    echo.
    echo ERROR: GitNexus install failed.
    echo You can also install it manually:
    echo   npm install -g gitnexus
    pause
    exit /b 1
  )
)

set "GITNEXUS_CMD=gitnexus.cmd"
call gitnexus.cmd --version >nul 2>nul
if errorlevel 1 (
  call gitnexus --version >nul 2>nul
  if not errorlevel 1 set "GITNEXUS_CMD=gitnexus"
)
if errorlevel 1 (
  echo.
  echo ERROR: GitNexus is still not available on PATH after install.
  echo Close this terminal, reopen it, and run run.bat again.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing dashboard dependencies...
  call npm.cmd install
  if errorlevel 1 (
    echo.
    echo ERROR: npm install failed.
    pause
    exit /b 1
  )
)

echo.
echo Reindexing GitNexus knowledge graph for:
echo   %CORE_PLATFORM_ROOT%
echo.
call %GITNEXUS_CMD% analyze "%CORE_PLATFORM_ROOT%" --index-only --force --worker-timeout 600 --max-file-size 32768
if errorlevel 1 (
  echo.
  echo ERROR: GitNexus reindex failed. The agent needs a current graph before generating tests.
  echo Check the GitNexus output above, then run this file again.
  pause
  exit /b 1
)

echo.
echo Starting all services:
echo   Core Platform: %CORE_PLATFORM_ROOT%
echo   Dashboard:     http://127.0.0.1:5372
echo.
echo Keep this window open while using the framework.
echo Press Ctrl+C to stop the foreground dashboard.
echo To stop all services later, run:
echo   npm run stop:all
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\tests\scripts\start-list-view-test-environment.ps1" -Port 5372
set "EXIT_CODE=%ERRORLEVEL%"

echo.
echo Framework exited with code %EXIT_CODE%.
pause
exit /b %EXIT_CODE%
