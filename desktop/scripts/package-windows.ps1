<#
.SYNOPSIS
  Package a stamped Flutter Windows Release bundle in the per-user install shape.

.DESCRIPTION
  The zip contains Harness.exe, Harness.ico, current, and the complete
  app\<version>\ bundle. Only the first-frame .started marker is omitted from
  the owned staging copy; the source bundle is never changed.
#>
param(
  [Parameter(Mandatory = $true)][string]$Version,
  [Parameter(Mandatory = $true)][ValidateSet('x64', 'arm64')][string]$Arch,
  [Parameter(Mandatory = $true)][string]$Launcher,
  [string]$Bundle = '',
  [string]$OutDir = ''
)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$desktop = Split-Path -Parent $PSScriptRoot
if (-not $Bundle) { $Bundle = Join-Path $desktop "build\windows\$Arch\runner\Release" }
if (-not $OutDir) { $OutDir = Join-Path $desktop 'build\windows-zip' }
if ($Version -notmatch '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$') {
  throw "Version '$Version' is not X.Y.Z[-prerelease]"
}
$app = Join-Path $Bundle 'harness-desktop.exe'
$dll = Join-Path $Bundle 'harness_pipe_io.dll'
$icon = Join-Path $desktop 'windows\runner\resources\app_icon.ico'
foreach ($required in @($app, $dll, $Launcher, $icon)) {
  if (-not (Test-Path -LiteralPath $required -PathType Leaf)) { throw "required package file is missing: $required" }
}
$stamped = ((Get-Item -LiteralPath $app).VersionInfo.ProductVersion -split '\+')[0]
if ($stamped -ne $Version) {
  throw "harness-desktop.exe says it is '$stamped', not ${Version}: build with --build-name $Version"
}

New-Item -ItemType Directory -Force -Path $OutDir | Out-Null
$name = "harness-desktop-$Version-windows-$Arch"
$stage = Join-Path $OutDir (".harness-package-" + [guid]::NewGuid().ToString('N'))
$zip = Join-Path $OutDir "$name.zip"
$appStage = Join-Path $stage "app\$Version"
try {
  New-Item -ItemType Directory -Force -Path $appStage | Out-Null
  Get-ChildItem -LiteralPath $Bundle -Force | Copy-Item -Destination $appStage -Recurse -Force
  $marker = Join-Path $appStage '.started'
  if (Test-Path -LiteralPath $marker) { Remove-Item -LiteralPath $marker -Force }
  foreach ($required in @('harness-desktop.exe', 'harness_pipe_io.dll')) {
    if (-not (Test-Path -LiteralPath (Join-Path $appStage $required) -PathType Leaf)) {
      throw "staged app is missing $required"
    }
  }
  Copy-Item -LiteralPath $Launcher -Destination (Join-Path $stage 'Harness.exe')
  Copy-Item -LiteralPath $icon -Destination (Join-Path $stage 'Harness.ico')
  [System.IO.File]::WriteAllText((Join-Path $stage 'current'), "$Version`r`n", (New-Object System.Text.UTF8Encoding($false)))

  Add-Type -AssemblyName System.IO.Compression
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  $root = (Resolve-Path -LiteralPath $stage).Path.TrimEnd([char[]]@('\', '/')) + '\'
  $archive = [System.IO.Compression.ZipFile]::Open($zip, [System.IO.Compression.ZipArchiveMode]::Create)
  try {
    foreach ($file in Get-ChildItem -LiteralPath $stage -Recurse -File -Force) {
      $entry = $file.FullName.Substring($root.Length).Replace('\', '/')
      [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
        $archive, $file.FullName, $entry, [System.IO.Compression.CompressionLevel]::Optimal
      ) | Out-Null
    }
  } finally {
    $archive.Dispose()
  }
  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Output "$zip $hash $((Get-Item -LiteralPath $zip).Length)"
} catch {
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  throw
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
