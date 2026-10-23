# flash-circle.ps1
# Harness CIRCLE flasher for Windows: the twin of flash-circle.sh, with the same steps, flags, numbers and output
# lines, for `harness flash` and the desktop app's Flash firmware on Windows
# (docs/superpowers/specs/2026-10-19-windows-dial-design.md section 3). It downloads a pinned standalone esptool and
# the firmware from the same public bucket, checks both against their published sha256, finds the board itself, and
# refuses to write to anything that is not an ESP32-S3.
#
#   irm https://harness.autonomous.ai/flash-circle.ps1 -OutFile flash-circle.ps1
#   powershell -NoProfile -ExecutionPolicy Bypass -File flash-circle.ps1
#
#   --detect-only     find the board and print what it is; write nothing
#   --no-flash        download + verify the firmware, then stop (prints the cached path)
#   --version X.Y.Z   flash a specific published version instead of the newest
#   --port COMn       skip auto-detection (needed when two boards are plugged in)
#   --yes             don't ask for confirmation (`harness flash` always passes it)
#   --erase-nvs       ALSO wipe pairing + saved WiFi. Off by default
#   --no-verify       don't reopen the port afterwards to confirm the running version
#   --version-info    print this tool's version and exit
#
# SCOPE: this UPDATES a board that already works (see flash-circle.sh). Anything but an ESP32-S3 is a hard stop.
#
# ASCII only, on purpose: Windows PowerShell 5.1 reads a script without a BOM in the ANSI code page. The numbers
# below must equal flash-circle.sh's; flash-circle-ps1.spec.ts reads both and fails on any difference.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Console]::OutputEncoding = New-Object Text.UTF8Encoding($false) } catch { }
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Check = [char]0x2713; $Arrow = [char]0x2192; $Dash = [char]0x2014; $Ellipsis = [char]0x2026

function EnvOr([string]$Name, [string]$Default) {
  $value = [Environment]::GetEnvironmentVariable($Name)
  if ($value) { $value } else { $Default }
}

$FLASHER_VERSION = '1.2.0'

# --- Where things live (all overridable; names match scripts/upload-firmware.sh and flash-circle.sh) ---
$GCS_BUCKET = EnvOr 'GCS_BUCKET' 's3-autonomous-upgrade-3'
$GCS_PUBLIC_BASE_URL = EnvOr 'GCS_PUBLIC_BASE_URL' "https://storage.googleapis.com/$GCS_BUCKET"
$METADATA_PATH = EnvOr 'METADATA_PATH' 'harness/esp32/ota/metadata.json'
$OTA_KEY = EnvOr 'OTA_KEY' 'commander'
$FIRMWARE_PATH_PREFIX = EnvOr 'FIRMWARE_PATH_PREFIX' 'harness/esp32/bin'
$FLASHER_BASE = EnvOr 'FLASHER_BASE' "$($GCS_PUBLIC_BASE_URL.TrimEnd('/'))/harness/flasher"
$ESPTOOL_VERSION = EnvOr 'ESPTOOL_VERSION' '5.3.1'
$ESPTOOL_RELEASE_BASE = EnvOr 'ESPTOOL_RELEASE_BASE' 'https://github.com/espressif/esptool/releases/download'
$CACHE_DIR = EnvOr 'HARNESS_FLASHER_CACHE' (Join-Path $env:USERPROFILE '.harness\flasher')
$PROBE_TIMEOUT = [int](EnvOr 'HARNESS_PROBE_TIMEOUT' '25')
$CANCEL_FILE = Join-Path $CACHE_DIR 'cancel'
$FLASHING_FILE = Join-Path $CACHE_DIR 'flashing'
# The app can retire only its own lease after forcibly ending this tree. Standalone and older
# callers keep the shared timestamp marker; an invalid capability cannot name a different path.
$flashRunId = [Environment]::GetEnvironmentVariable('HARNESS_FLASH_RUN_ID')
if ($flashRunId -cmatch '\A[0-9a-f]{32}\z') { $FLASHING_FILE = Join-Path $CACHE_DIR "flashing.$flashRunId" }
# Freeze ownership above, then keep the capability out of esptool, recovery and restarted daemons.
[Environment]::SetEnvironmentVariable('HARNESS_FLASH_RUN_ID', $null, 'Process')

# --- Flash geometry. Source of truth: apps/esp32-circle/partitions.csv (as flash-circle.sh) ---
$CHIP = 'esp32s3'
$APP_OFFSET = '0x20000'
$OTADATA_OFFSET = '0xf000'
$OTADATA_SIZE = '0x2000'
$NVS_OFFSET = '0x9000'
$NVS_SIZE = '0x6000'
$FLASH_MODE = 'dio'; $FLASH_FREQ = '80m'; $FLASH_SIZE = '16MB'

# Espressif publishes no arm64 Windows build; on arm64 Windows this x64 one runs emulated.
$ESPTOOL_ASSET = "esptool-v$ESPTOOL_VERSION-windows-amd64.zip"
function Get-PinnedEsptoolSha([string]$Asset) {
  # The vendor's own release digest. Bumping ESPTOOL_VERSION means replacing this, and flash-circle.sh's block:
  # upload-flasher.sh --mirror-esptool prints both.
  switch ($Asset) {
    'esptool-v5.3.1-windows-amd64.zip' { '2b4a73c45db27426685896f64ce3e557f63a64f43cc100cb65c0cc3486af96d3' }
    default { '' }
  }
}

$script:DETECT_ONLY = $false; $script:NO_FLASH = $false; $script:ASSUME_YES = $false
$script:ERASE_NVS = $false; $script:NO_VERIFY = $false; $script:Finished = $false
$script:WANT_VERSION = ''; $script:PORT = ''
$script:FW_VER = ''; $script:FW_URL = ''; $script:FW_SHA = ''; $script:FW_SIZE = ''; $script:FW_FILE = ''
$script:ESPTOOL = $null
$script:Child = $null
$script:HarnessStopped = $false
$script:FlashingMarked = $false
$script:ExitCode = 0
$StopMarker = 'flash-circle: stopped'

function Say([string]$Text) { [Console]::Out.WriteLine($Text) }
function Warn([string]$Text) { [Console]::Error.WriteLine($Text) }
# Thrown, not `exit`: the outer finally starts Harness again on every way out.
function Die([string]$Text, [int]$Code = 1) { Warn "error: $Text"; $script:ExitCode = $Code; throw $StopMarker }

function Show-Usage {
  Get-Content -LiteralPath $PSCommandPath | Select-Object -Skip 1 -First 18 | ForEach-Object { $_ -replace '^# ?', '' }
}

function Read-Arguments([object[]]$Given) {
  $i = 0
  while ($i -lt $Given.Count) {
    $a = [string]$Given[$i]
    if ($a -eq '--detect-only') { $script:DETECT_ONLY = $true }
    elseif ($a -eq '--no-flash') { $script:NO_FLASH = $true }
    elseif ($a -eq '--yes' -or $a -eq '-y') { $script:ASSUME_YES = $true }
    elseif ($a -eq '--erase-nvs') { $script:ERASE_NVS = $true }
    elseif ($a -eq '--no-verify') { $script:NO_VERIFY = $true }
    elseif ($a -eq '--version-info') { Say "flash-circle $FLASHER_VERSION"; $script:Finished = $true; return }
    elseif ($a -like '--version=*') { $script:WANT_VERSION = $a.Substring('--version='.Length) }
    elseif ($a -like '--port=*') { $script:PORT = $a.Substring('--port='.Length) }
    elseif ($a -eq '--version') { $i++; if ($i -ge $Given.Count) { Die '--version needs X.Y.Z' }; $script:WANT_VERSION = [string]$Given[$i] }
    elseif ($a -eq '--port') { $i++; if ($i -ge $Given.Count) { Die '--port needs a device path' }; $script:PORT = [string]$Given[$i] }
    elseif ($a -eq '--help' -or $a -eq '-h') { Show-Usage; $script:Finished = $true; return }
    else { Die "unknown argument '$a' (try --help)" }
    $i++
  }
  if ($script:WANT_VERSION -and $script:WANT_VERSION -notmatch '^[0-9]+\.[0-9]+\.[0-9]+$') { Die '--version must look like X.Y.Z' }
  if ($script:PORT) {
    $script:PORT = $script:PORT.ToUpperInvariant()
    if ($script:PORT -notmatch '^COM[1-9][0-9]{0,2}$') { Die "--port needs a COM port such as COM3, not '$($script:PORT)'" }
  }
}

function Get-Sha256([string]$Path) { (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant() }

function Save-Url([string]$Url, [string]$OutFile) {
  for ($try = 0; $try -lt 3; $try++) {
    Test-Cancel
    try { Invoke-WebRequest -Uri $Url -OutFile $OutFile -UseBasicParsing -TimeoutSec 60; Test-Cancel; return $true } catch {
      if ($_.Exception.Message -eq $StopMarker) { throw }
      Start-Sleep -Seconds 1
    }
  }
  return $false
}

function Get-UrlText([string]$Url) {
  Test-Cancel
  try {
    $content = (Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 60).Content
    Test-Cancel
    if ($content -is [byte[]]) { [Text.Encoding]::UTF8.GetString($content) } else { [string]$content }
  } catch {
    if ($_.Exception.Message -eq $StopMarker) { throw }
    $null
  }
}

# Windows' own command-line rules (CommandLineToArgvW), so a firmware path under a profile with a space, an
# apostrophe, & or % reaches esptool as one argument. ProcessStartInfo takes one string, not a list.
function ConvertTo-ArgumentText([string[]]$Values) {
  ($Values | ForEach-Object {
    if ($_ -ne '' -and $_ -notmatch '[\s"]') { $_ }
    else { '"' + (($_ -replace '(\\*)"', '$1$1\"') -replace '(\\+)$', '$1$1') + '"' }
  }) -join ' '
}

# --- esptool: the pinned mirror, then the vendor release, then one already on PATH ---
function Find-Esptool([string]$Dir) {
  if (-not (Test-Path -LiteralPath $Dir)) { return $null }
  $file = Get-ChildItem -LiteralPath $Dir -Recurse -Depth 2 -Filter 'esptool.exe' -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($file) { $file.FullName } else { $null }
}

function Install-EsptoolFrom([string]$Url, [string]$Want, [string]$Dir) {
  $zip = Join-Path $CACHE_DIR $ESPTOOL_ASSET
  if (-not (Save-Url $Url $zip)) { Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue; return $false }
  $got = Get-Sha256 $zip
  if ($got -ne $Want) {
    Warn "   sha256 mismatch from $Url (expected $Want, got $got) $Dash not installing"
    Remove-Item -LiteralPath $zip -Force -ErrorAction SilentlyContinue
    return $false
  }
  if (Test-Path -LiteralPath $Dir) { Remove-Item -LiteralPath $Dir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $Dir | Out-Null
  Expand-Archive -LiteralPath $zip -DestinationPath $Dir -Force
  Remove-Item -LiteralPath $zip -Force
  $found = Find-Esptool $Dir
  if (-not $found) { return $false }
  $script:ESPTOOL = $found
  return $true
}

function Install-Esptool {
  $dir = Join-Path $CACHE_DIR "esptool\$ESPTOOL_VERSION"
  $found = Find-Esptool $dir
  if ($found) { $script:ESPTOOL = $found; return }
  New-Item -ItemType Directory -Force -Path $CACHE_DIR | Out-Null
  $pinned = Get-PinnedEsptoolSha $ESPTOOL_ASSET
  Say ">> installing esptool $ESPTOOL_VERSION ($ESPTOOL_ASSET)"
  # 1. Our mirror first: reachable from networks that block GitHub, and it serves its own .sha256.
  $mirror = "$($FLASHER_BASE.TrimEnd('/'))/esptool/$ESPTOOL_VERSION/$ESPTOOL_ASSET"
  $mirrorSha = ''
  $text = Get-UrlText "$mirror.sha256"
  if ($text) { $mirrorSha = ($text.Trim() -split '\s+')[0] }
  if (-not $mirrorSha) { $mirrorSha = $pinned }
  if ($mirrorSha -and (Install-EsptoolFrom $mirror $mirrorSha $dir)) { Say "   installed from the mirror $Check"; return }
  # 2. The vendor release, checked against the pin above.
  if ($pinned) {
    if (Install-EsptoolFrom "$ESPTOOL_RELEASE_BASE/v$ESPTOOL_VERSION/$ESPTOOL_ASSET" $pinned $dir) { Say "   installed from the esptool release $Check (sha256 pinned)"; return }
  } else {
    Warn "   (no pinned sha256 for esptool $ESPTOOL_VERSION $Dash refusing to install an unverified binary)"
  }
  Warn "   (mirror unavailable at $mirror $Dash falling back to a local esptool)"
  $local = Get-Command 'esptool.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($local) { $script:ESPTOOL = $local.Source; return }
  Die "no esptool available. The tool installs a pinned esptool by itself; both the mirror and the vendor release were unreachable. Check the network, or put esptool.exe on PATH and re-run."
}

# --- running esptool: bounded, cancellable, its output copied byte for byte ---
function Stop-Child {
  $p = $script:Child
  if ($p -and -not $p.HasExited) {
    # The standalone esptool is two processes, its bootloader and the program: ending only the first leaves the
    # second holding the port. taskkill /T ends the tree.
    $previous = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      & taskkill.exe /PID $p.Id /T /F 2>&1 | Out-Null
      if (-not $p.WaitForExit(5000)) { $p.Kill(); [void]$p.WaitForExit(1000) }
    } finally { $ErrorActionPreference = $previous }
  }
  $script:Child = $null
}

function Test-Cancel {
  if (Test-Path -LiteralPath $CANCEL_FILE) {
    Remove-Item -LiteralPath $CANCEL_FILE -Force -ErrorAction SilentlyContinue
    Stop-Child
    Die 'cancelled' 130
  }
}

# -Show all: esptool's output as it comes. errors: only what it prints on stderr. none: nothing (the probe).
function Invoke-Esptool([string[]]$Arguments, [int]$Seconds, [string]$Show = 'all') {
  Test-Cancel
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $script:ESPTOOL
  $info.Arguments = ConvertTo-ArgumentText $Arguments
  $info.UseShellExecute = $false
  $info.CreateNoWindow = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $p = [Diagnostics.Process]::Start($info)
  $script:Child = $p
  $captured = New-Object IO.MemoryStream
  $pumps = @(
    @{ From = $p.StandardOutput.BaseStream; To = [Console]::OpenStandardOutput(); Copy = ($Show -eq 'all'); Buffer = (New-Object byte[] 8192); Task = $null; Done = $false },
    @{ From = $p.StandardError.BaseStream; To = [Console]::OpenStandardError(); Copy = ($Show -ne 'none'); Buffer = (New-Object byte[] 8192); Task = $null; Done = $false }
  )
  $deadline = [DateTime]::UtcNow.AddSeconds($Seconds)
  try {
    while ($true) {
      $open = 0
      foreach ($pump in $pumps) {
        if ($pump.Done) { continue }
        $open++
        if ($null -eq $pump.Task) { $pump.Task = $pump.From.ReadAsync($pump.Buffer, 0, $pump.Buffer.Length) }
        if ($pump.Task.Wait(100)) {
          $read = $pump.Task.Result
          $pump.Task = $null
          if ($read -eq 0) { $pump.Done = $true; continue }
          $captured.Write($pump.Buffer, 0, $read)
          if ($pump.Copy) { $pump.To.Write($pump.Buffer, 0, $read); $pump.To.Flush() }
        }
      }
      # Closed pipes do not mean the child exited; keep timeout and cancellation active.
      if ($open -eq 0 -and $p.HasExited) { break }
      if ($open -eq 0) { Start-Sleep -Milliseconds 50 }
      Test-Cancel
      if ([DateTime]::UtcNow -gt $deadline) {
        Stop-Child
        return @{ Code = 124; Text = [Text.Encoding]::UTF8.GetString($captured.ToArray()) }
      }
    }
    return @{ Code = $p.ExitCode; Text = [Text.Encoding]::UTF8.GetString($captured.ToArray()) }
  } finally {
    Stop-Child
    $p.Dispose()
    $captured.Dispose()
  }
}

function Assert-Esptool($Result, [string]$Step) {
  if ($Result.Code -eq 124) { Die "esptool did not finish the $Step in time" }
  if ($Result.Code -ne 0) { Die "esptool failed during the $Step (exit $($Result.Code))" }
}

# --- finding the board ---
# The dial's COM ports by its USB id, the same id harness-serial matches (serial/src/model.rs): the registry keeps
# the PortName of every enumeration, present or not, so it only ever classifies a port that is present.
function Get-DialPortNames {
  @(Get-ChildItem -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Enum\USB\VID_303A&PID_1001&MI_00' -ErrorAction SilentlyContinue | ForEach-Object {
    (Get-ItemProperty -LiteralPath (Join-Path $_.PSPath 'Device Parameters') -ErrorAction SilentlyContinue).PortName
  } | Where-Object { $_ })
}

# The detected chip's name, '' when none answered, or 'BUSY' when another program holds the port.
function Get-Chip([string]$Port) {
  $result = Invoke-Esptool @('--port', $Port, '--before', 'default_reset', '--after', 'hard_reset', '--connect-attempts', '1', '--no-stub', 'chip_id') $PROBE_TIMEOUT 'none'
  if ($result.Text -match '(?i)esp32-s3') { return 'ESP32-S3' }
  if ($result.Text -match '(?i)could not open|access is denied|permissionerror|port is busy') { return 'BUSY' }
  $match = [regex]::Match($result.Text, 'Detecting chip type\.*\s*([^\r\n]*)')
  if ($match.Success) { return $match.Groups[1].Value.Trim() }
  return ''
}

function Select-Port {
  if ($script:PORT) { Say ">> using port $($script:PORT) (given)"; return }
  $ports = @([System.IO.Ports.SerialPort]::GetPortNames() | Where-Object { $_ -match '^COM[1-9][0-9]{0,2}$' } | Sort-Object { [int]$_.Substring(3) } -Unique)
  if ($ports.Count -eq 0) { Die 'no USB serial device found. Plug the board in and check the cable carries data (some are charge-only).' }
  $dials = Get-DialPortNames
  Say ">> probing $($ports.Count) serial port(s)$Ellipsis"
  $found = @()
  foreach ($port in $ports) {
    $chip = Get-Chip $port
    if ($chip -like '*ESP32-S3*') { Say "   $port $Arrow ESP32-S3 $Check"; $found += $port }
    elseif ($chip -eq 'BUSY' -and $script:DETECT_ONLY -and $dials -contains $port) {
      # Harness holds its dial while it runs, and --detect-only does not stop it. A flash stops it first and asks
      # the chip before it writes anything.
      Say "   $port $Arrow in use by Harness (a dial, by its USB id)"; $found += $port
    }
    elseif ($chip -eq 'BUSY') { Say "   $port $Arrow in use by another program $Dash skipped" }
    elseif (-not $chip) { Say "   $port $Arrow no ESP chip answered $Dash skipped" }
    else { Say "   $port $Arrow $chip $Dash NOT a circle board, skipped" }
  }
  if ($found.Count -eq 0) { Die 'found no ESP32-S3. The circle board is esp32s3; the square board is esp32p4 and must NOT be flashed with this image.' }
  if ($found.Count -gt 1) {
    Warn 'more than one ESP32-S3 is connected:'
    foreach ($port in $found) { Warn "  $port" }
    Die 'pass --port <one of the above> so the right board is written'
  }
  $script:PORT = $found[0]
  Say ">> board: $($script:PORT)"
}

# --- the firmware ---
function Resolve-Release {
  $metaUrl = "$($GCS_PUBLIC_BASE_URL.TrimEnd('/'))/$($METADATA_PATH.TrimStart('/'))"
  $text = Get-UrlText $metaUrl
  if (-not $text) { Die 'cannot read the release manifest (network? bucket?)' }
  $meta = $text | ConvertFrom-Json
  if ($script:WANT_VERSION) {
    $script:FW_VER = $script:WANT_VERSION
    $script:FW_URL = "$($GCS_PUBLIC_BASE_URL.TrimEnd('/'))/$($FIRMWARE_PATH_PREFIX.TrimStart('/'))/$($script:FW_VER).bin"
    Warn 'note: --version bypasses the manifest, which is the only place a sha256 is published.'
    Warn '      The download can be checked for shape but NOT for authenticity.'
  } else {
    $entry = $meta.$OTA_KEY
    if (-not $entry -or -not $entry.version -or -not $entry.url) { Die "manifest has no usable '$OTA_KEY' entry" }
    $script:FW_VER = [string]$entry.version; $script:FW_URL = [string]$entry.url
    $script:FW_SHA = [string]$entry.sha256; $script:FW_SIZE = [string]$entry.size
  }
  Say ">> release: $OTA_KEY $($script:FW_VER)"
  Say "   $($script:FW_URL)"
}

function Get-Firmware {
  $dir = Join-Path $CACHE_DIR "firmware\$OTA_KEY"
  New-Item -ItemType Directory -Force -Path $dir | Out-Null
  $script:FW_FILE = Join-Path $dir "$($script:FW_VER).bin"
  if ((Test-Path -LiteralPath $script:FW_FILE) -and $script:FW_SHA -and (Get-Sha256 $script:FW_FILE) -eq $script:FW_SHA) {
    Say ">> cached: $($script:FW_FILE)"
  } else {
    Say ">> downloading$Ellipsis"
    $part = "$($script:FW_FILE).part"
    if (-not (Save-Url $script:FW_URL $part)) { Remove-Item -LiteralPath $part -Force -ErrorAction SilentlyContinue; Die 'download failed' }
    Move-Item -LiteralPath $part -Destination $script:FW_FILE -Force
  }
  if ($script:FW_SHA) {
    $got = Get-Sha256 $script:FW_FILE
    if ($got -ne $script:FW_SHA) { Remove-Item -LiteralPath $script:FW_FILE -Force; Die "firmware sha256 mismatch (expected $($script:FW_SHA), got $got) $Dash refusing to flash" }
    Say "   sha256 $Check"
  }
  $length = (Get-Item -LiteralPath $script:FW_FILE).Length
  if ($script:FW_SIZE -and [string]$length -ne $script:FW_SIZE) { Die "firmware size mismatch (expected $($script:FW_SIZE), got $length)" }
  $stream = [IO.File]::OpenRead($script:FW_FILE)
  try { $magic = $stream.ReadByte() } finally { $stream.Close() }
  if ($magic -ne 0xE9) { Die ("'$($script:FW_FILE)' is not an ESP firmware image (first byte 0x{0:x2}, expected 0xe9)" -f $magic) }
  if (-not $script:FW_SHA) { Say "   shape $Check (unverified: no published sha256 for this version)" }
  Say "   $length bytes"
}

function Confirm-Flash {
  if ($script:ASSUME_YES) { return }
  if ([Console]::IsInputRedirected) { Die "not a terminal $Dash re-run with --yes if this is intentional" }
  [Console]::Out.Write("Flash $OTA_KEY $($script:FW_VER) to $($script:PORT)? [y/N] ")
  $reply = [Console]::ReadLine()
  if ($reply -notmatch '^(y|Y|yes|YES)$') { Die 'cancelled' }
}

# --- Harness: stopped to free the port, started again however the run ends ---
function Invoke-Harness([string]$Verb) {
  $harness = Get-Command 'harness' -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $harness) { return $null }
  # A native command's stderr becomes an error record in Windows PowerShell 5.1, which 'Stop' would throw on.
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $harness.Source $Verb *> $null; return $LASTEXITCODE } finally { $ErrorActionPreference = $previous }
}

function Stop-HarnessForFlash {
  if (-not (Get-Command 'harness' -ErrorAction SilentlyContinue)) { return }
  Say ">> stopping Harness to release USB serial ports$Ellipsis"
  New-Item -ItemType Directory -Force -Path $CACHE_DIR | Out-Null
  Set-Content -LiteralPath $FLASHING_FILE -Value ([DateTimeOffset]::UtcNow.ToUnixTimeSeconds()) -Encoding ascii
  $script:FlashingMarked = $true
  if ((Invoke-Harness 'stop') -ne 0) { Die "could not stop Harness. Run 'harness stop', then retry the flash." }
  $script:HarnessStopped = $true
  # The daemon's harness-serial children end at the end of their stdin, a moment after it (spec section 1). Only
  # this session's: another user's are not this daemon's.
  $session = [Diagnostics.Process]::GetCurrentProcess().SessionId
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([DateTime]::UtcNow -lt $deadline -and @(Get-Process -Name 'harness-serial' -ErrorAction SilentlyContinue | Where-Object { $_.SessionId -eq $session }).Count) {
    Start-Sleep -Milliseconds 200
  }
}

function Start-HarnessAfterFlash {
  # A failed stop must clear this run's marker, without starting anything it did not stop.
  if ($script:FlashingMarked) {
    Remove-Item -LiteralPath $FLASHING_FILE -Force -ErrorAction SilentlyContinue
    $script:FlashingMarked = $false
  }
  if (-not $script:HarnessStopped) { return }
  $script:HarnessStopped = $false
  Say ">> starting Harness again$Ellipsis"
  if ((Invoke-Harness 'start') -ne 0) { Warn "could not start Harness $Dash run 'harness start' yourself." }
}

function Complete-HarnessFlash {
  # The daemon was stopped during the flash, so it could not see busy -> free and forget a previous
  # foreign-board verdict. Only a new CLI supplies this callback, and it owns the verdict file format.
  # Standalone flashers and older CLIs keep working without it. Never resolve a different CLI on PATH.
  $node = [Environment]::GetEnvironmentVariable('HARNESS_FLASH_RECOVERY_NODE')
  $json = [Environment]::GetEnvironmentVariable('HARNESS_FLASH_RECOVERY_ARGS')
  if (-not $node -and -not $json) { return }
  $previous = $ErrorActionPreference
  try {
    if (-not $node -or -not (Test-Path -LiteralPath $node -PathType Leaf) -or -not $json -or -not $json.TrimStart().StartsWith('[')) { throw 'invalid completion capability' }
    $decoded = ConvertFrom-Json -InputObject $json
    if (@($decoded).Count -eq 0) { throw 'empty completion capability' }
    foreach ($value in $decoded) { if ($value -isnot [string] -or -not $value) { throw 'invalid completion argument' } }
    [string[]]$arguments = @($decoded)
    # Native stderr is an ErrorRecord in Windows PowerShell 5.1. Its exit status, not that conversion,
    # decides whether this optional recovery succeeded; finally must still restart Harness on failure.
    $ErrorActionPreference = 'Continue'
    & $node @arguments 'flash' '__complete' $script:PORT *> $null
    if ($LASTEXITCODE -ne 0) { throw "completion exited $LASTEXITCODE" }
  } catch {
    Warn "could not refresh the flashed board in Harness: $($_.Exception.Message)"
  } finally { $ErrorActionPreference = $previous }
}

# --- writing, and reading back what runs ---
function Invoke-Flash {
  Say ''
  Say ">> flashing $($script:FW_VER) $Arrow $($script:PORT)"
  Say "   erase otadata ($OTADATA_OFFSET +$OTADATA_SIZE)"
  Assert-Esptool (Invoke-Esptool @('--chip', $CHIP, '--port', $script:PORT, '--before', 'default_reset', '--after', 'no_reset', 'erase_region', $OTADATA_OFFSET, $OTADATA_SIZE) 120 'errors') 'otadata erase'
  if ($script:ERASE_NVS) {
    Warn "   erase NVS ($NVS_OFFSET +$NVS_SIZE) $Dash pairing and saved WiFi will be gone"
    Assert-Esptool (Invoke-Esptool @('--chip', $CHIP, '--port', $script:PORT, '--before', 'default_reset', '--after', 'no_reset', 'erase_region', $NVS_OFFSET, $NVS_SIZE) 120 'errors') 'NVS erase'
  }
  Say "   write app ($APP_OFFSET)"
  Assert-Esptool (Invoke-Esptool @('--chip', $CHIP, '--port', $script:PORT, '-b', '460800', '--before', 'default_reset', '--after', 'hard_reset', 'write_flash', '--flash_mode', $FLASH_MODE, '--flash_size', $FLASH_SIZE, '--flash_freq', $FLASH_FREQ, $APP_OFFSET, $script:FW_FILE) 600) 'app write'
  Say '>> flashed.'
}

function Confirm-Running {
  if ($script:NO_VERIFY) { return $false }
  Say ">> confirming the running version$Ellipsis"
  $text = New-Object Text.StringBuilder
  $port = $null
  try {
    $port = New-Object System.IO.Ports.SerialPort $script:PORT, 115200
    $port.ReadTimeout = 500
    $port.Open()
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([DateTime]::UtcNow -lt $deadline) {
      Test-Cancel
      try { [void]$text.Append($port.ReadExisting()) } catch { }
      Start-Sleep -Milliseconds 200
    }
  } catch {
    if ($_.Exception.Message -eq $StopMarker) { throw }
  } finally {
    if ($port) { $port.Dispose() }
  }
  $match = [regex]::Match($text.ToString(), 'App version:\s*([^\r\n]*)')
  $seen = if ($match.Success) { $match.Groups[1].Value.Trim() } else { '' }
  if (-not $seen) {
    Warn "   could not read a version from the boot log (not fatal $Dash power-cycle and check the screen)"
  } elseif ($seen -eq $script:FW_VER) {
    Say "   running $seen $Check"
    return $true
  } else {
    Warn "   running $seen but $($script:FW_VER) was flashed $Dash the board did not boot what we wrote"
    Warn '   (if this repeats, the app may be rolling back; report it with this output)'
  }
  return $false
}

function Invoke-FlashCircle([object[]]$Given) {
  Read-Arguments $Given
  if ($script:Finished) { return }
  New-Item -ItemType Directory -Force -Path $CACHE_DIR | Out-Null
  # A cancel left from an earlier run must not cancel this one.
  Remove-Item -LiteralPath $CANCEL_FILE -Force -ErrorAction SilentlyContinue
  # esptool is only needed to TALK to a board; --no-flash is a pure download + verify.
  if (-not $script:NO_FLASH) {
    if (-not $script:DETECT_ONLY) { Stop-HarnessForFlash }
    Install-Esptool
    Select-Port
  }
  if ($script:DETECT_ONLY) { Say '>> detect-only: nothing was written.'; return }
  Test-Cancel
  Resolve-Release
  Test-Cancel
  Get-Firmware
  Test-Cancel
  if ($script:NO_FLASH) { Say ">> --no-flash: stopping. Image at $($script:FW_FILE)"; return }
  Confirm-Flash
  Test-Cancel
  Invoke-Flash
  # A completed write alone does not prove that this board booted the dial firmware.
  if (Confirm-Running) { Complete-HarnessFlash }
  Say ''
  Say "Done. $OTA_KEY $($script:FW_VER) is on $($script:PORT)."
  if ($script:ERASE_NVS) { Say "NVS was erased $Dash the device will ask to be set up again." }
}

try {
  Invoke-FlashCircle $args
} catch {
  if ($_.Exception.Message -ne $StopMarker) { Warn "error: $($_.Exception.Message)"; $script:ExitCode = 1 }
} finally {
  Stop-Child
  Start-HarnessAfterFlash
}
exit $script:ExitCode
