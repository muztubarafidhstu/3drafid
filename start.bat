@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Download the LTS version from https://nodejs.org , install it, then double-click this file again.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: installing, this takes a minute...
  call npm install --omit=dev
)
start "" cmd /c "timeout /t 3 >nul & start http://localhost:3000"
echo Shop admin is running at http://localhost:3000  (close this window to stop it)
node server.js
pause
