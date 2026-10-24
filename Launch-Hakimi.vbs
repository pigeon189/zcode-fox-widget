Set fso = CreateObject("Scripting.FileSystemObject")
strScriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
strTarget = strScriptDir & "\src\HakimiWidget.ps1"

Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & strTarget & """", 0, False
Set WshShell = Nothing
Set fso = Nothing
