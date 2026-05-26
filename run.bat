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
  echo ERROR: Core Platform app repo was not found at:
  echo   %CORE_PLATFORM_ROOT%
  echo.
  echo Set CORE_PLATFORM_ROOT in .env, then run this file again.
  echo Example:
  echo   CORE_PLATFORM_ROOT=D:\core-platform
  echo.
  pause
  exit /b 1
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
