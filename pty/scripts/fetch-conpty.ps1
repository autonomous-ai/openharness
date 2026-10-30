<#
.SYNOPSIS
  Fetches the ConPTY payload the Harness PTY host runs with on Windows.

.DESCRIPTION
  The host loads conpty.dll from its own folder (or PATH) when it is there, and that conpty.dll starts the pane's
  console in OpenConsole.exe instead of the inbox conhost.exe: the Windows Terminal project's newer console, with its
  fixes, on every Windows 10 1809+ (tui/vendor/alacritty_terminal/src/tty/windows/conpty.rs). Both come from
  Microsoft's Microsoft.Windows.Console.ConPTY NuGet package (MIT, https://github.com/microsoft/terminal).

  This downloads the pinned version, refuses it unless its SHA-256 is the one recorded here, and extracts conpty.dll
  and OpenConsole.exe for x64 and arm64 into pty/vendor/conpty/<arch>/. The binaries are fetched, never committed
  (.gitignore). cli/build-bundle.mjs copies the build's architecture beside harness-pty.exe in dist/pty/.

  To move to a newer version: pick it from
  https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/index.json (a release, not a -preview),
  download its .nupkg once, check that the layout below still holds, and record its version and SHA-256 here.

.EXAMPLE
  pwsh pty/scripts/fetch-conpty.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File pty\scripts\fetch-conpty.ps1   # Windows PowerShell 5.1
#>
[CmdletBinding()]
param(
  # Where the <arch> folders go: pty/vendor/conpty by default.
  [string]$Destination = '',
  # Fetch again even when the recorded version is already there.
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# Windows PowerShell 5.1 has no $PSScriptRoot yet while it binds the parameters.
if (-not $Destination) { $Destination = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) '..\vendor\conpty' }

# Microsoft.Windows.Console.ConPTY 1.25.260930003, the newest release on 2026-10-15.
$Version = '1.25.260930003'
$Sha256 = '02b07b349af66d801159bdf9e440d4a1ce78bb951f37fc8609731665afdae7ee'
$Url = "https://api.nuget.org/v3-flatcontainer/microsoft.windows.console.conpty/$Version/microsoft.windows.console.conpty.$Version.nupkg"
# The package's layout (checked for this version): conpty.dll under runtimes/, OpenConsole.exe under build/native/.
$Files = [ordered]@{
  'x64'   = @('runtimes/win-x64/native/conpty.dll', 'build/native/runtimes/x64/OpenConsole.exe')
  'arm64' = @('runtimes/win-arm64/native/conpty.dll', 'build/native/runtimes/arm64/OpenConsole.exe')
}
$Stamp = "Microsoft.Windows.Console.ConPTY $Version sha256:$Sha256"

New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$Destination = (Resolve-Path $Destination).Path
$stampFile = Join-Path $Destination 'VERSION'
$complete = (Test-Path $stampFile) -and ((Get-Content -Raw $stampFile).Trim() -eq $Stamp)
foreach ($arch in $Files.Keys) {
  foreach ($name in $Files[$arch]) {
    if (-not (Test-Path (Join-Path (Join-Path $Destination $arch) ($name -split '/')[-1]))) { $complete = $false }
  }
}
if ($complete -and -not $Force) {
  Write-Host "ConPTY payload $Version is already in $Destination"
  return
}

$work = Join-Path ([IO.Path]::GetTempPath()) ("harness-conpty-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $work | Out-Null
try {
  $package = Join-Path $work 'conpty.nupkg'
  Write-Host "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $package -UseBasicParsing
  $actual = (Get-FileHash -Algorithm SHA256 -Path $package).Hash.ToLowerInvariant()
  if ($actual -ne $Sha256) {
    throw "Microsoft.Windows.Console.ConPTY $Version has SHA-256 $actual, not the recorded $Sha256; nothing was extracted."
  }

  Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
  $zip = [IO.Compression.ZipFile]::OpenRead($package)
  try {
    foreach ($arch in $Files.Keys) {
      $target = Join-Path $Destination $arch
      New-Item -ItemType Directory -Force -Path $target | Out-Null
      foreach ($name in $Files[$arch]) {
        $entry = $zip.GetEntry($name)
        if (-not $entry) { throw "Microsoft.Windows.Console.ConPTY $Version has no $name; its layout changed." }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (Join-Path $target $entry.Name), $true)
        Write-Host "  $arch\$($entry.Name)"
      }
    }
  } finally {
    $zip.Dispose()
  }
  Set-Content -Path $stampFile -Value $Stamp -Encoding ascii
  Write-Host "ConPTY payload $Version is in $Destination"
} finally {
  Remove-Item -Recurse -Force -Path $work -ErrorAction SilentlyContinue
}
