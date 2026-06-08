param(
    [switch]$ForceRedownload
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$FfmpegDir = Join-Path $ProjectRoot "Requirements\ffmpeg"
$FfmpegExe = Join-Path $FfmpegDir "bin\ffmpeg.exe"

if (-not $ForceRedownload -and (Test-Path -LiteralPath $FfmpegExe)) {
    Write-Host "ffmpeg already present at $FfmpegExe — skipping download"
    exit 0
}

$TempZip = Join-Path ([System.IO.Path]::GetTempPath()) "ffmpeg-tauri-build.zip"
$TempExtract = Join-Path ([System.IO.Path]::GetTempPath()) "ffmpeg-tauri-extract"

$DownloadUrl = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip"

Write-Host "Downloading ffmpeg from $DownloadUrl ..."
try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $TempZip -UseBasicParsing
} catch {
    Write-Error "Failed to download ffmpeg: $_"
    exit 1
}

Write-Host "Extracting ffmpeg ..."
if (Test-Path -LiteralPath $TempExtract) {
    Remove-Item -LiteralPath $TempExtract -Recurse -Force
}
Expand-Archive -LiteralPath $TempZip -DestinationPath $TempExtract -Force

$ExtractedDir = Get-ChildItem -LiteralPath $TempExtract -Directory | Select-Object -First 1
if (-not $ExtractedDir) {
    Write-Error "Unexpected archive structure — no root directory found after extraction"
    exit 1
}

Write-Host "Installing ffmpeg to $FfmpegDir ..."
if (Test-Path -LiteralPath $FfmpegDir) {
    Remove-Item -LiteralPath $FfmpegDir -Recurse -Force
}
Copy-Item -LiteralPath $ExtractedDir.FullName -Destination $FfmpegDir -Recurse

Write-Host "Cleaning up temporary files ..."
Remove-Item -LiteralPath $TempZip -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $TempExtract -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "ffmpeg successfully installed at $FfmpegExe"
exit 0
