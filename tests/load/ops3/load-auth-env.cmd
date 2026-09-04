@echo off
set "REPO_ENV=%~dp0..\..\..\.env"
if not exist "%REPO_ENV%" goto :eof

for /f "usebackq tokens=1,* delims==" %%A in ("%REPO_ENV%") do (
  if /i "%%~A"=="ADMIN_USERNAME" if not defined ADMIN_USERNAME set "ADMIN_USERNAME=%%~B"
  if /i "%%~A"=="ADMIN_PASSWORD" if not defined ADMIN_PASSWORD set "ADMIN_PASSWORD=%%~B"
)
