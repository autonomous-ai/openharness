# screenshot.ps1 -Out <png> [-Window <process name>] [-Mask "x,y,w,h;x,y,w,h"]: the screen as this user sees it, run
# in the desktop session (session-run.ps1). Layered windows (toasts, menus) are captured too (CAPTUREBLT). -Window
# crops to that process's main window; -Mask paints black boxes (screen pixels) over anything that must not reach the
# public evidence: an email address, a machine name, a QR code or a sign-in code. A relative -Out is beside this script.
param([Parameter(Mandatory)][string]$Out, [string]$Window, [string]$Mask)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedSession | Out-Null
Add-Type -Namespace HxE2E -Name Shot -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
'@
[HxE2E.Shot]::SetProcessDPIAware() | Out-Null
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
if (-not [IO.Path]::IsPathRooted($Out)) { $Out = Join-Path $PSScriptRoot $Out }
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
if ($Window) {
  $p = Get-Process -Name $Window -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } | Select-Object -First 1
  if (-not $p) { Write-Output "no window of ${Window}: the whole screen is taken" }
  else {
    $r = New-Object HxE2E.Shot+RECT
    [HxE2E.Shot]::GetWindowRect($p.MainWindowHandle, [ref]$r) | Out-Null
    $bounds = New-Object System.Drawing.Rectangle $r.Left, $r.Top, ($r.Right - $r.Left), ($r.Bottom - $r.Top)
  }
}
$bitmap = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$copy = [System.Drawing.CopyPixelOperation]::SourceCopy -bor [System.Drawing.CopyPixelOperation]::CaptureBlt
$graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bitmap.Size, $copy)
if ($Mask) {
  foreach ($box in $Mask.Split(';')) {
    $n = @($box.Split(',') | ForEach-Object { [int]$_ })
    if ($n.Count -ne 4) { throw "a mask box is x,y,w,h: '$box'" }
    $graphics.FillRectangle([System.Drawing.Brushes]::Black, $n[0] - $bounds.Left, $n[1] - $bounds.Top, $n[2], $n[3])
  }
}
$graphics.Dispose()
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Out) | Out-Null
$bitmap.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()
Write-Output "screenshot $Out ($($bounds.Width)x$($bounds.Height) at $($bounds.Left),$($bounds.Top)$(if ($Mask) { ", masked" }))"
