# The fake `harness` on Windows, which fake-harness.cmd starts with its arguments in FAKE_HARNESS_ARGS:
# tests/fake-harness's contract, for the lines the end to end (scripts/e2e/windows.ps1) needs. Its folder is FAKE_HARNESS,
# or `fake` beside this script. Each run appends its arguments to calls.log and its pid to pids.log, then plays the file
# named by its arguments joined with `_` (`hardware_watch_--json`): each line is printed, except
#   @wait NAME       waits until the file NAME is in the folder
#   @stdin           waits until stdin closes
#   @record          the same, appending what it read to stdin.log
#   @exit N          exits N
#   @spawn NAME      starts a process that waits, as a run's helper does, and writes its pid to NAME
#   @breakaway NAME  the same, asking to leave the job as harness-launch.exe starts the daemon (pty/src/launcher.rs):
#                    NAME gets its pid, or `refused <error>` when the job does not let it go
# A run that ends by itself appends its arguments to ends.log; a killed one leaves no line.
$ErrorActionPreference = 'Stop'
$dir = if ($env:FAKE_HARNESS) { $env:FAKE_HARNESS } else { Join-Path $PSScriptRoot 'fake' }
# The app's arguments hold no space: split on it.
$argv = @("$env:FAKE_HARNESS_ARGS" -split ' ' | Where-Object { $_ })
$joined = $argv -join ' '
$played = [IO.Path]::Combine($dir, ($argv -join '_'))
# The CLI prints UTF-8 and ends each line with LF, as Node does.
$stdout = New-Object IO.StreamWriter([Console]::OpenStandardOutput(), (New-Object Text.UTF8Encoding $false))
$stdout.AutoFlush = $true

# Several runs write the same file at once: shared, and tried again while another holds it.
function Append([string]$name, [byte[]]$bytes, [int]$count) {
  for ($try = 0; ; $try++) {
    try {
      $file = [IO.File]::Open((Join-Path $dir $name), 'Append', 'Write', 'ReadWrite')
      try { $file.Write($bytes, 0, $count) } finally { $file.Dispose() }
      return
    } catch [IO.IOException] {
      if ($try -ge 100) { throw }
      Start-Sleep -Milliseconds 20
    }
  }
}

function Line([string]$name, [string]$text) {
  $bytes = [Text.Encoding]::UTF8.GetBytes("$text`n")
  Append $name $bytes $bytes.Length
}

function Finish([int]$code) {
  Line 'ends.log' $joined
  exit $code
}

# Written whole: the end to end reads it as soon as it is there.
function Put([string]$name, [string]$text) {
  $temp = Join-Path $dir "$name.tmp"
  [IO.File]::WriteAllText($temp, $text)
  Move-Item -LiteralPath $temp -Destination (Join-Path $dir $name) -Force
}

# A process that waits an hour with no window and no handle of this run's: ping, which needs no console input.
function Start-Waiting([string]$name, [uint32]$flags) {
  if (-not ('FakeHarness.Spawn' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace FakeHarness {
  public static class Spawn {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct StartupInfo {
      public int cb; public string reserved, desktop, title;
      public int x, y, xSize, ySize, xChars, yChars, fill, flags;
      public short show, reserved2; public IntPtr reserved3, stdIn, stdOut, stdErr;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInformation { public IntPtr process, thread; public int pid, tid; }
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "CreateProcessW")]
    static extern bool CreateProcess(string app, StringBuilder line, IntPtr processAttributes, IntPtr threadAttributes,
      bool inherit, uint flags, IntPtr environment, string folder, ref StartupInfo startup, out ProcessInformation info);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    // The pid, or minus the error code.
    public static int Start(string app, string line, uint flags) {
      StartupInfo startup = new StartupInfo();
      startup.cb = Marshal.SizeOf(startup);
      ProcessInformation info;
      if (!CreateProcess(app, new StringBuilder(line), IntPtr.Zero, IntPtr.Zero, false, flags, IntPtr.Zero, null,
          ref startup, out info)) {
        return -Marshal.GetLastWin32Error();
      }
      CloseHandle(info.thread);
      CloseHandle(info.process);
      return info.pid;
    }
  }
}
'@
  }
  $ping = Join-Path $env:SystemRoot 'System32\PING.EXE'
  $started = [FakeHarness.Spawn]::Start($ping, "`"$ping`" -n 3601 127.0.0.1", $flags)
  Put $name $(if ($started -gt 0) { "$started" } else { "refused $(-$started)" })
}

# What stdin brings, until it closes, chunk by chunk, so each line the app sends is there when it is sent.
function Read-Stdin([string]$into) {
  $in = [Console]::OpenStandardInput()
  $buffer = New-Object byte[] 4096
  while (($read = $in.Read($buffer, 0, $buffer.Length)) -gt 0) {
    if ($into) { Append $into $buffer $read }
  }
}

$CREATE_NO_WINDOW = 0x08000000
$CREATE_NEW_PROCESS_GROUP = 0x00000200
$CREATE_BREAKAWAY_FROM_JOB = 0x01000000

Line 'calls.log' $joined
Line 'pids.log' "$PID"
if (-not (Test-Path -LiteralPath $played -PathType Leaf)) {
  [Console]::Error.WriteLine('Unknown command')
  Finish 1
}
foreach ($line in [IO.File]::ReadAllLines($played)) {
  if ($line.StartsWith('@wait ')) {
    $wanted = Join-Path $dir $line.Substring(6)
    while (-not (Test-Path -LiteralPath $wanted)) { Start-Sleep -Milliseconds 20 }
  }
  elseif ($line -eq '@stdin') { Read-Stdin $null }
  elseif ($line -eq '@record') { Read-Stdin 'stdin.log' }
  elseif ($line.StartsWith('@exit ')) { Finish ([int]$line.Substring(6)) }
  elseif ($line.StartsWith('@spawn ')) { Start-Waiting $line.Substring(7) $CREATE_NO_WINDOW }
  elseif ($line.StartsWith('@breakaway ')) {
    Start-Waiting $line.Substring(11) ($CREATE_NO_WINDOW -bor $CREATE_NEW_PROCESS_GROUP -bor $CREATE_BREAKAWAY_FROM_JOB)
  }
  else { $stdout.Write("$line`n") }
}
Finish 0
