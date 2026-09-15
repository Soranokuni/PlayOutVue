param(
    [switch]$ForceRedownload,
    # Optional SHA-256 pin. When set (or when $env:VCREDIST_SHA256 is set) the
    # downloaded/cached file must match exactly.
    [string]$ExpectedSha256 = $env:VCREDIST_SHA256
)

# Audit T1-14: the previous script downloaded an unpinned executable over a
# moving alias with no verification, and skipped entirely if *any* bytes were
# already present. The redistributable is shipped inside the installer and run
# post-install, so it must be a genuine Microsoft-signed binary.

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot
$VcredistDir = Join-Path $ProjectRoot "Requirements\vcredist"
$VcredistExe = Join-Path $VcredistDir "VC_redist.x64.exe"
$DownloadUrl = "https://aka.ms/vs/17/release/vc_redist.x64.exe"

function Assert-GenuineRedist {
    param([string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        throw "VC++ Redistributable not found at $Path"
    }
    $item = Get-Item -LiteralPath $Path
    if ($item.Length -lt 10MB) {
        throw "VC++ Redistributable at $Path is suspiciously small ($($item.Length) bytes)"
    }

    $sig = Get-AuthenticodeSignature -FilePath $Path
    if ($sig.Status -ne 'Valid') {
        throw "VC++ Redistributable at $Path has an invalid Authenticode signature: $($sig.Status) $($sig.StatusMessage)"
    }
    $subject = $sig.SignerCertificate.Subject
    if ($subject -notmatch 'O=Microsoft Corporation') {
        throw "VC++ Redistributable at $Path is not signed by Microsoft Corporation (signer: $subject)"
    }

    if ($ExpectedSha256) {
        $actual = (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($actual -ne $ExpectedSha256.ToLowerInvariant()) {
            throw "VC++ Redistributable SHA-256 mismatch. expected=$ExpectedSha256 actual=$actual"
        }
    }

    Write-Host "Verified VC++ Redistributable: signer '$subject', $([math]::Round($item.Length / 1MB, 1)) MB"
}

if (-not $ForceRedownload -and (Test-Path -LiteralPath $VcredistExe)) {
    try {
        Assert-GenuineRedist -Path $VcredistExe
        Write-Host "VC++ Redist already present and verified at $VcredistExe - skipping download"
        exit 0
    } catch {
        Write-Warning "Cached redistributable failed verification ($_). Re-downloading."
        Remove-Item -LiteralPath $VcredistExe -Force
    }
}

Write-Host "Downloading VC++ Redistributable from $DownloadUrl ..."
try {
    if (-not (Test-Path -LiteralPath $VcredistDir)) {
        New-Item -ItemType Directory -Path $VcredistDir -Force | Out-Null
    }
    $tmp = "$VcredistExe.download"
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $tmp -UseBasicParsing
    Move-Item -LiteralPath $tmp -Destination $VcredistExe -Force
} catch {
    Write-Error "Failed to download VC++ Redist: $_"
    exit 1
}

try {
    Assert-GenuineRedist -Path $VcredistExe
} catch {
    Remove-Item -LiteralPath $VcredistExe -Force -ErrorAction SilentlyContinue
    Write-Error "Downloaded VC++ Redist failed verification and was deleted: $_"
    exit 1
}

Write-Host "VC++ Redistributable successfully downloaded and verified at $VcredistExe"
exit 0
