param(
    [string]$TargetProject = "D:\proyek\sistem_rekonsiliasi_stok",
    [string]$OpenCodeBaseUrl = "http://127.0.0.1:4096",
    [switch]$SkipInstall,
    [switch]$SkipSourceValidation
)

$ErrorActionPreference = "Stop"
$RunFailed = $false
$TempOpenCode = $null
$TranscriptStarted = $false
$StartLocation = (Get-Location).Path
$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$LogFile = Join-Path $env:TEMP ("9router-opencode-preflight-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")

function Invoke-CheckedCommand {
    param(
        [Parameter(Mandatory = $true)][string]$Command,
        [Parameter(Mandatory = $true)][string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command $($Arguments -join ' ') gagal dengan exit code $LASTEXITCODE."
    }
}

function Test-LocalTcpPort {
    param(
        [string]$HostName = "127.0.0.1",
        [int]$Port = 4096,
        [int]$TimeoutMs = 700
    )

    $Client = $null
    try {
        $Client = New-Object System.Net.Sockets.TcpClient
        $Async = $Client.BeginConnect($HostName, $Port, $null, $null)
        if (-not $Async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)) {
            return $false
        }
        $Client.EndConnect($Async)
        return $Client.Connected
    }
    catch {
        return $false
    }
    finally {
        if ($Client) {
            $Client.Dispose()
        }
    }
}

function Get-BaseUrlPort {
    param([string]$BaseUrl)

    $Uri = New-Object System.Uri($BaseUrl)
    if ($Uri.Host -notin @("127.0.0.1", "localhost", "::1")) {
        throw "Preflight Windows default hanya mengizinkan loopback OpenCode server. Diterima: $($Uri.Host)"
    }
    return $Uri.Port
}

try {
    try {
        Start-Transcript -Path $LogFile -Force | Out-Null
        $TranscriptStarted = $true
    }
    catch {
        Write-Host "WARN - Transcript tidak dapat dimulai: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  9ROUTER vNext - WINDOWS OPENCODE PREFLIGHT" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "ROUTER_REPO=$Repo"
    Write-Host "TARGET_PROJECT=$TargetProject"
    Write-Host "OPENCODE_BASE_URL=$OpenCodeBaseUrl"
    Write-Host "LOG=$LogFile" -ForegroundColor DarkGray

    Write-Host "`n=== 1. TOOLCHAIN GUARD ===" -ForegroundColor Yellow
    foreach ($Tool in @("git", "node", "npm", "opencode")) {
        $Resolved = Get-Command $Tool -ErrorAction SilentlyContinue
        if (-not $Resolved) {
            throw "Command '$Tool' tidak ditemukan di PATH."
        }
        Write-Host "PASS - $Tool tersedia." -ForegroundColor Green
    }

    Write-Host "NODE=$(& node --version)"
    Write-Host "NPM=$(& npm --version)"
    Write-Host "GIT=$(& git --version)"
    Write-Host "OPENCODE=$(& opencode --version)"

    Set-Location -LiteralPath $Repo

    Write-Host "`n=== 2. ROUTER REPOSITORY GUARD ===" -ForegroundColor Yellow
    $Dirty = @(& git status --porcelain)
    if ($LASTEXITCODE -ne 0) {
        throw "git status gagal pada intelligent-agent-router."
    }
    if ($Dirty.Count -gt 0) {
        Write-Host ($Dirty -join "`n") -ForegroundColor DarkYellow
        throw "intelligent-agent-router memiliki perubahan lokal. Preflight dihentikan agar pekerjaan lokal tidak tertimpa."
    }
    Write-Host "PASS - Working tree bersih." -ForegroundColor Green

    $Head = (& git rev-parse HEAD | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "git rev-parse HEAD gagal."
    }
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
        Write-Host "PASS - npm run check." -ForegroundColor Green
        Invoke-CheckedCommand -Command "npm" -Arguments @("run", "eval")
        Write-Host "PASS - npm run eval." -ForegroundColor Green
    }
    else {
        Write-Host "`n=== 4. SOURCE VALIDATION ===" -ForegroundColor Yellow
        Write-Host "SKIP - requested by -SkipSourceValidation." -ForegroundColor DarkYellow
    }

    Write-Host "`n=== 5. TARGET PROJECT GUARD ===" -ForegroundColor Yellow
    if (-not (Test-Path -LiteralPath $TargetProject)) {
        throw "Target project tidak ditemukan: $TargetProject"
    }
    $TargetProject = (Resolve-Path -LiteralPath $TargetProject).Path
    $TargetTopLevel = (& git -C $TargetProject rev-parse --show-toplevel 2>$null | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $TargetTopLevel) {
        throw "Target bukan Git repository yang valid: $TargetProject"
    }
    Write-Host "PASS - TARGET_PROJECT=$TargetProject" -ForegroundColor Green

    Write-Host "`n=== 6. SAFE OPENCODE CONFIG ===" -ForegroundColor Yellow
    $env:OPENCODE_BASE_URL = $OpenCodeBaseUrl
    $env:OPENCODE_PROJECT_DIR = $TargetProject
    $env:OPENCODE_ALLOW_REMOTE = "false"
    $env:OPENCODE_LIVE_SESSION_SMOKE = "false"
    if (-not $env:OPENCODE_SERVER_USERNAME) {
        $env:OPENCODE_SERVER_USERNAME = "opencode"
    }
    Write-Host "OPENCODE_BASE_URL=$($env:OPENCODE_BASE_URL)"
    Write-Host "OPENCODE_PROJECT_DIR=$($env:OPENCODE_PROJECT_DIR)"
    Write-Host "OPENCODE_ALLOW_REMOTE=false"
    Write-Host "OPENCODE_LIVE_SESSION_SMOKE=false"
    Write-Host "BASIC_AUTH_CONFIGURED=$([bool]$env:OPENCODE_SERVER_PASSWORD)"
    Write-Host "PASS - Read-only live preflight configured." -ForegroundColor Green

    Write-Host "`n=== 7. OPENCODE LOCAL SERVER ===" -ForegroundColor Yellow
    $Port = Get-BaseUrlPort -BaseUrl $OpenCodeBaseUrl
    if (Test-LocalTcpPort -Port $Port) {
        Write-Host "PASS - Existing OpenCode server reachable on loopback port $Port." -ForegroundColor Green
    }
    else {
        Write-Host "INFO - OpenCode server belum aktif. Starting temporary server on port $Port..." -ForegroundColor DarkCyan
        $OpenCodeCommand = Get-Command opencode -ErrorAction Stop
        $TempOpenCode = Start-Process -FilePath $OpenCodeCommand.Source -ArgumentList @(
            "serve",
            "--hostname", "127.0.0.1",
            "--port", $Port.ToString()
        ) -WindowStyle Hidden -PassThru

        Write-Host "TEMP_OPENCODE_PID=$($TempOpenCode.Id)"
        $Ready = $false
        for ($Attempt = 1; $Attempt -le 40; $Attempt++) {
            Start-Sleep -Milliseconds 500
            if ($TempOpenCode.HasExited) {
                throw "Temporary OpenCode server berhenti sebelum ready. ExitCode=$($TempOpenCode.ExitCode)"
            }
            if (Test-LocalTcpPort -Port $Port) {
                $Ready = $true
                break
            }
        }
        if (-not $Ready) {
            throw "OpenCode server tidak ready pada port $Port dalam 20 detik."
        }
        Write-Host "PASS - Temporary OpenCode server ready." -ForegroundColor Green
    }

    Write-Host "`n=== 8. LIVE READ-ONLY OPENCODE PREFLIGHT ===" -ForegroundColor Yellow
    Invoke-CheckedCommand -Command "npm" -Arguments @("run", "validate:opencode-live")
    Write-Host "PASS - OpenCode live adapter preflight." -ForegroundColor Green

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "  9ROUTER LIVE PREFLIGHT : PASS" -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "PASS - Router source validation." -ForegroundColor Green
    Write-Host "PASS - Target repository validation." -ForegroundColor Green
    Write-Host "PASS - OpenCode localhost reachability." -ForegroundColor Green
    Write-Host "PASS - OpenCode live read-only adapter gate." -ForegroundColor Green
    Write-Host "NEXT_GATE=LIVE_SESSION_AND_ISOLATED_WORKTREE_SMOKE" -ForegroundColor Cyan
    [Environment]::ExitCode = 0
}
catch {
    $RunFailed = $true
    [Environment]::ExitCode = 1
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "  9ROUTER PREFLIGHT : FAILED" -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "ERROR=$($_.Exception.Message)" -ForegroundColor Red
    if ($_.InvocationInfo.PositionMessage) {
        Write-Host $_.InvocationInfo.PositionMessage -ForegroundColor DarkYellow
    }
}
finally {
    if ($TempOpenCode) {
        try {
            if (-not $TempOpenCode.HasExited) {
                Write-Host "`n=== CLEANUP TEMPORARY OPENCODE ===" -ForegroundColor DarkGray
                Stop-Process -Id $TempOpenCode.Id -Force -ErrorAction Stop
                $TempOpenCode.WaitForExit()
                Write-Host "PASS - Temporary OpenCode server stopped." -ForegroundColor Green
            }
        }
        catch {
            Write-Host "WARN - Temporary OpenCode cleanup gagal: $($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    try {
        Set-Location -LiteralPath $StartLocation
    }
    catch {}

    if ($TranscriptStarted) {
        try {
            Stop-Transcript | Out-Null
        }
        catch {}
    }

    Write-Host ""
    if ($RunFailed) {
        Write-Host "RESULT=FAILED" -ForegroundColor Red
    }
    else {
        Write-Host "RESULT=PASS" -ForegroundColor Green
    }
    Write-Host "LOG=$LogFile" -ForegroundColor Cyan
}
