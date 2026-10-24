<#
.SYNOPSIS
    Antigravity Token Monitor & Live Official Quota Synchronizer
    Strictly 4 Models: Gemini 4 Argon, Gemini 3.8 Flash, Claude Opus 5.5, Claude Sonnet 5.5
    Fetches real-time official quotas directly from Antigravity language_server.exe (GetUserStatus RPC)
#>

class AntigravityMonitor {
    [string]$BrainPath
    [string]$AgyDataPath
    [string]$ConfigDir
    [hashtable]$Pricing
    [string]$ActiveModel
    [string]$ActivePlan
    [string]$LastPbtxtModel = ""
    [string]$CurrentConvId = ""
    [string]$CurrentTranscriptPath = ""
    [long]$LastFileOffset = 0
    [datetime]$LastQuotaSync = [datetime]::MinValue
    [hashtable]$CachedLiveQuotas = $null

    [hashtable]$ConvModelCache = @{}
    [hashtable]$TranscriptFileCache = @{}

    [hashtable]$LastTurn = @{
        InputTokens = 0L
        CacheReadTokens = 0L
        OutputTokens = 0L
        TotalTokens = 0L
        CacheHitRate = 0.0
        CostUSD = 0.0
        CostCNY = 0.0
        SavingsUSD = 0.0
        SavingsCNY = 0.0
        Timestamp = [datetime]::MinValue
    }

    [hashtable]$Session = @{
        ConvId = ""
        Turns = 0
        InputTokens = 0L
        CacheReadTokens = 0L
        OutputTokens = 0L
        TotalTokens = 0L
        CurrentContext = 0L
        ContextPct = 0.0
        CostUSD = 0.0
        CostCNY = 0.0
        SavingsUSD = 0.0
        SavingsCNY = 0.0
    }

    [hashtable]$Today = @{
        Turns = 0
        InputTokens = 0L
        CacheReadTokens = 0L
        OutputTokens = 0L
        TotalTokens = 0L
        CostUSD = 0.0
        CostCNY = 0.0
        SavingsUSD = 0.0
        SavingsCNY = 0.0
    }

    [hashtable]$FiveHour = @{
        Turns = 0
        TotalTokens = 0L
        LimitTurns = 2500
        LimitTokens = 80000000L
        UsedPct = 0
        RemainingPct = 100
        ResetDisplay = "重置 --:--"
    }

    [hashtable]$Weekly = @{
        Turns = 0
        TotalTokens = 0L
        LimitTurns = 15000
        LimitTokens = 500000000L
        UsedPct = 0
        RemainingPct = 100
        ResetDisplay = "重置 --:--"
    }

    [System.Collections.Generic.List[hashtable]]$ModelQuotas = [System.Collections.Generic.List[hashtable]]::new()

    [hashtable]$RateLimits = @{
        CurrentRPM = 0
        MaxRPM = 15
        CurrentTPM = 0L
        MaxTPM = 1000000L
        CurrentRPD = 0
        MaxRPD = 1500
        ContextWindow = 1048576L
        ResetCountdown = "00:00:00"
    }

    [System.Collections.Generic.List[hashtable]]$RecentRequests = [System.Collections.Generic.List[hashtable]]::new()

        [hashtable]$ActiveRound = @{
        IsActive = $false
        Steps = 0
        InputTokens = 0L
        CacheReadTokens = 0L
        OutputTokens = 0L
        TotalTokens = 0L
    }
    [scriptblock]$OnTurnFinished = $null
    [scriptblock]$OnRoundFinished = $null

    AntigravityMonitor([string]$brainPath, [string]$pricingPath, [string]$model, [string]$plan) {
        $this.BrainPath = $brainPath
        $this.AgyDataPath = Split-Path -Parent $brainPath
        $this.ConfigDir = Join-Path (Split-Path -Parent (Split-Path -Parent $pricingPath)) "config"
        $this.ActiveModel = $model
        $this.ActivePlan = $plan
        $this.LoadPricing($pricingPath)
        $detected = $this.DetectAntigravityActiveModel()
        if (![string]::IsNullOrEmpty($detected)) {
            $this.ActiveModel = $detected
            $this.LastPbtxtModel = $detected
        }
        $this.UpdateModelLimits()
        $this.ScanAllWindows()
        $this.CheckActiveConversation()
    }

    [void]LoadPricing([string]$pricingPath) {
        if (Test-Path $pricingPath) {
            $json = Get-Content -LiteralPath $pricingPath -Raw -Encoding UTF8 | ConvertFrom-Json
            $defaultCtx = 1048576L
            if ($null -ne $json.context_window) { $defaultCtx = [long]$json.context_window }

            $freeRpm = 15; $freeTpm = 1000000L; $freeRpd = 1500; $freeMult = 1.0
            $tier1Rpm = 1000; $tier1Tpm = 4000000L; $tier1Rpd = 10000; $tier1Mult = 5.0
            if ($null -ne $json.limits) {
                if ($null -ne $json.limits.free) {
                    $freeRpm = [int]$json.limits.free.rpm
                    $freeTpm = [long]$json.limits.free.tpm
                    $freeRpd = [int]$json.limits.free.rpd
                    if ($null -ne $json.limits.free.quota_multiplier) { $freeMult = [double]$json.limits.free.quota_multiplier }
                }
                if ($null -ne $json.limits.tier1) {
                    $tier1Rpm = [int]$json.limits.tier1.rpm
                    $tier1Tpm = [long]$json.limits.tier1.tpm
                    $tier1Rpd = [int]$json.limits.tier1.rpd
                    if ($null -ne $json.limits.tier1.quota_multiplier) { $tier1Mult = [double]$json.limits.tier1.quota_multiplier }
                }
            }

            $modelsHash = @{}
            if ($null -ne $json.models) {
                foreach ($p in $json.models.PSObject.Properties) {
                    $k = $p.Name
                    $v = $p.Value
                    $tiersList = @()
                    if ($null -ne $v.tiers) {
                        foreach ($t in $v.tiers) {
                            $maxIn = [long]::MaxValue
                            if ($null -ne $t.maxIn) { $maxIn = [long]$t.maxIn }
                            $tiersList += @{
                                maxIn = $maxIn
                                hit = [double]$t.hit
                                miss = [double]$t.miss
                                out = [double]$t.out
                            }
                        }
                    }
                    $modelsHash[$k] = @{
                        display_name = [string]$v.display_name
                        short_name = [string]$v.short_name
                        vendor = [string]$v.vendor
                        badge = [string]$v.badge
                        note = [string]$v.note
                        context_window = $(if ($null -ne $v.context_window) { [long]$v.context_window } else { $defaultCtx })
                        quota_5h_turns = $(if ($null -ne $v.quota_5h_turns) { [int]$v.quota_5h_turns } else { 1200 })
                        quota_5h_tokens = $(if ($null -ne $v.quota_5h_tokens) { [long]$v.quota_5h_tokens } else { 45000000L })
                        quota_weekly_turns = $(if ($null -ne $v.quota_weekly_turns) { [int]$v.quota_weekly_turns } else { 7000 })
                        quota_weekly_tokens = $(if ($null -ne $v.quota_weekly_tokens) { [long]$v.quota_weekly_tokens } else { 280000000L })
                        tiers = $tiersList
                    }
                }
            }

            $this.Pricing = @{
                usd_to_cny = $(if ($null -ne $json.usd_to_cny) { [double]$json.usd_to_cny } else { 7.25 })
                default_model = $(if ($null -ne $json.default_model) { [string]$json.default_model } else { "gemini-4-argon" })
                context_window = $defaultCtx
                models = $modelsHash
                limits = @{
                    free = @{ rpm = $freeRpm; tpm = $freeTpm; rpd = $freeRpd; quota_multiplier = $freeMult }
                    tier1 = @{ rpm = $tier1Rpm; tpm = $tier1Tpm; rpd = $tier1Rpd; quota_multiplier = $tier1Mult }
                }
            }
        }
    }

    [void]SetModel([string]$model, [string]$plan) {
        $this.ActiveModel = $model
        $this.ActivePlan = $plan
        $this.UpdateModelLimits()
        $this.RecalculateSessionCost()
        $this.ScanAllWindows()
    }

    [void]UpdateModelLimits() {
        if (!$this.Pricing) { return }
        $m = $this.Pricing.models[$this.ActiveModel]
        if ($m) {
            $this.RateLimits.ContextWindow = [long]$m.context_window
        }
        $limits = $this.Pricing.limits[$this.ActivePlan]
        if ($limits) {
            $this.RateLimits.MaxRPM = [int]$limits.rpm
            $this.RateLimits.MaxTPM = [long]$limits.tpm
            $this.RateLimits.MaxRPD = [int]$limits.rpd
        }
    }

    [string]DetectAntigravityActiveModel() {
        $pbtxtPath = Join-Path $this.AgyDataPath "antigravity_state.pbtxt"
        if (Test-Path $pbtxtPath) {
            try {
                $content = Get-Content -LiteralPath $pbtxtPath -Raw -Encoding UTF8
                if ($content -match 'last_selected_agent_model:\s*(\S+)') {
                    $raw = $Matches[1].Trim('"'' ')
                    if ($raw -match 'M417|M418|M419|M421|argon') {
                        return "gemini-4-argon"
                    }
                    if ($raw -match 'M318|M319|M320|flash') {
                        return "gemini-3.8-flash"
                    }
                    if ($raw -match 'M400|M401|M402|M26|opus') {
                        return "claude-opus-5-5"
                    }
                    if ($raw -match 'M403|M404|M405|M35|sonnet') {
                        return "claude-sonnet-5-5"
                    }
                }
            } catch {}
        }
        if ([string]::IsNullOrEmpty($this.ActiveModel) -or !$this.Pricing.models.ContainsKey($this.ActiveModel)) {
            return "gemini-4-argon"
        }
        return $this.ActiveModel
    }

    [object]CallLanguageServerRpc([string]$endpoint, [int]$port, [string]$csrf) {
        try {
            $url = "http://127.0.0.1:$port/exa.language_server_pb.LanguageServerService/$endpoint"
            $req = [System.Net.HttpWebRequest]::Create($url)
            $req.Method = "POST"
            $req.ContentType = "application/json"
            $req.Timeout = 1500
            $req.ReadWriteTimeout = 1500
            $req.Headers.Add("Connect-Protocol-Version", "1")
            $req.Headers.Add("x-codeium-csrf-token", $csrf)
            $bytes = [System.Text.Encoding]::UTF8.GetBytes("{}")
            $req.ContentLength = $bytes.Length
            $reqStream = $req.GetRequestStream()
            $reqStream.Write($bytes, 0, $bytes.Length)
            $reqStream.Close()
            $resp = $req.GetResponse()
            $reader = [System.IO.StreamReader]::new($resp.GetResponseStream(), [System.Text.Encoding]::UTF8)
            $jsonStr = $reader.ReadToEnd()
            $reader.Close()
            $resp.Close()
            if (![string]::IsNullOrWhiteSpace($jsonStr)) {
                return ($jsonStr | ConvertFrom-Json)
            }
        } catch {}
        return $null
    }

    [object]CallLanguageServerGetUserStatus([int]$port, [string]$csrf) {
        return $this.CallLanguageServerRpc("GetUserStatus", $port, $csrf)
    }

    [hashtable]FetchLiveAntigravityQuotas() {
        $nowUtc = [datetime]::UtcNow
        if ($null -ne $this.CachedLiveQuotas -and ($nowUtc - $this.LastQuotaSync).TotalSeconds -lt 10) {
            return $this.CachedLiveQuotas
        }

        $bridgePath = Join-Path $this.ConfigDir "ls_bridge.json"
        $port = 0
        $csrf = ""

        if (Test-Path $bridgePath) {
            try {
                $b = Get-Content -LiteralPath $bridgePath -Raw -Encoding UTF8 | ConvertFrom-Json
                if ($null -ne $b.port -and $null -ne $b.csrf) {
                    $port = [int]$b.port
                    $csrf = [string]$b.csrf
                }
            } catch {}
        }

        # 优先使用官方最权威的 RetrieveUserQuotaSummary 接口
        $summaryObj = $null
        if ($port -gt 0 -and ![string]::IsNullOrEmpty($csrf)) {
            $summaryObj = $this.CallLanguageServerRpc("RetrieveUserQuotaSummary", $port, $csrf)
        }

        if ($null -eq $summaryObj) {
            try {
                $lsProcs = @(Get-CimInstance Win32_Process -Filter "Name='language_server.exe'" -ErrorAction SilentlyContinue)
                foreach ($p in $lsProcs) {
                    $cmd = [string]$p.CommandLine
                    if ($cmd -match '--csrf_token\s+(\S+)') {
                        $candCsrf = $Matches[1].Trim('"'' ')
                        $conns = @(Get-NetTCPConnection -State Listen -OwningProcess $p.ProcessId -ErrorAction SilentlyContinue | Sort-Object LocalPort)
                        foreach ($c in $conns) {
                            $candPort = [int]$c.LocalPort
                            $summaryObj = $this.CallLanguageServerRpc("RetrieveUserQuotaSummary", $candPort, $candCsrf)
                            if ($null -ne $summaryObj) {
                                $port = $candPort
                                $csrf = $candCsrf
                                try {
                                    if (!(Test-Path $this.ConfigDir)) { New-Item -ItemType Directory -Path $this.ConfigDir -Force | Out-Null }
                                    @{ port = $port; csrf = $csrf; pid = $p.ProcessId } | ConvertTo-Json | Set-Content -LiteralPath $bridgePath -Encoding UTF8 -Force
                                } catch {}
                                break
                            }
                        }
                    }
                    if ($null -ne $summaryObj) { break }
                }
            } catch {}
        }

        $result = @{
            PlanName = "Pro"
            Models = @{}
            WeeklyResetDisplay = ""
            FiveHourResetDisplay = ""
        }

        # 方案 A：从 RetrieveUserQuotaSummary 官方结构中解析（完美解决 55% 每周限额与重置时间）
        if ($null -ne $summaryObj -and $null -ne $summaryObj.response -and $null -ne $summaryObj.response.groups) {
            try {
                $bucketMap = @{}
                foreach ($g in $summaryObj.response.groups) {
                    foreach ($b in $g.buckets) {
                        $bid = [string]$b.bucketId
                        $remFract = [double]$b.remainingFraction
                        $remPct = [int][Math]::Min(100, [Math]::Max(0, [Math]::Ceiling($remFract * 100.0)))
                        $resetDisp = ""
                        if ($b.resetTime) {
                            $parsedDt = [datetime]::UtcNow
                            if ([datetime]::TryParse([string]$b.resetTime, [ref]$parsedDt)) {
                                $localDt = $parsedDt.ToLocalTime()
                                $resetDisp = if ($b.window -eq "weekly") { "重置 " + $localDt.ToString("MM-dd HH:mm") } else { "重置 " + $localDt.ToString("HH:mm") }
                            }
                        }
                        $bucketMap[$bid] = @{
                            RemainingPct = $remPct
                            ResetDisplay = $resetDisp
                        }
                    }
                }

                $g5h = $bucketMap["gemini-5h"]
                $gWeekly = $bucketMap["gemini-weekly"]
                $c5h = $bucketMap["3p-5h"]
                $cWeekly = $bucketMap["3p-weekly"]
                $argonWeekly = $bucketMap["gemini-argon-wtu-weekly"]

                # 1. Gemini 3.8 Flash
                $result.Models["gemini-3.8-flash"] = @{
                    FiveHourRemainingPct = $(if ($g5h) { $g5h.RemainingPct } else { 100 })
                    FiveHourReset = $(if ($g5h) { $g5h.ResetDisplay } else { "重置 --:--" })
                    WeeklyRemainingPct = $(if ($gWeekly) { $gWeekly.RemainingPct } else { 100 })
                    WeeklyReset = $(if ($gWeekly) { $gWeekly.ResetDisplay } else { "重置 --:--" })
                }

                # 2. Gemini 4 Argon
                $result.Models["gemini-4-argon"] = @{
                    FiveHourRemainingPct = $(if ($argonWeekly) { $argonWeekly.RemainingPct } else { 100 })
                    FiveHourReset = "同周限额"
                    WeeklyRemainingPct = $(if ($argonWeekly) { $argonWeekly.RemainingPct } else { 100 })
                    WeeklyReset = $(if ($argonWeekly) { $argonWeekly.ResetDisplay } else { "重置 --:--" })
                }

                # 3. Claude Opus 5.5
                $result.Models["claude-opus-5-5"] = @{
                    FiveHourRemainingPct = $(if ($c5h) { $c5h.RemainingPct } else { 100 })
                    FiveHourReset = $(if ($c5h) { $c5h.ResetDisplay } else { "重置 --:--" })
                    WeeklyRemainingPct = $(if ($cWeekly) { $cWeekly.RemainingPct } else { 100 })
                    WeeklyReset = $(if ($cWeekly) { $cWeekly.ResetDisplay } else { "重置 --:--" })
                }

                # 4. Claude Sonnet 5.5
                $result.Models["claude-sonnet-5-5"] = @{
                    FiveHourRemainingPct = $(if ($c5h) { $c5h.RemainingPct } else { 100 })
                    FiveHourReset = $(if ($c5h) { $c5h.ResetDisplay } else { "重置 --:--" })
                    WeeklyRemainingPct = $(if ($cWeekly) { $cWeekly.RemainingPct } else { 100 })
                    WeeklyReset = $(if ($cWeekly) { $cWeekly.ResetDisplay } else { "重置 --:--" })
                }

                if ($gWeekly) { $result.WeeklyResetDisplay = $gWeekly.ResetDisplay }
                if ($g5h) { $result.FiveHourResetDisplay = $g5h.ResetDisplay }

                $this.CachedLiveQuotas = $result
                $this.LastQuotaSync = $nowUtc
                return $result
            } catch {}
        }

        # 方案 B：降级使用 GetUserStatus
        $respObj = $null
        if ($port -gt 0 -and ![string]::IsNullOrEmpty($csrf)) {
            $respObj = $this.CallLanguageServerGetUserStatus($port, $csrf)
        }
        if ($null -ne $respObj -and $null -ne $respObj.userStatus) {
            try {
                if ($null -ne $respObj.userStatus.planStatus -and $null -ne $respObj.userStatus.planStatus.planInfo -and $null -ne $respObj.userStatus.planStatus.planInfo.planName) {
                    $result.PlanName = [string]$respObj.userStatus.planStatus.planInfo.planName
                }
                $configs = $respObj.userStatus.cascadeModelConfigData.clientModelConfigs
                foreach ($cfg in $configs) {
                    $mid = [string]$cfg.modelId
                    $ph = ""
                    if ($null -ne $cfg.modelOrAlias -and $null -ne $cfg.modelOrAlias.model) {
                        $ph = [string]$cfg.modelOrAlias.model
                    }
                    $lbl = [string]$cfg.label
                    $targetKey = ""
                    if ($mid -match 'argon' -or $ph -in @('MODEL_PLACEHOLDER_M417', 'MODEL_PLACEHOLDER_M418', 'MODEL_PLACEHOLDER_M419', 'MODEL_PLACEHOLDER_M421') -or $lbl -match 'Argon') {
                        $targetKey = "gemini-4-argon"
                    } elseif ($mid -match 'flash' -or $ph -in @('MODEL_PLACEHOLDER_M318', 'MODEL_PLACEHOLDER_M319', 'MODEL_PLACEHOLDER_M320') -or $lbl -match 'Flash') {
                        $targetKey = "gemini-3.8-flash"
                    } elseif ($mid -match 'opus' -or $ph -in @('MODEL_PLACEHOLDER_M400', 'MODEL_PLACEHOLDER_M401', 'MODEL_PLACEHOLDER_M402', 'MODEL_PLACEHOLDER_M26') -or $lbl -match 'Opus') {
                        $targetKey = "claude-opus-5-5"
                    } elseif ($mid -match 'sonnet' -or $ph -in @('MODEL_PLACEHOLDER_M403', 'MODEL_PLACEHOLDER_M404', 'MODEL_PLACEHOLDER_M405', 'MODEL_PLACEHOLDER_M35') -or $lbl -match 'Sonnet') {
                        $targetKey = "claude-sonnet-5-5"
                    }
                    if ([string]::IsNullOrEmpty($targetKey)) { continue }

                    $q = $cfg.quotaInfo
                    $remPct = 100
                    $resetUtc = $nowUtc.AddHours(5)
                    $hasReset = $false
                    $isWeeklyWindow = $false

                    if ($null -ne $q) {
                        if ($null -ne $q.resetTime -and ![string]::IsNullOrEmpty([string]$q.resetTime)) {
                            $parsedDt = $nowUtc
                            if ([datetime]::TryParse([string]$q.resetTime, [ref]$parsedDt)) {
                                $resetUtc = $parsedDt.ToUniversalTime()
                                $hasReset = $true
                            }
                        }
                        if ($null -ne $q.remainingFraction) {
                            $remPct = [int][Math]::Min(100, [Math]::Max(0, [Math]::Ceiling([double]$q.remainingFraction * 100.0)))
                        } elseif ($hasReset) {
                            $remPct = 0
                        }
                    }
                    $hoursLeft = ($resetUtc - $nowUtc).TotalHours
                    if ($hoursLeft -gt 24.0) { $isWeeklyWindow = $true }
                    $localReset = $resetUtc.ToLocalTime()
                    $resetDisp = if ($isWeeklyWindow) { "重置 " + $localReset.ToString("MM-dd HH:mm") } else { "重置 " + $localReset.ToString("HH:mm") }

                    if (!$result.Models.ContainsKey($targetKey)) {
                        $result.Models[$targetKey] = @{
                            FiveHourRemainingPct = $(if (!$isWeeklyWindow) { $remPct } else { 100 })
                            FiveHourReset = $(if (!$isWeeklyWindow) { $resetDisp } else { "同周限额" })
                            WeeklyRemainingPct = $(if ($isWeeklyWindow) { $remPct } else { 100 })
                            WeeklyReset = $(if ($isWeeklyWindow) { $resetDisp } else { "重置 --:--" })
                        }
                    }
                }
            } catch {}
        }

        $this.CachedLiveQuotas = $result
        $this.LastQuotaSync = $nowUtc
        return $result
    }
    [string]GetConversationModel([string]$convId) {
        if ([string]::IsNullOrEmpty($convId)) { return $this.ActiveModel }
        if ($this.ConvModelCache.ContainsKey($convId)) {
            return [string]$this.ConvModelCache[$convId]
        }

        $dbPath = Join-Path (Join-Path $this.AgyDataPath "conversations") "$convId.db"
        if (Test-Path $dbPath) {
            try {
                $bytes = [System.IO.File]::ReadAllBytes($dbPath)
                $chunkLen = [Math]::Min(120000, $bytes.Length)
                $latin1 = [System.Text.Encoding]::GetEncoding("ISO-8859-1").GetString($bytes, [Math]::Max(0, $bytes.Length - $chunkLen), $chunkLen)

                if ($latin1 -match 'MODEL_PLACEHOLDER_M417|MODEL_PLACEHOLDER_M418|MODEL_PLACEHOLDER_M419|gemini-4-argon|argon') {
                    $this.ConvModelCache[$convId] = "gemini-4-argon"
                    return "gemini-4-argon"
                }
                if ($latin1 -match 'MODEL_PLACEHOLDER_M400|MODEL_PLACEHOLDER_M401|MODEL_PLACEHOLDER_M402|MODEL_PLACEHOLDER_M26|claude-opus') {
                    $this.ConvModelCache[$convId] = "claude-opus-5-5"
                    return "claude-opus-5-5"
                }
                if ($latin1 -match 'MODEL_PLACEHOLDER_M403|MODEL_PLACEHOLDER_M404|MODEL_PLACEHOLDER_M405|claude-sonnet') {
                    $this.ConvModelCache[$convId] = "claude-sonnet-5-5"
                    return "claude-sonnet-5-5"
                }
                if ($latin1 -match 'MODEL_PLACEHOLDER_M318|MODEL_PLACEHOLDER_M319|MODEL_PLACEHOLDER_M320|gemini-3\.8-flash|flash') {
                    $this.ConvModelCache[$convId] = "gemini-3.8-flash"
                    return "gemini-3.8-flash"
                }
            } catch {}
        }

        $detected = $this.DetectAntigravityActiveModel()
        $this.ConvModelCache[$convId] = $detected
        return $detected
    }

    [hashtable]CalculateCost([long]$inputTokens, [long]$cacheTokens, [long]$outputTokens, [string]$modelKey) {
        if ([string]::IsNullOrEmpty($modelKey) -or !$this.Pricing.models.ContainsKey($modelKey)) {
            $modelKey = $this.ActiveModel
        }
        $m = $this.Pricing.models[$modelKey]
        $rate = [double]$this.Pricing.usd_to_cny

        $totalInput = $inputTokens + $cacheTokens
        $hitRate = 0.0
        if ($totalInput -gt 0) {
            $hitRate = [double]$cacheTokens / [double]$totalInput
        }

        $matchedTier = $m.tiers[0]
        foreach ($t in $m.tiers) {
            if ($totalInput -le $t.maxIn) {
                $matchedTier = $t
                break
            }
        }

        $costUSD = (($cacheTokens / 1000000.0) * $matchedTier.hit) +
                   (($inputTokens / 1000000.0) * $matchedTier.miss) +
                   (($outputTokens / 1000000.0) * $matchedTier.out)

        $savingsUSD = ($cacheTokens / 1000000.0) * ($matchedTier.miss - $matchedTier.hit)

        return @{
            CostUSD = [Math]::Round($costUSD, 6)
            CostCNY = [Math]::Round($costUSD * $rate, 4)
            SavingsUSD = [Math]::Round($savingsUSD, 6)
            SavingsCNY = [Math]::Round($savingsUSD * $rate, 4)
            HitRate = [Math]::Round($hitRate * 100.0, 1)
        }
    }

    [void]CheckActiveConversation() {
        if (!(Test-Path $this.BrainPath)) { return }

        $dirs = Get-ChildItem -Path $this.BrainPath -Directory -ErrorAction SilentlyContinue |
                Sort-Object LastWriteTime -Descending

        if ($dirs.Count -gt 0) {
            $newest = $dirs[0]
            if ($newest.Name -ne $this.CurrentConvId) {
                $this.CurrentConvId = $newest.Name
                $this.CurrentTranscriptPath = Join-Path $newest.FullName ".system_generated\logs\transcript.jsonl"
                $this.LastFileOffset = 0
                $this.ResetSessionStats($this.CurrentConvId)
                $this.ReadEntireCurrentTranscript()
            }
        }
    }

    [void]ResetSessionStats([string]$convId) {
        $this.Session.ConvId = $convId
        $this.Session.Turns = 0
        $this.Session.InputTokens = 0L
        $this.Session.CacheReadTokens = 0L
        $this.Session.OutputTokens = 0L
        $this.Session.TotalTokens = 0L
        $this.Session.CurrentContext = 0L
        $this.Session.ContextPct = 0.0
        $this.Session.CostUSD = 0.0
        $this.Session.CostCNY = 0.0
        $this.Session.SavingsUSD = 0.0
                $this.Session.SavingsCNY = 0.0
        $this.ActiveRound = @{
            IsActive = $false
            Steps = 0
            InputTokens = 0L
            CacheReadTokens = 0L
            OutputTokens = 0L
            TotalTokens = 0L
        }
    }

    [void]ReadEntireCurrentTranscript() {
        if (!(Test-Path $this.CurrentTranscriptPath)) { return }
        try {
            $lines = Get-Content -LiteralPath $this.CurrentTranscriptPath -Encoding UTF8 -ErrorAction SilentlyContinue
            $fi = [System.IO.FileInfo]::new($this.CurrentTranscriptPath)
            $this.LastFileOffset = $fi.Length

            foreach ($line in $lines) {
                if ([string]::IsNullOrWhiteSpace($line)) { continue }
                if ($line.IndexOf('"input_tokens"') -ge 0) {
                    $d = $line | ConvertFrom-Json
                    if ($null -ne $d.input_tokens) {
                        $this.ProcessStep($d, $false)
                    }
                }
            }
            $this.RecalculateSessionCost()
        } catch {}
    }

    [void]PollUpdates() {
        $pbtxtModel = $this.DetectAntigravityActiveModel()
        if (![string]::IsNullOrEmpty($pbtxtModel) -and $pbtxtModel -ne $this.LastPbtxtModel) {
            $this.LastPbtxtModel = $pbtxtModel
            $this.ActiveModel = $pbtxtModel
            $this.UpdateModelLimits()
            $this.ScanAllWindows()
        }

        $this.CheckActiveConversation()
        if (!(Test-Path $this.CurrentTranscriptPath)) { return }

        $fi = [System.IO.FileInfo]::new($this.CurrentTranscriptPath)
        $fi.Refresh()
        $hasNewTurn = $false
        $roundReport = $null
        if ($fi.Length -gt $this.LastFileOffset) {
            try {
                $fs = [System.IO.FileStream]::new($this.CurrentTranscriptPath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)
                $fs.Seek($this.LastFileOffset, [System.IO.SeekOrigin]::Begin) | Out-Null
                $reader = [System.IO.StreamReader]::new($fs, [System.Text.Encoding]::UTF8)
                while (!$reader.EndOfStream) {
                    $line = $reader.ReadLine()
                    if ([string]::IsNullOrWhiteSpace($line)) { continue }

                    $step = $null
                    try {
                        $step = $line | ConvertFrom-Json
                    } catch { continue }
                    if ($null -eq $step) { continue }

                    # 1. 监测用户提问（开启整轮新对话）
                    if ($step.type -eq "USER_INPUT") {
                        $this.ActiveRound = @{
                            IsActive = $true
                            Steps = 0
                            InputTokens = 0L
                            CacheReadTokens = 0L
                            OutputTokens = 0L
                            TotalTokens = 0L
                        }
                    }

                    # 2. 监测模型输出与 Token 计费
                    if ($null -ne $step.input_tokens) {
                        $this.ProcessStep($step, $true)
                        $hasNewTurn = $true

                        if (!$this.ActiveRound.IsActive) {
                            $this.ActiveRound = @{
                                IsActive = $true
                                Steps = 0
                                InputTokens = 0L
                                CacheReadTokens = 0L
                                OutputTokens = 0L
                                TotalTokens = 0L
                            }
                        }

                        $sInp = [long]$step.input_tokens
                        $sCache = if ($null -ne $step.cache_read_tokens) { [long]$step.cache_read_tokens } else { 0L }
                        $sOut = if ($null -ne $step.output_tokens) { [long]$step.output_tokens } else { 0L }

                        $this.ActiveRound.InputTokens += $sInp
                        $this.ActiveRound.CacheReadTokens += $sCache
                        $this.ActiveRound.OutputTokens += $sOut
                        $this.ActiveRound.TotalTokens += ($sInp + $sCache + $sOut)
                        $this.ActiveRound.Steps += 1

                        # 判断是否为整轮最终回答完毕：
                        # 必须没有待执行的 tool_calls，并且输出了实际对用户的回复内容
                        $hasTools = ($null -ne $step.tool_calls -and $step.tool_calls.Count -gt 0)
                        $hasContent = !([string]::IsNullOrWhiteSpace($step.content))

                        if (!$hasTools -and $hasContent) {
                            $this.ActiveRound.IsActive = $false
                            $convModel = $this.GetConversationModel($this.CurrentConvId)
                            $costInfo = $this.CalculateCost($this.ActiveRound.InputTokens, $this.ActiveRound.CacheReadTokens, $this.ActiveRound.OutputTokens, $convModel)

                            $roundReport = @{
                                InputTokens = $this.ActiveRound.InputTokens
                                CacheReadTokens = $this.ActiveRound.CacheReadTokens
                                OutputTokens = $this.ActiveRound.OutputTokens
                                TotalTokens = $this.ActiveRound.TotalTokens
                                Steps = $this.ActiveRound.Steps
                                CacheHitRate = $(if (($this.ActiveRound.InputTokens + $this.ActiveRound.CacheReadTokens) -gt 0) {
                                    [Math]::Round(($this.ActiveRound.CacheReadTokens / [double]($this.ActiveRound.InputTokens + $this.ActiveRound.CacheReadTokens)) * 100.0, 1)
                                } else { 0.0 })
                                CostUSD = $costInfo.CostUSD
                                CostCNY = $costInfo.CostCNY
                                SavingsCNY = $costInfo.SavingsCNY
                                Model = $convModel
                            }
                        }
                    }
                }
                $this.LastFileOffset = $fs.Position
                $reader.Dispose()
                $fs.Dispose()

                if ($hasNewTurn) {
                    $this.LastQuotaSync = [datetime]::MinValue
                    $this.RecalculateSessionCost()
                    $this.ScanAllWindows()
                    if ($this.OnTurnFinished) {
                        try {
                            & $this.OnTurnFinished $this.LastTurn
                        } catch {}
                    }
                }

                if ($null -ne $roundReport) {
                    if ($this.OnRoundFinished) {
                        try {
                            & $this.OnRoundFinished $roundReport
                        } catch {}
                    }
                }
            } catch {}
        }

        if (!$hasNewTurn -and ([datetime]::UtcNow - $this.LastQuotaSync).TotalSeconds -ge 15) {
            $this.ScanAllWindows()
        }

        $this.UpdateRollingRateLimits()
    }


    [void]ProcessStep($d, [bool]$isLive) {
        $inp = [long]$d.input_tokens
        $cache = 0L
        if ($null -ne $d.cache_read_tokens) { $cache = [long]$d.cache_read_tokens }
        $out = 0L
        if ($null -ne $d.output_tokens) { $out = [long]$d.output_tokens }
        $tot = $inp + $cache + $out
        $rate = 0.0
        if (($inp + $cache) -gt 0) {
            $rate = [Math]::Round(($cache / [double]($inp + $cache)) * 100.0, 1)
        }

        $this.LastTurn.InputTokens = $inp
        $this.LastTurn.CacheReadTokens = $cache
        $this.LastTurn.OutputTokens = $out
        $this.LastTurn.TotalTokens = $tot
        $this.LastTurn.CacheHitRate = $rate

        $this.Session.Turns += 1
        $this.Session.InputTokens += $inp
        $this.Session.CacheReadTokens += $cache
        $this.Session.OutputTokens += $out
        $this.Session.TotalTokens += $tot
        $this.Session.CurrentContext = $tot

        if ($this.RateLimits.ContextWindow -gt 0) {
            $this.Session.ContextPct = [Math]::Round(($tot / [double]$this.RateLimits.ContextWindow) * 100.0, 1)
        }

        if ($isLive) {
            $this.RecentRequests.Add(@{
                Time = [datetime]::UtcNow
                Tokens = $tot
            })
        }
    }

    [void]RecalculateSessionCost() {
        $convModel = $this.GetConversationModel($this.CurrentConvId)
        $lt = $this.CalculateCost($this.LastTurn.InputTokens, $this.LastTurn.CacheReadTokens, $this.LastTurn.OutputTokens, $convModel)
        $this.LastTurn.CostUSD = $lt.CostUSD
        $this.LastTurn.CostCNY = $lt.CostCNY
        $this.LastTurn.SavingsUSD = $lt.SavingsUSD
        $this.LastTurn.SavingsCNY = $lt.SavingsCNY

        $sc = $this.CalculateCost($this.Session.InputTokens, $this.Session.CacheReadTokens, $this.Session.OutputTokens, $convModel)
        $this.Session.CostUSD = $sc.CostUSD
        $this.Session.CostCNY = $sc.CostCNY
        $this.Session.SavingsUSD = $sc.SavingsUSD
        $this.Session.SavingsCNY = $sc.SavingsCNY
    }

    [void]ScanAllWindows() {
        $files = @()
        if (Test-Path $this.BrainPath) {
            $pattern = Join-Path $this.BrainPath "*\.system_generated\logs\transcript.jsonl"
            $files = @(Get-ChildItem -Path $pattern -ErrorAction SilentlyContinue)
        }
        $nowUtc = [datetime]::UtcNow
        $todayStr = $nowUtc.ToString("yyyy-MM-dd")
        $cutoff5h = $nowUtc.AddHours(-5)
        $cutoff7d = $nowUtc.AddDays(-7)
        $cutoff1m = $nowUtc.AddSeconds(-60)

        $tTurns = 0; $tInp = 0L; $tCache = 0L; $tOut = 0L
        $oldest5h = [datetime]::MaxValue
        $oldest7d = [datetime]::MaxValue

        $this.RecentRequests.Clear()

        $realModels = @(
            "gemini-4-argon",
            "gemini-3.8-flash",
            "claude-opus-5-5",
            "claude-sonnet-5-5"
        )
        $modelBuckets = @{}
        foreach ($mk in $realModels) {
            $modelBuckets[$mk] = @{
                Turns5h = 0
                Tokens5h = 0L
                Turns7d = 0
                Tokens7d = 0L
            }
        }

        foreach ($f in $files) {
            try {
                if ($f.LastWriteTimeUtc -lt $cutoff7d) { continue }
                $fKey = $f.FullName
                $fTicks = $f.LastWriteTimeUtc.Ticks
                $fLen = $f.Length

                $cachedFile = $this.TranscriptFileCache[$fKey]
                if ($null -eq $cachedFile -or $cachedFile.Ticks -ne $fTicks -or $cachedFile.Length -ne $fLen) {
                    $lines = Get-Content -LiteralPath $fKey -Encoding UTF8 -ErrorAction SilentlyContinue
                    if (!$lines) { continue }
                    $cid = $f.Directory.Parent.Parent.Name
                    $convModel = $this.GetConversationModel($cid)
                    if (!$modelBuckets.ContainsKey($convModel)) {
                        $convModel = "gemini-3.8-flash"
                    }
                    $parsedSteps = [System.Collections.Generic.List[hashtable]]::new()
                    foreach ($line in $lines) {
                        if ([string]::IsNullOrWhiteSpace($line) -or $line.IndexOf('"input_tokens"') -lt 0) { continue }
                        $step = $line | ConvertFrom-Json
                        if ($null -eq $step.input_tokens) { continue }
                        $stUtc = $nowUtc
                        if ($null -ne $step.created_at) {
                            [datetime]::TryParse($step.created_at, [ref]$stUtc) | Out-Null
                            $stUtc = $stUtc.ToUniversalTime()
                        }
                        $sInp = [long]$step.input_tokens
                        $sCache = if ($null -ne $step.cache_read_tokens) { [long]$step.cache_read_tokens } else { 0L }
                        $sOut = if ($null -ne $step.output_tokens) { [long]$step.output_tokens } else { 0L }
                        $parsedSteps.Add(@{
                            Utc = $stUtc
                            Inp = $sInp
                            Cache = $sCache
                            Out = $sOut
                            Tot = ($sInp + $sCache + $sOut)
                        })
                    }
                    $cachedFile = @{
                        Ticks = $fTicks
                        Length = $fLen
                        Model = $convModel
                        Steps = $parsedSteps
                    }
                    $this.TranscriptFileCache[$fKey] = $cachedFile
                }

                $convModel = $cachedFile.Model
                if (!$modelBuckets.ContainsKey($convModel)) {
                    $convModel = "gemini-3.8-flash"
                }

                foreach ($ps in $cachedFile.Steps) {
                    $stUtc = $ps.Utc
                    $sInp = $ps.Inp
                    $sCache = $ps.Cache
                    $sOut = $ps.Out
                    $sTot = $ps.Tot

                    if ($stUtc.ToString("yyyy-MM-dd") -eq $todayStr) {
                        $tTurns += 1
                        $tInp += $sInp
                        $tCache += $sCache
                        $tOut += $sOut
                    }

                    if ($stUtc -ge $cutoff1m) {
                        $this.RecentRequests.Add(@{ Time = $stUtc; Tokens = $sTot })
                    }

                    if ($stUtc -ge $cutoff7d) {
                        if ($stUtc -lt $oldest7d) { $oldest7d = $stUtc }
                        $mb = $modelBuckets[$convModel]
                        $mb.Turns7d += 1
                        $mb.Tokens7d += $sTot

                        if ($stUtc -ge $cutoff5h) {
                            if ($stUtc -lt $oldest5h) { $oldest5h = $stUtc }
                            $mb.Turns5h += 1
                            $mb.Tokens5h += $sTot
                        }
                    }
                }
            } catch {}
        }

        $this.Today.Turns = $tTurns
        $this.Today.InputTokens = $tInp
        $this.Today.CacheReadTokens = $tCache
        $this.Today.OutputTokens = $tOut
        $this.Today.TotalTokens = $tInp + $tCache + $tOut
        $tc = $this.CalculateCost($tInp, $tCache, $tOut, $this.ActiveModel)
        $this.Today.CostUSD = $tc.CostUSD
        $this.Today.CostCNY = $tc.CostCNY
        $this.Today.SavingsUSD = $tc.SavingsUSD
        $this.Today.SavingsCNY = $tc.SavingsCNY
        $this.RateLimits.CurrentRPD = $tTurns

        # Fetch official live quotas from Antigravity language_server.exe
        $live = $this.FetchLiveAntigravityQuotas()

        $mult = 1.0
        if ($this.Pricing -and $this.Pricing.limits -and $this.Pricing.limits[$this.ActivePlan]) {
            $mult = [double]$this.Pricing.limits[$this.ActivePlan].quota_multiplier
        }

        $reset5hTime = if ($oldest5h -ne [datetime]::MaxValue) { $oldest5h.AddHours(5) } else { $nowUtc.AddHours(5) }
        $reset7dTime = if ($oldest7d -ne [datetime]::MaxValue) { $oldest7d.AddDays(7) } else { $nowUtc.AddDays(7) }
        $defaultReset5hStr = "重置 " + $reset5hTime.ToLocalTime().ToString("HH:mm")
        $defaultReset7dStr = "重置 " + $reset7dTime.ToLocalTime().ToString("MM-dd HH:mm")
        if ($null -ne $live -and ![string]::IsNullOrEmpty($live.WeeklyResetDisplay)) {
            $defaultReset7dStr = $live.WeeklyResetDisplay
        }
        if ($null -ne $live -and ![string]::IsNullOrEmpty($live.FiveHourResetDisplay)) {
            $defaultReset5hStr = $live.FiveHourResetDisplay
        }

        $this.ModelQuotas.Clear()
        $activeMq = $null

        if ($this.Pricing) {
            foreach ($mk in $realModels) {
                if (!$this.Pricing.models.ContainsKey($mk)) { continue }
                $minfo = $this.Pricing.models[$mk]
                $b = $modelBuckets[$mk]
                $mLim5hTurns = [int]([Math]::Round($minfo.quota_5h_turns * $mult))
                $mLim7dTurns = [int]([Math]::Round($minfo.quota_weekly_turns * $mult))

                $localUsed5h = [int][Math]::Min(100, [Math]::Max(0, [Math]::Round($(if ($mLim5hTurns -gt 0) { ($b.Turns5h / [double]$mLim5hTurns) * 100.0 } else { 0.0 }))))
                $localUsed7d = [int][Math]::Min(100, [Math]::Max(0, [Math]::Round($(if ($mLim7dTurns -gt 0) { ($b.Turns7d / [double]$mLim7dTurns) * 100.0 } else { 0.0 }))))
                $rem5h = [Math]::Max(0, 100 - $localUsed5h)
                $rem7d = [Math]::Max(0, 100 - $localUsed7d)
                $res5h = $defaultReset5hStr
                $res7d = $defaultReset7dStr

                if ($null -ne $live -and $live.Models.ContainsKey($mk)) {
                    $lq = $live.Models[$mk]
                    if ($null -ne $lq.FiveHourRemainingPct) {
                        $rem5h = [int]$lq.FiveHourRemainingPct
                        $res5h = [string]$lq.FiveHourReset
                    }
                    if ($null -ne $lq.WeeklyRemainingPct) {
                        $rem7d = [int]$lq.WeeklyRemainingPct
                        $res7d = [string]$lq.WeeklyReset
                    }
                }

                $mqEntry = @{
                    Key = $mk
                    DisplayName = $minfo.display_name
                    ShortName = $minfo.short_name
                    Vendor = $minfo.vendor
                    Badge = $minfo.badge
                    IsActive = ($mk -eq $this.ActiveModel)
                    FiveHourUsedTurns = $b.Turns5h
                    FiveHourLimitTurns = $mLim5hTurns
                    FiveHourUsedPct = (100 - $rem5h)
                    FiveHourRemainingPct = $rem5h
                    FiveHourReset = $res5h
                    WeeklyUsedTurns = $b.Turns7d
                    WeeklyLimitTurns = $mLim7dTurns
                    WeeklyUsedPct = (100 - $rem7d)
                    WeeklyRemainingPct = $rem7d
                    WeeklyReset = $res7d
                }
                $this.ModelQuotas.Add($mqEntry)
                if ($mk -eq $this.ActiveModel) {
                    $activeMq = $mqEntry
                }
            }
        }

        if ($null -eq $activeMq -and $this.ModelQuotas.Count -gt 0) {
            $activeMq = $this.ModelQuotas[0]
        }

        if ($null -ne $activeMq) {
            $this.FiveHour.Turns = $activeMq.FiveHourUsedTurns
            $this.FiveHour.LimitTurns = $activeMq.FiveHourLimitTurns
            $this.FiveHour.UsedPct = $activeMq.FiveHourUsedPct
            $this.FiveHour.RemainingPct = $activeMq.FiveHourRemainingPct
            $this.FiveHour.ResetDisplay = $activeMq.FiveHourReset

            $this.Weekly.Turns = $activeMq.WeeklyUsedTurns
            $this.Weekly.LimitTurns = $activeMq.WeeklyLimitTurns
            $this.Weekly.UsedPct = $activeMq.WeeklyUsedPct
            $this.Weekly.RemainingPct = $activeMq.WeeklyRemainingPct
            $this.Weekly.ResetDisplay = $activeMq.WeeklyReset
        }
    }

    [void]ScanTodayTotal() {
        $this.ScanAllWindows()
    }

    [void]UpdateRollingRateLimits() {
        $now = [datetime]::UtcNow
        $cutoff = $now.AddSeconds(-60)

        for ($i = $this.RecentRequests.Count - 1; $i -ge 0; $i--) {
            if ($this.RecentRequests[$i].Time -lt $cutoff) {
                $this.RecentRequests.RemoveAt($i)
            }
        }

        $this.RateLimits.CurrentRPM = $this.RecentRequests.Count
        $tpm = 0L
        foreach ($r in $this.RecentRequests) {
            $tpm += [long]$r.Tokens
        }
        $this.RateLimits.CurrentTPM = $tpm

        $tomorrow = $now.Date.AddDays(1)
        $diff = $tomorrow - $now
        $this.RateLimits.ResetCountdown = [string]::Format("{0:D2}:{1:D2}:{2:D2}", [int]$diff.TotalHours, $diff.Minutes, $diff.Seconds)
    }
}
