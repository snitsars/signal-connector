#Requires -Version 5.1
<#
.SYNOPSIS
  Download the latest signal-cli release into %LOCALAPPDATA%\SignalConnector\signal-cli
  and print the path to signal-cli.bat (for config.signal.cliPath).
#>
[CmdletBinding()]
param(
    [string]$Destination = (Join-Path $env:LOCALAPPDATA 'SignalConnector\signal-cli')
)

$ErrorActionPreference = 'Stop'

function Find-Bat {
    param([string]$Root)
    if (-not (Test-Path $Root)) { return $null }
    Get-ChildItem -Path $Root -Recurse -Filter 'signal-cli.bat' -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

$existing = Find-Bat -Root $Destination
if ($existing) {
    Write-Host "signal-cli already installed: $($existing.FullName)" -ForegroundColor Green
    Write-Output $existing.FullName
    exit 0
}

Write-Host "Fetching latest signal-cli release..."
$release = Invoke-RestMethod -Uri 'https://api.github.com/repos/AsamK/signal-cli/releases/latest' `
    -Headers @{ 'User-Agent' = 'SignalConnector' }

$asset = $release.assets | Where-Object { $_.name -match '^signal-cli-[\d.]+\.tar\.gz$' } | Select-Object -First 1
if (-not $asset) { throw "No signal-cli-<version>.tar.gz asset found in the latest release." }

$tmp = Join-Path $env:TEMP $asset.name
Write-Host "Downloading $($asset.name)..."
Invoke-WebRequest -Uri $asset.browser_download_url -OutFile $tmp

if (Test-Path $Destination) { Remove-Item -Recurse -Force $Destination }
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
Write-Host "Extracting to $Destination..."
tar -xzf $tmp -C $Destination
if ($LASTEXITCODE -ne 0) { throw "tar extraction failed ($LASTEXITCODE)." }
Remove-Item $tmp -Force -ErrorAction SilentlyContinue

$bat = Find-Bat -Root $Destination
if (-not $bat) { throw "signal-cli.bat not found after extraction." }

Write-Host "Installed signal-cli $($release.tag_name)" -ForegroundColor Green
Write-Host "  -> $($bat.FullName)"
Write-Output $bat.FullName
