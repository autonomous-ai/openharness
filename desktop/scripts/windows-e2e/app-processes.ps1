# Pure process selection shared by launch waiting/reporting. Readers run only after session/SID checks.
function Test-DesktopLauncherImage([string]$ImagePath) {
  if ([IO.Path]::GetFileName($ImagePath) -ine 'Harness.exe') { return $false }
  $dir = Split-Path -Parent $ImagePath
  $current = Join-Path $dir 'current'
  if (-not (Test-Path -LiteralPath $current -PathType Leaf) -or
      -not (Test-Path -LiteralPath (Join-Path $dir 'Harness.ico') -PathType Leaf)) { return $false }
  if ((Get-Item -LiteralPath $current).Length -gt 512) { return $false }
  $version = [IO.File]::ReadAllText($current).Trim()
  if (-not $version -or $version -eq '.' -or $version -eq '..' -or $version -match '[\\/:\x00\r\n]') { return $false }
  # The CLI has the same case-insensitive executable name. Only the desktop launcher's install/zip layout
  # has these siblings; an EXE filename or case alone is not evidence of a desktop launcher.
  return Test-Path -LiteralPath (Join-Path $dir "app\$version") -PathType Container
}

function Select-OwnedDesktopProcesses {
  param(
    [Parameter(Mandatory)][AllowEmptyCollection()][object[]]$Candidates,
    [Parameter(Mandatory)][int]$SessionId,
    [Parameter(Mandatory)][string]$OwnerSid,
    [Parameter(Mandatory)][scriptblock]$ReadOwnerSid,
    [Parameter(Mandatory)][scriptblock]$ReadImagePath
  )
  foreach ($candidate in $Candidates) {
    # Do not read a foreign session's token, image, timestamps or windows.
    if ($candidate.SessionId -ne $SessionId) { continue }
    $sid = & $ReadOwnerSid $candidate
    if (-not $sid) { throw "unverified ownership of process $($candidate.Id); no desktop count can be claimed" }
    if ($sid -ne $OwnerSid) { continue }
    $image = & $ReadImagePath $candidate
    if (-not $image) { throw "unverified image of owned process $($candidate.Id)" }
    $name = [IO.Path]::GetFileName($image)
    if ($name -ieq 'harness-desktop.exe') { $kind = 'app' }
    elseif (Test-DesktopLauncherImage $image) { $kind = 'launcher' }
    else { continue }
    [pscustomobject]@{Id=$candidate.Id;Kind=$kind;ProcessName=[IO.Path]::GetFileNameWithoutExtension($image);
      Path=$image;StartTime=$candidate.StartTime}
  }
}
