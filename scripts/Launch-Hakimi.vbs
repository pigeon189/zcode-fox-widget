Set fso = CreateObject("Scripting.FileSystemObject")
strScriptDir = fso.GetParentFolderName(WScript.ScriptFullName)
strPluginRoot = fso.GetParentFolderName(strScriptDir)
strTarget = strPluginRoot & "\src\HakimiWidget.ps1"

On Error Resume Next
Set objWMIService = GetObject("winmgmts:\\.\root\cimv2")
If Err.Number = 0 Then
    Set colItems = objWMIService.ExecQuery("SELECT ProcessId FROM Win32_Process WHERE Name = 'powershell.exe' AND CommandLine LIKE '%HakimiWidget.ps1%'")
    If colItems.Count > 0 Then
        WScript.Quit 0
    End If
End If
On Error GoTo 0

Set WshShell = CreateObject("WScript.Shell")
WshShell.Run "powershell.exe -STA -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File """ & strTarget & """", 0, False
Set WshShell = Nothing
Set fso = Nothing
