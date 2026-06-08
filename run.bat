@echo off
setlocal

cd /d "%~dp0"

echo.
echo == TestFlowAI local run ==
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is required but was not found in PATH.
  exit /b 1
)

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is required but was not found in PATH.
  exit /b 1
)

if not exist ".env.local" (
  echo Creating .env.local from .env.example
  if exist ".env.example" (
    copy ".env.example" ".env.local" >nul
  ) else (
    type nul > ".env.local"
  )
)

echo Installing node modules...
call npm install
if errorlevel 1 exit /b 1

echo Stopping existing TestFlowAI listeners on ports 3000 and 3001...
powershell -NoProfile -ExecutionPolicy Bypass -Command "Get-NetTCPConnection -LocalPort 3000,3001 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }"

echo.
echo Frontend: http://localhost:3000
echo Backend:  http://localhost:3001
findstr /B /C:"DATABASE_URL=" ".env.local" >nul 2>nul
if errorlevel 1 (
  echo Database: JSON file persistence .testflow-data.json
  echo To use Postgres locally, add DATABASE_URL to .env.local before running this file.
) else (
  echo Database: DATABASE_URL from .env.local
)
echo.

start "TestFlowAI Backend :3001" cmd /k "cd /d ""%~dp0"" && npm run dev:backend"
start "TestFlowAI Frontend :3000" cmd /k "cd /d ""%~dp0"" && npm run dev:frontend"

echo Run complete. Two terminal windows were opened for the backend and frontend.
endlocal
