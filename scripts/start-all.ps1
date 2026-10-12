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
  pwsh scripts/start-all.ps1 -Projects "C:\Sources\appA" "C:\Sources\appB"
  pwsh scripts/start-all.ps1 -Projects @("C:\Sources\appA","C:\Sources\appB") -BridgePort 9000
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, ValueFromRemainingArguments = $true)][string[]]$Projects
)

$BridgePort = 8790

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot

# Normalize -Projects: PowerShell may hand "-Projects a,b" over as one
# comma-joined string, and "a, b" as separate tokens. Split on commas either way.
$Projects = @(
    $Projects |
        ForEach-Object { $_ -split ',' } |
        ForEach-Object { $_.Trim() } |
        Where-Object { $_ -ne '' }
)
if ($Projects.Count -eq 0) { throw "No project paths given." }

# 1. Install the plugin globally so any project loads it.
$pluginSrc = Join-Path $root '.opencode\plugins\signal-connector.ts'
$pluginDir = Join-Path $env:USERPROFILE '.config\opencode\plugins'
New-Item -ItemType Directory -Force -Path $pluginDir | Out-Null
Copy-Item $pluginSrc (Join-Path $pluginDir 'signal-connector.ts') -Force
Write-Host "plugin installed -> $pluginDir\signal-connector.ts" -ForegroundColor Green

# 2. Set agent.kind = "plugin" in the service config (section-scoped, idempotent).
$cfg = Join-Path $env:APPDATA 'SignalConnector\config.toml'
if (Test-Path $cfg) {
    $out = New-Object System.Collections.Generic.List[string]
    $inAgent = $false
    $agentSeen = $false
    $kindWritten = $false
    foreach ($line in (Get-Content -Path $cfg)) {
        if ($line -match '^\s*\[(.+?)\]') {
            if ($inAgent -and -not $kindWritten) { $out.Add('kind = "plugin"') }
            $inAgent = ($Matches[1] -eq 'agent')
            if ($inAgent) { $agentSeen = $true }
            $kindWritten = $false
            $out.Add($line)
            continue
        }
        if ($inAgent -and $line -match '^\s*kind\s*=') {
            if (-not $kindWritten) { $out.Add('kind = "plugin"'); $kindWritten = $true }
            continue
        }
        $out.Add($line)
    }
    if ($inAgent -and -not $kindWritten) { $out.Add('kind = "plugin"') }
    if (-not $agentSeen) { $out.Add(''); $out.Add('[agent]'); $out.Add('kind = "plugin"') }
    Set-Content -Path $cfg -Value $out -Encoding utf8
    Write-Host "config: agent.kind = plugin  ($cfg)" -ForegroundColor Green
} else {
    Write-Host "No config found — run scripts/setup.ps1 first." -ForegroundColor Yellow
}

# 3. Start the service (unless it is already listening on the bridge port).
$listening = $null
try { $listening = Get-NetTCPConnection -LocalPort $BridgePort -State Listen -ErrorAction Stop } catch { }
if ($listening) {
    Write-Host "service already running (bridge $BridgePort)" -ForegroundColor Green
} else {
    Write-Host "starting service..."
    Start-Process -FilePath "pwsh" -ArgumentList '-NoProfile', '-File', (Join-Path $PSScriptRoot 'run.ps1') -WindowStyle Hidden
    Start-Sleep -Seconds 6
}

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
