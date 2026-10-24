@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "& { $s=[Environment]::GetFolderPath('Startup'); $v=Join-Path $s 'gemini-hakimi-daemon.vbs'; $t=Join-Path $PSScriptRoot 'Launch-Hakimi.vbs'; $c='Set WshShell = CreateObject(\"WScript.Shell\")`r`nWshShell.Run \"wscript.exe `\"' + $t + '`\"\", 0, False`r`nSet WshShell = Nothing'; [IO.File]::WriteAllText($v,$c,[Text.Encoding]::ASCII); Write-Host 'Auto-Start Enabled! VBS: ' $v }"
pause
