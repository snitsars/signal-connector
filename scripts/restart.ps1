#Requires -Version 5.1
<#
.SYNOPSIS
  Restart the SignalConnector service (stop, then start). Projects stay open.

.EXAMPLE
  pwsh scripts/restart.ps1
#>
[CmdletBinding()]
param(
    [int]$BridgePort = 8790,
    [int]$DaemonPort = 8080
)

$ErrorActionPreference = 'Stop'

# Remember who owned the daemon port: a restart that leaves the same pid behind
# has kept a wedged daemon, and the service would adopt it.
$before = $null
try {
    $before = (Get-NetTCPConnection -LocalPort $DaemonPort -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess
} catch { }

Write-Host "stopping..."
& (Join-Path $PSScriptRoot 'stop.ps1') -BridgePort $BridgePort -DaemonPort $DaemonPort
Start-Sleep -Seconds 2

Write-Host "starting service..."
Start-Process -FilePath "pwsh" -ArgumentList '-NoProfile', '-File', (Join-Path $PSScriptRoot 'run.ps1') -WindowStyle Hidden
Start-Sleep -Seconds 6

$listening = $null
try { $listening = Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction Stop } catch { }
if ($listening) {
    Write-Host "service restarted (bridge $BridgePort)" -ForegroundColor Green
} else {
    Write-Host "service started; if it did not come up, check the log in %APPDATA%\SignalConnector\logs" -ForegroundColor Yellow
}

# The daemon is spawned by the service and takes a few seconds to answer.
$after = $null
for ($i = 0; $i -lt 20; $i++) {
    try {
        $after = (Get-NetTCPConnection -LocalPort $DaemonPort -State Listen -ErrorAction Stop | Select-Object -First 1).OwningProcess
    } catch { }
    if ($after) { break }
    Start-Sleep -Milliseconds 500
}

if (-not $after) {
    Write-Host "warning: no signal-cli daemon listening on $DaemonPort yet" -ForegroundColor Yellow
} elseif ($before -and $after -eq $before) {
    Write-Host "warning: the same signal-cli daemon (pid $after) survived the restart; a wedged daemon answers 'version' but never 'receive', so stop it and start again" -ForegroundColor Red
} else {
    Write-Host "signal-cli daemon restarted (pid $after)" -ForegroundColor Green
}
