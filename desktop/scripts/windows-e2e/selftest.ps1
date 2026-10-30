# selftest.ps1: the session tools work on this machine before a scenario relies on them. Run in the desktop session
# (desktop-e2e.sh run selftest.ps1). One line per check, ok or FAIL; the exit code counts the failures.
param([string]$ClipboardMarker = '')
$ErrorActionPreference = 'Continue'
. (Join-Path $PSScriptRoot 'ownership.ps1')
$owned = Assert-OwnedSession
if (-not $ClipboardMarker) { $ClipboardMarker = 'HX_E2E_' + $owned.run_id + '_' + [guid]::NewGuid().ToString('N') }
$script:fail = 0
function Check([string]$What, [bool]$Ok, [string]$Detail = '') {
  if ($Ok) { Write-Output "ok   $What $Detail" } else { Write-Output "FAIL $What $Detail"; $script:fail++ }
}
$here = $PSScriptRoot
$shot = & (Join-Path $here 'screenshot.ps1') -Out 'shots\selftest.png'
$png = Join-Path $here 'shots\selftest.png'
Check 'screenshot' ((Test-Path -LiteralPath $png) -and (Get-Item -LiteralPath $png).Length -gt 10000) "$shot"
& (Join-Path $here 'clipboard.ps1') -Text $ClipboardMarker | Out-Null
Add-Type -AssemblyName System.Windows.Forms
Check 'clipboard text round trip' ([System.Windows.Forms.Clipboard]::GetText() -eq $ClipboardMarker)
& (Join-Path $here 'input.ps1') -X 40 -Y 40 | Out-Null
$pos = [System.Windows.Forms.Cursor]::Position
Check 'the pointer moves to screen pixels' ($pos.X -eq 40 -and $pos.Y -eq 40) "($($pos.X),$($pos.Y))"
$tray = @(& (Join-Path $here 'uia.ps1') -Root Tray -Do List -Depth 3)
Check 'UI Automation sees the taskbar' ((($tray | Out-String) -match 'Taskbar')) "$($tray.Count) elements"
$watch = @(& (Join-Path $here 'watch-windows.ps1') -Seconds 6 -Probe)
Check 'the console-window detector sees a console' ((($watch | Out-String) -match 'probe: seen'))
Write-Output "$($script:fail) check(s) failed"
exit $script:fail
