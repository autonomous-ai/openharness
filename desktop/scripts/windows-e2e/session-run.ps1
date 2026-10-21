# session-run.ps1 -User <name> -Script <file> [-ArgsB64 <b64>] [-TimeoutSec 120] [-NoWait] | -User <name> -Probe
# Run a script of the user's e2e folder (C:\Users\<name>\e2e) INSIDE that user's desktop session, as a one-shot
# scheduled task with an interactive logon: a GUI app it starts has a desktop, a screenshot sees the screen, and
# input reaches the windows. Run as an administrator (desktop-e2e.sh run). The user must be signed in at the desktop
# (root establishes it without reboot or admin signout). No password is stored: an interactive task runs only in the existing session.
# The task starts hxrun.exe (compiled here once, a GUI program), which runs PowerShell with no console window, so
# nothing of the tooling flashes on the screen the run is checking. The output comes back on stdout, then the task is
# deleted. -NoWait leaves it running (keep-awake.ps1) and prints its name; cleanup.ps1 deletes those.
# -Probe only says whether the user has a desktop session (exit 0) or not (exit 3).
param(
  [Parameter(Mandatory)][string]$User,
  [Parameter(Mandatory)][string]$RunId,
  [string]$Script,
  [string]$ArgsB64 = '',
  [int]$TimeoutSec = 120,
  [switch]$NoWait,
  [switch]$Probe
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
. (Join-Path $PSScriptRoot 'ownership.ps1')
$owner = Read-Owner $User $RunId

function Get-DesktopSession([string]$Name) {
  foreach ($p in @(Get-CimInstance Win32_Process -Filter "Name='explorer.exe'")) {
    $owner = Invoke-CimMethod -InputObject $p -MethodName GetOwner
    if ($owner.User -eq $Name) {
      if (-not ('HxConsoleSession.Native' -as [type])) { Add-Type -Namespace HxConsoleSession -Name Native -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint WTSGetActiveConsoleSessionId();' }
      if ($p.SessionId -eq [HxConsoleSession.Native]::WTSGetActiveConsoleSessionId()) { return $p.SessionId }
    }
  }
  return $null
}

$session = Get-DesktopSession $User
if ($Probe) {
  if ($null -ne $session) { Write-Output "$User has desktop session $session"; exit 0 }
  Write-Output "$User has no desktop session"; exit 3
}
if ($null -eq $session) { Write-Output "$User is not signed in at the desktop: root must establish an owned active unlocked session without reboot/admin signout"; exit 3 }
if (-not $Script -or $Script -notmatch '^[a-z][a-z0-9-]*\.ps1$') { Write-Output 'usage: session-run.ps1 -User <name> -Script <file> [-ArgsB64 <b64>] [-TimeoutSec n] [-NoWait] | -Probe'; exit 2 }

$sid = $owner.sid
$profilePath = (Get-CimInstance Win32_UserProfile -Filter "SID='$sid'").LocalPath
if (-not [string]::Equals($profilePath, $owner.profile, [StringComparison]::OrdinalIgnoreCase)) { throw 'owned profile changed' }
$dir = Join-Path $profilePath 'e2e'
if (-not (Test-Path -LiteralPath (Join-Path $dir $Script) -PathType Leaf)) { Write-Output "no script $Script in $dir (desktop-e2e.sh push copies them)"; exit 2 }

$hxrun = Join-Path $dir 'hxrun.exe'
if (-not (Test-Path -LiteralPath $hxrun)) {
  Add-Type -OutputType WindowsApplication -OutputAssembly $hxrun -TypeDefinition @'
using System.Diagnostics;
public static class HxRun {
  // hxrun.exe <script.ps1>: Windows PowerShell with no console window; its exit code is passed back.
  public static int Main(string[] args) {
    var shell = System.Environment.ExpandEnvironmentVariables(@"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe");
    var start = new ProcessStartInfo(shell, "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"" + args[0] + "\"");
    start.UseShellExecute = false;
    start.CreateNoWindow = true;
    using (var p = Process.Start(start)) { p.WaitForExit(); return p.ExitCode; }
  }
}
'@
}

function Quote([string]$Text) { "'" + $Text.Replace("'", "''") + "'" }
$id = 'HxDesktopE2E-' + $User + '-' + [guid]::NewGuid().ToString('N')
$wrapper = Join-Path $dir "$id.ps1"
$out = Join-Path $dir "$id.out"
$done = Join-Path $dir "$id.done"
@"
`$ErrorActionPreference = 'Continue'
`$ProgressPreference = 'SilentlyContinue'
`$global:LASTEXITCODE = 0
`$code = 0
try {
  . $(Quote (Join-Path $dir 'ownership.ps1'))
  Assert-OwnedSession | Out-Null
  & $(Quote (Join-Path $dir 'invoke.ps1')) -Script $(Quote $Script) -ArgsB64 $(Quote $ArgsB64) -RunId $(Quote $RunId) *> $(Quote $out)
  `$code = `$LASTEXITCODE
} catch {
  "`$_" | Out-File -Append -LiteralPath $(Quote $out) -Encoding utf8
  `$code = 1
}
Set-Content -LiteralPath $(Quote $done) -Value `$code -Encoding ascii
"@ | Set-Content -LiteralPath $wrapper -Encoding utf8

$action = New-ScheduledTaskAction -Execute $hxrun -Argument ('"' + $wrapper + '"')
$principal = New-ScheduledTaskPrincipal -UserId $sid -LogonType Interactive -RunLevel Limited
$limit = if ($NoWait) { New-TimeSpan -Hours 8 } else { New-TimeSpan -Seconds ($TimeoutSec + 60) }
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit $limit -MultipleInstances IgnoreNew
# Record intent before creation; a name collision is never overwritten or adopted.
if (Get-ScheduledTask -TaskName $id -ErrorAction SilentlyContinue) { throw 'task name already exists' }
Record-OwnedTask $User $RunId $id $Script $false
Register-ScheduledTask -TaskName $id -Action $action -Principal $principal -Settings $settings | Out-Null
Record-OwnedTask $User $RunId $id $Script $true
$keep = $false
$code = 124
try {
  Start-ScheduledTask -TaskName $id
  if ($NoWait) { $keep = $true; Write-Output "started $id (left running; cleanup.ps1 deletes it)"; $code = 0; return }
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  $startBy = (Get-Date).AddSeconds(20)
  while (-not (Test-Path -LiteralPath $done)) {
    if ((Get-Date) -gt $deadline) { Stop-ScheduledTask -TaskName $id -ErrorAction SilentlyContinue; Write-Output "timed out after $TimeoutSec s: $Script"; break }
    if ((Get-Date) -gt $startBy -and -not (Test-Path -LiteralPath $out)) {
      Write-Output "the task did not start (last result $((Get-ScheduledTaskInfo -TaskName $id).LastTaskResult)): is $User signed in at the desktop?"
      Stop-ScheduledTask -TaskName $id -ErrorAction SilentlyContinue
      break
    }
    Start-Sleep -Milliseconds 300
  }
  if (Test-Path -LiteralPath $out) { Get-Content -LiteralPath $out }
  if (Test-Path -LiteralPath $done) { $code = [int](Get-Content -LiteralPath $done -Raw).Trim() }
} finally {
  if (-not $keep) {
    Stop-ScheduledTask -TaskName $id -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $id -Confirm:$false -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $wrapper, $out, $done -Force -ErrorAction SilentlyContinue
  }
}
exit $code
