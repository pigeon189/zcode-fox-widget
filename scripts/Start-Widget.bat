@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 启动反重力哈基米桌宠记账

echo ===================================================
echo     ✦ Gemini Hakimi - 反重力记账桌宠 ✦
echo ===================================================
echo 正在检查并启动哈基米...

powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0src\HakimiWidget.ps1"

exit
