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
    [int]$BridgePort = 8790
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

# 2. signal-cli daemon (java).
Get-CimInstance Win32_Process -Filter "Name='java.exe'" |
    Where-Object { $_.CommandLine -like '*org.asamk.signal.Main*' } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force
        Write-Host "stopped signal-cli daemon (pid $($_.ProcessId))" -ForegroundColor Yellow
        $script:stopped++
    }

# 3. Fallback: whatever holds the bridge port.
$bridgePid = (Get-NetTCPConnection -LocalPort $BridgePort -State Listen | Select-Object -First 1).OwningProcess
if ($bridgePid) {
    Stop-Process -Id $bridgePid -Force
    Write-Host "stopped bridge listener (pid $bridgePid)" -ForegroundColor Yellow
    $script:stopped++
}

# 4. Optional: opencode server on :4096.
if ($All) {
    $ocPid = (Get-NetTCPConnection -LocalPort 4096 -State Listen | Select-Object -First 1).OwningProcess
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
