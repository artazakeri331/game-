@echo off
title Skyfront Multiplayer Server
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo Node.js was not found. Install the LTS version from https://nodejs.org/
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo Installing server packages for the first time...
  call npm install
  if errorlevel 1 (
    echo Package installation failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)

echo Starting Skyfront server...
call npm start
pause
