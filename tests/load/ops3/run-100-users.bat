@echo off
setlocal
pushd "%~dp0"

if not exist reports mkdir reports
call user-pool-300.cmd
call load-auth-env.cmd

if not defined API_BASE set API_BASE=http://localhost:5001
if not defined AUTH_API_BASE set AUTH_API_BASE=%API_BASE%
set SETUP_WAIT_SECONDS=2
if not defined DURATION set DURATION=2m
if not defined ADMIN_USERNAME set ADMIN_USERNAME=admin
if not defined ADMIN_PASSWORD set ADMIN_PASSWORD=admin
set SETUP_DESCRIBE=1
set FAILURE_LOG_LIMIT=50
set SEEDED_USER_POOL_LIMIT=300
set REQUIRE_UNIQUE_USERS=1
set SKIP_LIST_TABS=1
set QUERY_LIST_VIEW_EVERY=3
set SKIP_QUERY_LIST_VIEW=0
set SKIP_FILE_OPS=1
set MIN_ITERATION_MS=200
set CRM_OBJECT_API=account
set HR_OBJECT_API=department
set ADMIN_APP_VUS=2
set SHOCKWAVE_ADMIN_VUS=5
set CRM_VUS=83
set HR_VUS=10

k6 run "real-time-ops3-test.js"
if exist ops3-summary.html copy /Y ops3-summary.html reports\ops3-100-users-summary.html >nul

popd
