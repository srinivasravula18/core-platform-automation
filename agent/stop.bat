@echo off
REM TestFlow Desktop Agent — stop. Terminates whatever is listening on the agent's local port (2424).
setlocal
set FOUND=0
for /f "tokens=5" %%a in ('netstat -ano ^| findstr :2424 ^| findstr LISTENING') do (
  taskkill /pid %%a /t /f >nul 2>nul
  set FOUND=1
)
if "%FOUND%"=="1" (echo TestFlow Agent stopped.) else (echo TestFlow Agent was not running.)
