#Requires -Version 5.1
<#
.SYNOPSIS
  Ensure a JDK 25 is available (signal-cli requires it).
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

function Get-JavaMajor {
    try {
        $out = (& java -version 2>&1 | Out-String)
    } catch {
        return 0
    }
    if ($out -match 'version "(?<v>\d+)') { return [int]$Matches['v'] }
    return 0
}

$major = Get-JavaMajor
if ($major -ge 25) {
    Write-Host "Java $major detected." -ForegroundColor Green
    exit 0
}

Write-Host "Java 25 not found (detected: $major). Installing Microsoft OpenJDK 25 via winget..." -ForegroundColor Yellow
if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
    throw "winget is not available. Install a JDK 25 manually (https://adoptium.net) and re-run setup."
}

winget install --id Microsoft.OpenJDK.25 -e --accept-source-agreements --accept-package-agreements
if ($LASTEXITCODE -ne 0) {
    throw "winget install failed with exit code $LASTEXITCODE. Install a JDK 25 manually and re-run."
}

Write-Host "Java 25 installed. Open a NEW shell so PATH updates, then re-run." -ForegroundColor Green
