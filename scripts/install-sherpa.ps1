#Requires -Version 5.1
<#
.SYNOPSIS
  Fetch sherpa-onnx and the Ukrainian Moonshine model into
  %LOCALAPPDATA%\SignalConnector\sherpa, verify the tool runs, and print the two
  paths to paste into config.toml (voice.sherpaPath, voice.sherpaModelDir).

.DESCRIPTION
  sherpa-onnx is a plain Windows binary and the Moonshine Ukrainian model is an
  ONNX download; nothing is installed from npm and nothing is hosted. When both
  paths are set, the connector uses this recogniser instead of whisper: on a
  laptop CPU it is several times faster on short utterances.

.PARAMETER Destination
  Where the tool and model live. Defaults to
  %LOCALAPPDATA%\SignalConnector\sherpa.
#>
[CmdletBinding()]
param(
    [string]$Destination = ''
)

$ErrorActionPreference = 'Stop'

$ModelName = 'sherpa-onnx-moonshine-base-uk-quantized-2026-02-27'
$ModelUri = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/$ModelName.tar.bz2"

function Invoke-Download {
    param([string]$Uri, [string]$Path, [string]$What)
    $partial = "$Path.part"
    try {
        Invoke-WebRequest -Uri $Uri -OutFile $partial -TimeoutSec 900 -UseBasicParsing
        if (-not (Test-Path $partial) -or (Get-Item $partial).Length -eq 0) {
            throw "the download produced no data"
        }
        Move-Item -Path $partial -Destination $Path -Force
    } catch {
        Remove-Item $partial -Force -ErrorAction SilentlyContinue
        throw "Could not download $What from $Uri — $($_.Exception.Message)"
    }
}

function Find-SherpaExe {
    param([string]$Root)
    if (-not (Test-Path $Root)) { return $null }
    Get-ChildItem -Path $Root -Recurse -Filter 'sherpa-onnx-offline.exe' -File -ErrorAction SilentlyContinue |
        Select-Object -First 1
}

if (-not $Destination) {
    if (-not $env:LOCALAPPDATA) {
        throw "LOCALAPPDATA is not set; pass -Destination explicitly."
    }
    $Destination = Join-Path $env:LOCALAPPDATA 'SignalConnector\sherpa'
}

$existingExe = Find-SherpaExe -Root $Destination
$existingModel = Join-Path $Destination $ModelName
if ($existingExe -and (Test-Path (Join-Path $existingModel 'tokens.txt'))) {
    Write-Host "sherpa-onnx already installed: $($existingExe.FullName)" -ForegroundColor Green
    Write-Output "sherpaPath = '$($existingExe.FullName)'"
    Write-Output "sherpaModelDir = '$existingModel'"
    exit 0
}

Write-Host "Fetching the latest sherpa-onnx Windows release..."
try {
    $release = Invoke-RestMethod `
        -Uri 'https://api.github.com/repos/k2-fsa/sherpa-onnx/releases/latest' `
        -Headers @{ 'User-Agent' = 'SignalConnector' } `
        -UseBasicParsing
} catch {
    throw "Cannot read the sherpa-onnx release feed (no network, or GitHub refused): $($_.Exception.Message)"
}
$asset = $release.assets | Where-Object { $_.name -match 'win-x64-shared-MT-Release-no-tts\.tar\.bz2$' } | Select-Object -First 1
if (-not $asset) {
    $asset = $release.assets | Where-Object { $_.name -match 'win-x64-shared-MD-Release-no-tts\.tar\.bz2$' } | Select-Object -First 1
}
if (-not $asset) {
    throw "No Windows x64 no-tts archive found in sherpa-onnx $($release.tag_name)."
}

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$bin = Join-Path $env:TEMP ("signalconnector-sherpa-" + [guid]::NewGuid().ToString('N') + ".tar.bz2")
$model = Join-Path $env:TEMP ("signalconnector-moonshine-" + [guid]::NewGuid().ToString('N') + ".tar.bz2")
try {
    Write-Host "Downloading sherpa-onnx $($release.tag_name) ($($asset.name))..."
    Invoke-Download -Uri $asset.browser_download_url -Path $bin -What "sherpa-onnx $($asset.name)"
    Write-Host "Downloading the Ukrainian Moonshine model..."
    Invoke-Download -Uri $ModelUri -Path $model -What "the Ukrainian Moonshine model"
    Write-Host "Extracting..."
    & tar -xjf $bin -C $Destination
    if ($LASTEXITCODE -ne 0) { throw "Could not extract $($asset.name)." }
    & tar -xjf $model -C $Destination
    if ($LASTEXITCODE -ne 0) { throw "Could not extract the Moonshine model." }
} finally {
    Remove-Item $bin, $model -Force -ErrorAction SilentlyContinue
}

$exe = Find-SherpaExe -Root $Destination
if (-not $exe) {
    throw "sherpa-onnx was extracted to $Destination but bin\sherpa-onnx-offline.exe was not found."
}
$modelDir = Join-Path $Destination $ModelName
if (-not (Test-Path (Join-Path $modelDir 'tokens.txt'))) {
    throw "The Moonshine model is missing from $modelDir."
}

Write-Host "Installed sherpa-onnx $($release.tag_name) with the Ukrainian Moonshine model." -ForegroundColor Green
Write-Host "Paste these two lines inside the existing [voice] table in %APPDATA%\SignalConnector\config.toml"
Write-Output "sherpaPath = '$($exe.FullName)'"
Write-Output "sherpaModelDir = '$modelDir'"
