# input.ps1 [-Focus <process>] [-X <px> -Y <px> [-Right] [-Double]] [-Keys <SendKeys>] [-Text <text>]: a person's
# hands, in the desktop session (session-run.ps1): bring a window to the front, click at screen pixels, press keys
# (SendKeys syntax: ^v is Ctrl+V, ^+c Ctrl+Shift+C, {ENTER}, {ESC}), or type text as it is. In that order, each once.
param([string]$Focus, [int]$X = -1, [int]$Y = -1, [switch]$Right, [switch]$Double, [string]$Keys, [string]$Text, [int]$DelayMs = 250)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedSession | Out-Null
Add-Type -Namespace HxE2E -Name Input -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int command);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, IntPtr pid);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint from, uint to, bool attach);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@
[HxE2E.Input]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms

if ($Focus) {
  $p = Get-Process -Name $Focus -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
  if (-not $p) { Write-Output "no window of $Focus to bring to the front"; exit 1 }
  $h = $p.MainWindowHandle
  if ([HxE2E.Input]::IsIconic($h)) { [HxE2E.Input]::ShowWindow($h, 9) | Out-Null }
  # Windows gives the foreground only to the thread that has the input; attach to it for the call.
  $front = [HxE2E.Input]::GetWindowThreadProcessId([HxE2E.Input]::GetForegroundWindow(), [IntPtr]::Zero)
  $me = [HxE2E.Input]::GetCurrentThreadId()
  [HxE2E.Input]::AttachThreadInput($me, $front, $true) | Out-Null
  [HxE2E.Input]::BringWindowToTop($h) | Out-Null
  $ok = [HxE2E.Input]::SetForegroundWindow($h)
  [HxE2E.Input]::AttachThreadInput($me, $front, $false) | Out-Null
  Write-Output "front: $Focus (pid $($p.Id)) $ok"
  Start-Sleep -Milliseconds $DelayMs
}
if ($X -ge 0 -and $Y -ge 0) {
  [HxE2E.Input]::SetCursorPos($X, $Y) | Out-Null
  $down, $up = if ($Right) { 0x0008, 0x0010 } else { 0x0002, 0x0004 }
  $times = if ($Double) { 2 } else { 1 }
  for ($i = 0; $i -lt $times; $i++) {
    [HxE2E.Input]::mouse_event($down, 0, 0, 0, [UIntPtr]::Zero)
    [HxE2E.Input]::mouse_event($up, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
  }
  Write-Output "$(if ($Right) { 'right ' })$(if ($Double) { 'double ' })click at $X,$Y"
  Start-Sleep -Milliseconds $DelayMs
}
if ($Keys) { [System.Windows.Forms.SendKeys]::SendWait($Keys); Write-Output "keys $Keys"; Start-Sleep -Milliseconds $DelayMs }
if ($Text) {
  $escaped = -join ($Text.ToCharArray() | ForEach-Object { if ('+^%~(){}[]'.Contains([string]$_)) { '{' + $_ + '}' } else { [string]$_ } })
  [System.Windows.Forms.SendKeys]::SendWait($escaped)
  Write-Output "typed $($Text.Length) characters"
}
