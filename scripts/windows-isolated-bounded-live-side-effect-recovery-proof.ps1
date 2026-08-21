param(
    [string]$ExpectedHead = "",
    [switch]$SkipInstall,
    [switch]$SkipSourceValidation
)

$ErrorActionPreference = "Stop"
$RunFailed = $false
$TranscriptStarted = $false
$StartLocation = (Get-Location).Path
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$RunStamp = (Get-Date -Format "yyyyMMdd-HHmmss") + "-" + ([guid]::NewGuid().ToString("N").Substring(0, 8))
$StateRoot = Join-Path $env:TEMP ("9router-bounded-live-recovery-" + $RunStamp)
$LogFile = Join-Path $env:TEMP ("9router-bounded-live-recovery-" + $RunStamp + ".log")

function Invoke-CheckedCommand {
    param([Parameter(Mandatory = $true)][string]$Command, [Parameter(Mandatory = $true)][string[]]$Arguments)
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command $($Arguments -join ' ') failed with exit code $LASTEXITCODE." }
}

try {
    try { Start-Transcript -Path $LogFile -Force | Out-Null; $TranscriptStarted = $true } catch {}
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  9ROUTER ISOLATED BOUNDED-LIVE SIDE-EFFECT RECOVERY PROOF" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "ROUTER_REPO=$Repo"
    Write-Host "STATE_ROOT=$StateRoot"
    Write-Host "LOG=$LogFile"

    Write-Host "`n=== 1. TOOLCHAIN + REPOSITORY GUARD ===" -ForegroundColor Yellow
    foreach ($Tool in @("git", "node", "npm")) { if (-not (Get-Command $Tool -ErrorAction SilentlyContinue)) { throw "$Tool not found in PATH." } }
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
    $env:ROUTER_BOUNDED_LIVE_PROJECT_DIR = $Repo
    $env:ROUTER_BOUNDED_LIVE_STATE_ROOT = $StateRoot
    $env:ROUTER_BOUNDED_LIVE_SINK_PORT = "4097"
    Write-Host "PASS - state under TEMP." -ForegroundColor Green

    Write-Host "`n=== 4. TWO-PROCESS RECOVERY PROOF ===" -ForegroundColor Yellow
    Invoke-CheckedCommand -Command "node" -Arguments @("scripts/run-isolated-bounded-live-side-effect-recovery-proof.mjs")
}
catch {
    $RunFailed = $true
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "  9ROUTER ISOLATED BOUNDED-LIVE SIDE-EFFECT RECOVERY : FAILED" -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "ERROR=$($_.Exception.Message)" -ForegroundColor Red
    Write-Host "STATE_ROOT=$StateRoot" -ForegroundColor Yellow
}
finally {
    try { Set-Location -LiteralPath $StartLocation } catch {}
    if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
}

if ($RunFailed) {
    Write-Host ""
    Write-Host "RESULT=FAILED" -ForegroundColor Red
    Write-Host "STATE_ROOT=$StateRoot" -ForegroundColor Cyan
    Write-Host "LOG=$LogFile" -ForegroundColor Cyan
    exit 1
}

exit 0