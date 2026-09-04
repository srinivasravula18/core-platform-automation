@echo off
setlocal
pushd "%~dp0"

if not defined API_BASE set API_BASE=https://ops.acchindra.com
set ADMIN_USERNAME=admin
set ADMIN_PASSWORD=change-me

k6 run "shockwave-bulk-load-test.js"
popd
