#Requires -Version 5.1
<#
.SYNOPSIS
  Start the opencode v2 server in the background on a fixed port.
#>
[CmdletBinding()]
param(
    [int]$Port = 4096
)

$ErrorActionPreference = 'Stop'
$url = "http://127.0.0.1:$Port"

try {
    Invoke-WebRequest -Uri "$url/api/info" -TimeoutSec 2 -ErrorAction Stop | Out-Null
    Write-Host "opencode server already running at $url" -ForegroundColor Green
    exit 0
} catch {
    # not running yet
}

$cmd = Get-Command opencode -ErrorAction SilentlyContinue
if (-not $cmd) { throw "opencode is not on PATH. Install it first (see README)." }

$exe = $cmd.Source
if ($exe -like '*.ps1') { $exe = [System.IO.Path]::ChangeExtension($exe, '.cmd') }

Write-Host "Starting opencode serve on port $Port..."
Start-Process -FilePath $exe -ArgumentList 'serve', '--port', "$Port" -WindowStyle Hidden
Start-Sleep -Seconds 6
Write-Host "opencode server should now be listening at $url" -ForegroundColor Green
Write-Host "Auth uses OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD from the environment."
