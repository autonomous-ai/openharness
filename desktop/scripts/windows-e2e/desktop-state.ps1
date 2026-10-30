# desktop-state.ps1 [-InstallRoot <dir>]: what the Harness desktop app has put on this PC for this user, read-only, in
# the desktop session (desktop-e2e.sh state) or over SSH. The install folder and its pointers (bytes checked: one
# line, no BOM), each version folder (its executable, machine type, version resource and .started marker),
# launch.log's last lines, the harness:// key, the uninstall entry, the Start Menu shortcut (target and AUMID), the
# app's own state folder (present or not, never its contents), the sign-in's machine id, and the CLI pieces the app
# relies on. Nothing secret is printed: the daemon token by its size, the pipe by its name (redacted on the Mac).
param([string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Programs\Harness'), [switch]$DriverRecord, [switch]$DriverPort)
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedUser | Out-Null
if ($DriverRecord -or $DriverPort) {
  $ErrorActionPreference = 'Stop'
  $data = if ($env:ADAPTER_DATA_DIR) { $env:ADAPTER_DATA_DIR } else { Join-Path $env:USERPROFILE '.harness\cli\data' }
  $path = Join-Path $data 'daemon-18473.json'
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'no daemon record for this owned user; start its own daemon first' }
  $item = Get-Item -LiteralPath $path
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 65536) { throw 'invalid owned daemon record file' }
  $record = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
  if (($record.port -isnot [int] -and $record.port -isnot [long]) -or $record.port -lt 1 -or $record.port -gt 65535) {
    throw 'no valid actual port in this owned user record; never fall back to shared 18473'
  }
  if ($DriverPort) { Write-Output $record.port } else { @{port=$record.port} | ConvertTo-Json -Compress }
  exit 0
}


function Read-Pointer([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { return '(absent)' }
  $b = [IO.File]::ReadAllBytes($Path)
  $bom = $b.Length -ge 3 -and $b[0] -eq 0xEF -and $b[1] -eq 0xBB -and $b[2] -eq 0xBF
  $text = [Text.Encoding]::UTF8.GetString($b)
  $end = if ($text.EndsWith("`r`n")) { 'CRLF' } elseif ($text.EndsWith("`n")) { 'LF' } else { 'none' }
  $lines = @($text -split "`r?`n" | Where-Object { $_ -ne '' }).Count
  "'$($text.Trim())' ($($b.Length) bytes, BOM $bom, line end $end, lines $lines)"
}

function Get-Machine([string]$Exe) {
  if (-not (Test-Path -LiteralPath $Exe -PathType Leaf)) { return 'no executable' }
  $fs = [IO.File]::OpenRead($Exe)
  try {
    $r = New-Object IO.BinaryReader $fs
    $fs.Position = 0x3C
    $fs.Position = $r.ReadInt32() + 4
    switch ($r.ReadUInt16()) { 0x8664 { 'x64' } 0xAA64 { 'arm64' } 0x014C { 'x86' } default { 'unknown machine' } }
  } finally { $fs.Dispose() }
}

function Show-Key([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { "  $Path (absent)"; return }
  $k = Get-Item -LiteralPath $Path
  foreach ($n in $k.GetValueNames()) {
    "  $Path : $(if ($n) { $n } else { '(default)' }) = '$($k.GetValue($n, $null, 'DoNotExpandEnvironmentNames'))' ($($k.GetValueKind($n)))"
  }
}

Write-Output "## install folder $InstallRoot"
if (Test-Path -LiteralPath $InstallRoot) {
  Get-ChildItem -LiteralPath $InstallRoot -Force | ForEach-Object { "  $($_.Name)$(if ($_.PSIsContainer) { '\' } else { " ($($_.Length) bytes)" })" }
  Write-Output "current: $(Read-Pointer (Join-Path $InstallRoot 'current'))"
  Write-Output "previous: $(Read-Pointer (Join-Path $InstallRoot 'previous'))"
  $launcher = Join-Path $InstallRoot 'Harness.exe'
  if (Test-Path -LiteralPath $launcher) {
    $v = (Get-Item -LiteralPath $launcher).VersionInfo
    Write-Output "Harness.exe: $(Get-Machine $launcher), FileDescription '$($v.FileDescription)', ProductName '$($v.ProductName)'"
  }
  $apps = Join-Path $InstallRoot 'app'
  if (Test-Path -LiteralPath $apps) {
    Get-ChildItem -LiteralPath $apps -Force | ForEach-Object {
      $exe = Join-Path $_.FullName 'harness-desktop.exe'
      $started = Join-Path $_.FullName '.started'
      $info = if (Test-Path -LiteralPath $exe) {
        $vi = (Get-Item -LiteralPath $exe).VersionInfo
        "$(Get-Machine $exe), ProductVersion $($vi.ProductVersion), FileDescription '$($vi.FileDescription)', ProductName '$($vi.ProductName)'"
      } else { 'no harness-desktop.exe' }
      $mark = if (Test-Path -LiteralPath $started) { 'written ' + (Get-Item -LiteralPath $started -Force).LastWriteTime.ToString('HH:mm:ss') } else { 'absent' }
      "app\$($_.Name): $info; .started $mark"
    }
  }
  $log = Join-Path $InstallRoot 'launch.log'
  if (Test-Path -LiteralPath $log) { Write-Output '## launch.log, last 15 lines'; Get-Content -LiteralPath $log -Tail 15 | ForEach-Object { "  $_" } }
} else { Write-Output '  (absent)' }

Write-Output '## harness:// and the uninstall entry'
Show-Key 'HKCU:\Software\Classes\harness'
Show-Key 'HKCU:\Software\Classes\harness\shell\open\command'
Show-Key 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Harness'

$programs = [Environment]::GetFolderPath('Programs')
$lnk = Join-Path $programs 'Harness.lnk'
Write-Output "## Start Menu shortcut $lnk"
if (Test-Path -LiteralPath $lnk) {
  $s = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
  Write-Output "  target '$($s.TargetPath)' arguments '$($s.Arguments)'"
  try {
    $item = (New-Object -ComObject Shell.Application).Namespace($programs).ParseName('Harness.lnk')
    Write-Output "  AUMID '$($item.ExtendedProperty('System.AppUserModel.ID'))'"
  } catch { Write-Output "  AUMID not readable here: $($_.Exception.Message)" }
  foreach ($a in @(Get-StartApps -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq 'Harness' })) { Write-Output "  Start: '$($a.Name)' AppID '$($a.AppID)'" }
} else { Write-Output '  (absent)' }

$h = Join-Path $env:USERPROFILE '.harness'
Write-Output "## $h (HOME is '$env:HOME')"
foreach ($d in @(Get-ChildItem -LiteralPath $h -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'desktop-app*' -or $_.Name -eq 'logs' })) {
  "  $($d.Name)\: $(@(Get-ChildItem -LiteralPath $d.FullName -Force).Count) entries"
}
$session = Join-Path $h 'auth\session.json'
if (Test-Path -LiteralPath $session) {
  # Only the machine id leaves session.json, never its tokens (as B's approve-qr.mts reads it).
  Write-Output "  signed in: machine $((Get-Content -Raw -LiteralPath $session | ConvertFrom-Json).machineId)"
} else { Write-Output '  signed in: no (no auth\session.json)' }
Write-Output "  cli\current: $(Read-Pointer (Join-Path $h 'cli\current'))"
Write-Output "  runtime\current-node: $(Read-Pointer (Join-Path $h 'runtime\current-node'))"
Get-ChildItem -LiteralPath (Join-Path $h 'runtime\pty') -Directory -ErrorAction SilentlyContinue | ForEach-Object { "  runtime\pty\$($_.Name)\harness-pty.exe: $(Test-Path -LiteralPath (Join-Path $_.FullName 'harness-pty.exe'))" }
Write-Output "  bin\harness.exe: $(Test-Path -LiteralPath (Join-Path $h 'bin\harness.exe'))"
$data = if ($env:ADAPTER_DATA_DIR) { $env:ADAPTER_DATA_DIR } else { Join-Path $h 'cli\data' }
$record = Join-Path $data 'daemon-18473.json'
if (Test-Path -LiteralPath $record) {
  $r = Get-Content -Raw -LiteralPath $record | ConvertFrom-Json
  Write-Output "  daemon-18473.json: port $($r.port), pipe $($r.pipe), core pid $($r.pid)"
} else { Write-Output '  daemon-18473.json: (absent)' }
$token = Join-Path $data 'daemon-token'
Write-Output "  daemon-token: $(if (Test-Path -LiteralPath $token) { "$((Get-Item -LiteralPath $token).Length) bytes" } else { '(absent)' })"
Write-Output "  Harness tasks of this user: $(@(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object { $_.TaskName -eq "Harness harnessd ($env:USERNAME)" }).Count)"
