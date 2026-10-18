@echo off
cd /d "%~dp0.."
where node >nul 2>nul
if errorlevel 1 (
  echo node.exe not found in PATH.
  pause
  exit /b 9009
)
node tools\fox-dock.mjs status
echo.
echo Press any key to close...
pause >nul
