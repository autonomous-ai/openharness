# dial-state.ps1 [-Lines 8]: read-only dial state for the owned user's daemon (E5).
# Report settings names, not values; public evidence must not contain full device or computer identifiers.
param([ValidateRange(1, 100)][int]$Lines = 8)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedUser | Out-Null

function Short([string]$Text) {
  if ($Text -and $Text.Length -gt 8) { $Text.Substring(0, 8) + '...' } else { '(redacted)' }
}
function Scrub([string]$Text) {
  $Text = $Text -replace '(?i)(x-harness-(?:auth|proof):)\s*\S+', '$1 <redacted>'
  $Text = $Text -replace '(?i)\bBearer\s+[A-Za-z0-9._~+/=-]+', 'Bearer <token>'
  $Text = $Text -replace '\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+', '<token>'
  $Text = $Text -replace '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b', '<email>'
  $Text = $Text -replace '(?i)\b((?:[0-9a-f]{2}:){2}[0-9a-f]{2})(?::[0-9a-f]{2}){3}\b', '$1:...'
  $Text = $Text -replace '(?i)\b([0-9a-f]{8})-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', '$1...'
  $Text = $Text -replace '(?i)\b([0-9a-f]{8})[0-9a-f]{4,}\b', '$1...'
  $Text -replace 'usb-[^\s\\/]+', 'usb-<id>'
}

$code = 0
$harness = Join-Path $env:USERPROFILE '.harness\bin\harness.exe'
if (Test-Path -LiteralPath $harness -PathType Leaf) {
  try {
    $raw = (& $harness hardware list --json 2>&1) -join "`n"
    if ($LASTEXITCODE -ne 0) { throw 'hardware list failed' }
    $doc = $raw | ConvertFrom-Json
    if ($null -eq $doc -or -not $doc.PSObject.Properties['hosts']) { throw 'no hosts document' }
    foreach ($h in @($doc.hosts)) {
      $devices = @()
      # Fleet snapshots can be empty; only the legacy single-device shape has an id on status itself.
      if ($null -ne $h.status.devices) { $devices = @($h.status.devices | Where-Object { $null -ne $_ }) }
      elseif ($h.status.id) { $devices = @($h.status) }
      "host $(Short $h.machineId) online=$($h.online) available=$($h.available) devices=$($devices.Count)"
      foreach ($d in $devices) {
        $names = if ($d.settings) { ($d.settings.PSObject.Properties.Name | Sort-Object) -join ',' } else { '(none)' }
        Scrub "  device $(Short $d.id) attached=$($d.attached) fw=$($d.fw) hw=$($d.hw) settings=$names updating=$($d.updating)"
      }
    }
  } catch {
    # Failed CLI output can include account details or the entire response; never echo it into evidence.
    'hardware list unavailable (command failed or invalid JSON)'
    $code = 1
  }
} else { 'hardware list unavailable (CLI not installed)'; $code = 1 }

$serial = @(Get-Process -Name 'harness-serial' -ErrorAction SilentlyContinue | Where-Object {
  $_.Path -and $_.Path.StartsWith("$env:USERPROFILE\", [StringComparison]::OrdinalIgnoreCase)
})
"harness-serial processes of this user: $($serial.Count)"
$logs = Join-Path $env:USERPROFILE '.harness\logs'
$log = Get-ChildItem -LiteralPath $logs -Filter 'dial-*.log' -Recurse -File -ErrorAction SilentlyContinue |
  Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $log) { 'dial log: (none yet)'; exit $code }
Scrub "dial log: $($log.Directory.Name)\$($log.Name)"
$tail = Get-Content -LiteralPath $log.FullName -Tail 600
$tail | Select-String -Pattern 'alive up=' | Select-Object -Last 3 | ForEach-Object { '  ' + (Scrub $_.Line) }
# CableSession writes its cable: events into DialLog as [daemon], with cable: removed.
$tail | Select-String -Pattern 'cable:|\[daemon\]' | Select-Object -Last $Lines | ForEach-Object {
  '  ' + (Scrub ($_.Line -replace '\[daemon\]\s*', 'cable: '))
}
exit $code
