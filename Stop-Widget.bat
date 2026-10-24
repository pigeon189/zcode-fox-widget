@echo off
chcp 65001 >nul
echo 正在停止反重力哈基米记账挂件...

powershell.exe -NoProfile -ExecutionPolicy Bypass -Command ^
  "Get-WmiObject Win32_Process | Where-Object { $_.CommandLine -match 'HakimiWidget.ps1' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"

echo 哈基米已优雅退场喵～
timeout /t 2 >nul
exit
