@echo off
rem Starts the ai-hub interface: double-click. It opens in the browser; close this window to stop it.
rem If Node.js is missing (first time) it runs bootstrap.cmd, which installs it after asking permission.
rem (No parenthesized blocks: cmd mishandles variables set in the same block.)
setlocal
cd /d "%~dp0"
title ai-hub

where node >nul 2>nul
if errorlevel 1 goto prepare
for /f %%v in ('node -p "process.versions.node.split(/[.]/)[0]"') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR goto prepare
if %NODE_MAJOR% LSS 18 goto prepare

node ui\server.mjs %*
set "RC=%errorlevel%"
if not "%RC%"=="0" pause
exit /b %RC%

:prepare
echo Before starting, this computer needs to be prepared (Node.js).
call "%~dp0bootstrap.cmd"
exit /b %errorlevel%
