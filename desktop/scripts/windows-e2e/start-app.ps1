# start-app.ps1 -Path <exe or .lnk> [-ArgumentList <args>] | -Url <link> | -Report   [-Repeat 1] [-WaitSec 60] [-NoWait]
# Start Harness in the desktop session as a person would (session-run.ps1): -Path runs a program or shortcut (the
# zip's Harness.exe, the installed launcher, the Start Menu shortcut; %VARS% are expanded, a relative path is under
# %USERPROFILE%); -Url opens a link through the shell, the way a browser hands harness:// to Windows. -Repeat starts it
# that many times 300 ms apart (a second launch while the first is starting). Then it waits for a Harness window and
# says what runs. -Report only says what runs: each harness-desktop.exe and Harness.exe with its start time, path and
# visible windows.
param([string]$Path, [string[]]$ArgumentList = @(), [string]$Url, [switch]$Report, [int]$Repeat = 1, [int]$WaitSec = 60, [switch]$NoWait)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedSession | Out-Null
Add-Type -Namespace HxE2E -Name Windows -MemberDefinition @'
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
public static System.Collections.Generic.List<string> Visible(uint pid) {
  var list = new System.Collections.Generic.List<string>();
  EnumWindows(delegate (IntPtr h, IntPtr l) {
    uint p;
    GetWindowThreadProcessId(h, out p);
    if (p == pid && IsWindowVisible(h)) {
      var t = new System.Text.StringBuilder(256);
      GetWindowText(h, t, 256);
      if (t.Length > 0) list.Add(t.ToString());
    }
    return true;
  }, IntPtr.Zero);
  return list;
}
'@

function Show-Running {
  $all = @(Get-Process -Name 'harness-desktop', 'Harness' -ErrorAction SilentlyContinue)
  if (-not $all.Count) { Write-Output 'running: no harness-desktop.exe or Harness.exe' }
  foreach ($p in $all) {
    $windows = @([HxE2E.Windows]::Visible([uint32]$p.Id))
    Write-Output ('running: {0} pid {1} since {2:HH:mm:ss} {3} windows {4} {5}' -f $p.ProcessName, $p.Id, $p.StartTime, $p.Path, $windows.Count, (($windows | ForEach-Object { '"' + $_ + '"' }) -join ' '))
  }
  $apps = @($all | Where-Object { $_.ProcessName -eq 'harness-desktop' })
  $visible = 0
  foreach ($p in $apps) { $visible += @([HxE2E.Windows]::Visible([uint32]$p.Id)).Count }
  Write-Output "harness-desktop.exe processes: $($apps.Count); visible windows: $visible"
}

if ($Report) { Show-Running; exit 0 }
if (-not $Url -and -not $Path) { Write-Output 'usage: start-app.ps1 -Path <exe> [-ArgumentList ...] | -Url <link> | -Report'; exit 2 }
if ($Path) {
  $Path = [Environment]::ExpandEnvironmentVariables($Path)
  if (-not [IO.Path]::IsPathRooted($Path)) { $Path = Join-Path $env:USERPROFILE $Path }
  if (-not (Test-Path -LiteralPath $Path)) { Write-Output "no such file: $Path"; exit 1 }
}
$t0 = Get-Date
for ($i = 1; $i -le [Math]::Max(1, $Repeat); $i++) {
  if ($Url) { Start-Process -FilePath $Url }
  elseif ($ArgumentList.Count) { Start-Process -FilePath $Path -ArgumentList $ArgumentList }
  else { Start-Process -FilePath $Path }
  if ($i -lt $Repeat) { Start-Sleep -Milliseconds 300 }
}
Write-Output "started $(if ($Url) { $Url } else { "$Path $($ArgumentList -join ' ')" }) x$([Math]::Max(1, $Repeat)) at $($t0.ToString('HH:mm:ss.fff'))"
if ($NoWait) { exit 0 }
$up = @()
$deadline = $t0.AddSeconds($WaitSec)
do {
  $up = @(Get-Process -Name 'harness-desktop' -ErrorAction SilentlyContinue | Where-Object { @([HxE2E.Windows]::Visible([uint32]$_.Id)).Count -gt 0 })
  if ($up.Count) { Write-Output ('a Harness window after {0:N1} s' -f ((Get-Date) - $t0).TotalSeconds); break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
if (-not $up.Count) { Write-Output "no Harness window within $WaitSec s" }
Show-Running
