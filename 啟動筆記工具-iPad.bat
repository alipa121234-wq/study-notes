@echo off
setlocal
title StudyNote (LAN) - close this window to stop the app
cd /d "%~dp0"

rem Same as the normal launcher, but binds to the whole network so that
rem an iPad / iPhone on the same Wi-Fi (or hotspot) can connect.

set PY=
where py >nul 2>nul
if not errorlevel 1 set PY=py
if defined PY goto :gotpy

where python3 >nul 2>nul
if not errorlevel 1 set PY=python3
if defined PY goto :gotpy

where python >nul 2>nul
if not errorlevel 1 set PY=python

:gotpy
if not defined PY (
  echo.
  echo [ERROR] Python not found.
  echo Install Python from https://www.python.org/downloads/
  echo and tick "Add python.exe to PATH" during setup.
  echo.
  pause
  exit /b 1
)

%PY% serve.py lan

echo.
echo Server stopped.
pause
