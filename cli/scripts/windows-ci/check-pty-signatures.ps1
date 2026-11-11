# Before a terminal host is promoted to production (release.yml pty-signatures, then promote-pty-payload.sh): read the
# staging pty manifest, fetch the zip it names for each architecture, check its size and SHA-256, unpack it, and check
# every file's Authenticode signature with Windows' own check, the one Smart App Control applies. The check is
# install.ps1's (Get-HarnessPtySignatureProblems), loaded from it, so a release refuses exactly what an install would.
#
# From 2026-11-04 to 11-09 production named an unsigned host: on a computer with Smart App Control on, harness-launch.exe
# was blocked, and Harness could neither start nor update itself there.
#
# Prints, and writes to GITHUB_OUTPUT as signed_zips when it is set, the zips it found signed: `<key>=<sha256>` for each,
# space-separated. promote-pty-payload.sh promotes only zips named there (PTY_SIGNED_ZIPS). Exits 1 naming each problem.
#   powershell -NoProfile -ExecutionPolicy Bypass -File cli\scripts\windows-ci\check-pty-signatures.ps1 -Version 0.5.80
param(
  [Parameter(Mandatory)][string]$Version,
  [string]$ManifestUrl = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/staging/pty/metadata.json'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$env:HARNESS_INSTALL_LIBRARY = '1'
. (Join-Path $PSScriptRoot '..\install.ps1')

$tar = Test-HarnessHost
# Not $manifest: install.ps1's [string]$Manifest parameter, dot-sourced above, would turn the document into a string.
$document = Get-HarnessJson $ManifestUrl
$work = Join-Path ([IO.Path]::GetTempPath()) "harness-pty-signatures-$PID"
$problems = @()
$signed = @()
try {
  foreach ($key in @('win32-x64', 'win32-arm64')) {
    $entry = Get-HarnessProperty (Get-HarnessProperty $document 'pty') $key
    if (-not $entry -or [string]$entry.version -ne $Version) {
      $problems += "${key}: the staging manifest names $(if ($entry) { [string]$entry.version } else { 'no host' }), not $Version"
      continue
    }
    $dir = Join-Path $work $key
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
    $zip = Join-Path $dir 'pty.zip'
    Save-HarnessVerified -Source ([string]$entry.url) -Destination $zip -Sha256 ([string]$entry.sha256) -Size $entry.size
    $unpacked = Join-Path $dir 'payload'
    Expand-HarnessZip -Tar $tar -Archive $zip -Destination $unpacked
    if (-not (Test-HarnessPtyFolder $unpacked)) { $problems += "${key}: the zip lacks one of $($HarnessPtyFiles -join ', ')"; continue }
    $found = @(Get-HarnessPtySignatureProblems $unpacked)
    if ($found.Count -gt 0) { $problems += @($found | ForEach-Object { "${key}: $_" }); continue }
    Write-Host "ok   $key $Version, every file signed: $([string]$entry.url)"
    $signed += "$key=$([string]$entry.sha256)"
  }
} finally {
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

if ($problems.Count -gt 0) {
  foreach ($problem in $problems) { Write-Host "::error::$problem" }
  Write-Host "The terminal host $Version is not promoted: $($problems.Count) problem(s) above."
  exit 1
}
$line = $signed -join ' '
Write-Host "PTY_SIGNED_ZIPS=$line"
# .NET's UTF-8 without a byte order mark: Windows PowerShell 5.1's Out-File -Encoding utf8 starts an empty file with one,
# and the runner would then read an output named "signed_zips" with the mark in front, leaving signed_zips empty and the promote refused.
if ($env:GITHUB_OUTPUT) { [IO.File]::AppendAllText($env:GITHUB_OUTPUT, "signed_zips=$line`n") }
if ($env:GITHUB_STEP_SUMMARY) { [IO.File]::AppendAllText($env:GITHUB_STEP_SUMMARY, "Terminal host ``$Version``: every file of both zips is signed (Windows' own check).`n") }
exit 0
