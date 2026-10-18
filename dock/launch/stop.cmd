@echo off
setlocal
cd /d "%~dp0.."
set LOG=%~dp0last-stop.log
set NODE=
where node >nul 2>nul && set NODE=node
if not defined NODE if exist "%ProgramFiles%\nodejs\node.exe" set NODE="%ProgramFiles%\nodejs\node.exe"
if not defined NODE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set NODE="%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE (
  echo [fox-dock] node.exe not found.> "%LOG%" 2>&1
  exit /b 9009
)
%NODE% tools\fox-dock.mjs stop %* > "%LOG%" 2>&1
exit /b %ERRORLEVEL%
