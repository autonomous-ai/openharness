# Headless fixture: only synthetic process records and newly created temp files. No GUI/product entry point,
# Get-Process, CIM, token API, account, service, clipboard or network action is invoked.
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'app-processes.ps1')
$dir = Join-Path ([IO.Path]::GetTempPath()) ('harness-app-selection-' + [guid]::NewGuid().ToString('N'))
$created = $false
$fail = 0
function Check([string]$Name, [bool]$Pass) {
  if ($Pass) { Write-Output "ok   $Name" } else { Write-Output "FAIL $Name"; $script:fail++ }
}
try {
  New-Item -ItemType Directory -Path $dir | Out-Null
  $created = $true
  $launcher = Join-Path $dir 'Harness.exe'
  [IO.File]::WriteAllText($launcher, 'fixture, never executed')
  [IO.File]::WriteAllText((Join-Path $dir 'current'), "1.4.0`r`n")
  [IO.File]::WriteAllText((Join-Path $dir 'Harness.ico'), 'fixture')
  New-Item -ItemType Directory -Path (Join-Path $dir 'app\1.4.0') | Out-Null
  $cliDir = Join-Path $dir 'cli-bin'
  New-Item -ItemType Directory -Path $cliDir | Out-Null
  $cliImage = Join-Path $cliDir 'harness.exe'
  [IO.File]::WriteAllText($cliImage, 'CLI fixture, never executed')
  $sid = 'S-1-5-21-1-2-3-1005'
  $app = [pscustomobject]@{Id=1;SessionId=11;OwnerSid=$sid;ImagePath=(Join-Path $dir 'app\1.4.0\harness-desktop.exe');StartTime=[DateTime]::UtcNow}
  $foreign = [pscustomobject]@{Id=2;SessionId=22}
  foreach ($property in 'OwnerSid', 'ImagePath', 'StartTime') {
    $foreign | Add-Member -MemberType ScriptProperty -Name $property -Value { throw 'foreign-session property was inspected' }
  }
  $cli = [pscustomobject]@{Id=3;SessionId=11;OwnerSid=$sid;ImagePath=$cliImage}
  $cli | Add-Member -MemberType ScriptProperty -Name StartTime -Value { throw 'CLI timestamp was inspected' }
  $desktopLauncher = [pscustomobject]@{Id=4;SessionId=11;OwnerSid=$sid;ImagePath=$launcher;StartTime=[DateTime]::UtcNow}
  $otherSid = [pscustomobject]@{Id=5;SessionId=11;OwnerSid='S-1-5-21-1-2-3-1006'}
  $otherSid | Add-Member -MemberType ScriptProperty -Name ImagePath -Value { throw 'another SID image was inspected' }
  $readSid = { param($process) $process.OwnerSid }
  $readImage = { param($process) $process.ImagePath }
  $selected = @(Select-OwnedDesktopProcesses -Candidates @($app,$foreign,$cli,$desktopLauncher,$otherSid) -SessionId 11 -OwnerSid $sid -ReadOwnerSid $readSid -ReadImagePath $readImage)
  Check 'owned app and positively identified desktop launcher only' ((@($selected.Id | Sort-Object) -join ',') -eq '1,4')
  Check 'single-instance app count excludes preserved session and CLI' (@($selected | Where-Object { $_.Kind -eq 'app' }).Count -eq 1)
  Check 'case-insensitive CLI name is not desktop launcher identity' (-not (Test-DesktopLauncherImage $cliImage))
  $empty = @(Select-OwnedDesktopProcesses -Candidates @() -SessionId 11 -OwnerSid $sid -ReadOwnerSid $readSid -ReadImagePath $readImage)
  Check 'no candidates is an empty owned snapshot' ($empty.Count -eq 0)
  $unknownFailed = $false
  try { Select-OwnedDesktopProcesses -Candidates @($app) -SessionId 11 -OwnerSid $sid -ReadOwnerSid { $null } -ReadImagePath $readImage | Out-Null }
  catch { $unknownFailed = $_.Exception.Message -like '*unverified ownership*' }
  Check 'unknown SID cannot manufacture a desktop count' $unknownFailed
} finally {
  if ($created) { Remove-Item -LiteralPath $dir -Recurse -Force }
}
Write-Output "$fail check(s) failed"
exit $fail
