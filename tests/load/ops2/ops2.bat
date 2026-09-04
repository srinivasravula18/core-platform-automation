@echo off
setlocal
pushd "%~dp0"

if not defined API_BASE set API_BASE=https://ops.acchindra.com
set SETUP_WAIT_SECONDS=30
set DURATION=1m
set SKIP_FILE_OPS=1
set ADMIN_USERNAME=admin
set ADMIN_PASSWORD=change-me
set USER_POOL=User01:user01test,User02:user02test,User03:user03test,User04:user04test,User05:user05test,User06:user06test,User07:user07test,User08:user08test,User09:user09test,User10:user10test,User11:user11test,User12:user12test,User46:user46test,User47:user47test,User48:user48test,User49:user49test,User50:user50test,User51:user51test,User52:user52test,User53:user53test,User54:user54test,User55:user55test,User56:user56test,User57:user57test,User58:user58test,User59:user59test,User60:user60test,User61:user61test

k6 run "real-time-ops2-test.js"
popd
