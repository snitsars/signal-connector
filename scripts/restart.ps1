#Requires -Version 5.1
<#
.SYNOPSIS
  Restart the SignalConnector service (stop, then start). Projects stay open.

.EXAMPLE
  pwsh scripts/restart.ps1
#>
[CmdletBinding()]
param(
    [int]$BridgePort = 8790
)

$ErrorActionPreference = 'Stop'

Write-Host "stopping..."
& (Join-Path $PSScriptRoot 'stop.ps1') -BridgePort $BridgePort
Start-Sleep -Seconds 2

Write-Host "starting service..."
Start-Process -FilePath "pwsh" -ArgumentList '-NoProfile', '-File', (Join-Path $PSScriptRoot 'run.ps1') -WindowStyle Hidden
Start-Sleep -Seconds 6

$listening = Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    Write-Host "service restarted (bridge $BridgePort)" -ForegroundColor Green
} else {
    Write-Host "service started; if it did not come up, check the log in %APPDATA%\SignalConnector\logs" -ForegroundColor Yellow
}
