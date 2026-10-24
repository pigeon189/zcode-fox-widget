$WshShell = New-Object -ComObject WScript.Shell
$Desktop = [System.Environment]::GetFolderPath('Desktop')
$Shortcut = $WshShell.CreateShortcut((Join-Path $Desktop "反重力哈基米记账.lnk"))
$Shortcut.TargetPath = "wscript.exe"
$Shortcut.Arguments = """$PSScriptRoot\Launch-Hakimi.vbs"""
$Shortcut.WorkingDirectory = $PSScriptRoot
$Shortcut.IconLocation = "$PSScriptRoot\assets\icon.ico, 0"
$Shortcut.Description = "Gemini Hakimi - 反重力桌面记账小挂件"
$Shortcut.Save()
Write-Output "桌面快捷方式已成功创建到: $Desktop\反重力哈基米记账.lnk"
