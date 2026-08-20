param(
    [Parameter(Mandatory = $true)][string]$ReferenceProviderId,
    [Parameter(Mandatory = $true)][string]$ReferenceModelId,
    [Parameter(Mandatory = $true)][string]$CandidateProviderId,
    [Parameter(Mandatory = $true)][string]$CandidateModelId,
    [string]$OpenCodeBaseUrl = "http://127.0.0.1:4096",
    [string]$SinkBaseUrl = "http://127.0.0.1:4097",
    [string]$ExpectedHead = "",
    [switch]$SkipInstall,
    [switch]$SkipSourceValidation
)

$ErrorActionPreference = "Stop"
$RunFailed = $false
$TempOpenCode = $null
$TempSink = $null
$TranscriptStarted = $false
$StartLocation = (Get-Location).Path
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RunStamp = (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
$StateRoot = Join-Path $env:TEMP ("9router-bounded-live-" + $RunStamp)
$LogFile = Join-Path $env:TEMP ("9router-bounded-live-preflight-" + $RunStamp + ".log")

function Invoke-CheckedCommand {
    param([Parameter(Mandatory = $true)][string]$Command, [Parameter(Mandatory = $true)][string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE." }
}

function Test-LocalTcpPort {
    param([int]$Port, [int]$TimeoutMs = 700)
    $Client = $null
    try {
        $Client = New-Object System.Net.Sockets.TcpClient
        $Async = $Client.BeginConnect("127.0.0.1", $Port, $null, $null)
        if (-not $Async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) { return $false }
        $Client.EndConnect($Async)
        return $Client.Connected
    }
    catch { return $false }
    finally { if ($Client) { $Client.Dispose() } }
}

function Get-LoopbackPort {
    param([string]$BaseUrl, [string]$Label)
    $Uri = New-Object System.Uri($BaseUrl)
    if ($Uri.Scheme -ne "http" -or $Uri.Host -ne "127.0.0.1") { throw "$Label must use exact http://127.0.0.1 loopback URL. Received: $BaseUrl" }
    return $Uri.Port
}

function Start-HiddenPowerShell {
    param([Parameter(Mandatory = $true)][string]$Script)
    $PowerShellExe = $null
    try { $PowerShellExe = (Get-Process -Id $PID -ErrorAction Stop).Path } catch {}
    if (-not $PowerShellExe) { $PowerShellExe = (Get-Command powershell.exe -ErrorAction Stop).Source }
    $Encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($Script))
    return Start-Process -FilePath $PowerShellExe -ArgumentList @("-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", $Encoded) -WindowStyle Hidden -PassThru
}

function Stop-ProcessTree {
    param([Parameter(Mandatory = $true)][System.Diagnostics.Process]$Process)
    if ($Process.HasExited) { return }
    $TaskKill = Get-Command taskkill.exe -ErrorAction SilentlyContinue
    if ($TaskKill) {
        & $TaskKill.Source /PID $Process.Id /T /F *> $null
        try { $Process.WaitForExit(5000) } catch {}
        return
    }
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
}

try {
    if (-not $ReferenceProviderId.Trim() -or -not $ReferenceModelId.Trim() -or -not $CandidateProviderId.Trim() -or -not $CandidateModelId.Trim()) { throw "Provider/model IDs must not be empty." }
    if ($ReferenceProviderId -eq $CandidateProviderId -and $ReferenceModelId -eq $CandidateModelId) { throw "Reference and candidate model targets must be distinct." }
    $OpenCodePort = Get-LoopbackPort -BaseUrl $OpenCodeBaseUrl -Label "OpenCode base URL"
    $SinkPort = Get-LoopbackPort -BaseUrl $SinkBaseUrl -Label "Bounded-live sink base URL"
    if ($OpenCodePort -eq $SinkPort) { throw "OpenCode and bounded-live sink ports must be distinct." }

    try { Start-Transcript -Path $LogFile -Force | Out-Null; $TranscriptStarted = $true } catch {}
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  9ROUTER ISOLATED BOUNDED-LIVE RUNTIME PROOF" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "ROUTER_REPO=$Repo"
    Write-Host "REFERENCE_MODEL=$ReferenceProviderId/$ReferenceModelId"
    Write-Host "CANDIDATE_MODEL=$CandidateProviderId/$CandidateModelId"
    Write-Host "OPENCODE_BASE_URL=$OpenCodeBaseUrl"
    Write-Host "ISOLATED_SINK_BASE_URL=$SinkBaseUrl"
    Write-Host "STATE_ROOT=$StateRoot"
    Write-Host "LOG=$LogFile"

    Write-Host "`n=== 1. TOOLCHAIN + REPOSITORY GUARD ===" -ForegroundColor Yellow
    foreach ($Tool in @("git", "node", "npm", "opencode")) { if (-not (Get-Command $Tool -ErrorAction SilentlyContinue)) { throw "$Tool not found in PATH." } }
    Set-Location -LiteralPath $Repo
    $Dirty = @(& git status --porcelain=v1 --untracked-files=all)
    if ($LASTEXITCODE -ne 0) { throw "git status failed." }
    if ($Dirty.Count -gt 0) { Write-Host ($Dirty -join "`n") -ForegroundColor DarkYellow; throw "Proof worktree must be clean." }
    $Head = (& git rev-parse HEAD | Out-String).Trim()
    if ($ExpectedHead.Trim() -and $Head -ne $ExpectedHead.Trim()) { throw "HEAD mismatch. HEAD=$Head EXPECTED=$ExpectedHead" }
    Write-Host "PASS - clean exact proof worktree. HEAD=$Head" -ForegroundColor Green

    Write-Host "`n=== 2. DEPENDENCIES + SOURCE VALIDATION ===" -ForegroundColor Yellow
    if (-not $SkipInstall) { Invoke-CheckedCommand -Command "npm" -Arguments @("ci") } else { Write-Host "SKIP - npm ci" -ForegroundColor DarkYellow }
    if (-not $SkipSourceValidation) { Invoke-CheckedCommand -Command "npm" -Arguments @("run", "check"); Invoke-CheckedCommand -Command "npm" -Arguments @("run", "eval") } else { Write-Host "SKIP - source validation" -ForegroundColor DarkYellow }
    Invoke-CheckedCommand -Command "npm" -Arguments @("run", "build", "--silent")
    Write-Host "PASS - source/build gate." -ForegroundColor Green

    Write-Host "`n=== 3. ISOLATED STATE + ENVIRONMENT ===" -ForegroundColor Yellow
    New-Item -ItemType Directory -Path $StateRoot -Force | Out-Null
    $env:OPENCODE_BASE_URL = $OpenCodeBaseUrl
    $env:OPENCODE_PROJECT_DIR = $Repo
    $env:OPENCODE_ALLOW_REMOTE = "false"
    if (-not $env:OPENCODE_SERVER_USERNAME) { $env:OPENCODE_SERVER_USERNAME = "opencode" }
    $env:ROUTER_BOUNDED_LIVE_PROJECT_DIR = $Repo
    $env:ROUTER_BOUNDED_LIVE_STATE_ROOT = $StateRoot
    $env:ROUTER_BOUNDED_LIVE_REFERENCE_PROVIDER_ID = $ReferenceProviderId
    $env:ROUTER_BOUNDED_LIVE_REFERENCE_MODEL_ID = $ReferenceModelId
    $env:ROUTER_BOUNDED_LIVE_CANDIDATE_PROVIDER_ID = $CandidateProviderId
    $env:ROUTER_BOUNDED_LIVE_CANDIDATE_MODEL_ID = $CandidateModelId
    $env:ROUTER_BOUNDED_LIVE_SINK_BASE_URL = $SinkBaseUrl
    $env:ROUTER_BOUNDED_LIVE_SINK_HOST = "127.0.0.1"
    $env:ROUTER_BOUNDED_LIVE_SINK_PORT = "$SinkPort"
    $env:ROUTER_BOUNDED_LIVE_SINK_STATE_PATH = (Join-Path $StateRoot "sink-state.json")
    $env:ROUTER_BOUNDED_LIVE_REFERENCE_SUBJECT_ID = "opencode:$ReferenceProviderId/$ReferenceModelId"
    $env:ROUTER_BOUNDED_LIVE_ISOLATED_SINK_ONLY = "ISOLATED_LOOPBACK_ONLY"
    Write-Host "PASS - state under TEMP; external publication restricted to loopback sink." -ForegroundColor Green

    Write-Host "`n=== 4. OPENCODE LOOPBACK SERVER ===" -ForegroundColor Yellow
    if (Test-LocalTcpPort -Port $OpenCodePort) { Write-Host "PASS - existing OpenCode loopback server reachable." -ForegroundColor Green }
    else {
        $TempOpenCode = Start-HiddenPowerShell -Script "& opencode serve --hostname 127.0.0.1 --port $OpenCodePort; if (`$LASTEXITCODE -is [int]) { exit `$LASTEXITCODE }"
        $Ready = $false
        for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 500; if ($TempOpenCode.HasExited) { throw "Temporary OpenCode server exited early." }; if (Test-LocalTcpPort -Port $OpenCodePort) { $Ready = $true; break } }
        if (-not $Ready) { throw "OpenCode server did not become ready." }
        Write-Host "PASS - temporary OpenCode server ready. PID=$($TempOpenCode.Id)" -ForegroundColor Green
    }
    Invoke-CheckedCommand -Command "npm" -Arguments @("run", "validate:opencode-live")

    Write-Host "`n=== 5. ISOLATED BOUNDED-LIVE SINK ===" -ForegroundColor Yellow
    if (Test-LocalTcpPort -Port $SinkPort) { throw "Sink port $SinkPort is already occupied; proof refuses to use an unknown service." }
    $TempSink = Start-HiddenPowerShell -Script "Set-Location -LiteralPath '$($Repo.Replace("'", "''"))'; & node scripts/isolated-bounded-live-sink.mjs; if (`$LASTEXITCODE -is [int]) { exit `$LASTEXITCODE }"
    $SinkReady = $false
    for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 250; if ($TempSink.HasExited) { throw "Isolated sink exited before ready." }; if (Test-LocalTcpPort -Port $SinkPort) { $SinkReady = $true; break } }
    if (-not $SinkReady) { throw "Isolated sink did not become ready." }
    Write-Host "PASS - isolated sink ready on 127.0.0.1:$SinkPort. PID=$($TempSink.Id)" -ForegroundColor Green

    Write-Host "`n=== 6. REAL CANDIDATE BOUNDED-LIVE PROOF ===" -ForegroundColor Yellow
    Write-Host "INFO - Prior shadow/reference-live budget evidence is deterministic and authorized; only candidate visibility is executed against the isolated sink." -ForegroundColor DarkCyan
    Invoke-CheckedCommand -Command "node" -Arguments @("--env-file-if-exists=.env", "scripts/run-isolated-bounded-live-runtime-proof.mjs")

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "  9ROUTER ISOLATED BOUNDED-LIVE RUNTIME : PASS" -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "PASS - candidate budget capped at 5000 basis points." -ForegroundColor Green
    Write-Host "PASS - real candidate output crossed only isolated loopback sink after deterministic verification." -ForegroundColor Green
    Write-Host "PASS - no raw provider output persisted; no production routing mutation or automatic retry/redispatch." -ForegroundColor Green
    Write-Host "PASS - explicit reference restore exercised only as labeled deterministic rollback safety drill." -ForegroundColor Green
    Write-Host "STATE_ROOT=$StateRoot" -ForegroundColor Cyan
    Write-Host "NEXT_GATE=INDEPENDENT_BOUNDED_LIVE_RUNTIME_REVIEW" -ForegroundColor Cyan
}
catch {
    $RunFailed = $true
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "  9ROUTER ISOLATED BOUNDED-LIVE RUNTIME : FAILED" -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "ERROR=$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "STATE_ROOT=$StateRoot" -ForegroundColor Yellow
}
finally {
    foreach ($Process in @($TempSink, $TempOpenCode)) {
        if ($Process) { try { Stop-ProcessTree -Process $Process } catch { Write-Host "WARN - cleanup failed for PID $($Process.Id): $($_.Exception.Message)" -ForegroundColor Yellow } }
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
