# hold-port.ps1 [-Port COM3] [-Seconds 30]: hold a COM port like a serial monitor (E5 scenario 5).
# Always dispose the handle, so the daemon can take the dial when the hold ends or opening fails.
param([string]$Port = 'COM3', [ValidateRange(1, 300)][int]$Seconds = 30)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedUser | Out-Null
if ($Port -cnotmatch '^COM[1-9][0-9]{0,2}$') { throw 'Port must be COM1 through COM999' }
$sp = New-Object System.IO.Ports.SerialPort $Port, 115200
try {
  try { $sp.Open() } catch { "could not open $Port (unavailable or in use)"; exit 3 }
  "holding $Port for $Seconds s"
  Start-Sleep -Seconds $Seconds
} finally { $sp.Dispose() }
"released $Port"
exit 0
