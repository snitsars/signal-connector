#Requires -Version 5.1
<#
.SYNOPSIS
  Fetch whisper.cpp and a multilingual model into
  %LOCALAPPDATA%\SignalConnector\whisper, verify the tool runs, and print the
  two paths to paste into config.toml (voice.whisperPath, voice.modelPath).

.DESCRIPTION
  Nothing is installed from npm and nothing is hosted: the release and the model
  are plain downloads. Every step fails with a message naming what is missing,
  and a partial download is removed rather than left behind.

.PARAMETER Destination
  Where the tool and model live. Defaults to
  %LOCALAPPDATA%\SignalConnector\whisper.

.PARAMETER Model
  Which multilingual model to fetch: tiny, base or small. Defaults to base.
#>
[CmdletBinding()]
param(
    [string]$Destination = '',
    [ValidateSet('tiny', 'base', 'small')]
    [string]$Model = 'base'
)

$ErrorActionPreference = 'Stop'

$ModelFiles = @{
    tiny  = 'ggml-tiny.bin'
    base  = 'ggml-base.bin'
    small = 'ggml-small.bin'
}
$ModelFile = $ModelFiles[$Model]

function Find-WhisperExe {
    param([string]$Root)
    if (-not (Test-Path $Root)) { return $null }
    # Newer releases ship whisper-cli.exe; older ones main.exe.
    foreach ($name in @('whisper-cli.exe', 'main.exe', 'whisper.exe')) {
        $found = Get-ChildItem -Path $Root -Recurse -Filter $name -ErrorAction SilentlyContinue |
            Where-Object { -not $_.PSIsContainer } |
            Select-Object -First 1
        if ($found) { return $found }
    }
    return $null
}

function Test-WhisperRuns {
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
        # Never leave a half-downloaded file in place.
        Remove-Item $partial -Force -ErrorAction SilentlyContinue
        throw "Could not download $What from $Uri — $($_.Exception.Message)"
    }
}

function Write-VoiceConfig {
    param([string]$Exe, [string]$ModelPath)
    # config.toml is generated with a [voice] table already, and smol-toml
    # refuses a second one, so print keys only, never a header to paste.
    Write-Host "Paste these two lines inside the existing [voice] table in %APPDATA%\SignalConnector\config.toml"
    Write-Host "(do not add a second [voice] header — the file already has one):"
    Write-Output "whisperPath = '$Exe'"
    Write-Output "modelPath = '$ModelPath'"
}

if (-not $Destination) {
    if (-not $env:LOCALAPPDATA) {
        throw "LOCALAPPDATA is not set; cannot choose where to install whisper.cpp. Pass -Destination explicitly."
    }
    $Destination = Join-Path $env:LOCALAPPDATA 'SignalConnector\whisper'
}

# Already installed and working: print the paths and stop.
$existingExe = Find-WhisperExe -Root $Destination
$existingModel = Join-Path (Join-Path $Destination 'models') $ModelFile
if ($existingExe -and (Test-Path $existingModel) -and (Test-WhisperRuns -Exe $existingExe.FullName)) {
    Write-Host "whisper.cpp already installed: $($existingExe.FullName)" -ForegroundColor Green
    Write-VoiceConfig -Exe $existingExe.FullName -ModelPath $existingModel
    exit 0
}

Write-Host "Fetching the latest whisper.cpp release..."
try {
    $release = Invoke-RestMethod `
        -Uri 'https://api.github.com/repos/ggerganov/whisper.cpp/releases/latest' `
        -Headers @{ 'User-Agent' = 'SignalConnector' } `
        -UseBasicParsing
} catch {
    throw "Cannot read the whisper.cpp release feed (no network, or GitHub refused): $($_.Exception.Message)"
}
if (-not $release -or -not $release.assets -or $release.assets.Count -eq 0) {
    throw "The whisper.cpp release feed returned no assets."
}

# Prefer the plain x64 Windows build; fall back to any x64 zip.
$asset = $release.assets | Where-Object { $_.name -match '^whisper.*bin.*x64.*\.zip$' } | Select-Object -First 1
if (-not $asset) {
    $asset = $release.assets | Where-Object { $_.name -match '\.zip$' -and $_.name -match 'x64' } | Select-Object -First 1
}
if (-not $asset) {
    $asset = $release.assets | Where-Object { $_.name -match '\.zip$' } | Select-Object -First 1
}
if (-not $asset) {
    throw "No Windows .zip asset found in whisper.cpp $($release.tag_name)."
}

$zip = Join-Path $env:TEMP ("signalconnector-whisper-" + [guid]::NewGuid().ToString('N') + ".zip")
$staging = Join-Path $env:TEMP ("signalconnector-whisper-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Force -Path $staging | Out-Null

try {
    Get-FileVerified -Uri $asset.browser_download_url -Path $zip -What "whisper.cpp $($release.tag_name) ($($asset.name))"

    Write-Host "Extracting..."
    try {
        Expand-Archive -Path $zip -DestinationPath $staging -Force
    } catch {
        throw "Could not extract $($asset.name): $($_.Exception.Message)"
    }

    $stagedExe = Find-WhisperExe -Root $staging
    if (-not $stagedExe) {
        throw "The $($asset.name) archive contained no whisper-cli.exe or main.exe."
    }
    if (-not (Test-WhisperRuns -Exe $stagedExe.FullName)) {
        throw "The extracted whisper.cpp binary did not run: $($stagedExe.FullName)"
    }

    # Move the built tree into place, keeping a models folder from an earlier run.
    New-Item -ItemType Directory -Force -Path $Destination | Out-Null
    Get-ChildItem -Path $Destination -Force |
        Where-Object { $_.Name -ne 'models' } |
        Remove-Item -Recurse -Force
    Get-ChildItem -Path $staging -Force | ForEach-Object {
        Copy-Item -Path $_.FullName -Destination $Destination -Recurse -Force
    }
} finally {
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Remove-Item $staging -Recurse -Force -ErrorAction SilentlyContinue
}

$exe = Find-WhisperExe -Root $Destination
if (-not $exe) {
    throw "whisper.cpp was copied to $Destination but no whisper-cli.exe or main.exe was found there."
}
if (-not (Test-WhisperRuns -Exe $exe.FullName)) {
    throw "The installed whisper.cpp binary did not run: $($exe.FullName). Delete $Destination and run this script again."
}

# The multilingual base model: `base` has no `.en` suffix, so it is not English-only.
$modelDir = Join-Path $Destination 'models'
New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
$modelPath = Join-Path $modelDir $ModelFile
if (-not (Test-Path $modelPath)) {
    Get-FileVerified `
        -Uri "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$ModelFile" `
        -Path $modelPath `
        -What "the multilingual $Model model ($ModelFile)"
}
if (-not (Test-Path $modelPath) -or (Get-Item $modelPath).Length -eq 0) {
    throw "The model file is missing or empty: $modelPath"
}

Write-Host "Installed whisper.cpp $($release.tag_name) with the multilingual $Model model." -ForegroundColor Green
Write-VoiceConfig -Exe $exe.FullName -ModelPath $modelPath
