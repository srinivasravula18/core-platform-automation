@echo off
setlocal
pushd "%~dp0\..\..\.."

powershell -ExecutionPolicy Bypass -File .\scripts\stop-all.ps1
powershell -ExecutionPolicy Bypass -File .\scripts\start-all-loadtest.ps1

popd
