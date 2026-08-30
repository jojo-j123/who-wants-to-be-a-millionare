@echo off
REM Starts the show server and opens the launcher page.
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed. Get it from https://nodejs.org ^(any version 16 or newer^).
  pause
  exit /b 1
)

if "%PORT%"=="" set PORT=8080
start "" "http://localhost:%PORT%"
node server.js --port %PORT%
pause
