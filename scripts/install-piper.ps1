#Requires -Version 5.1
<#
.SYNOPSIS
  Fetch Piper and one Ukrainian neural voice into
  %LOCALAPPDATA%\SignalConnector\piper, verify the tool runs, and print the two
  paths to paste into config.toml (voice.piperPath, voice.piperVoicePath).

.DESCRIPTION
  Nothing is installed from npm and nothing is hosted: the Windows build and the
  .onnx voice are plain downloads from the Piper project. A partial download is
  removed rather than left behind. When both paths are set, the avatar speaks
  with Piper instead of the Windows system voice.

.PARAMETER Destination
  Where Piper and its voices live. Defaults to
  %LOCALAPPDATA%\SignalConnector\piper.

.PARAMETER Voice
  Which Ukrainian voice to fetch: oleksa (male, high), mykyta (male, high),
  tetiana (female, high) or ukrainian_tts (female, medium). Defaults to oleksa.
#>
[CmdletBinding()]
param(
    [string]$Destination = '',
    [ValidateSet('oleksa', 'mykyta', 'tetiana', 'ukrainian_tts')]
    [string]$Voice = 'oleksa'
)

$ErrorActionPreference = 'Stop'

$Voices = @{
    oleksa         = 'uk/uk_UA/oleksa/high/uk_UA-oleksa-high'
    mykyta         = 'uk/uk_UA/mykyta/high/uk_UA-mykyta-high'
    tetiana        = 'uk/uk_UA/tetiana/high/uk_UA-tetiana-high'
    ukrainian_tts  = 'uk/uk_UA/ukrainian_tts/medium/uk_UA-ukrainian_tts-medium'
}
$VoiceStem = $Voices[$Voice]
$ReleaseUri = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip'
$VoiceBase = 'https://huggingface.co/rhasspy/piper-voices/resolve/main'

function Get-FileVerified {
    param([string]$Uri, [string]$Path, [string]$What)
    $partial = "$Path.part"
    Remove-Item $partial -Force -ErrorAction SilentlyContinue
    try {
        Write-Host "Downloading $What..."
        Invoke-WebRequest -Uri $Uri -OutFile $partial -UseBasicParsing
        if (-not (Test-Path $partial) -or (Get-Item $partial).Length -eq 0) {
            throw "the download produced no data"
        }
        Move-Item -Path $partial -Destination $Path -Force
    } catch {
        Remove-Item $partial -Force -ErrorAction SilentlyContinue
        throw "Could not download $What from $Uri — $($_.Exception.Message)"
    }
}

function Find-PiperExe {
    param([string]$Root)
    if (-not (Test-Path $Root)) { return $null }
    $found = Get-ChildItem -Path $Root -Recurse -Filter 'piper.exe' -ErrorAction SilentlyContinue |
        Where-Object { -not $_.PSIsContainer } |
        Select-Object -First 1
    return $found
}

function Test-PiperRuns {
    param([string]$Exe)
    if (-not (Test-Path $Exe)) { return $false }
    try {
        $output = & $Exe --help 2>&1
        # Some builds answer --help with a non-zero code; the point is that the
        # process started and spoke, so the binary and its DLLs are present.
        return ($LASTEXITCODE -eq 0) -or ("$output".Trim().Length -gt 0)
    } catch {
        return $false
    }
}

function Write-PiperConfig {
    param([string]$Exe, [string]$VoicePath)
    # config.toml is generated with a [voice] table already, and smol-toml
    # refuses a second one, so print keys only, never a header to paste.
    Write-Host "Paste these two lines inside the existing [voice] table in %APPDATA%\SignalConnector\config.toml"
    Write-Host "(do not add a second [voice] header — the file already has one):"
    Write-Output "piperPath = '$Exe'"
    Write-Output "piperVoicePath = '$VoicePath'"
}

if (-not $Destination) {
    if (-not $env:LOCALAPPDATA) {
        throw "LOCALAPPDATA is not set; cannot choose where to install Piper. Pass -Destination explicitly."
    }
    $Destination = Join-Path $env:LOCALAPPDATA 'SignalConnector\piper'
}

# Already installed and working: make sure the chosen voice is there, then print.
$existingExe = Find-PiperExe -Root $Destination
$voiceDir = Join-Path $Destination 'voices'
$voiceName = Split-Path $VoiceStem -Leaf
$voicePath = Join-Path $voiceDir "$voiceName.onnx"
$voiceJson = "$voicePath.json"

New-Item -ItemType Directory -Force -Path $voiceDir | Out-Null
if (-not (Test-Path $voicePath)) {
    Get-FileVerified -Uri "$VoiceBase/$VoiceStem.onnx" -Path $voicePath -What "the $Voice voice model"
}
if (-not (Test-Path $voiceJson)) {
    Get-FileVerified -Uri "$VoiceBase/$VoiceStem.onnx.json" -Path $voiceJson -What "the $Voice voice config"
}
if (-not (Test-Path $voicePath) -or (Get-Item $voicePath).Length -eq 0) {
    throw "The voice model is missing or empty: $voicePath"
}

if ($existingExe -and (Test-PiperRuns -Exe $existingExe.FullName)) {
    Write-Host "Piper already installed: $($existingExe.FullName)" -ForegroundColor Green
    Write-PiperConfig -Exe $existingExe.FullName -VoicePath $voicePath
    exit 0
}

$zip = Join-Path $env:TEMP ("signalconnector-piper-" + [guid]::NewGuid().ToString('N') + ".zip")
$staging = Join-Path $env:TEMP ("signalconnector-piper-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $staging | Out-Null

try {
    Get-FileVerified -Uri $ReleaseUri -Path $zip -What "Piper for Windows"
    Write-Host "Extracting..."
    try {
        Expand-Archive -Path $zip -DestinationPath $staging -Force
    } catch {
        throw "Could not extract the Piper archive: $($_.Exception.Message)"
    }

    $stagedExe = Find-PiperExe -Root $staging
    if (-not $stagedExe) {
        throw "The Piper archive contained no piper.exe."
    }

    # The archive has one piper/ root; move that tree into place and keep voices.
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem -Path $Destination -Force |
        Where-Object { $_.Name -ne 'voices' } |
        Remove-Item -Recurse -Force
    Get-ChildItem -Path $staging -Force | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $Destination -Recurse -Force
    }
} finally {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}

$exe = Find-PiperExe -Root $Destination
if (-not $exe) {
    throw "Piper was copied to $Destination but no piper.exe was found there."
}
if (-not (Test-PiperRuns -Exe $exe.FullName)) {
    throw "The installed Piper binary did not run: $($exe.FullName). Delete $Destination and run this script again."
}

Write-Host "Installed Piper with the $Voice voice." -ForegroundColor Green
Write-PiperConfig -Exe $exe.FullName -VoicePath $voicePath
