@echo off
rem Start on Windows (double-click, or from PowerShell / Command Prompt: .\bootstrap.cmd).
rem Makes sure Node.js (>= 22) is there, then runs "node scripts\setup.mjs", which installs the rest from dependencies.json.
rem Setup options: .\bootstrap.cmd --yes
rem (No parenthesized blocks: cmd mishandles %ProgramFiles% and variables set in the same block.)
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode
for /f %%v in ('node -p "process.versions.node.split(/[.]/)[0]"') do set "NODE_MAJOR=%%v"
if not defined NODE_MAJOR goto nonode
if %NODE_MAJOR% GEQ 22 goto run

:nonode
echo Node.js 22 or newer not found.
where winget >nul 2>nul
if errorlevel 1 goto manual
set /p ANS="Install it with winget (winget install OpenJS.NodeJS.LTS)? [y/N] "
if /i "%ANS%"=="y" goto install
if /i "%ANS%"=="yes" goto install
if /i "%ANS%"=="s" goto install
if /i "%ANS%"=="si" goto install
goto manual

:install
winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
if errorlevel 1 goto failed
rem This window's PATH does not know Node yet: add it for this run only.
set "PATH=%ProgramFiles%\nodejs;%PATH%"
where node >nul 2>nul
if errorlevel 1 goto reopen
goto run

:manual
echo Install Node.js from https://nodejs.org/en/download and run bootstrap.cmd again
pause
exit /b 1

:failed
echo Installing Node.js failed.
pause
exit /b 1

:reopen
echo Node.js was installed: close this window, reopen it and run bootstrap.cmd again
pause
exit /b 1

:run
node scripts\setup.mjs %*
set "RC=%errorlevel%"
if not "%RC%"=="0" pause
exit /b %RC%
