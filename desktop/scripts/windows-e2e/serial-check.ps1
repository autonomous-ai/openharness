# serial-check.ps1 [-Port COM3] [-Seconds 10] [-WatchOnly]: does opening the dial reset it? (E1.3, spec 1.2)
# Watch the attachment session, read the open port, then watch again. A reset must not change the session,
# end the open, or send an ESP-ROM banner. -WatchOnly opens nothing (E5 scenarios 4 and 7).
# Run as administrator with nothing else holding the port. Never print raw watch/error/device bytes.
param([string]$Port = 'COM3', [int]$Seconds = 10, [switch]$WatchOnly)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$exe = Join-Path $PSScriptRoot 'harness-serial.exe'
$p = $null
$failure = 'serial check failed'

function Start-Serial([string]$Arguments) {
  $info = New-Object Diagnostics.ProcessStartInfo
  $info.FileName = $exe
  $info.Arguments = $Arguments # Only fixed keywords and a validated COM name.
  $info.UseShellExecute = $false
  $info.RedirectStandardInput = $true
  $info.RedirectStandardOutput = $true
  $info.RedirectStandardError = $true
  $info.CreateNoWindow = $true
  [Diagnostics.Process]::Start($info)
}

function Stop-Serial([Diagnostics.Process]$Child) {
  if ($null -eq $Child) { return }
  try {
    if (-not $Child.HasExited) {
      $Child.Kill()
      if (-not $Child.WaitForExit(5000)) { throw 'serial child did not stop' }
    }
  } finally { $Child.Dispose() }
}

function Get-Dial {
  $watch = $null
  try {
    $watch = Start-Serial 'watch'
    # Drain stderr concurrently; a failing helper must not fill its pipe and deadlock startup/exit.
    $errors = $watch.StandardError.ReadToEndAsync()
    $line = $watch.StandardOutput.ReadLineAsync()
    if (-not $line.Wait(5000)) { throw 'watch startup deadline exceeded' }
    $watch.StandardInput.Close()
    if (-not $watch.WaitForExit(5000)) { throw 'watch did not end at end of stdin' }
    if (-not $errors.Wait(5000)) { throw 'watch stderr deadline exceeded' }
    if ($watch.ExitCode -ne 0 -or $errors.Result.Trim()) { throw 'watch failed' }
    # Parsing and all later errors are caught below without printing the raw line or exception text.
    $state = $line.Result | ConvertFrom-Json
    $dial = @($state.ports | Where-Object { $_.path -ceq $Port })
    if ($state.console -isnot [bool] -or $dial.Count -ne 1) { throw 'watch did not list one dial' }
    if ($dial[0].session -isnot [string] -or [string]::IsNullOrWhiteSpace($dial[0].session)) {
      throw 'watch did not supply an attachment session'
    }
    [pscustomobject]@{ console = $state.console; session = $dial[0].session; serial = $dial[0].serialNumber }
  } finally { Stop-Serial $watch }
}

try {
  $failure = 'invalid input or missing harness-serial.exe; put-admin the binary first'
  if (-not (Test-Path -LiteralPath $exe -PathType Leaf)) { throw 'missing binary' }
  if ($Port -cnotmatch '^COM[1-9][0-9]{0,2}$') { throw 'invalid COM port' }
  if ($Seconds -lt 1 -or $Seconds -gt 300) { throw 'Seconds must be between 1 and 300' }

  $failure = 'watch failed before opening the dial (missing dial/session, helper error or timeout)'
  $before = Get-Dial
  if ($WatchOnly) {
    $session = $before.session
    if ($before.serial) { $session = $session.Replace([string]$before.serial, '(redacted)') }
    "session: $session"
    "console session: $($before.console)"
    exit 0
  }

  $failure = 'open failed (helper error or startup/read/exit timeout)'
  $p = Start-Serial "open $Port"
  $firstRead = $p.StandardError.ReadLineAsync()
  $buffer = New-Object byte[] 65536
  $stream = $p.StandardOutput.BaseStream
  $read = $stream.ReadAsync($buffer, 0, $buffer.Length)
  if (-not $firstRead.Wait(5000)) { throw 'open startup deadline exceeded' }
  $first = $firstRead.Result
  $rest = $p.StandardError.ReadToEndAsync()
  $opened = $first -ceq 'open'
  $bytes = [long]0
  $banner = $false
  $tail = ''
  $eof = $false
  $clock = [Diagnostics.Stopwatch]::StartNew()
  while ($opened -and $clock.Elapsed.TotalSeconds -lt $Seconds -and -not $p.HasExited) {
    if ($read.Wait(200)) {
      if ($read.Result -eq 0) { $eof = $true; break }
      $bytes += $read.Result
      # Keep only the banner overlap, so split reads are detected without retaining raw device output.
      $text = $tail + [Text.Encoding]::ASCII.GetString($buffer, 0, $read.Result)
      $banner = $banner -or $text.Contains('ESP-ROM:')
      $tail = $text.Substring([Math]::Max(0, $text.Length - 7))
      $read = $stream.ReadAsync($buffer, 0, $buffer.Length)
    }
  }
  $stayedOpen = $opened -and -not $eof -and -not $p.HasExited -and $clock.Elapsed.TotalSeconds -ge $Seconds
  $p.StandardInput.Close()
  # E1.3 must inspect the pending read and trailing bytes, including a banner split across stdin EOF.
  # Drain while the helper exits so a full stdout pipe cannot prevent its bounded shutdown.
  $shutdown = [Diagnostics.Stopwatch]::StartNew()
  while (-not $eof -and $shutdown.ElapsedMilliseconds -lt 5000) {
    if (-not $read.Wait([int][Math]::Max(1, 5000 - $shutdown.ElapsedMilliseconds))) { break }
    if ($read.Result -eq 0) { $eof = $true; break }
    $bytes += $read.Result
    $text = $tail + [Text.Encoding]::ASCII.GetString($buffer, 0, $read.Result)
    $banner = $banner -or $text.Contains('ESP-ROM:')
    $tail = $text.Substring([Math]::Max(0, $text.Length - 7))
    $read = $stream.ReadAsync($buffer, 0, $buffer.Length)
  }
  $ended = $p.WaitForExit([int][Math]::Max(1, 5000 - $shutdown.ElapsedMilliseconds))
  $exitCode = if ($ended) { $p.ExitCode } else { 'did not end' }
  if (-not $ended) { $p.Kill(); if (-not $p.WaitForExit(5000)) { throw 'open did not stop' } }
  if (-not $eof) { throw 'open stdout deadline exceeded' }
  if (-not $rest.Wait(5000)) { throw 'open stderr deadline exceeded' }
  $quietExit = [string]::IsNullOrWhiteSpace($rest.Result)
  Stop-Serial $p
  $p = $null

  $failure = 'watch failed after opening the dial (missing dial/session, helper error or timeout)'
  $after = Get-Dial
  $unchanged = $before.session -ceq $after.session
  $short = '(none)'
  if ($before.serial) {
    # Never reveal an entire short serial or arbitrary diagnostic/control characters from the helper.
    $serial = [string]$before.serial
    $short = if ($serial.Length -gt 8 -and $serial.Substring(0, 8) -cmatch '^[0-9a-fA-F:]+$') {
      $serial.Substring(0, 8) + '...'
    } else { '(redacted)' }
  }
  $status = if ($first -cin @('open', 'busy', 'gone')) { $first } else { '(diagnostics redacted)' }
  "dial: $Port, serial $short, console session: $($before.console)"
  "opened: $opened ($status)"
  "stayed open for $Seconds s: $stayedOpen"
  "bytes read: $bytes"
  "ESP-ROM banner seen: $banner"
  "exit at end of stdin: $exitCode $(if (-not $quietExit) { '(diagnostics redacted)' })"
  "session unchanged: $unchanged"
  if (-not ($opened -and $stayedOpen -and -not $banner -and $ended -and $exitCode -eq 0 -and $quietExit -and $unchanged)) {
    exit 1
  }
} catch {
  # Exceptions can embed an entire JSON watch line or native stderr, including the device's full serial.
  Write-Output "error: $failure"
  exit 1
} finally {
  try { Stop-Serial $p } catch { Write-Output 'error: serial child cleanup failed'; exit 1 }
}
