#Requires -Version 5.1
<#
.SYNOPSIS
  Stop the SignalConnector service, its signal-cli daemon, and (optionally) opencode serve.

.EXAMPLE
  pwsh scripts/stop.ps1
  pwsh scripts/stop.ps1 -All
#>
[CmdletBinding()]
param(
    [switch]$All,          # also stop the opencode server on :4096
    [int]$BridgePort = 8790,
    [int]$DaemonPort = 8080
)

$ErrorActionPreference = 'SilentlyContinue'
$stopped = 0

# 1. SignalConnector service (node running src/index.ts or dist/index.js).
Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
    Where-Object { $_.CommandLine -match 'src[\\/]index\.ts' -or $_.CommandLine -match 'dist[\\/]index\.js' } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force
        Write-Host "stopped service (pid $($_.ProcessId))" -ForegroundColor Yellow
        $script:stopped++
    }

# 2. signal-cli daemon (java), matched on its command line. A daemon whose
#    connection to Signal died keeps answering `version` while never answering
#    `receive`, and the next service start would adopt it, so it has to go.
Get-CimInstance Win32_Process -Filter "Name='java.exe'" |
    Where-Object { $_.CommandLine -like '*org.asamk.signal.Main*' -or $_.CommandLine -like '*signal-cli*' } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force
        Write-Host "stopped signal-cli daemon (pid $($_.ProcessId))" -ForegroundColor Yellow
        $script:stopped++
    }

# 3. Whatever still holds the daemon port (the java filter above can miss a
#    daemon started by another account or an older install).
$daemonPid = $null
try {
    $daemonPid = (Get-NetTCPConnection -LocalPort $DaemonPort -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess
} catch { }
if ($daemonPid) {
    Stop-Process -Id $daemonPid -Force
    Write-Host "stopped daemon port listener on $DaemonPort (pid $daemonPid)" -ForegroundColor Yellow
    $script:stopped++
}

# 4. Fallback: whatever holds the bridge port.
$bridgePid = $null
try {
    $bridgePid = (Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess
} catch { }
if ($bridgePid) {
    Stop-Process -Id $bridgePid -Force
    Write-Host "stopped bridge listener (pid $bridgePid)" -ForegroundColor Yellow
    $script:stopped++
}

# 5. Optional: opencode server on :4096.
if ($All) {
    $ocPid = $null
    try {
        $ocPid = (Get-NetTCPConnection -LocalPort 4096 -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess
    } catch { }
    if ($ocPid) {
        Stop-Process -Id $ocPid -Force
        Write-Host "stopped opencode serve (pid $ocPid)" -ForegroundColor Yellow
        $script:stopped++
    }
}

if ($stopped -eq 0) {
    Write-Host "nothing running to stop" -ForegroundColor Green
} else {
    Write-Host "stopped $stopped process(es)" -ForegroundColor Green
}

# A port that survives the stop is what makes the next start adopt a stale
# process, so say so instead of quietly reporting success.
Start-Sleep -Milliseconds 500
foreach ($port in @($BridgePort, $DaemonPort)) {
    $held = $null
    try { $held = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction Stop } catch { }
    if ($held) {
        Write-Host "warning: port $port is still held (pid $($held[0].OwningProcess)); stop it before starting again" -ForegroundColor Red
    }
}
