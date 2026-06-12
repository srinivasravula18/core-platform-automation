@echo off
REM Test Flow AI - DATA RESET (destructive). Wipes Postgres tables + the local JSON
REM persistence files, so the app re-seeds demo data and the admin/mark logins next start.
setlocal
cd /d "%~dp0.."

echo == Test Flow AI - DATA RESET ==
echo This DELETES ALL data:
echo   - Postgres: every table in the public schema is truncated
echo   - JSON: .testflow-data.json and .testflow-settings.json are removed
echo   (projects, cases, runs, reports, defects, app users, websites, knowledge, usage)
echo The app re-seeds demo data and recreates the admin/mark logins on next start.
echo.

set "ans="
set /p "ans=Type 'reset' to confirm: "
if /I not "%ans%"=="reset" (
  echo Aborted.
  exit /b 1
)

set RESET_CONFIRM=1
node scripts\reset-data.mjs
set "exitcode=%ERRORLEVEL%"
endlocal & exit /b %exitcode%
