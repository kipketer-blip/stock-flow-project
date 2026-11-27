@echo off
title StockFlow Pro
cd /d "%~dp0"

echo ============================================
echo   StockFlow Pro - Inventory and Sales System
echo ============================================
echo.

rem 1. Node.js must be installed (version 20 or newer)
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js is not installed on this computer.
  echo Install the LTS version from https://nodejs.org, then run this file again.
  start "" https://nodejs.org
  pause
  exit /b 1
)
node -e "process.exit(Number(process.versions.node.split('.')[0]) >= 20 ? 0 : 1)"
if errorlevel 1 (
  echo Your Node.js version is too old:
  node --version
  echo Install version 20 LTS or newer from https://nodejs.org, then run this file again.
  pause
  exit /b 1
)

rem 2. Libraries: install if missing, repair the database driver if it was built for another PC
if not exist "node_modules\express" (
  echo Installing libraries - this needs internet and takes a minute...
  call npm install --no-audit --no-fund
  if errorlevel 1 goto :npmfail
)
node -e "require('better-sqlite3')" >nul 2>nul
if errorlevel 1 (
  echo Preparing the database driver for this computer...
  call npm rebuild better-sqlite3
  node -e "require('better-sqlite3')" >nul 2>nul
  if errorlevel 1 (
    call npm install --no-audit --no-fund
    node -e "require('better-sqlite3')" >nul 2>nul
    if errorlevel 1 goto :npmfail
  )
)

rem 3. Start the server and open the browser
if "%PORT%"=="" set PORT=3000
echo.
echo Starting StockFlow Pro on http://localhost:%PORT%
echo First login: admin / admin123  (change the password after signing in)
echo Keep this window open while using the system. Close it to stop the server.
echo.
if not defined STOCKFLOW_NO_BROWSER start "" cmd /c "timeout /t 3 /nobreak >nul & start http://localhost:%PORT%"
node server.js
echo.
echo The server has stopped.
pause
exit /b 0

:npmfail
echo.
echo Could not install the libraries. Check the internet connection and try again.
pause
exit /b 1
