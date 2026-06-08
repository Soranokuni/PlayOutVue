param(
    [switch]$ForceRedownload
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VcredistDir = Join-Path $ProjectRoot "Requirements\vcredist"
$VcredistExe = Join-Path $VcredistDir "VC_redist.x64.exe"

if (-not $ForceRedownload -and (Test-Path -LiteralPath $VcredistExe)) {
    Write-Host "VC++ Redist already present at $VcredistExe — skipping download"
    exit 0
}

$DownloadUrl = "https://aka.ms/vs/17/release/vc_redist.x64.exe"

Write-Host "Downloading VC++ Redistributable from $DownloadUrl ..."
try {
    if (-not (Test-Path -LiteralPath $VcredistDir)) {
        New-Item -ItemType Directory -Path $VcredistDir -Force | Out-Null
    }
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $VcredistExe -UseBasicParsing
} catch {
    Write-Error "Failed to download VC++ Redist: $_"
    exit 1
}

Write-Host "VC++ Redistributable successfully downloaded to $VcredistExe"
exit 0
