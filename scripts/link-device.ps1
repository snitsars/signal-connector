#Requires -Version 5.1
<#
.SYNOPSIS
  Link this app as a secondary device to your Signal account (scan the QR).
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    npm run link
} finally {
    Pop-Location
}
