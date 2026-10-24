$running = Get-WmiObject Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.CommandLine -match 'HakimiWidget.ps1' }
if (!$running) {
    # 优先请求 Sidecar 后端直接在用户真实交互桌面 WinSta0\Default 启动桌宠
    $started = $false
    try {
        $resp = Invoke-RestMethod -Uri "http://127.0.0.1:54716/api/desktop-pet" -Method Post -Body '{"action":"start"}' -ContentType "application/json" -TimeoutSec 2 -ErrorAction Stop
        if ($resp.ok) { $started = $true }
    } catch {}

    if (!$started) {
        $scriptDir = Split-Path $PSScriptRoot -Parent
        $pyServer = Join-Path $scriptDir "sidecars\hakimi_panel\server.py"
        if (Test-Path $pyServer) {
            Start-Process "python.exe" -ArgumentList "-c `"import sys; sys.path.insert(0, r'$((Split-Path $pyServer))'); import server; server.start_desktop_pet()`"" -WindowStyle Hidden
        } else {
            $vbs = Join-Path $scriptDir "scripts\Launch-Hakimi.vbs"
            if (Test-Path $vbs) {
                Start-Process "wscript.exe" -ArgumentList "`"$vbs`"" -WindowStyle Hidden
            }
        }
    }
}
Write-Output "{}"
