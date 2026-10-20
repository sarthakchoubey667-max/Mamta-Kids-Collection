@echo off
setlocal
cd /d "%~dp0"

if exist "C:\Program Files\nodejs\node.exe" (
  "C:\Program Files\nodejs\node.exe" --env-file-if-exists=.env server.js
  exit /b %errorlevel%
)

where node >nul 2>nul
if %errorlevel%==0 (
  node --env-file-if-exists=.env server.js
  exit /b %errorlevel%
)

echo Node.js was not found. Install Node.js or update the path in start-server.cmd.
pause
exit /b 1
