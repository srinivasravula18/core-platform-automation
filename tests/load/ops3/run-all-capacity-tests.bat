@echo off
setlocal
pushd "%~dp0"

echo Running staged ops3 capacity tests...
echo.

call run-100-users.bat
if errorlevel 1 goto :fail

call run-150-users.bat
if errorlevel 1 goto :fail

call run-200-users.bat
if errorlevel 1 goto :fail

call run-250-users.bat
if errorlevel 1 goto :fail

call run-300-users.bat
if errorlevel 1 goto :fail

echo.
echo All staged ops3 capacity tests completed.
echo Reports are in "%~dp0reports"
popd
exit /b 0

:fail
echo.
echo Capacity test sequence stopped because one of the runs failed.
echo Check the console output and the reports folder for the last successful run.
popd
exit /b 1
