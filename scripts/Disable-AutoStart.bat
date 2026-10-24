@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& { $s=[Environment]::GetFolderPath('Startup'); $v=Join-Path $s 'gemini-hakimi-daemon.vbs'; if (Test-Path $v) { Remove-Item $v -Force; Write-Host 'Auto-Start Disabled! Removed: ' $v } else { Write-Host 'Auto-Start was not enabled.' } }"
pause
