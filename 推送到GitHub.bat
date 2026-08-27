@echo off
setlocal
title Push to GitHub
cd /d "%~dp0"

echo.
echo  ============================================================
echo   Pushing to GitHub
echo.
echo   A browser window will open asking you to sign in to GitHub.
echo   Complete the sign-in, then come back here.
echo.
echo   This is only needed ONCE. After that the credential is
echo   remembered and future pushes happen automatically.
echo  ============================================================
echo.

git push -u origin main

echo.
if errorlevel 1 (
  echo  [FAILED] Push did not complete. See the message above.
) else (
  echo  [OK] Pushed successfully.
  echo.
  echo  Next: tell Claude it is done, and Pages will be enabled.
)
echo.
pause
