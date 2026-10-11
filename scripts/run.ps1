#Requires -Version 5.1
<#
.SYNOPSIS
  Run the SignalConnector daemon.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    npm run dev
} finally {
    Pop-Location
}
