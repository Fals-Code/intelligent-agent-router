param(
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
$LogFile = Join-Path $env:TEMP ("9router-source-runtime-preflight-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")

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
        throw "Source/runtime Windows preflight hanya mengizinkan loopback OpenCode server. Diterima: $($Uri.Host)"
    }
    return $Uri.Port
}

function Start-TemporaryOpenCodeServer {
    param([Parameter(Mandatory = $true)][int]$Port)
    $PowerShellExe = $null
    try { $PowerShellExe = (Get-Process -Id $PID -ErrorAction Stop).Path } catch {}
    if (-not $PowerShellExe) { $PowerShellExe = (Get-Command powershell.exe -ErrorAction Stop).Source }
    if (-not $PowerShellExe -or -not (Test-Path -LiteralPath $PowerShellExe)) {
        throw "Executable PowerShell untuk temporary OpenCode server tidak dapat di-resolve."
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
    try {
        Start-Transcript -Path $LogFile -Force | Out-Null
        $TranscriptStarted = $true
    }
    catch {
        Write-Host "WARN - Transcript tidak dapat dimulai: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  9ROUTER REFERENCE SOURCE/RUNTIME SLICE" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "ROUTER_REPO=$Repo"
    Write-Host "OPENCODE_BASE_URL=$OpenCodeBaseUrl"
    Write-Host "LOG=$LogFile" -ForegroundColor DarkGray

    Write-Host "`n=== 1. TOOLCHAIN GUARD ===" -ForegroundColor Yellow
    foreach ($Tool in @("git", "node", "npm", "opencode")) {
        if (-not (Get-Command $Tool -ErrorAction SilentlyContinue)) { throw "Command '$Tool' tidak ditemukan di PATH." }
        Write-Host "PASS - $Tool tersedia." -ForegroundColor Green
    }

    Set-Location -LiteralPath $Repo
    Write-Host "`n=== 2. ROUTER REPOSITORY GUARD ===" -ForegroundColor Yellow
    $Dirty = @(& git status --porcelain)
    if ($LASTEXITCODE -ne 0) { throw "git status gagal pada intelligent-agent-router." }
    if ($Dirty.Count -gt 0) {
        Write-Host ($Dirty -join "`n") -ForegroundColor DarkYellow
        throw "intelligent-agent-router memiliki perubahan lokal."
    }
    $Head = (& git rev-parse HEAD | Out-String).Trim()
    $OriginMain = (& git rev-parse refs/remotes/origin/main | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or -not $OriginMain) { throw "origin/main tidak dapat di-resolve." }
    if ($Head -ne $OriginMain) { throw "Router HEAD harus exact origin/main. HEAD=$Head ORIGIN_MAIN=$OriginMain" }
    Write-Host "PASS - Working tree bersih dan HEAD exact origin/main." -ForegroundColor Green
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

    Write-Host "`n=== 5. SAFE OPENCODE CONFIG ===" -ForegroundColor Yellow
    $env:OPENCODE_BASE_URL = $OpenCodeBaseUrl
    $env:OPENCODE_PROJECT_DIR = $Repo
    $env:ROUTER_SOURCE_RUNTIME_PROJECT_DIR = $Repo
    $env:OPENCODE_ALLOW_REMOTE = "false"
    if (-not $env:OPENCODE_SERVER_USERNAME) { $env:OPENCODE_SERVER_USERNAME = "opencode" }
    Write-Host "OPENCODE_PROJECT_DIR=$Repo"
    Write-Host "OPENCODE_ALLOW_REMOTE=false"
    Write-Host "PASS - local-only source/runtime configuration." -ForegroundColor Green

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
            if ($TempOpenCode.HasExited) { throw "Temporary OpenCode host berhenti sebelum ready. ExitCode=$($TempOpenCode.ExitCode)" }
            if (Test-LocalTcpPort -Port $Port) { $Ready = $true; break }
        }
        if (-not $Ready) { throw "OpenCode server tidak ready pada port $Port dalam 20 detik." }
        Write-Host "PASS - Temporary OpenCode server ready." -ForegroundColor Green
    }

    Write-Host "`n=== 7. LIVE READ-ONLY OPENCODE PREFLIGHT ===" -ForegroundColor Yellow
    Invoke-CheckedCommand -Command "npm" -Arguments @("run", "validate:opencode-live")
    Write-Host "PASS - OpenCode live adapter preflight." -ForegroundColor Green

    Write-Host "`n=== 8. PROMPT-DRIVEN REFERENCE SOURCE/RUNTIME SLICE ===" -ForegroundColor Yellow
    Write-Host "INFO - Agent may edit exactly one core source file plus one regression test in an isolated retained worktree." -ForegroundColor DarkCyan
    Write-Host "INFO - Agent has no shell/network permission; harness runs only fixed allowlisted verification commands." -ForegroundColor DarkCyan
    Write-Host "INFO - No commit, push, merge, or deployment is performed by this gate." -ForegroundColor DarkCyan
    Invoke-CheckedCommand -Command "npm" -Arguments @("run", "run:reference-source-runtime")
    Write-Host "PASS - Prompt-driven source/runtime reference slice." -ForegroundColor Green

    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "  9ROUTER SOURCE/RUNTIME VERTICAL SLICE : PASS" -ForegroundColor Green
    Write-Host "============================================================" -ForegroundColor Green
    Write-Host "PASS - Router source validation." -ForegroundColor Green
    Write-Host "PASS - OpenCode localhost + live adapter gate." -ForegroundColor Green
    Write-Host "PASS - Prompt-driven R2 source mutation gate." -ForegroundColor Green
    Write-Host "PASS - Exact source + regression-test Git scope." -ForegroundColor Green
    Write-Host "PASS - Fixed command allowlist execution." -ForegroundColor Green
    Write-Host "PASS - Independent deterministic verifier." -ForegroundColor Green
    Write-Host "PASS - Router main remained unchanged." -ForegroundColor Green
    Write-Host "NEXT_GATE=INDEPENDENT_SOURCE_REVIEW_AND_PUBLISH" -ForegroundColor Cyan
    [Environment]::ExitCode = 0
}
catch {
    $RunFailed = $true
    [Environment]::ExitCode = 1
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "  9ROUTER SOURCE/RUNTIME PREFLIGHT : FAILED" -ForegroundColor Red
    Write-Host "============================================================" -ForegroundColor Red
    Write-Host "ERROR=$($_.Exception.Message)" -ForegroundColor Red
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
        catch { Write-Host "WARN - Temporary OpenCode cleanup gagal: $($_.Exception.Message)" -ForegroundColor Yellow }
    }
    try { Set-Location -LiteralPath $StartLocation } catch {}
    if ($TranscriptStarted) { try { Stop-Transcript | Out-Null } catch {} }
    Write-Host ""
    if ($RunFailed) { Write-Host "RESULT=FAILED" -ForegroundColor Red } else { Write-Host "RESULT=PASS" -ForegroundColor Green }
    Write-Host "LOG=$LogFile" -ForegroundColor Cyan
}
