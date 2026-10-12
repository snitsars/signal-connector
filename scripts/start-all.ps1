#Requires -Version 5.1
<#
.SYNOPSIS
  Start the SignalConnector service in plugin mode and open each project in
  opencode so it registers its own plugin.

.DESCRIPTION
  - installs the plugin globally (~/.config/opencode/plugins) so every project loads it
  - sets agent.kind = "plugin" in the service config
  - starts the service
  - opens opencode in each given project (each registers and gets a Signal greeting)

.EXAMPLE
  pwsh scripts/start-all.ps1 -Projects C:\Sources\appA, C:\Sources\appB
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string[]]$Projects,
    [int]$BridgePort = 8790
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# 1. Install the plugin globally so any project loads it.
$pluginSrc = Join-Path $root '.opencode\plugins\signal-connector.ts'
$pluginDir = Join-Path $env:USERPROFILE '.config\opencode\plugins'
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
Copy-Item $pluginSrc (Join-Path $pluginDir 'signal-connector.ts') -Force
Write-Host "plugin installed -> $pluginDir\signal-connector.ts" -ForegroundColor Green

# 2. Set agent.kind = "plugin" in the service config.
$cfg = Join-Path $env:APPDATA 'SignalConnector\config.toml'
if (Test-Path $cfg) {
    $text = Get-Content $cfg -Raw
    if ($text -match '(?m)^\s*kind\s*=\s*"opencode-(server|cli)"') {
        $text = $text -replace '(?m)^\s*kind\s*=\s*"opencode-(server|cli)"', 'kind = "plugin"'
    } elseif ($text -match '(?m)^\[agent\]') {
        $text = $text -replace '(?m)^(\[agent\]\s*\r?\n)', "`$1kind = `"plugin`"`n"
    } else {
        $text = $text.TrimEnd() + "`n`n[agent]`nkind = `"plugin`"`n"
    }
    Set-Content -Path $cfg -Value $text -Encoding utf8
    Write-Host "config: agent.kind = plugin  ($cfg)" -ForegroundColor Green
} else {
    Write-Host "No config found — run scripts/setup.ps1 first." -ForegroundColor Yellow
}

# 3. Start the service.
Write-Host "starting service..."
Start-Process -FilePath "pwsh" -ArgumentList '-NoProfile', '-File', (Join-Path $PSScriptRoot 'run.ps1') -WindowStyle Hidden
Start-Sleep -Seconds 6

# 4. Open each project in opencode (loads the global plugin -> registers with the service).
foreach ($p in $Projects) {
    if (-not (Test-Path $p)) { Write-Host "skip (not found): $p" -ForegroundColor Yellow; continue }
    Write-Host "opening opencode in $p"
    Start-Process -FilePath 'cmd' -ArgumentList '/c', 'opencode', $p
}

Write-Host ""
Write-Host "Done. Each project registers with the service and you get a Signal message:" -ForegroundColor Cyan
Write-Host '  Project "<name>" connected. Reply to this message to address it, or use /use <name>.'
Write-Host "Reply (quote) any project message to route your command to that project."
Write-Host "Bridge: ws://127.0.0.1:$BridgePort"
