# Harness CLI installer for Windows, served from https://cdn.autonomous.ai/harness/cli/install.ps1.
# Source of truth: THIS file, cli/scripts/install.ps1. It is published by cli/scripts/upload-install-ps1.sh (staging
# by default; production is the owner's step) and tested by cli/src/scripts/installPs1.spec.ts. It is the Windows
# counterpart of install.sh, step for step.
#
#   irm https://cdn.autonomous.ai/harness/cli/install.ps1 | iex
#   iex "& { $(irm https://cdn.autonomous.ai/harness/cli/install.ps1) } -Desktop"
#   irm https://cdn.autonomous.ai/harness/desktop/install.ps1 | iex      (the desktop app: this file, app line on)
#   powershell -NoProfile -ExecutionPolicy Bypass -File install.ps1 -Manifest C:\build\install-manifest.json -NoService
#
# It installs per user, with no administrator rights. Everything goes under %USERPROFILE%\.harness, and PATH is the
# user's own (HKCU\Environment), never the machine's. The file is pure ASCII on purpose: Windows PowerShell 5.1
# reads a script file without a BOM in the ANSI code page, so one non-ASCII character would garble it.
param(
  [switch]$Desktop,
  [switch]$App,
  [string]$Manifest = $env:HARNESS_INSTALL_MANIFEST,
  [switch]$NoService
)

# The base under which the three published manifests live: cli/metadata.json, runtime/metadata.json and
# pty/metadata.json. upload-install-ps1.sh rewrites this one line for the staging copy.
$HarnessManifestBase = 'https://storage.googleapis.com/s3-autonomous-upgrade-3/harness/'
# What a run with no switch installs: the CLI here, and the app in the copy published as desktop/install.ps1.
# upload-install-ps1.sh --app rewrites this one line.
$HarnessInstallApp = $false
# Set when this runs as a file (-File, or a saved copy). It is empty under `irm | iex`.
$HarnessScriptPath = $MyInvocation.MyCommand.Path

$HarnessCliVersionPattern = '^\d+\.\d+\.\d+(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$'
$HarnessPtyVersionPattern = '^\d+(\.\d+)*$'
$HarnessPtyFiles = @('harness-pty.exe', 'harness-launch.exe', 'harness.exe', 'conpty.dll', 'OpenConsole.exe', 'harness-serial.exe')

function Get-HarnessPlatform {
  # The platform from the NATIVE architecture, read where Windows keeps it for the whole system. An x64
  # PowerShell emulated on an ARM64 computer reports AMD64 in its own environment, and would install the
  # emulated build.
  param([string]$Architecture)
  if (-not $Architecture) {
    $item = Get-ItemProperty -Path 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -Name PROCESSOR_ARCHITECTURE -ErrorAction SilentlyContinue
    if ($item) { $Architecture = [string]$item.PROCESSOR_ARCHITECTURE }
    if (-not $Architecture) { $Architecture = [string]$env:PROCESSOR_ARCHITECTURE }
  }
  switch ($Architecture.ToUpperInvariant()) {
    'AMD64' { return 'win32-x64' }
    'ARM64' { return 'win32-arm64' }
    default { throw "This computer's processor ($Architecture) is not supported: Harness runs on 64-bit Windows, x64 or ARM64." }
  }
}

function Test-HarnessHost {
  # ConPTY, which the terminal host needs, arrived in Windows 10 1809 (build 17763). tar.exe, which unpacks the
  # downloads, has shipped in System32 since 1803. The path is fixed so a GNU tar on PATH is never used: it
  # cannot read a zip.
  param([int]$Build = [Environment]::OSVersion.Version.Build, [string]$SystemRoot = $env:SystemRoot)
  if ($Build -lt 17763) { throw "Harness needs Windows 10 version 1809 or later, and this computer runs build $Build. Update Windows, then run the installer again." }
  $tar = Join-Path $SystemRoot 'System32\tar.exe'
  if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) { throw "Windows' own tar.exe is missing ($tar). It is part of Windows 10 1803 and later." }
  return $tar
}

function Test-HarnessUrl([string]$Value) { return $Value -match '^https://' }
function Test-HarnessScheme([string]$Value) { return $Value -match '^[A-Za-z][A-Za-z0-9+.-]*://' }

function Invoke-HarnessRetry {
  # Three tries for a network step, as install.sh's download() makes. A connection that drops in the middle
  # of a 30 MB runtime is common on Wi-Fi.
  param([scriptblock]$Action, [int]$Attempts = 3)
  for ($i = 1; ; $i++) {
    try { return & $Action } catch {
      if ($i -ge $Attempts) { throw }
      Write-Host "  Connection interrupted; retrying ($($i + 1)/$Attempts)..."
      Start-Sleep -Seconds 2
    }
  }
}

function Get-HarnessJson {
  param([string]$Source)
  if (Test-HarnessUrl $Source) {
    $response = Invoke-HarnessRetry { Invoke-WebRequest -Uri $Source -UseBasicParsing -TimeoutSec 60 -Headers @{ 'Cache-Control' = 'no-cache' } }
    $content = $response.Content
    if ($content -is [byte[]]) { $content = [Text.Encoding]::UTF8.GetString($content) }
    return $content | ConvertFrom-Json
  }
  if (Test-HarnessScheme $Source) { throw "Only https:// addresses are trusted, and $Source is not one." }
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "The manifest $Source does not exist." }
  return (Get-Content -LiteralPath $Source -Raw -Encoding UTF8) | ConvertFrom-Json
}

function Resolve-HarnessRef {
  # Where an entry's file is. A published manifest names https:// addresses only. A local manifest (a test, or a
  # build of this tree) may also name files beside it.
  param([string]$Ref, [string]$ManifestSource)
  if (Test-HarnessUrl $Ref) { return $Ref }
  if (Test-HarnessScheme $Ref) { throw "Only https:// addresses are trusted, and $Ref is not one." }
  if (Test-HarnessUrl $ManifestSource) { throw "The manifest $ManifestSource names $Ref, which is not an https:// address." }
  if ([IO.Path]::IsPathRooted($Ref)) { return $Ref }
  return Join-Path (Split-Path -Parent $ManifestSource) $Ref
}

function Get-HarnessProperty($Object, [string]$Name) {
  if ($null -eq $Object) { return $null }
  $property = $Object.PSObject.Properties[$Name]
  if ($property) { return $property.Value }
  return $null
}

function Get-HarnessManifests {
  # The three entries this computer needs, each with the document it came from: relative names in a local
  # manifest are resolved against that document. With -Manifest it is one document holding the cli, node and pty
  # keys. Otherwise it is the three published documents under $Base.
  param([string]$Manifest, [string]$Platform, [string]$Base = $HarnessManifestBase)
  if ($Manifest) {
    if (-not (Test-HarnessUrl $Manifest) -and -not (Test-HarnessScheme $Manifest)) {
      if (-not (Test-Path -LiteralPath $Manifest -PathType Leaf)) { throw "The manifest $Manifest does not exist." }
      $Manifest = (Resolve-Path -LiteralPath $Manifest).ProviderPath
    }
    $document = Get-HarnessJson $Manifest
    $sources = @{ cli = $Manifest; node = $Manifest; pty = $Manifest }
    $documents = @{ cli = $document; node = $document; pty = $document }
  } else {
    $sources = @{ cli = "${Base}cli/metadata.json"; node = "${Base}runtime/metadata.json"; pty = "${Base}pty/metadata.json" }
    $documents = @{}
    foreach ($name in 'cli', 'node', 'pty') { $documents[$name] = Get-HarnessJson $sources[$name] }
  }
  $cli = Get-HarnessProperty $documents.cli 'cli'
  $node = Get-HarnessProperty (Get-HarnessProperty $documents.node 'node') $Platform
  $pty = Get-HarnessProperty (Get-HarnessProperty $documents.pty 'pty') $Platform
  if (-not $cli) { throw "The CLI manifest ($($sources.cli)) has no 'cli' entry." }
  if (-not $node) { throw "The Node runtime manifest ($($sources.node)) has no '$Platform' entry: Harness is not published for this computer yet." }
  if (-not $pty) { throw "The terminal host manifest ($($sources.pty)) has no '$Platform' entry: Harness is not published for this computer yet." }
  return @{
    cli = @{ entry = $cli; source = $sources.cli }
    node = @{ entry = $node; source = $sources.node }
    pty = @{ entry = $pty; source = $sources.pty }
  }
}

function Get-HarnessSha256([string]$Path) {
  # A file's SHA-256 as lowercase hex, computed by .NET. Not Get-FileHash: in Windows PowerShell 5.1 that is a script
  # function which module autoload has to find, and a PSModulePath handed on by PowerShell 7 (a pwsh 7 window, CI)
  # makes autoload load 7's Microsoft.PowerShell.Utility instead, where it does not exist: "The term 'Get-FileHash'
  # is not recognized" (CI run 38826134075). Every other command here is a compiled cmdlet 5.1 has from the start.
  $stream = [IO.File]::OpenRead((Get-Item -LiteralPath $Path).FullName)
  try {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
  } finally { $stream.Dispose() }
}

function Save-HarnessVerified {
  # Download (or copy, for a local manifest), then keep the file only if its size and SHA-256 are the manifest's.
  # The manifest is the trust: the downloaded bytes are not, until they match it.
  param([string]$Source, [string]$Destination, [string]$Sha256, $Size)
  if ($Sha256 -notmatch '^[0-9a-fA-F]{64}$') { throw "The manifest gives no valid SHA-256 for $Source." }
  try {
    if (Test-HarnessUrl $Source) {
      Invoke-HarnessRetry { Invoke-WebRequest -Uri $Source -OutFile $Destination -UseBasicParsing -TimeoutSec 600 } | Out-Null
    } elseif (Test-HarnessScheme $Source) {
      throw "Only https:// addresses are trusted, and $Source is not one."
    } else {
      Copy-Item -LiteralPath $Source -Destination $Destination -Force
    }
    $length = (Get-Item -LiteralPath $Destination).Length
    if ($null -ne $Size -and "$Size" -ne '' -and [int64]$Size -ne $length) {
      throw "$Source is $length bytes, but the manifest says ${Size}: the download is incomplete, or is not the published file."
    }
    $got = Get-HarnessSha256 $Destination
    if ($got -ne $Sha256.ToLowerInvariant()) { throw "$Source failed its checksum (expected $Sha256, got $got): it is not the published file." }
  } catch {
    Remove-Item -LiteralPath $Destination -Force -ErrorAction SilentlyContinue
    throw
  }
}

function Expand-HarnessZip {
  # Unpack the archive into the destination; the archive is moved there first and removed afterwards. tar.exe reads
  # its arguments in the ANSI code page, so a profile path with a letter outside it (a CJK name on a Western
  # Windows) reached it as '?' and the archive could not be opened (seen on the VM, 2026-10-16). It therefore runs
  # inside the destination, on an ASCII relative name: a native command's working directory is PowerShell's current
  # location, and is handed over in Unicode.
  param([string]$Tar, [string]$Archive, [string]$Destination)
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  $name = ".harness-archive-$PID.zip"
  $local = Join-Path $Destination $name
  Move-Item -LiteralPath $Archive -Destination $local
  Push-Location -LiteralPath $Destination
  try {
    & $Tar -xf $name
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
    Remove-Item -LiteralPath $local -Force -ErrorAction SilentlyContinue
  }
  if ($code -ne 0) { throw "Could not unpack $Archive (tar.exe exit code $code)." }
}

function New-HarnessStaging {
  # The name the CLI's own sweep recognizes (.<name>-staging-<pid>-<time>, runtimeInstall.ts sweepStaging).
  # A folder left by an installer that was stopped is removed by the next daemon start.
  param([string]$Parent, [string]$Name)
  $dir = Join-Path $Parent ".$Name-staging-$PID-$([DateTime]::UtcNow.Ticks)"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  return $dir
}

function Move-HarnessFile {
  # Rename over the destination, retried. An antivirus scan or the search indexer can hold a new file for a
  # moment, and a harness-launch.exe that is still exiting holds its own. The backup name is [NullString]::Value:
  # Windows PowerShell 5.1 passes a plain $null to a .NET string as "", which Replace rejects ("The path is not
  # of a legal form"), so every pointer that already existed failed to update (seen on the VM, 2026-10-16).
  param([string]$Source, [string]$Destination)
  for ($i = 1; ; $i++) {
    try {
      if ([IO.File]::Exists($Destination)) { [IO.File]::Replace($Source, $Destination, [NullString]::Value) } else { [IO.File]::Move($Source, $Destination) }
      return
    } catch {
      if ($i -ge 5) { Remove-Item -LiteralPath $Source -Force -ErrorAction SilentlyContinue; throw }
      Start-Sleep -Milliseconds (50 * $i)
    }
  }
}

function Test-HarnessSameFile([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Destination -PathType Leaf)) { return $false }
  if ((Get-Item -LiteralPath $Source).Length -ne (Get-Item -LiteralPath $Destination).Length) { return $false }
  return (Get-HarnessSha256 $Source) -eq (Get-HarnessSha256 $Destination)
}

function Copy-HarnessFile {
  # Copy through a temporary file and a rename, and only when the bytes differ: a file that is already right is left
  # alone. A program that is running (a `harness` someone left open) can be renamed but not deleted. Replace then
  # renames it to <name>~RF<hex>.TMP itself and succeeds (seen on the VM, 2026-10-16); should it fail instead, the
  # program is moved aside to .<name>.old-<pid>-<time>. Remove-HarnessAside deletes either once it has exited.
  param([string]$Source, [string]$Destination)
  if (Test-HarnessSameFile $Source $Destination) { return }
  $temp = "$Destination.tmp-$PID"
  Copy-Item -LiteralPath $Source -Destination $temp -Force
  try {
    Move-HarnessFile -Source $temp -Destination $Destination
  } catch {
    if (-not [IO.File]::Exists($Destination)) { throw }
    $aside = Join-Path (Split-Path -Parent $Destination) (".{0}.old-{1}-{2}" -f (Split-Path -Leaf $Destination), $PID, [DateTime]::UtcNow.Ticks)
    [IO.File]::Move($Destination, $aside)
    Copy-Item -LiteralPath $Source -Destination $temp -Force
    Move-HarnessFile -Source $temp -Destination $Destination
  }
}

function Remove-HarnessAside([string]$Dir) {
  # The programs Copy-HarnessFile moved aside. One that still runs cannot be deleted yet, and waits for the next run.
  foreach ($pattern in '.*.old-*', '*~RF*.TMP') {
    Get-ChildItem -LiteralPath $Dir -Filter $pattern -Force -ErrorAction SilentlyContinue | Remove-Item -Force -ErrorAction SilentlyContinue
  }
}

function Write-HarnessPointer {
  # One line and CRLF, UTF-8 with no BOM, through a rename (installLayout.ts writePointer). The Rust reader
  # (pty/src/launcher.rs, which harness.exe and harness-launch.exe use) would keep a BOM as part of the value.
  param([string]$Path, [string]$Value)
  $temp = "$Path.tmp-$PID"
  [IO.File]::WriteAllText($temp, "$Value`r`n", (New-Object Text.UTF8Encoding $false))
  Move-HarnessFile -Source $temp -Destination $Path
}

function Add-HarnessUserPath {
  # Add the folder to the user's PATH in HKCU\Environment once. The value keeps its kind (REG_EXPAND_SZ, normally)
  # and every entry already in it. An entry is compared expanded, case-insensitively and without a trailing
  # backslash, so %USERPROFILE%\.harness\bin counts as the same folder. With no -SubKey it is Environment, or
  # HARNESS_INSTALL_ENV_KEY when that is set: a test that forgets -SubKey still never writes the real PATH.
  param([string]$Directory, [string]$SubKey)
  if (-not $SubKey) { $SubKey = if ($env:HARNESS_INSTALL_ENV_KEY) { $env:HARNESS_INSTALL_ENV_KEY } else { 'Environment' } }
  $key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($SubKey)
  try {
    $current = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = [Microsoft.Win32.RegistryValueKind]::ExpandString
    if ($current -ne '') { try { $kind = $key.GetValueKind('Path') } catch { } }
    $entries = @($current -split ';' | Where-Object { $_ -ne '' })
    $wanted = $Directory.TrimEnd('\')
    foreach ($entry in $entries) {
      if ([Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\') -ieq $wanted) { return $false }
    }
    $key.SetValue('Path', ((@($entries) + $wanted) -join ';'), $kind)
    return $true
  } finally { $key.Close() }
}

function Send-HarnessEnvironmentChange {
  # Tell Explorer, and through it every terminal started from now on, that the user's PATH changed. Add-Type
  # compiles a little C#, which Constrained Language Mode (some managed computers) forbids. That only means a
  # new terminal must be opened from a fresh Explorer, so it is a note and not a failure.
  try {
    if (-not ('Harness.NativeMethods' -as [type])) {
      Add-Type -Namespace Harness -Name NativeMethods -MemberDefinition @'
[DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
'@
    }
    $result = [UIntPtr]::Zero
    [void][Harness.NativeMethods]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
  } catch {
    Write-Host '  (Could not announce the PATH change; terminals opened after you sign in again will see it.)'
  }
}

# --- Install ---

function Test-HarnessPtyFolder([string]$Dir) {
  foreach ($name in $HarnessPtyFiles) { if (-not (Test-Path -LiteralPath (Join-Path $Dir $name) -PathType Leaf)) { return $false } }
  return $true
}

function Install-HarnessNode {
  # runtime\node-<version>-<platform>\node.exe, from nodejs.org's own zip (node-<version>-win-<arch>\node.exe).
  # current-node is written last, and only once node.exe has answered. The CLI, the desktop app and harness.exe
  # all execute what it names.
  param([string]$Root, $Entry, [string]$Source, [string]$Tar, [string]$Platform)
  $version = [string]$Entry.version
  if ($version -notmatch '^v\d+\.\d+\.\d+$') { throw "The Node runtime manifest names an unexpected version '$version'." }
  $archiveRoot = [string]$Entry.archiveRoot
  if ($archiveRoot -notmatch '^node-v\d+\.\d+\.\d+-win-(x64|arm64)$') { throw "The Node runtime manifest names an unexpected archive folder '$archiveRoot'." }
  $runtime = Join-Path $Root 'runtime'
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  $target = Join-Path $runtime "node-$version-$Platform"
  $node = Join-Path $target 'node.exe'
  if (-not (Test-Path -LiteralPath $node -PathType Leaf)) {
    Write-Host "  Downloading Node $version ($Platform)..."
    $staging = New-HarnessStaging $runtime 'node'
    try {
      $archive = Join-Path $staging 'node.zip'
      Save-HarnessVerified -Source (Resolve-HarnessRef ([string]$Entry.url) $Source) -Destination $archive -Sha256 ([string]$Entry.sha256) -Size $Entry.size
      Expand-HarnessZip -Tar $Tar -Archive $archive -Destination $staging
      $unpacked = Join-Path $staging $archiveRoot
      if (-not (Test-Path -LiteralPath (Join-Path $unpacked 'node.exe') -PathType Leaf)) { throw "The Node archive has no $archiveRoot\node.exe." }
      # A folder without node.exe is what a stopped install leaves; nothing can be running from it.
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
      Move-Item -LiteralPath $unpacked -Destination $target
    } finally { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
  }
  $said = & $node --version
  if ($LASTEXITCODE -ne 0) { throw "The Node runtime at $node does not run on this computer." }
  Write-HarnessPointer -Path (Join-Path $runtime 'current-node') -Value $node
  Write-Host "  OK Node $said -> $target"
}

function Install-HarnessCli {
  # cli\<version>\cli.js, notify.mjs and package.json, written into staging and renamed into place, then
  # cli\current and the stable cli\notify.mjs. A version folder whose cli.js already has the manifest's digest
  # is kept: it is that version, and a running daemon may be using it.
  param([string]$Root, $Entry, [string]$Source)
  $version = [string]$Entry.version
  if ($version -notmatch $HarnessCliVersionPattern) { throw "The CLI manifest names an unexpected version '$version'." }
  foreach ($part in 'cli', 'notify') { if (-not (Get-HarnessProperty $Entry $part)) { throw "The CLI manifest has no '$part' file." } }
  $cliRoot = Join-Path $Root 'cli'
  New-Item -ItemType Directory -Force -Path $cliRoot | Out-Null
  $target = Join-Path $cliRoot $version
  $installed = Join-Path $target 'cli.js'
  $current = (Test-Path -LiteralPath $installed -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $target 'notify.mjs') -PathType Leaf) -and ((Get-HarnessSha256 $installed) -ieq [string]$Entry.cli.sha256)
  if (-not $current) {
    Write-Host "  Downloading Harness $version..."
    $staging = New-HarnessStaging $cliRoot 'cli'
    try {
      Save-HarnessVerified -Source (Resolve-HarnessRef ([string]$Entry.cli.url) $Source) -Destination (Join-Path $staging 'cli.js') -Sha256 ([string]$Entry.cli.sha256) -Size $Entry.cli.size
      Save-HarnessVerified -Source (Resolve-HarnessRef ([string]$Entry.notify.url) $Source) -Destination (Join-Path $staging 'notify.mjs') -Sha256 ([string]$Entry.notify.sha256) -Size $Entry.notify.size
      # The bundle is an ES module, and Node decides that from the nearest package.json. install.sh writes the same file.
      [IO.File]::WriteAllText((Join-Path $staging 'package.json'), "{""type"":""module""}`n", (New-Object Text.UTF8Encoding $false))
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
      Move-Item -LiteralPath $staging -Destination $target
    } finally { if (Test-Path -LiteralPath $staging) { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue } }
  }
  Write-HarnessPointer -Path (Join-Path $cliRoot 'current') -Value $version
  Copy-HarnessFile -Source (Join-Path $target 'notify.mjs') -Destination (Join-Path $cliRoot 'notify.mjs')
  Write-Host "  OK Harness $version -> $target"
  return $version
}

function Install-HarnessPty {
  # runtime\pty\<version>\ with the host, the launcher, the harness command, ConPTY and harness-serial (the dial's
  # port, sub-project E), then current-pty and
  # bin\harness-launch.exe. A complete version folder is never replaced: a host may be running from it, and a running
  # .exe cannot be overwritten on Windows (A's spec, host upgrade). It returns the version folder.
  param([string]$Root, $Entry, [string]$Source, [string]$Tar)
  $version = [string]$Entry.version
  if ($version -notmatch $HarnessPtyVersionPattern) { throw "The terminal host manifest names an unexpected version '$version'." }
  $ptyRoot = Join-Path $Root 'runtime\pty'
  New-Item -ItemType Directory -Force -Path $ptyRoot | Out-Null
  $target = Join-Path $ptyRoot $version
  if (-not (Test-HarnessPtyFolder $target)) {
    Write-Host "  Downloading the terminal host $version..."
    $staging = New-HarnessStaging $ptyRoot 'pty'
    try {
      $archive = Join-Path $staging 'pty.zip'
      Save-HarnessVerified -Source (Resolve-HarnessRef ([string]$Entry.url) $Source) -Destination $archive -Sha256 ([string]$Entry.sha256) -Size $Entry.size
      $unpacked = Join-Path $staging 'payload'
      Expand-HarnessZip -Tar $Tar -Archive $archive -Destination $unpacked
      if (-not (Test-HarnessPtyFolder $unpacked)) { throw "The terminal host archive lacks one of $($HarnessPtyFiles -join ', ')." }
      if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
      Move-Item -LiteralPath $unpacked -Destination $target
    } finally { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction SilentlyContinue }
  }
  $pointer = Join-Path $ptyRoot 'current-pty'
  $before = ''
  if (Test-Path -LiteralPath $pointer -PathType Leaf) { $before = ([string](Get-Content -LiteralPath $pointer -TotalCount 1)).Trim() }
  Write-HarnessPointer -Path $pointer -Value $version
  # An explicit install supersedes a host the updater put on probation: left, its marker would let the next probation
  # roll this install back to the version before it (pty-pending.json, cli/src/lib/windows/ptyInstall.ts).
  if ($before -ne $version) { Remove-Item -LiteralPath (Join-Path $ptyRoot 'pty-pending.json') -Force -ErrorAction SilentlyContinue }
  $bin = Join-Path $Root 'bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  Copy-HarnessFile -Source (Join-Path $target 'harness-launch.exe') -Destination (Join-Path $bin 'harness-launch.exe')
  Write-Host "  OK terminal host $version -> $target"
  return $target
}

function Install-HarnessCommand {
  # bin\harness.exe, the `harness` command (pty/src/command.rs), from the terminal host's version folder. It holds
  # no path itself: it finds the install from its own folder and reads the two pointers the installer and the
  # updater keep, so Node and the CLI can move on without it. It is a program and not a batch file, so cmd never
  # parses the arguments a second time. A harness.cmd that an earlier install wrote goes: it re-parsed them.
  param([string]$Root, [string]$PtyFolder)
  $bin = Join-Path $Root 'bin'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  $command = Join-Path $bin 'harness.exe'
  Copy-HarnessFile -Source (Join-Path $PtyFolder 'harness.exe') -Destination $command
  $old = Join-Path $bin 'harness.cmd'
  if (Test-Path -LiteralPath $old) { Remove-Item -LiteralPath $old -Force }
  Remove-HarnessAside $bin
  return $command
}

function Add-HarnessPath {
  # The user's PATH for every new terminal, and this session's own PATH so `harness` works in this window now.
  # Under `irm | iex` that is the person's own session. HARNESS_INSTALL_ENV_KEY (tests only) moves the registry
  # write to a throwaway key and skips the broadcast.
  param([string]$Root)
  $bin = Join-Path $Root 'bin'
  $subKey = 'Environment'
  if ($env:HARNESS_INSTALL_ENV_KEY) { $subKey = $env:HARNESS_INSTALL_ENV_KEY }
  if (Add-HarnessUserPath -Directory $bin -SubKey $subKey) {
    if (-not $env:HARNESS_INSTALL_ENV_KEY) { Send-HarnessEnvironmentChange }
    Write-Host "  OK added $bin to your PATH"
  }
  if (-not (@($env:Path -split ';') | Where-Object { $_.TrimEnd('\') -ieq $bin })) { $env:Path = "$env:Path;$bin" }
}

function Register-HarnessService {
  # The task that starts Harness at sign-in and keeps it running (harness service install, sub-project B3). A
  # computer whose policy forbids user tasks still has a working Harness, so a failure here is a sentence and
  # not a failed install.
  param([string]$Command)
  $exit = 1
  $why = ''
  try {
    & $Command service install | ForEach-Object { Write-Host "  $_" }
    $exit = $LASTEXITCODE
  } catch { $why = $_.Exception.Message }
  # 5: the task is registered, and Task Scheduler did not start harnessd now, as over SSH
  # (serviceCommand.ts SERVICE_REGISTERED_NOT_RUNNING). It said "could not set itself to start" of a task it had just
  # registered (the Windows install job, B5.12). harness service install has said what happened and what to run; this
  # adds nothing to it (re-review N1).
  if ($exit -eq 5 -and -not $why) { return }
  if ($exit -ne 0) {
    if (-not $why) { $why = "harness service install exited $exit" }
    Write-Host "  Harness could not set itself to start when you sign in ($why)."
    Write-Host "  It still works: run 'harness start' to connect this computer."
    return
  }
  try { & $Command status | ForEach-Object { Write-Host "  $_" } } catch { }
}

function Test-HarnessReady {
  # Signed in, and the daemon running: then the closing guide has no setup steps to give (G8, a reinstall over a live
  # install said "1. sign in"). Anything it cannot read counts as not ready, and the steps are given.
  # The CLI's stderr (a sign-in refresh warning, say) is dropped, never part of the closing text. Continue here: with
  # Stop, Windows PowerShell 5.1 turns a native command's redirected stderr line into a terminating error.
  # The status row's glyph is optional: Windows PowerShell may read it in the console code page as other characters.
  param([string]$Command)
  if (-not $Command) { return $false }
  $ErrorActionPreference = 'Continue'
  try {
    $auth = (@(& $Command auth status --json 2>$null) -join "`n") | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $auth.loggedIn -ne $true) { return $false }
    $line = @(& $Command status 2>$null) | Where-Object { $_ -match '^\s*status\s' } | Select-Object -First 1
    return [bool]($LASTEXITCODE -eq 0 -and $line -match '^\s*status\s+(\S+\s+)?(running|started)\b')
  } catch { return $false }
}

function Write-HarnessDone {
  param([string]$Version, [switch]$Desktop, [switch]$NoService, [string]$Command)
  Write-Host ''
  if ($Desktop) { Write-Host "  harness $Version installed."; return }
  Write-Host "  OK harness $Version installed."
  Write-Host ''
  if (Test-HarnessReady -Command $Command) {
    Write-Host '  This computer is signed in and Harness is running: nothing more to set up.'
    Write-Host ''
    Write-Host '  Useful:'
    Write-Host '      harness status                 # is the daemon running, and which machine this is'
    Write-Host '      harness remote-password set    # let your OTHER machines reach this one, if you have not yet'
    Write-Host '      harness --help                 # everything else'
    Write-Host ''
    Write-Host '  harness works in this window now. Terminals that were already open see it once they are reopened.'
    return
  }
  Write-Host '  Set this computer up with three commands, in this order:'
  Write-Host ''
  Write-Host '      harness login                  # 1. sign in with your Autonomous account (opens a browser)'
  Write-Host '      harness start                  # 2. connect this computer as a machine (runs in the background)'
  Write-Host '      harness remote-password set    # 3. let your OTHER machines reach this one (asked once, kept)'
  Write-Host ''
  Write-Host '  Useful:'
  Write-Host '      harness status                 # is the daemon running, and which machine this is'
  Write-Host '      harness --help                 # everything else'
  Write-Host ''
  Write-Host '  harness works in this window now. Terminals that were already open see it once they are reopened.'
}

function Find-HarnessGit {
  # The git Store installs clone with, or '' when this computer has none. Windows does not come with one, and git
  # was missing on computers where every Store install failed at once (0 of 25 in three days, 2026-10-28). PATH
  # first, then where Git for Windows installs, for everyone or for this user alone, in case PATH is not updated yet.
  param(
    [string]$Path = $env:PATH,
    [string[]]$Roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $(if ($env:LOCALAPPDATA) { Join-Path $env:LOCALAPPDATA 'Programs' }))
  )
  foreach ($dir in ($Path -split ';')) {
    $git = Get-HarnessFileIn -Folder $dir -Name 'git.exe'
    if ($git) { return $git }
  }
  foreach ($root in $Roots) {
    $git = Get-HarnessFileIn -Folder $root -Name 'Git\cmd\git.exe'
    if ($git) { return $git }
  }
  return ''
}

function Get-HarnessFileIn {
  # [Folder]\[Name] when that file exists, else ''. Joined as text and tried on its own: PATH can name a drive that is
  # not there (an unplugged USB disk, an unmapped share), where Join-Path stops with 'Cannot find drive', or hold an
  # entry in quotes, which .NET calls illegal. Under the installer's errors-stop either one turned a finished install
  # into a failed one (review of #2025).
  param([string]$Folder, [string]$Name)
  if (-not $Folder) { return '' }
  try {
    $file = [IO.Path]::Combine($Folder, $Name)
    if (Test-Path -LiteralPath $file -PathType Leaf) { return $file }
  } catch { }
  return ''
}

function Write-HarnessGitNote {
  # Said, not done: installing Git for Windows is the person's choice, and this installer changes nothing outside
  # their own folder and PATH. Harness itself runs without git; the Store's harnesses do not.
  param([string]$Git = (Find-HarnessGit))
  if ($Git) { return }
  Write-Host ''
  Write-Host '  Git for Windows is not installed. Harnesses from the Store are installed with git, and run their setup in its Git Bash.' -ForegroundColor Yellow
  Write-Host '  Install it, then open a new window:'
  Write-Host ''
  Write-Host '      winget install --id Git.Git -e'
  Write-Host ''
  Write-Host '  or download it from https://git-scm.com/download/win'
}

function Read-HarnessCurrentCli {
  # The version cli\current names, or '' before a first install.
  param([string]$Root)
  $pointer = Join-Path $Root 'cli\current'
  if (-not (Test-Path -LiteralPath $pointer -PathType Leaf)) { return '' }
  return ([string](Get-Content -LiteralPath $pointer -TotalCount 1)).Trim()
}

function Read-HarnessCurrentPty {
  # The version runtime\pty\current-pty names, or '' before a first install. Read before the payload install moves
  # it, so Restart-HarnessDaemon can tell that only the terminal host changed.
  param([string]$Root)
  $pointer = Join-Path $Root 'runtime\pty\current-pty'
  if (-not (Test-Path -LiteralPath $pointer -PathType Leaf)) { return '' }
  return ([string](Get-Content -LiteralPath $pointer -TotalCount 1)).Trim()
}

function Restart-HarnessDaemon {
  # Run again over a live install, the installer moves the daemon to the new build. The master re-execs only before
  # a core starts, and nothing tells it that cli\current moved, so the daemon is restarted once: harness stop, then
  # harness start. Agents keep running: the terminal host is independent of the daemon, and the new core reattaches
  # them. It also restarts when only the terminal host moved: a daemon holds on to the host it started with, so a new
  # host is used only after a restart. Nothing happens when neither version changed, on a first install, or when no
  # daemon runs. An explicit install installs: pty-rejected.json is the updater's back-off and is not read here.
  param([string]$Command, [string]$Before, [string]$After, [string]$PtyBefore, [string]$PtyAfter)
  $cliMoved = $Before -and $Before -ne $After
  $ptyMoved = $PtyBefore -and $PtyBefore -ne $PtyAfter
  if (-not $cliMoved -and -not $ptyMoved) { return $false }
  $statusLine = @(& $Command status) | Where-Object { $_ -match '^\s*status\s' } | Select-Object -First 1
  if ($LASTEXITCODE -ne 0 -or -not $statusLine -or $statusLine -match 'stopped|out of reach') { return $false }
  if ($cliMoved) {
    Write-Host "  Moving the running Harness from $Before to $After (your agents keep running)..."
  } else {
    Write-Host "  Moving the running Harness to terminal host $PtyAfter (your agents keep running)..."
  }
  & $Command stop | ForEach-Object { Write-Host "  $_" }
  # A daemon that did not stop is still on the old build: nothing is started beside it, and no move is reported.
  if ($LASTEXITCODE -ne 0) {
    if ($cliMoved) {
      Write-Host "  Harness is still running version $Before; it moves to $After when it next restarts (harness stop, then harness start)."
    } else {
      Write-Host "  Harness is still running on terminal host $PtyBefore; it moves to $PtyAfter when it next restarts (harness stop, then harness start)."
    }
    return $false
  }
  # Not piped, and not left as the function's output (which a caller's `$null =` would capture through a pipe too):
  # the daemon `harness start` leaves running inherits the handles that command writes to, and a pipe read here would
  # not end until the daemon did (seen on the VM). Start-Process -NoNewWindow gives it this window's own, and waits
  # for that one process only. Reading Handle first keeps ExitCode readable once it has exited.
  $start = Start-Process -FilePath $Command -ArgumentList 'start' -NoNewWindow -PassThru
  $null = $start.Handle
  $start.WaitForExit()
  if ($start.ExitCode -ne 0) {
    if ($cliMoved) { Write-Host "  Harness did not start again on version ${After}. Run 'harness start'." }
    else { Write-Host "  Harness did not start again on terminal host ${PtyAfter}. Run 'harness start'." }
  }
  return $true
}

function Install-Harness {
  # install.sh's steps, in its order. Each step is named, so a failure says which one in a sentence a first-time
  # user can act on. Nothing outside %USERPROFILE%\.harness and the user's PATH is ever changed.
  param([switch]$Desktop, [string]$Manifest, [switch]$NoService)
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'   # Windows PowerShell 5.1 downloads many times slower with the bar drawn
  $root = Join-Path $env:USERPROFILE '.harness'
  $step = 'Checking this computer'
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $tar = Test-HarnessHost
    $platform = Get-HarnessPlatform
    Write-Host "Installing Harness for $platform into $root"

    $step = 'Reading the release manifests'
    $sources = Get-HarnessManifests -Manifest $Manifest -Platform $platform

    $step = 'Installing the Node runtime'
    Install-HarnessNode -Root $root -Entry $sources.node.entry -Source $sources.node.source -Tar $tar -Platform $platform
    $step = 'Installing the Harness CLI'
    # The version a running daemon may be on, read before the pointer moves (Restart-HarnessDaemon below).
    $before = Read-HarnessCurrentCli -Root $root
    $ptyBefore = Read-HarnessCurrentPty -Root $root
    $version = Install-HarnessCli -Root $root -Entry $sources.cli.entry -Source $sources.cli.source
    # The terminal host is installed in -Desktop mode too: the daemon the app starts runs its terminals on it.
    $step = 'Installing the terminal host'
    $ptyFolder = Install-HarnessPty -Root $root -Entry $sources.pty.entry -Source $sources.pty.source -Tar $tar
    $step = 'Installing the harness command'
    $ptyAfter = Split-Path -Leaf $ptyFolder
    $command = Install-HarnessCommand -Root $root -PtyFolder $ptyFolder
    $step = 'Adding Harness to your PATH'
    Add-HarnessPath -Root $root
    $step = 'Checking the installed CLI'
    $said = [string](@(& $command version) | Select-Object -First 1)
    if ($LASTEXITCODE -ne 0 -or $said.Trim() -ne $version) { throw "harness version answered '$said' (exit code $LASTEXITCODE), not $version." }
    $step = 'Moving the running Harness to the new build'
    # $null: Install-Harness returns a single integer (the guard takes the last value).
    $null = Restart-HarnessDaemon -Command $command -Before $before -After $version -PtyBefore $ptyBefore -PtyAfter $ptyAfter
    if (-not $Desktop -and -not $NoService) {
      $step = 'Starting Harness when you sign in'
      Register-HarnessService -Command $command
    }
  } catch {
    Write-Host ''
    Write-Host "Harness could not be installed. The step that failed: $step." -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "  Nothing outside $root and your PATH was changed. Run the installer again, or send this message to Harness support."
    return 1
  }
  Write-HarnessDone -Version $version -Desktop:$Desktop -NoService:$NoService -Command $command
  Write-HarnessGitNote
  return 0
}

function ConvertTo-HarnessVersionKey([string]$Version) {
  # C4.7 publishes X.Y.Z or X.Y.Z-prerelease. Only the three numeric parts order, as in DesktopUpdater.
  if (-not ($Version -cmatch '^([0-9]+)\.([0-9]+)\.([0-9]+)(-[0-9A-Za-z]+(\.[0-9A-Za-z]+)*)?$')) { return $null }
  try { return [version]::new([int]$Matches[1], [int]$Matches[2], [int]$Matches[3]) }
  catch { return $null } # A published-looking component outside [version]'s range cannot order.
}

function Select-HarnessAppEntry {
  # Native x64 uses x64. Native arm64 takes the newer arm64 or x64 entry, with arm64 winning a tie.
  param($Document, [string]$Platform)
  $keys = if ($Platform -eq 'win32-arm64') { @('desktop-windows-arm64', 'desktop-windows-x64') } else { @('desktop-windows-x64') }
  $best = $null
  foreach ($key in $keys) {
    $entry = Get-HarnessProperty $Document $key
    $value = Get-HarnessProperty $entry 'version'
    $url = Get-HarnessProperty $entry 'url'
    $sha256 = Get-HarnessProperty $entry 'sha256'
    $size = Get-HarnessProperty $entry 'size'
    if ($value -isnot [string] -or $url -isnot [string] -or $sha256 -isnot [string] -or
        ($size -isnot [int] -and $size -isnot [long])) { continue }
    $version = ConvertTo-HarnessVersionKey $value
    if ($version -and (-not $best -or $version -gt $best.version)) { $best = @{ entry = $entry; version = $version } }
  }
  if (-not $best) { throw "The desktop manifest has no Harness desktop app for this computer ($Platform) yet." }
  return $best.entry
}

function Start-HarnessAppInstall {
  # Wait for the extracted Harness.exe --install alone. The installed app it opens keeps running.
  param([string]$Launcher)
  $info = [Diagnostics.ProcessStartInfo]::new($Launcher, '--install')
  $info.UseShellExecute = $false
  $info.WorkingDirectory = Split-Path -Parent $Launcher
  $process = [Diagnostics.Process]::Start($info)
  try {
    $process.WaitForExit()
    return $process.ExitCode
  } finally { $process.Dispose() }
}

function Install-HarnessApp {
  # Download the complete desktop zip, verify it, and let its own launcher install and open it.
  param([string]$Manifest)
  $ErrorActionPreference = 'Stop'
  $ProgressPreference = 'SilentlyContinue'
  $step = 'Checking this computer'
  $staging = $null
  $installed = $false
  try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    $tar = Test-HarnessHost
    $platform = Get-HarnessPlatform

    $step = 'Reading the release manifest'
    $source = "${HarnessManifestBase}desktop/metadata.json"
    if ($Manifest) {
      $source = $Manifest
      if (-not (Test-HarnessUrl $source) -and -not (Test-HarnessScheme $source)) {
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "The manifest $source does not exist." }
        $source = (Resolve-Path -LiteralPath $source).ProviderPath
      }
    }
    $entry = Select-HarnessAppEntry -Document (Get-HarnessJson $source) -Platform $platform
    $version = [string]$entry.version
    Write-Host "Installing the Harness desktop app $version for $platform"

    $step = 'Downloading Harness'
    $staging = New-HarnessStaging -Parent ([IO.Path]::GetTempPath()) -Name 'harness-desktop'
    $zip = Join-Path $staging 'harness-desktop.zip'
    Save-HarnessVerified -Source (Resolve-HarnessRef -Ref ([string]$entry.url) -ManifestSource $source) -Destination $zip -Sha256 ([string]$entry.sha256) -Size $entry.size

    $step = 'Unpacking Harness'
    $folder = Join-Path $staging 'zip'
    Expand-HarnessZip -Tar $tar -Archive $zip -Destination $folder
    $launcher = Join-Path $folder 'Harness.exe'
    if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) { throw 'The download has no Harness.exe, so it is not a Harness desktop app.' }

    $step = 'Installing Harness'
    $code = Start-HarnessAppInstall -Launcher $launcher
    if ($code -ne 0) { throw "Harness's installer stopped (exit code $code). Its log is launch.log, in Programs\Harness under $env:LOCALAPPDATA." }
    $installed = $true
  } catch {
    Write-Host ''
    Write-Host "Harness could not be installed. The step that failed: $step." -ForegroundColor Red
    Write-Host "  $($_.Exception.Message)" -ForegroundColor Red
    Write-Host '  Run the installer again, or send this message to Harness support.'
    return 1
  } finally {
    if ($staging) {
      try { Remove-Item -LiteralPath $staging -Recurse -Force -ErrorAction Stop }
      catch {
        Write-Host "Warning: Temporary files remain at $staging." -ForegroundColor Yellow
        if ($installed) { Write-Host '  Harness was installed and can be used.' }
        else { Write-Host '  The install failed for the reason above.' }
        Write-Host "  Close anything using that folder, then remove it. $($_.Exception.Message)"
      }
    }
  }
  Write-Host ''
  Write-Host "Harness $version is installed, and it is opening now."
  Write-Host 'Next time, open it from the Start menu. On its first start it sets up the Harness command line.'
  Write-HarnessGitNote
  return 0
}

# --- Run ---
if ($env:HARNESS_INSTALL_LIBRARY -ne '1') {
  if (-not $Manifest) { $Manifest = $env:HARNESS_INSTALL_MANIFEST }
  if ($App -or $HarnessInstallApp) {
    $harnessExit = @(Install-HarnessApp -Manifest $Manifest)[-1]
  } else {
    $harnessExit = @(Install-Harness -Desktop:([bool]$Desktop) -Manifest $Manifest -NoService:([bool]$NoService))[-1]
  }
  # Run as a file, the exit code is the result. Run by `irm | iex`, it never calls `exit`: that would close the
  # person's PowerShell window with the message still in it.
  if ($HarnessScriptPath) { exit $harnessExit }
  $global:LASTEXITCODE = $harnessExit
}
