@echo off
setlocal
title StudyNote - close this window to stop the app
cd /d "%~dp0"

rem --- find a working Python launcher ---
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

rem serve.py opens the browser itself, only after the socket is listening.
rem It also detects an already-running copy. Pass "lan" to allow iPad/phone access.
%PY% serve.py %1

echo.
echo Server stopped.
pause
