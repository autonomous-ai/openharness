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
$owned = Assert-OwnedSession
. (Join-Path $PSScriptRoot 'app-processes.ps1')
Add-Type -Namespace HxE2E -Name Windows -MemberDefinition @'
public delegate bool EnumProc(IntPtr h, IntPtr l);
[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
[DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
[DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
[DllImport("advapi32.dll", SetLastError=true)] static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
[DllImport("advapi32.dll", SetLastError=true)] static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr data, int length, out int needed);
[DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, System.Text.StringBuilder path, ref uint length);
public static string OwnerSid(uint pid) {
  IntPtr process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
  if (process == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
  IntPtr token = IntPtr.Zero;
  try {
    if (!OpenProcessToken(process, 8, out token)) throw new System.ComponentModel.Win32Exception(); // TOKEN_QUERY
    int needed;
    GetTokenInformation(token, 1, IntPtr.Zero, 0, out needed); // TokenUser
    if (needed <= 0) throw new System.ComponentModel.Win32Exception();
    IntPtr data = Marshal.AllocHGlobal(needed);
    try {
      if (!GetTokenInformation(token, 1, data, needed, out needed)) throw new System.ComponentModel.Win32Exception();
      return new System.Security.Principal.SecurityIdentifier(Marshal.ReadIntPtr(data)).Value;
    } finally { Marshal.FreeHGlobal(data); }
  } finally { if (token != IntPtr.Zero) CloseHandle(token); CloseHandle(process); }
}
public static string ImagePath(uint pid) {
  IntPtr process = OpenProcess(0x1000, false, pid);
  if (process == IntPtr.Zero) throw new System.ComponentModel.Win32Exception();
  try {
    uint length = 32768;
    var path = new System.Text.StringBuilder((int)length);
    if (!QueryFullProcessImageName(process, 0, path, ref length)) throw new System.ComponentModel.Win32Exception();
    return path.ToString();
  } finally { CloseHandle(process); }
}
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

function Get-OwnedAppProcesses {
  Select-OwnedDesktopProcesses -Candidates @(Get-Process -Name 'harness-desktop', 'Harness' -ErrorAction SilentlyContinue) `
    -SessionId ([Diagnostics.Process]::GetCurrentProcess().SessionId) -OwnerSid $owned.sid `
    -ReadOwnerSid { param($process) [HxE2E.Windows]::OwnerSid([uint32]$process.Id) } `
    -ReadImagePath { param($process) [HxE2E.Windows]::ImagePath([uint32]$process.Id) }
}

function Show-Running {
  $all = @(Get-OwnedAppProcesses)
  if (-not $all.Count) { Write-Output 'running: no harness-desktop.exe or Harness.exe' }
  foreach ($p in $all) {
    $windows = @([HxE2E.Windows]::Visible([uint32]$p.Id))
    Write-Output ('running: {0} pid {1} since {2:HH:mm:ss} {3} windows {4} {5}' -f $p.ProcessName, $p.Id, $p.StartTime, $p.Path, $windows.Count, (($windows | ForEach-Object { '"' + $_ + '"' }) -join ' '))
  }
  $apps = @($all | Where-Object { $_.Kind -eq 'app' })
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
  $up = @(Get-OwnedAppProcesses | Where-Object { $_.Kind -eq 'app' -and @([HxE2E.Windows]::Visible([uint32]$_.Id)).Count -gt 0 })
  if ($up.Count) { Write-Output ('a Harness window after {0:N1} s' -f ((Get-Date) - $t0).TotalSeconds); break }
  Start-Sleep -Milliseconds 250
} while ((Get-Date) -lt $deadline)
if (-not $up.Count) { Write-Output "no Harness window within $WaitSec s" }
Show-Running
