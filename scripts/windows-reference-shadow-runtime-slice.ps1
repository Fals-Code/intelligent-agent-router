param(
    [Parameter(Mandatory = $true)][string]$ReferenceProviderId,
    [Parameter(Mandatory = $true)][string]$ReferenceModelId,
    [Parameter(Mandatory = $true)][string]$CandidateProviderId,
    [Parameter(Mandatory = $true)][string]$CandidateModelId,
    [string]$OpenCodeBaseUrl = "http://127.0.0.1:4096",
    [string]$ExpectedHead = "",
    [switch]$SkipInstall,
    [switch]$SkipSourceValidation
)

$ErrorActionPreference = "Stop"
$RunFailed = $false
$TempOpenCode = $null
$TranscriptStarted = $false
$StartLocation = (Get-Location).Path
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RunStamp = (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
$StateRoot = Join-Path $env:TEMP ("9router-shadow-runtime-" + $RunStamp)
$LogFile = Join-Path $env:TEMP ("9router-shadow-runtime-preflight-" + $RunStamp + ".log")

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE." }
}

function Test-LocalTcpPort {
    param([string]$HostName = "127.0.0.1", [int]$Port = 4096, [int]$TimeoutMs = 700)
    $Client = $null
    try {
        $Client = New-Object System.Net.Sockets.TcpClient
        $Async = $Client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $Async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $Client.EndConnect($Async)
        return $Client.Connected
    }
    catch { return $false }
    finally { if ($Client) { $Client.Dispose() } }
}

function Get-BaseUrlPort {
    param([string]$BaseUrl)
    $Uri = New-Object System.Uri($BaseUrl)
    if ($Uri.Host -notin @("127.0.0.1", "localhost", "::1")) {
        throw "Shadow runtime preflight only allows a loopback OpenCode server. Received: $($Uri.Host)"
    }
    return $Uri.Port
}

function Start-TemporaryOpenCodeServer {
    param([Parameter(Mandatory = $true)][int]$Port)
    $PowerShellExe = $null
    try { $PowerShellExe = (Get-Process -Id $PID -ErrorAction Stop).Path } catch {}
    if (-not $PowerShellExe) { $PowerShellExe = (Get-Command powershell.exe -ErrorAction Stop).Source }
    if (-not $PowerShellExe -or -not (Test-Path -LiteralPath $PowerShellExe)) {
        throw "PowerShell executable for temporary OpenCode server could not be resolved."
    }
    $ServeScript = @"
`$ErrorActionPreference = 'Stop'
& opencode serve --hostname 127.0.0.1 --port $Port
if (`$LASTEXITCODE -is [int]) { exit `$LASTEXITCODE }
"@
    $EncodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($ServeScript))
    return Start-Process -FilePath $PowerShellExe -ArgumentList @(
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $EncodedCommand
    ) -WindowStyle Hidden -PassThru
}

function Stop-TemporaryProcessTree {
    param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)
    if ($Process.HasExited) { return }
    $TaskKill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
    if ($TaskKill) {
        & $TaskKill.Source /PID $Process.Id /T /F *> $null
        if ($LASTEXITCODE -eq 0) {
            try { $Process.WaitForExit(5000) } catch {}
            return
        }
    }
    Stop-Process -Id $Process.Id -Force -ErrorAction Stop
    try { $Process.WaitForExit(5000) } catch {}
}

try {
    if (-not $ReferenceProviderId.Trim() -or -not $ReferenceModelId.Trim() -or -not $CandidateProviderId.Trim() -or -not $CandidateModelId.Trim()) {
        throw "Reference and candidate provider/model IDs must not be empty."
    }
    if ($ReferenceProviderId -eq $CandidateProviderId -and $ReferenceModelId -eq $CandidateModelId) {
        throw "Reference and candidate model targets must be distinct."
    }

    try {
        Start-Transcript -Path $LogFile -Force | Out-Null
        $TranscriptStarted = $true
    }
    catch { Write-Host "WARN - Transcript could not be started: $($_.Exception.Message)" -ForegroundColor Yellow }

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  9ROUTER REAL SHADOW RUNTIME REFERENCE SLICE" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "ROUTER_REPO=$Repo"
    Write-Host "OPENCODE_BASE_URL=$OpenCodeBaseUrl"
    Write-Host "REFERENCE_MODEL=$ReferenceProviderId/$ReferenceModelId"
    Write-Host "CANDIDATE_MODEL=$CandidateProviderId/$CandidateModelId"
    Write-Host "STATE_ROOT=$StateRoot"
    Write-Host "LOG=$LogFile" -ForegroundColor DarkGray

    Write-Host "`n=== 1. TOOLCHAIN GUARD ===" -ForegroundColor Yellow
    foreach ($Tool in @("git", "node", "npm", "opencode")) {
        if (-not (Get-Command $Tool -ErrorAction SilentlyContinue)) { throw "Command '$Tool' was not found in PATH." }
        Write-Host "PASS - $Tool available." -ForegroundColor Green
    }

    Set-Location -LiteralPath $Repo
    Write-Host "`n=== 2. ROUTER REPOSITORY GUARD ===" -ForegroundColor Yellow
    $Dirty = @(& git status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw "git status failed for intelligent-agent-router." }
    if ($Dirty.Count -gt 0) {
        Write-Host ($Dirty -join "`n") -ForegroundColor DarkYellow
        throw "intelligent-agent-router has local changes."
    }
    $Head = (& git rev-parse HEAD | Out-String).Trim()
    if ($ExpectedHead.Trim() -and $Head -ne $ExpectedHead.Trim()) {
        throw "Router HEAD does not match -ExpectedHead. HEAD=$Head EXPECTED=$ExpectedHead"
    }
    Write-Host "PASS - Working tree clean." -ForegroundColor Green
    Write-Host "HEAD=$Head"

    if (-not $SkipInstall) {
        Write-Host "`n=== 3. INSTALL DEPENDENCIES ===" -ForegroundColor Yellow
        Invoke-CheckedCommand -Command "npm" -Arguments @("ci")
        Write-Host "PASS - npm ci." -ForegroundColor Green
    }
    else {
        Write-Host "`n=== 3. INSTALL DEPENDENCIES ===" -ForegroundColor Yellow
        Write-Host "SKIP - requested by -SkipInstall." -ForegroundColor DarkYellow
    }

    if (-not $SkipSourceValidation) {
        Write-Host "`n=== 4. SOURCE VALIDATION ===" -ForegroundColor Yellow
        Invoke-CheckedCommand -Command "npm" -Arguments @("run", "check")
        Invoke-CheckedCommand -Command "npm" -Arguments @("run", "eval")
        Write-Host "PASS - npm run check + eval." -ForegroundColor Green
    }
    else {
        Write-Host "`n=== 4. SOURCE VALIDATION ===" -ForegroundColor Yellow
        Write-Host "SKIP - requested by -SkipSourceValidation." -ForegroundColor DarkYellow
    }

    Write-Host "`n=== 5. SAFE LOCAL CONFIG ===" -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    $env:OPENCODE_BASE_URL = $OpenCodeBaseUrl
    $env:OPENCODE_PROJECT_DIR = $Repo
    $env:ROUTER_SHADOW_RUNTIME_PROJECT_DIR = $Repo
    $env:ROUTER_SHADOW_RUNTIME_STATE_ROOT = $StateRoot
    $env:ROUTER_SHADOW_REFERENCE_PROVIDER_ID = $ReferenceProviderId
    $env:ROUTER_SHADOW_REFERENCE_MODEL_ID = $ReferenceModelId
    $env:ROUTER_SHADOW_CANDIDATE_PROVIDER_ID = $CandidateProviderId
    $env:ROUTER_SHADOW_CANDIDATE_MODEL_ID = $CandidateModelId
    $env:OPENCODE_ALLOW_REMOTE = "false"
    if (-not $env:OPENCODE_SERVER_USERNAME) { $env:OPENCODE_SERVER_USERNAME = "opencode" }
    Write-Host "PASS - State isolated under TEMP and OpenCode restricted to loopback." -ForegroundColor Green

    Write-Host "`n=== 6. OPENCODE LOCAL SERVER ===" -ForegroundColor Yellow
    $Port = Get-BaseUrlPort -BaseUrl $OpenCodeBaseUrl
    if (Test-LocalTcpPort -Port $Port) {
        Write-Host "PASS - Existing OpenCode server reachable on loopback port $Port." -ForegroundColor Green
    }
    else {
        Write-Host "INFO - Starting temporary OpenCode server on port $Port..." -ForegroundColor DarkCyan
        $TempOpenCode = Start-TemporaryOpenCodeServer -Port $Port
        Write-Host "TEMP_OPENCODE_HOST_PID=$($TempOpenCode.Id)"
        $Ready = $false
        for ($Attempt = 1; $Attempt -le 40; $Attempt++) {
            Start-Sleep -Milliseconds 500
            if ($TempOpenCode.HasExited) { throw "Temporary OpenCode host exited before ready. ExitCode=$($TempOpenCode.ExitCode)" }
            if (Test-LocalTcpPort -Port $Port) { $Ready = $true; break }
        }
        if (-not $Ready) { throw "OpenCode server was not ready on port $Port within 20 seconds." }
        Write-Host "PASS - Temporary OpenCode server ready." -ForegroundColor Green
    }

    Write-Host "`n=== 7. LIVE OPENCODE PREFLIGHT ===" -ForegroundColor Yellow
    Invoke-CheckedCommand -Command "npm" -Arguments @("run", "validate:opencode-live")
    Write-Host "PASS - OpenCode live adapter preflight." -ForegroundColor Green

    Write-Host "`n=== 8. BUILD SHADOW RUNTIME HARNESS ===" -ForegroundColor Yellow
    Invoke-CheckedCommand -Command "npm" -Arguments @("run", "build", "--silent")
    Write-Host "PASS - TypeScript build." -ForegroundColor Green

    Write-Host "`n=== 9. CONTROL-PLANE PROCESS A - PREPARE ===" -ForegroundColor Yellow
    Write-Host "INFO - Creates two real R0 OpenCode sessions through canonical durable runtime binding, runs identical no-tool shadow tasks, and exits without destroying the provider sessions." -ForegroundColor DarkCyan
    Invoke-CheckedCommand -Command "node" -Arguments @("--env-file-if-exists=.env", "scripts/run-reference-shadow-runtime-slice.mjs", "prepare")
    Write-Host "PASS - Process A shadow runtime prepare evidence." -ForegroundColor Green

    Write-Host "`n=== 10. CONTROL-PLANE PROCESS B - RECOVER ===" -ForegroundColor Yellow
    Write-Host "INFO - New Node PID reopens durable state, performs GET-only reconciliation for both sessions, deterministic verification, terminal Run Ledger finalization, and provider-session cleanup." -ForegroundColor DarkCyan
    Invoke-CheckedCommand -Command "node" -Arguments @("--env-file-if-exists=.env", "scripts/run-reference-shadow-runtime-slice.mjs", "recover")
    Write-Host "PASS - Process B shadow runtime recovery proof." -ForegroundColor Green

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "  9ROUTER REAL SHADOW RUNTIME SLICE : PASS" -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "PASS - Distinct reference/candidate OpenCode model targets used." -ForegroundColor Green
    Write-Host "PASS - Both tasks were R0, identical-input, and zero-tool." -ForegroundColor Green
    Write-Host "PASS - Candidate output remained internal and never entered a publication/production routing path." -ForegroundColor Green
    Write-Host "PASS - Distinct control-plane Node processes used." -ForegroundColor Green
    Write-Host "PASS - Recovery used GET-only runtime reconciliation; no automatic redispatch." -ForegroundColor Green
    Write-Host "PASS - Durable workflow, binding, verification, integrity, and Run Ledger reopened from disk." -ForegroundColor Green
    Write-Host "PASS - Router Git HEAD and working tree remained unchanged." -ForegroundColor Green
    Write-Host "STATE_ROOT=$StateRoot" -ForegroundColor Cyan
    Write-Host "NEXT_GATE=INDEPENDENT_LIVE_SHADOW_RUNTIME_REVIEW" -ForegroundColor Cyan
}
catch {
    $RunFailed = $true
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "  9ROUTER REAL SHADOW RUNTIME PREFLIGHT : FAILED" -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "ERROR=$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "STATE_ROOT=$StateRoot" -ForegroundColor Yellow
}
finally {
    if ($TempOpenCode) {
        try {
            if (-not $TempOpenCode.HasExited) {
                Write-Host "`n=== CLEANUP TEMPORARY OPENCODE ===" -ForegroundColor DarkGray
                Stop-TemporaryProcessTree -Process $TempOpenCode
                Write-Host "PASS - Temporary OpenCode process tree stopped." -ForegroundColor Green
            }
        }
        catch { Write-Host "WARN - Temporary OpenCode cleanup failed: $($_.Exception.Message)" -ForegroundColor Yellow }
    }
    try { Set-Location -LiteralPath $StartLocation } catch {}
    if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
    Write-Host ""
    if ($RunFailed) { Write-Host "RESULT=FAILED" -ForegroundColor Red } else { Write-Host "RESULT=PASS" -ForegroundColor Green }
    Write-Host "STATE_ROOT=$StateRoot" -ForegroundColor Cyan
    Write-Host "LOG=$LogFile" -ForegroundColor Cyan
}

if ($RunFailed) { exit 1 }
exit 0
