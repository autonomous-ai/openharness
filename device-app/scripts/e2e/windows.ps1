# End to end on Windows: a debug build's NSIS installer, installed per user, against the fake CLI
# (src-tauri/tests/fake-harness.cmd).
#
#   pwsh device-app/scripts/e2e/windows.ps1 -Installer <setup.exe> [-Out <folder>]
#   pwsh device-app/scripts/e2e/windows.ps1 -Update <OUT> [-Out <folder>]
#
# -Update installs update-pair.sh's 0.0.1 from OUT, serves OUT on 127.0.0.1:8765 and checks that 0.0.1 becomes 0.0.2.
#
# Prints `ok: <check>` for each check, `note:` for what it saw but does not judge, and stops at the first
# `FAILED: <check>`, exiting 1. It stops before it starts, exiting 2, when this account has a Harness Device, its data or
# its login item already, or a Harness CLI: it makes and removes only what it installed. Everything the app runs is the
# fake CLI or the test's own programs; never an account, a backend or the CDN. -Out keeps the app's log, the fake CLI's
# files of each part, and the foreground changes Windows reported beside the front check's steps.
#
# The app reads its folders from Windows (the known folders), not from USERPROFILE or LOCALAPPDATA, so it runs in this
# account's own: run it as a throwaway user or on a throwaway machine. One check changes the machine and runs only on a
# GitHub-hosted runner (RUNNER_ENVIRONMENT): the install line's, which an Image File Execution Options entry sends to a
# stand-in for Windows PowerShell so the line is seen, never run.
[CmdletBinding(DefaultParameterSetName = 'install')]
param(
  [Parameter(Mandatory, ParameterSetName = 'install')][string]$Installer,
  [Parameter(Mandatory, ParameterSetName = 'update')][string]$Update,
  [string]$Out)
$ErrorActionPreference = 'Stop'

# Every wait ends on what it waits for, bounded by this; an update by UPDATE_WAIT, from the launch.
$WAIT = 60
$UPDATE_WAIT = 300
$PORT = 8765
# `harness start --if-down` runs in seconds 10 to 19 of a minute, after two downs of the watch.
$START_WAIT = 150
$RUN_VALUE = 'Harness Device'
$ELLIPSIS = [string][char]0x2026
$MENU_REMOVED = 'menu: Harness removed | Install | About | Quit'
$MENU = "menu: Plug in your device | Sign in$ELLIPSIS | Export logs | About | Quit"
# install.rs WINDOWS and POWERSHELL_ARGS, byte for byte.
$INSTALL_LINE = '[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); iex "& { $(irm ''https://cdn.autonomous.ai/harness/cli/install.ps1'' -ErrorAction Stop) } -Desktop"; exit $LASTEXITCODE'
$INSTALL_ARGS = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', $INSTALL_LINE)

$id = 'ai.autonomous.harness.device'
$local = [Environment]::GetFolderPath('LocalApplicationData')
$roaming = [Environment]::GetFolderPath('ApplicationData')
$programs = [Environment]::GetFolderPath('Programs')
$installDir = Join-Path $local 'Harness Device'
$exe = Join-Path $installDir 'harness-device.exe'
$shortcut = Join-Path $programs 'Harness Device.lnk'
$desktopShortcut = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Harness Device.lnk'
# Tauri's folders: state.json and instance.lock in the roaming one, the log and the webview's data in the local one.
$data = Join-Path $roaming $id
$appLocal = Join-Path $local $id
$logs = Join-Path $appLocal 'logs'
$uninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Harness Device'
$runKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$approvedKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run'
$ifeoKey = 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\Image File Execution Options\powershell.exe'
# The installer's own key, named by the publisher Tauri takes from the identifier.
$vendorKey = 'HKCU:\Software\autonomous'
$productKey = 'HKCU:\Software\autonomous\Harness Device'
$fakeCli = Join-Path (Split-Path (Split-Path $PSScriptRoot)) 'src-tauri\tests\fake-harness.cmd'
$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'

# --- Before anything: this account has none of what the run makes

function Stop-Before([string]$why) {
  Write-Host "windows.ps1: $why"
  exit 2
}

if ($Update) {
  if (-not (Test-Path -LiteralPath $Update -PathType Container)) { Stop-Before "no update pair at $Update" }
  $Update = (Resolve-Path -LiteralPath $Update).Path
  $pair = @(Get-ChildItem -Path (Join-Path $Update '0.0.1\Harness-Device-windows-*-setup.exe'))
  if ($pair.Count -ne 1) { Stop-Before "$Update\0.0.1 holds one installer, not $($pair.Count)" }
  $Installer = $pair[0].FullName
  $updated = Join-Path $Update "0.0.2\$($pair[0].Name)"
  foreach ($file in @($updated, (Join-Path $Update 'metadata.json'))) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) { Stop-Before "no $file" }
  }
}
if (-not (Test-Path -LiteralPath $Installer -PathType Leaf)) { Stop-Before "no installer at $Installer" }
$Installer = (Resolve-Path -LiteralPath $Installer).Path
if (-not (Test-Path -LiteralPath $fakeCli -PathType Leaf)) { Stop-Before "no fake CLI at $fakeCli" }
foreach ($there in @($installDir, $data, $appLocal, $shortcut, $desktopShortcut, $uninstallKey)) {
  if (Test-Path -LiteralPath $there) { Stop-Before "$there is there: this account has a Harness Device already" }
}
foreach ($key in @($runKey, $approvedKey)) {
  if (Get-ItemProperty -LiteralPath $key -Name $RUN_VALUE -ErrorAction SilentlyContinue) {
    Stop-Before "$key has a $RUN_VALUE value: this account has a Harness Device login item already"
  }
}
if (Get-Process -Name 'harness-device' -ErrorAction SilentlyContinue) { Stop-Before 'a Harness Device runs' }
$userHome = [Environment]::GetFolderPath('UserProfile')
if ((Test-Path -LiteralPath (Join-Path $userHome '.harness')) -or (Get-Command 'harness.exe' -ErrorAction SilentlyContinue)) {
  Stop-Before 'this account has a Harness CLI: the checks need an account without one'
}
if ($env:HARNESS_DEVICE_CLI -or $env:FAKE_HARNESS) { Stop-Before 'HARNESS_DEVICE_CLI or FAKE_HARNESS is set already' }

# What the desktop app's install has here, which must be as it was after the Device app's.
$desktopApp = [ordered]@{
  folder = (Join-Path $local 'Programs\Harness')
  shortcut = (Join-Path $programs 'Harness.lnk')
  entry = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Harness'
}
$desktopBefore = @{}
foreach ($name in $desktopApp.Keys) { $desktopBefore[$name] = Test-Path -LiteralPath $desktopApp[$name] }
$hadVendorKey = Test-Path -LiteralPath $vendorKey
$hadProductKey = Test-Path -LiteralPath $productKey
$hadApprovedKey = Test-Path -LiteralPath $approvedKey

$work = Join-Path ([IO.Path]::GetTempPath()) ('harness-device-e2e-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
$fake = Join-Path $work 'fake'
$tools = Join-Path $work 'tools'
$apps = Join-Path $work 'apps'
$evidence = Join-Path $work 'evidence'
foreach ($folder in @($fake, $tools, $apps, $evidence)) { New-Item -ItemType Directory -Force -Path $folder | Out-Null }
$consoles = Join-Path $work 'consoles.log'
$served = Join-Path $work 'served.log'
$frontEvents = Join-Path $work 'foreground.log'
$frontSteps = Join-Path $work 'front-steps.log'

$script:failure = $null
$script:app = $null
$script:installed = $false
$script:ranInstaller = $false
$script:ifeo = $null
$script:phase = 'start'
$started = New-Object System.Collections.Generic.List[System.Diagnostics.Process]
$tokens = New-Object System.Collections.Generic.List[string]

function Ok([string]$check) { Write-Host "ok: $check" }
function Note([string]$text) { Write-Host "note: $text" }
function Fail([string]$check) {
  $script:failure = $check
  throw "FAILED: $check"
}

# GitHub's hosted Windows Arm runner refuses every foreground change the test makes: there the checks that need one are
# noted and skipped. Anywhere else a refusal fails, and the Windows ARM VM checks the front on arm64.
$frontLimited = ($env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted' -and
  [Runtime.InteropServices.RuntimeInformation]::OSArchitecture -eq 'Arm64')
function Front-Refused([string]$what) {
  if (-not $frontLimited) { Fail "the test brings $what to the front (Windows refused every way it tried)" }
  Note "GitHub's hosted Windows Arm runner refuses to bring $what to the front: the check that needs it is skipped here"
}

# Runs `ready` until it answers true, for `seconds` at most.
function Wait-For([scriptblock]$ready, [int]$seconds = $WAIT) {
  $deadline = [DateTime]::UtcNow.AddSeconds($seconds)
  while (-not (& $ready)) {
    if ([DateTime]::UtcNow -ge $deadline) { return $false }
    Start-Sleep -Milliseconds 100
  }
  return $true
}

# A file another process writes: opened sharing everything, so neither waits on the other.
function Read-Shared([string]$path) {
  try {
    $stream = [IO.File]::Open($path, 'Open', 'Read', 'ReadWrite, Delete')
  } catch [IO.IOException] {
    return ''
  }
  try { (New-Object IO.StreamReader($stream, [Text.Encoding]::UTF8)).ReadToEnd() } finally { $stream.Dispose() }
}

function Lines-Of([string]$path) {
  if (-not (Test-Path -LiteralPath $path)) { return @() }
  @((Read-Shared $path) -split "`n" | Where-Object { $_ })
}

# --- The test's own programs, compiled here with the .NET Framework's compiler every Windows has

$csc = @('FrameworkArm64', 'Framework64', 'Framework') |
  ForEach-Object { Join-Path $env:WINDIR "Microsoft.NET\$_\v4.0.30319\csc.exe" } |
  Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1

function Build-Tool([string]$name, [string]$target, [string]$source, [string[]]$references) {
  $file = Join-Path $tools "$name.cs"
  $built = Join-Path $tools "$name.exe"
  [IO.File]::WriteAllText($file, $source)
  $output = & $csc /nologo "/target:$target" "/out:$built" @($references | ForEach-Object { "/r:$_" }) $file | Out-String
  if ($LASTEXITCODE -ne 0) { Fail "the test's own $name.exe compiles: $output" }
  $built
}

# A window, titled by its argument, that does nothing: an app to bring to the front.
$windowSource = @'
using System;
using System.Windows.Forms;
static class TestWindow {
  [STAThread]
  static void Main(string[] args) {
    Form form = new Form();
    form.Text = args[0];
    form.Width = 360;
    form.Height = 200;
    Application.Run(form);
  }
}
'@

# Writes `ready`, then a line for each console window shown on this desktop (conhost's, or Windows Terminal's): its
# class, then its process and that process's parents, `name:pid` each. Pushed by the system, nothing polled.
$watcherSource = @'
using System;
using System.Collections.Generic;
using System.IO;
using System.Management;
using System.Runtime.InteropServices;
using System.Text;
static class ConsoleWatch {
  delegate void Proc(IntPtr hook, uint happened, IntPtr window, int what, int child, uint thread, uint time);
  [StructLayout(LayoutKind.Sequential)]
  struct Msg { public IntPtr window; public uint message; public IntPtr w, l; public uint time; public int x, y; }
  [DllImport("user32.dll")]
  static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, Proc proc, uint pid, uint thread, uint flags);
  [DllImport("user32.dll")]
  static extern int GetMessage(out Msg msg, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")]
  static extern IntPtr DispatchMessage(ref Msg msg);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)]
  static extern int GetClassName(IntPtr window, StringBuilder name, int size);
  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  const uint EVENT_OBJECT_SHOW = 0x8002;
  static string output;
  static Proc kept = Shown;
  static void Main(string[] args) {
    output = args[0];
    if (SetWinEventHook(EVENT_OBJECT_SHOW, EVENT_OBJECT_SHOW, IntPtr.Zero, kept, 0, 0, 0) == IntPtr.Zero) {
      Write("no hook");
      return;
    }
    Write("ready");
    Msg msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) DispatchMessage(ref msg);
  }
  static void Shown(IntPtr hook, uint happened, IntPtr window, int what, int child, uint thread, uint time) {
    if (what != 0) return;
    StringBuilder name = new StringBuilder(256);
    if (GetClassName(window, name, name.Capacity) == 0) return;
    string kind = name.ToString();
    if (kind != "ConsoleWindowClass" && kind != "CASCADIA_HOSTING_WINDOW_CLASS") return;
    uint pid;
    GetWindowThreadProcessId(window, out pid);
    Write(kind + " " + Chain(pid));
  }
  static string Chain(uint pid) {
    Dictionary<uint, uint> parents = new Dictionary<uint, uint>();
    Dictionary<uint, string> names = new Dictionary<uint, string>();
    using (ManagementObjectSearcher search =
        new ManagementObjectSearcher("SELECT ProcessId, ParentProcessId, Name FROM Win32_Process")) {
      foreach (ManagementObject process in search.Get()) {
        uint id = (uint)process["ProcessId"];
        parents[id] = (uint)process["ParentProcessId"];
        names[id] = (string)process["Name"];
      }
    }
    List<string> chain = new List<string>();
    HashSet<uint> seen = new HashSet<uint>();
    for (uint at = pid; names.ContainsKey(at) && seen.Add(at); at = parents[at]) chain.Add(names[at] + ":" + at);
    return chain.Count > 0 ? string.Join(" < ", chain.ToArray()) : "gone:" + pid;
  }
  static void Write(string line) { File.AppendAllText(output, line + "\n"); }
}
'@

# Writes `ready`, then a line for each foreground change Windows reports (EVENT_SYSTEM_FOREGROUND, hooked as the app
# hooks it): the time (UTC), the window, its process's id and name. A witness apart from the app, so a failure says
# whether Windows reported the change or the app missed it.
$frontWatchSource = @'
using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
static class FrontWatch {
  delegate void Proc(IntPtr hook, uint happened, IntPtr window, int what, int child, uint thread, uint time);
  [StructLayout(LayoutKind.Sequential)]
  struct Msg { public IntPtr window; public uint message; public IntPtr w, l; public uint time; public int x, y; }
  [DllImport("user32.dll")]
  static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, Proc proc, uint pid, uint thread, uint flags);
  [DllImport("user32.dll")]
  static extern int GetMessage(out Msg msg, IntPtr window, uint min, uint max);
  [DllImport("user32.dll")]
  static extern IntPtr DispatchMessage(ref Msg msg);
  [DllImport("user32.dll")]
  static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
  const uint EVENT_SYSTEM_FOREGROUND = 0x0003;
  static string output;
  static Proc kept = Changed;
  static void Main(string[] args) {
    output = args[0];
    if (SetWinEventHook(EVENT_SYSTEM_FOREGROUND, EVENT_SYSTEM_FOREGROUND, IntPtr.Zero, kept, 0, 0, 0) == IntPtr.Zero) {
      Write("no hook");
      return;
    }
    Write("ready");
    Msg msg;
    while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) DispatchMessage(ref msg);
  }
  static void Changed(IntPtr hook, uint happened, IntPtr window, int what, int child, uint thread, uint time) {
    uint pid;
    GetWindowThreadProcessId(window, out pid);
    string name = "gone";
    try { name = Process.GetProcessById((int)pid).ProcessName; } catch (Exception) { }
    Write(DateTime.UtcNow.ToString("HH:mm:ss.fff") + " " + window.ToInt64() + " " + pid + " " + name);
  }
  static void Write(string line) { File.AppendAllText(output, line + "\n"); }
}
'@

# Stands in for Windows PowerShell while the install line runs: writes whether it has a console window and each argument
# it got (the first is the program the app ran) to powershell.record beside itself, then prints an install.ps1 step line
# and its failure, and exits 1, as install.ps1 that could not download.
$standInSource = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
static class StandIn {
  [DllImport("kernel32.dll")]
  static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")]
  static extern bool IsWindowVisible(IntPtr window);
  static int Main(string[] args) {
    IntPtr console = GetConsoleWindow();
    StringBuilder record = new StringBuilder();
    record.Append("console: ").Append(console == IntPtr.Zero ? "none" : IsWindowVisible(console) ? "visible" : "hidden");
    record.Append('\n');
    foreach (string arg in args) record.Append("arg: ").Append(arg).Append('\n');
    string folder = AppDomain.CurrentDomain.BaseDirectory;
    string temp = Path.Combine(folder, "powershell.record.tmp");
    File.WriteAllText(temp, record.ToString(), new UTF8Encoding(false));
    File.Move(temp, Path.Combine(folder, "powershell.record"));
    StreamWriter stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
    stdout.AutoFlush = true;
    stdout.Write("  Downloading Harness 0.6.99 (e2e)...\n");
    stdout.Write("Harness could not be installed. The step that failed: e2e.\n");
    return 1;
  }
}
'@

if (-not ('E2E.Native' -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
namespace E2E {
  public static class Native {
    delegate bool EnumProc(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc proc, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr window, StringBuilder text, int size);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr window, int show);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] static extern void mouse_event(uint flags, int x, int y, uint data, UIntPtr extra);
    const uint MOUSEEVENTF_MOVE = 0x0001;
    const uint KEYEVENTF_KEYUP = 0x0002;
    const byte VK_MENU = 0x12;
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool inJob);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);

    // The visible top-level window of `pid` titled `title`.
    public static IntPtr Find(int pid, string title) {
      IntPtr found = IntPtr.Zero;
      EnumWindows(delegate (IntPtr window, IntPtr data) {
        uint owner;
        GetWindowThreadProcessId(window, out owner);
        if (owner != (uint)pid || !IsWindowVisible(window)) return true;
        StringBuilder text = new StringBuilder(256);
        GetWindowText(window, text, text.Capacity);
        if (text.ToString() != title) return true;
        found = window;
        return false;
      }, IntPtr.Zero);
      return found;
    }

    // The way the last Raise tried last: the one that put the window in front when it answered true.
    public static string Way = "";

    // The window in front and its process: `handle pid`.
    public static string Front() {
      IntPtr window = GetForegroundWindow();
      uint pid;
      GetWindowThreadProcessId(window, out pid);
      return window.ToInt64() + " " + pid;
    }

    // Brings `window` to the front; true when it is there. Windows lets a process that is not in front set the front
    // only when it gave the last input, so each way first gives some: a mouse move of nothing, then the Alt key, which
    // only `alt` allows, as a released Alt puts the window in its menu mode, where Return opens the system menu.
    public static bool Raise(IntPtr window, bool alt) {
      Way = "in front already";
      if (GetForegroundWindow() == window) return true;
      ShowWindow(window, 9);
      mouse_event(MOUSEEVENTF_MOVE, 0, 0, 0, UIntPtr.Zero);
      Way = "SetForegroundWindow";
      if (SetForegroundWindow(window) && GetForegroundWindow() == window) return true;
      uint pid;
      uint front = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
      uint me = GetCurrentThreadId();
      bool attached = front != 0 && front != me && AttachThreadInput(me, front, true);
      Way = attached ? "AttachThreadInput" : "BringWindowToTop";
      BringWindowToTop(window);
      SetForegroundWindow(window);
      if (attached) AttachThreadInput(me, front, false);
      if (GetForegroundWindow() == window || !alt) return GetForegroundWindow() == window;
      Way = "Alt";
      keybd_event(VK_MENU, 0, 0, UIntPtr.Zero);
      SetForegroundWindow(window);
      keybd_event(VK_MENU, 0, KEYEVENTF_KEYUP, UIntPtr.Zero);
      return GetForegroundWindow() == window;
    }

    public static void Press(byte key) {
      keybd_event(key, 0, 0, UIntPtr.Zero);
      keybd_event(key, 0, 2, UIntPtr.Zero);
    }

    // "yes", "no", or "unknown" when the process cannot be asked.
    public static string InJob(int pid) {
      IntPtr process = OpenProcess(0x1000, false, (uint)pid);
      if (process == IntPtr.Zero) return "unknown";
      bool inJob;
      bool asked = IsProcessInJob(process, IntPtr.Zero, out inJob);
      CloseHandle(process);
      return asked ? (inJob ? "yes" : "no") : "unknown";
    }
  }
}
'@
}

# --- The app, its log and its state

function Log-Text {
  $files = @(Get-ChildItem -LiteralPath $logs -Filter 'app-*.log' -ErrorAction SilentlyContinue | Sort-Object Name)
  ($files | ForEach-Object { Read-Shared $_.FullName }) -join ''
}

$script:mark = 0
# This launch's log lines, without their time.
function Run-Log {
  $text = Log-Text
  if ($text.Length -le $script:mark) { return @() }
  @($text.Substring($script:mark) -split "`n" | Where-Object { $_ } | ForEach-Object {
      $at = $_.IndexOf(' ')
      if ($at -ge 0) { $_.Substring($at + 1) } else { $_ }
    })
}
function Times-Logged([string]$line) { @(Run-Log | Where-Object { $_ -ceq $line }).Count }
function Logged([string]$line) { (Times-Logged $line) -gt 0 }

function Save-State([bool]$cliSeen, [bool]$askedSignIn, [bool]$loginItem) {
  $word = @{ $true = 'true'; $false = 'false' }
  New-Item -ItemType Directory -Force -Path $data | Out-Null
  $json = '{"version":1,"cliSeen":' + $word[$cliSeen] + ',"askedSignIn":' + $word[$askedSignIn] + ',"loginItem":' +
    $word[$loginItem] + '}'
  [IO.File]::WriteAllText((Join-Path $data 'state.json'), $json)
}

# The fake CLI's script for `name` (its arguments joined with `_`).
function Fake-Script([string]$name, [string[]]$lines) {
  [IO.File]::WriteAllText((Join-Path $fake $name), (($lines -join "`n") + "`n"), (New-Object Text.UTF8Encoding $false))
}
function Fake-Lines([string]$name) { @(Lines-Of (Join-Path $fake $name)) }
function Called([string]$call) { @(Fake-Lines 'calls.log' | Where-Object { $_ -ceq $call }).Count -gt 0 }
function Told([string]$exeName) {
  $line = '{"front":"' + $exeName + '"}'
  @(Fake-Lines 'stdin.log' | Where-Object { $_ -ieq $line }).Count
}

# The foreground changes Windows reported, as the witness wrote them: `time handle pid name`.
function Front-Events { @(Lines-Of $frontEvents | Where-Object { $_ -ne 'ready' }) }
# True when Windows reported a window of process `id` in front, from its `since`-th change on.
function Reported([int]$since, [int]$id) {
  @(Front-Events | Select-Object -Skip $since | Where-Object { ($_ -split ' ')[2] -eq "$id" }).Count -gt 0
}
# The window in front now, as GetForegroundWindow names it: `handle pid name`.
function In-Front {
  $handle, $owner = ([E2E.Native]::Front()) -split ' '
  "$handle $owner $((Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName)"
}
# One line of the front check's steps, timed as the witness's lines are.
function Step([string]$text) {
  [IO.File]::AppendAllText($frontSteps, "$([DateTime]::UtcNow.ToString('HH:mm:ss.fff')) $text`n")
}

# The app's environment: the fake CLI, or no CLI at all.
function Use-Fake([bool]$on) {
  if ($on) {
    $env:HARNESS_DEVICE_CLI = $fakeCli
    $env:FAKE_HARNESS = $fake
  } else {
    Remove-Item Env:HARNESS_DEVICE_CLI, Env:FAKE_HARNESS -ErrorAction SilentlyContinue
  }
}

function Launch([string]$phase) {
  $script:phase = $phase
  $script:mark = (Log-Text).Length
  $script:app = Start-Process -FilePath $exe -WorkingDirectory $work -PassThru
}

function Gone([int]$processId) {
  $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
  (-not $process) -or $process.HasExited
}

function Fakes-Gone {
  foreach ($line in (Fake-Lines 'pids.log')) {
    $process = Get-Process -Id ([int]$line) -ErrorAction SilentlyContinue
    if ($process -and -not $process.HasExited -and $process.ProcessName -eq 'powershell') { return $false }
  }
  return $true
}

# What a part left in the fake's folder goes to the evidence, then the folder is cleared for the next part.
function Keep-Fake {
  $kept = Join-Path $evidence $script:phase
  New-Item -ItemType Directory -Force -Path $kept | Out-Null
  Get-ChildItem -LiteralPath $fake -File | Where-Object { $_.Name -like '*.log' -or $_.Name -like '*.pid' } |
    ForEach-Object {
      Copy-Item -LiteralPath $_.FullName -Destination $kept
      Remove-Item -LiteralPath $_.FullName -Force
    }
}

# Ends the app's process, as a crash or Task Manager does, then waits for the fake CLI's runs, which its jobs end.
function Stop-App {
  if ($script:app.HasExited) { Fail 'the app runs until it is ended' }
  Stop-Process -Id $script:app.Id -Force
  if (-not (Wait-For { $script:app.HasExited })) { Fail "the app's process ends" }
  $script:app = $null
  if (-not (Wait-For { Fakes-Gone })) { Fail "the fake CLI's runs end with the app's process (their jobs close)" }
  Keep-Fake
}

function Run-Value {
  $item = Get-ItemProperty -LiteralPath $runKey -Name $RUN_VALUE -ErrorAction SilentlyContinue
  if ($item) { $item.$RUN_VALUE } else { $null }
}

function Url-Processes([string]$token) {
  @(Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($token) })
}

# What the app did with the sign-in URL carrying `token`: a program got it, or the log says the shell refused it.
function Open-Page([string]$token) {
  $script:opened = @()
  $answered = Wait-For {
    if (@(Run-Log | Where-Object { $_.StartsWith('browser: could not open') }).Count) { return $true }
    $script:opened = @(Url-Processes $token)
    $script:opened.Count -gt 0
  }
  $refused = @(Run-Log | Where-Object { $_.StartsWith('browser: could not open') })
  if (-not $answered) { Fail 'the shell opens the sign-in page: no program got its URL, and the log has no browser: line' }
  if ($refused.Count -and $refused[0].Contains('(os error 1155)')) {
    # ERROR_NO_ASSOCIATION: the shell was reached and answered; this Windows has no browser set for https.
    Note "this Windows has no program for https: $($refused[0])"
  } elseif ($refused.Count) {
    Fail "the shell opens the sign-in page: the log has $($refused[0])"
  } else {
    Note "the shell handed the sign-in page to $((@($script:opened | ForEach-Object { $_.Name }) | Sort-Object -Unique) -join ', ')"
    Ok 'the sign-in page opens through the shell (ShellExecuteW, on a thread of its own with COM set up)'
  }
  Stop-Tree @($script:opened | ForEach-Object { [int]$_.ProcessId })
}

# The processes and everything they started.
function Stop-Tree([int[]]$roots) {
  $all = @(Get-CimInstance Win32_Process)
  $ending = New-Object System.Collections.Generic.HashSet[int]
  $next = @($roots)
  while ($next.Count) {
    $found = @()
    foreach ($processId in $next) {
      if ($ending.Add($processId)) { $found += @($all | Where-Object { $_.ParentProcessId -eq $processId } | ForEach-Object { [int]$_.ProcessId }) }
    }
    $next = $found
  }
  foreach ($processId in $ending) { Stop-Process -Id $processId -Force -ErrorAction SilentlyContinue }
}

# A process a fake run started (`@spawn`, `@breakaway`), from its pid file: ping, nothing else.
function Stop-Ping([string]$pidFile) {
  foreach ($kept in @((Join-Path $fake $pidFile), (Get-ChildItem -LiteralPath $evidence -Recurse -Filter $pidFile -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName }))) {
    if (-not $kept -or -not (Test-Path -LiteralPath $kept)) { continue }
    $text = (Read-Shared $kept).Trim()
    if ($text -notmatch '^\d+$') { continue }
    $process = Get-Process -Id ([int]$text) -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq 'PING') { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  }
}

function Show-Diagnosis {
  $ErrorActionPreference = 'Continue'
  Write-Host "--- the app's log"
  try { (Log-Text) -split "`n" | Select-Object -Last 60 | ForEach-Object { Write-Host $_ } } catch { Write-Host $_ }
  foreach ($name in @('calls.log', 'ends.log', 'stdin.log')) {
    Write-Host "--- the fake CLI's $name"
    Fake-Lines $name | ForEach-Object { Write-Host $_ }
  }
  Write-Host '--- the console windows seen'
  Lines-Of $consoles | ForEach-Object { Write-Host $_ }
  Write-Host '--- the requests served'
  Lines-Of $served | ForEach-Object { Write-Host $_ }
  Write-Host '--- the foreground changes Windows reported'
  Lines-Of $frontEvents | ForEach-Object { Write-Host $_ }
  Write-Host "--- the front check's steps"
  Lines-Of $frontSteps | ForEach-Object { Write-Host $_ }
  Write-Host '--- the processes'
  Get-Process -Name 'harness-device', 'powershell', 'cmd', 'PING' -ErrorAction SilentlyContinue |
    Format-Table Id, ProcessName, SessionId, StartTime -AutoSize | Out-String -Width 200 | Write-Host
}

function Clean-Up {
  $ErrorActionPreference = 'Continue'
  # The machine-wide entry first: nothing else may reach the stand-in.
  if ($script:ifeo) {
    Remove-ItemProperty -LiteralPath $ifeoKey -Name 'Debugger' -ErrorAction SilentlyContinue
    if ($script:ifeo -eq 'key') { Remove-Item -LiteralPath $ifeoKey -ErrorAction SilentlyContinue }
  }
  Use-Fake $false
  Get-Process -Name 'harness-device' -ErrorAction SilentlyContinue |
    Where-Object { $_.Path -and $_.Path -ieq $exe } | Stop-Process -Force -ErrorAction SilentlyContinue
  foreach ($line in (Fake-Lines 'pids.log')) {
    $process = Get-Process -Id ([int]$line) -ErrorAction SilentlyContinue
    if ($process -and $process.ProcessName -eq 'powershell') { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }
  }
  foreach ($pidFile in @('daemon.pid', 'inside.pid')) { Stop-Ping $pidFile }
  foreach ($process in $started) { if (-not $process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } }
  foreach ($token in $tokens) {
    $opened = @(Url-Processes $token | ForEach-Object { [int]$_.ProcessId })
    if ($opened.Count) { Stop-Tree $opened }
  }
  if ($Out) {
    New-Item -ItemType Directory -Force -Path $Out | Out-Null
    Keep-Fake
    Copy-Item -Path (Join-Path $evidence '*') -Destination $Out -Recurse -Force -ErrorAction SilentlyContinue
    Copy-Item -Path (Join-Path $logs 'app-*.log'), $consoles, (Join-Path $tools 'powershell.record'), $served, `
      $frontEvents, $frontSteps -Destination $Out -Force -ErrorAction SilentlyContinue
  }
  # The uninstaller copies itself away and returns at once: what it removes is waited for.
  if ($script:installed -and (Test-Path -LiteralPath (Join-Path $installDir 'uninstall.exe'))) {
    Start-Process -FilePath (Join-Path $installDir 'uninstall.exe') -ArgumentList '/S' | Out-Null
    Wait-For { -not (Test-Path -LiteralPath $installDir) } | Out-Null
  }
  if ($script:ranInstaller) {
    foreach ($left in @($installDir, $shortcut, $desktopShortcut, $uninstallKey)) {
      if (Test-Path -LiteralPath $left) { Remove-Item -LiteralPath $left -Recurse -Force -ErrorAction SilentlyContinue }
    }
  }
  Remove-ItemProperty -LiteralPath $runKey -Name $RUN_VALUE -ErrorAction SilentlyContinue
  Remove-ItemProperty -LiteralPath $approvedKey -Name $RUN_VALUE -ErrorAction SilentlyContinue
  if (-not $hadApprovedKey -and (Test-Path -LiteralPath $approvedKey)) {
    Remove-Item -LiteralPath $approvedKey -ErrorAction SilentlyContinue
  }
  foreach ($folder in @($data, $appLocal)) { Remove-Item -LiteralPath $folder -Recurse -Force -ErrorAction SilentlyContinue }
  if (-not $hadProductKey) { Remove-Item -LiteralPath $productKey -Recurse -ErrorAction SilentlyContinue }
  if (-not $hadVendorKey -and (Test-Path -LiteralPath $vendorKey) -and -not (Get-ChildItem -LiteralPath $vendorKey)) {
    Remove-Item -LiteralPath $vendorKey -ErrorAction SilentlyContinue
  }
  Remove-Item -LiteralPath $work -Recurse -Force -ErrorAction SilentlyContinue
}

function Report-Failure($record) {
  if ($script:failure) { Write-Host "FAILED: $script:failure" }
  else { Write-Host "FAILED: the script stopped: $($record.Exception.Message) $($record.InvocationInfo.PositionMessage)" }
  Show-Diagnosis
}

# --- The update: 0.0.1 from update-pair.sh, installed, finds 0.0.2 at 127.0.0.1:8765 and becomes it

# Serves the folder it is given on 127.0.0.1:8765, one request at a time, and writes `ready`, then each request's line,
# to the file it is given.
$serverSource = @'
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
static class Serve {
  static void Main(string[] args) {
    string root = Path.GetFullPath(args[0]).TrimEnd('\\') + "\\";
    TcpListener listener = new TcpListener(IPAddress.Loopback, int.Parse(args[2]));
    listener.Start();
    File.AppendAllText(args[1], "ready\n");
    while (true) {
      using (TcpClient client = listener.AcceptTcpClient()) {
        try { Answer(client.GetStream(), root, args[1]); } catch (IOException) { }
      }
    }
  }
  static void Answer(NetworkStream stream, string root, string log) {
    StreamReader reader = new StreamReader(stream, Encoding.ASCII);
    string request = reader.ReadLine();
    if (request == null) return;
    for (string header = reader.ReadLine(); !string.IsNullOrEmpty(header); header = reader.ReadLine()) { }
    File.AppendAllText(log, request + "\n");
    string[] parts = request.Split(' ');
    string path = parts.Length > 1 ? Uri.UnescapeDataString(parts[1].Split('?')[0]).TrimStart('/') : "";
    string file = Path.GetFullPath(Path.Combine(root, path.Replace('/', '\\')));
    bool found = file.StartsWith(root, StringComparison.OrdinalIgnoreCase) && File.Exists(file);
    byte[] body = found ? File.ReadAllBytes(file) : new byte[0];
    byte[] head = Encoding.ASCII.GetBytes((found ? "HTTP/1.1 200 OK" : "HTTP/1.1 404 Not Found") +
      "\r\nContent-Length: " + body.Length + "\r\nConnection: close\r\n\r\n");
    stream.Write(head, 0, head.Length);
    stream.Write(body, 0, body.Length);
  }
}
'@

function Checked([int]$count) { @(Lines-Of $served | Where-Object { $_.StartsWith('GET /metadata.json ') }).Count -ge $count }

function Installed-Version {
  try { (Get-Item -LiteralPath $exe).VersionInfo.ProductVersion } catch { $null }
}

function Update-Checks {
  if (-not $csc) { Fail 'the .NET Framework compiler (csc.exe) is on this Windows' }
  $server = Build-Tool 'serve' 'winexe' $serverSource @()
  $started.Add((Start-Process -FilePath $server -ArgumentList "`"$Update`" `"$served`" $PORT" -PassThru))
  if (-not (Wait-For { (Lines-Of $served) -contains 'ready' })) { Fail "the pair is served on 127.0.0.1:$PORT" }

  # Seeded before the install, so no launch ever reaches the install line on its own.
  Save-State $true $true $true
  $script:installed = $true
  $script:ranInstaller = $true
  $setup = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru
  $null = $setup.Handle
  if (-not $setup.WaitForExit(300000)) { Fail 'the installer ends within 5 minutes' }
  if ($setup.ExitCode -ne 0) { Fail "the installer exits 0, not $($setup.ExitCode)" }
  $running = @(Get-Process -Name 'harness-device' -ErrorAction SilentlyContinue)
  if ($running.Count) {
    $running | Stop-Process -Force
    if (-not (Wait-For { -not (Get-Process -Name 'harness-device' -ErrorAction SilentlyContinue) })) { Fail 'the app started by the installer ends' }
  }
  if ((Installed-Version) -ne '0.0.1') { Fail "/S installs 0.0.1, not $(Installed-Version)" }
  Ok '/S installs 0.0.1'

  # cliSeen and askedSignIn: nothing is installed and no window opens. The login item is the run's to write, so the
  # update is seen to keep it.
  Save-State $true $true $false
  Use-Fake $false
  $deadline = [DateTime]::UtcNow.AddSeconds($UPDATE_WAIT)
  $left = { [Math]::Max(1, [int]($deadline - [DateTime]::UtcNow).TotalSeconds) }
  Launch 'update'
  if (-not (Wait-For { Logged 'login item: registered' })) { Fail 'the first run registers the login item' }
  $quoted = "`"$exe`""
  if ((Run-Value) -ine $quoted) { Fail "the Run value $RUN_VALUE is the quoted exe, not $(Run-Value)" }
  if (-not (Wait-For { Logged 'update: found 0.0.2' } (& $left))) { Fail '0.0.1 logs update: found 0.0.2' }
  if (-not (Wait-For { Logged 'update: installing 0.0.2' } (& $left))) { Fail '0.0.1 logs update: installing 0.0.2' }
  Ok '0.0.1 logs update: found 0.0.2, then update: installing 0.0.2'

  # The plugin ends the app as it starts the installer, which starts the app again when it is done.
  if (-not (Wait-For { $script:app.HasExited })) { Fail '0.0.1 ends for the install' }
  if (-not (Wait-For { (Installed-Version) -eq '0.0.2' } (& $left))) {
    Fail "the installed harness-device.exe is 0.0.2, not $(Installed-Version)"
  }
  Ok 'the installed harness-device.exe is 0.0.2'
  $old = $script:app.Id
  $relaunched = {
    @(Get-Process -Name 'harness-device' -ErrorAction SilentlyContinue |
      Where-Object { $_.Id -ne $old -and $_.Path -and $_.Path -ieq $exe }).Count -gt 0
  }
  if (-not (Wait-For $relaunched (& $left))) { Fail 'the app runs again after the update' }
  # 0.0.1 checked once: a second check is the relaunched app's.
  if (-not (Wait-For { Checked 2 } (& $left))) { Fail 'the relaunched app checks the manifest' }
  Ok 'the app runs again, 0.0.2, and checks the manifest'
  if ((Run-Value) -ine $quoted) { Fail "the update keeps the Run value $RUN_VALUE, the quoted exe: it is $(Run-Value)" }
  Ok "the update keeps the Run value $RUN_VALUE"

  # A check starts only once the one before it was answered, so the third request shows the relaunched app's first
  # check, the second, was answered: any update it found is logged by then.
  if (-not (Wait-For { Checked 3 } (& $left))) { Fail 'the relaunched app checks again, a minute later' }
  if ((Times-Logged 'update: found 0.0.2') -ne 1) { Fail '0.0.2 finds no update: one update: found in the log' }
  Ok '0.0.2 checks the manifest and finds no update'
}

if ($Update) {
  $code = 0
  try {
    Update-Checks
    Write-Host '0 FAILED'
  } catch {
    Report-Failure $_
    $code = 1
  } finally {
    Clean-Up
  }
  exit $code
}

$code = 0
try {
  if (-not $csc) { Fail 'the .NET Framework compiler (csc.exe) is on this Windows' }
  $window = Build-Tool 'window' 'winexe' $windowSource @('System.Windows.Forms.dll')
  $watcher = Build-Tool 'console-watch' 'winexe' $watcherSource @('System.Management.dll')
  $frontWatch = Build-Tool 'front-watch' 'winexe' $frontWatchSource @()
  $standIn = Build-Tool 'powershell-stand-in' 'exe' $standInSource @()
  Note "this script runs in a job: $([E2E.Native]::InJob($PID))"

  # --- 6, from here: every console window shown on this desktop

  $started.Add((Start-Process -FilePath $watcher -ArgumentList "`"$consoles`"" -PassThru))
  if (-not (Wait-For { (Lines-Of $consoles) -contains 'ready' })) { Fail "the console watcher hooks the desktop: $(Lines-Of $consoles)" }
  # It must see a console window when one opens and trace it to the process that opened it, or the check means nothing.
  $seenBefore = @(Lines-Of $consoles).Count
  $shown = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -ArgumentList '/k' -PassThru
  $started.Add($shown)
  $opener = "cmd.exe:$($shown.Id)"
  $traced = { @(Lines-Of $consoles | Select-Object -Skip $seenBefore | Where-Object { ($_ -split ' ') -contains $opener }) }
  if (-not (Wait-For { (& $traced).Count -gt 0 })) {
    Fail "the console watcher traces a console to its process, $opener; it saw: $(@(Lines-Of $consoles | Select-Object -Skip $seenBefore) -join ' / ')"
  }
  Stop-Process -Id $shown.Id -Force
  Ok "the console watcher traces a console window to the process that opened it: $(@(& $traced)[0])"

  # --- 1: the silent install, per user

  # Seeded before the install, so no launch ever reaches the install line on its own.
  Save-State $true $true $true
  $script:installed = $true
  $script:ranInstaller = $true
  $setup = Start-Process -FilePath $Installer -ArgumentList '/S' -PassThru
  # Held from the start: Windows PowerShell has no exit code for a process whose handle it opened after the exit.
  $null = $setup.Handle
  if (-not $setup.WaitForExit(300000)) { Fail 'the installer ends within 5 minutes' }
  if ($setup.ExitCode -ne 0) { Fail "the installer exits 0, not $($setup.ExitCode)" }
  $missing = @(@($exe, $shortcut, $uninstallKey) | Where-Object { -not (Test-Path -LiteralPath $_) })
  if ($missing.Count) { Fail "/S installs harness-device.exe, the Start Menu shortcut and the uninstall entry: missing $($missing -join ', ')" }
  Ok '/S installs Harness Device per user: %LOCALAPPDATA%\Harness Device\harness-device.exe, the Start Menu Harness Device.lnk and the Harness Device uninstall entry'
  foreach ($name in $desktopApp.Keys) {
    if ((Test-Path -LiteralPath $desktopApp[$name]) -ne $desktopBefore[$name]) { Fail "the desktop app's $name is as before the install" }
  }
  Ok "the desktop app's folder, Harness.lnk and Harness uninstall entry are as before"
  if (Test-Path -LiteralPath $desktopShortcut) { Note 'the silent install adds a desktop shortcut, Harness Device.lnk' }
  $running = @(Get-Process -Name 'harness-device' -ErrorAction SilentlyContinue)
  if ($running.Count) {
    Note 'the silent install started the app; it is ended before the checks'
    $running | Stop-Process -Force
    if (-not (Wait-For { -not (Get-Process -Name 'harness-device' -ErrorAction SilentlyContinue) })) { Fail 'the app started by the installer ends' }
  }

  # --- 2, and a login item turned off in Startup Apps: no CLI

  Save-State $true $true $false
  # Never New-Item -Force on a key that is there: it would empty it.
  if (-not $hadApprovedKey) { New-Item -Path $approvedKey -Force | Out-Null }
  New-ItemProperty -LiteralPath $approvedKey -Name $RUN_VALUE -PropertyType Binary -Force `
    -Value ([byte[]](3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)) | Out-Null
  Use-Fake $false
  Launch 'no-cli'
  if (-not (Wait-For { Logged $MENU_REMOVED })) { Fail "with cliSeen and no CLI, the log has $MENU_REMOVED" }
  Ok "with cliSeen and no CLI, the log has $MENU_REMOVED"
  if (-not (Wait-For { Logged 'login item: registered' })) { Fail 'the first run answers its login item' }
  if ($null -ne (Run-Value)) { Fail 'a login item turned off in Startup Apps is not written: the Run value stays absent' }
  Ok 'a login item turned off in Startup Apps (StartupApproved 03) is not written: no Run value'
  Stop-App
  Remove-ItemProperty -LiteralPath $approvedKey -Name $RUN_VALUE

  # --- 3, 4, 5: the fake CLI, the login item, one instance, the app in front

  Save-State $true $true $false
  Fake-Script 'hardware_watch_--json' @('{"attached":false}', '@record')
  Fake-Script 'auth_status_--json' @('{"loggedIn":false}')
  Fake-Script '--version' @('0.6.99')
  Use-Fake $true
  Launch 'fake-cli'
  if (-not (Wait-For { Logged $MENU })) { Fail "with the fake CLI, the log has $MENU" }
  Ok "with the fake CLI, the log has $MENU"

  if (-not (Wait-For { Logged 'login item: registered' })) { Fail 'the first run registers the login item' }
  $quoted = "`"$exe`""
  $value = Run-Value
  if ($value -ine $quoted) { Fail "the Run value $RUN_VALUE is the quoted exe, $quoted, not $value" }
  Ok "the Run value $RUN_VALUE is the quoted exe"
  $second = Start-Process -FilePath $exe -WorkingDirectory $work -PassThru
  $null = $second.Handle
  if (-not $second.WaitForExit($WAIT * 1000)) { Fail 'a second launch exits by itself' }
  if ($second.ExitCode -ne 0) { Fail "a second launch exits 0, not $($second.ExitCode)" }
  if ((Times-Logged 'instance: already running') -ne 1) { Fail 'a second launch logs instance: already running, once' }
  if ($script:app.HasExited) { Fail 'the first launch keeps running' }
  $copies = @(Get-Process -Name 'harness-device' -ErrorAction SilentlyContinue | Where-Object { -not $_.HasExited }).Count
  if ($copies -ne 1) { Fail "one harness-device.exe runs, not $copies" }
  if ((Run-Value) -cne $value) { Fail 'a second launch leaves the Run value as it is' }
  Ok 'a second launch exits with instance: already running; one harness-device.exe runs; the Run value is unchanged'

  # From here, each foreground change Windows reports, seen apart from the app.
  $started.Add((Start-Process -FilePath $frontWatch -ArgumentList "`"$frontEvents`"" -PassThru))
  if (-not (Wait-For { (Lines-Of $frontEvents) -contains 'ready' })) { Fail "the foreground witness hooks the desktop: $(Lines-Of $frontEvents)" }
  $fronts = @{}
  # Raises `name`'s window until GetForegroundWindow names it, and writes the step. False when the runner refuses it
  # (Front-Refused).
  function Raise-Front([string]$name) {
    $handle = $fronts[$name].MainWindowHandle
    $before = In-Front
    $script:calls = 0
    $raised = Wait-For { $script:calls++; [E2E.Native]::Raise($handle, $true) }
    Step "raise $name.exe: in front $before before, $(In-Front) after; Raise $raised by $([E2E.Native]::Way), $script:calls call(s)"
    if (-not $raised) { Front-Refused "$name.exe" }
    $raised
  }
  # Brings `name`'s window to the front from `other`'s until Windows reports the change (EVENT_SYSTEM_FOREGROUND, the
  # event the app follows, as the witness saw it), then waits until the watch has been told its exe once more.
  # GetForegroundWindow naming the window proves no change: the watch has gone untold for a minute while it named it.
  # A change Windows did not report is made again, twice at most. False when the runner refuses the front.
  function Bring([string]$name, [string]$other) {
    $handle = "$($fronts[$name].MainWindowHandle)"
    for ($try = 1; ; $try++) {
      # A change: from `other`, which first takes the front when this window has it.
      if ((([E2E.Native]::Front()) -split ' ')[0] -eq $handle -and -not (Raise-Front $other)) { return $false }
      $count = (Told "$name.exe") + 1
      $since = @(Front-Events).Count
      if (-not (Raise-Front $name)) { return $false }
      $reported = Wait-For { Reported $since ($fronts[$name].Id) } 5
      Step "Windows reported $name.exe in front: $reported"
      if ($reported) { break }
      if ($try -eq 3) { Fail "Windows reports $name.exe's window coming to the front (EVENT_SYSTEM_FOREGROUND), in $try tries" }
      Note "$name.exe's window came to the front with no change reported by Windows: it is brought there again"
    }
    $told = Wait-For { (Told "$name.exe") -ge $count }
    Step "the watch was told $name.exe $(Told "$name.exe") time(s)"
    if (-not $told) {
      Fail "Windows reported $name.exe in front: it reaches the watch's stdin as {`"front`":`"$name.exe`"}, $count time(s)"
    }
    return $true
  }
  # Both open, then each comes to the front in turn, then the first again, while the second is in front.
  foreach ($name in @('e2e-front', 'code')) {
    if (Told "$name.exe") { Fail "no $name.exe is told before it opens" }
    $copy = Join-Path $apps "$name.exe"
    Copy-Item -LiteralPath $window -Destination $copy
    $process = Start-Process -FilePath $copy -ArgumentList $name -PassThru
    $started.Add($process)
    if (-not (Wait-For { $process.Refresh(); $process.MainWindowHandle -ne [IntPtr]::Zero })) { Fail "the test window $name.exe opens" }
    $fronts[$name] = $process
    Step "opened $name.exe: window $($process.MainWindowHandle), pid $($process.Id)"
  }
  if ((Bring 'e2e-front' 'code') -and (Bring 'code' 'e2e-front') -and (Bring 'e2e-front' 'code')) {
    Ok 'two apps brought to the front in turn, each change reported by Windows, reach the watch: {"front":"e2e-front.exe"}, {"front":"code.exe"}, then e2e-front.exe again'
  }
  Stop-App
  foreach ($process in $fronts.Values) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue }

  # --- A page from the app: the sign-in window starts harness login, whose URL the shell opens (ShellExecuteW on a
  # thread of its own, in a single-threaded COM apartment)

  $token = [guid]::NewGuid().ToString('N')
  $tokens.Add($token)
  Save-State $true $false $true
  Fake-Script 'hardware_watch_--json' @('{"attached":false}', '@record')
  Fake-Script 'auth_status_--json' @('{"loggedIn":false}')
  Fake-Script '--version' @('0.6.99')
  # .invalid never resolves: whatever opens the page reaches no one.
  Fake-Script 'login_--json' @("{`"type`":`"authorize_url`",`"url`":`"https://example.invalid/harness-e2e?state=$token`"}", '@stdin')
  Launch 'sign-in'
  $script:harness = [IntPtr]::Zero
  if (-not (Wait-For { $script:harness = [E2E.Native]::Find($script:app.Id, 'Harness'); $script:harness -ne [IntPtr]::Zero })) {
    Fail 'a first run not asked to sign in shows the Sign in window'
  }
  if (Wait-For { [E2E.Native]::Raise($script:harness, $false) }) {
    # Return takes the window's primary answer, Sign in, once the page has drawn it.
    $signed = Wait-For {
      if (-not [E2E.Native]::Raise($script:harness, $false)) { return $false }
      [E2E.Native]::Press(0x0D)
      Wait-For { Called 'login --json' } 3
    }
    if (-not $signed) { Fail "the Sign in window's Return starts harness login --json" }
    Open-Page $token
  } else {
    Front-Refused 'the Sign in window'
  }
  Stop-App

  # --- The daemon: what `harness start` leaves outside its job outlives the run and the app

  Save-State $true $true $true
  Fake-Script 'hardware_watch_--json' @('@exit 3')
  Fake-Script 'auth_status_--json' @('{"loggedIn":false}')
  Fake-Script '--version' @('0.6.99')
  # `@spawn` stays in the run's job; `@breakaway` leaves it, as harness-launch.exe starts the daemon.
  Fake-Script 'start_--if-down' @('@spawn inside.pid', '@breakaway daemon.pid', '@wait start-may-end', '@exit 0')
  Launch 'daemon'
  $pidFile = { param($name) (Read-Shared (Join-Path $fake $name)).Trim() }
  if (-not (Wait-For { (& $pidFile 'daemon.pid') -and (& $pidFile 'inside.pid') } $START_WAIT)) {
    Fail 'after two downs of the watch, the app runs harness start --if-down in its slot'
  }
  $daemonText = & $pidFile 'daemon.pid'
  if ($daemonText -notmatch '^\d+$') { Fail "the run's job lets the daemon leave it (CREATE_BREAKAWAY_FROM_JOB): $daemonText" }
  $daemon = [int]$daemonText
  $inside = [int](& $pidFile 'inside.pid')
  # A job that does not let a process leave refuses CREATE_BREAKAWAY_FROM_JOB with access denied: a pid is the leave.
  # Whether it is in a job at all says nothing here, as the runner's own job holds every process of the step; that the
  # daemon is out of the app's job, whose handle only the app has, is what it outlives below.
  Ok "the run's job lets the daemon leave it: CREATE_BREAKAWAY_FROM_JOB starts it"
  Note "in a job: the daemon $([E2E.Native]::InJob($daemon)), what stays in the run $([E2E.Native]::InJob($inside)), this script $([E2E.Native]::InJob($PID))"
  if ((Gone $inside) -or (Gone $daemon)) { Fail 'while harness start runs, what it started runs' }
  New-Item -ItemType File -Path (Join-Path $fake 'start-may-end') | Out-Null
  if (-not (Wait-For { @(Fake-Lines 'ends.log' | Where-Object { $_ -ceq 'start --if-down' }).Count -gt 0 })) {
    Fail 'harness start --if-down ends'
  }
  if (-not (Wait-For { Gone $inside })) { Fail "what harness start left in its job ends when the run is reaped" }
  if (Gone $daemon) { Fail 'the daemon outlives the harness start that started it' }
  Ok 'once harness start ends, what it left in its job ends and the daemon runs on'
  Stop-App
  if (Gone $daemon) { Fail "the daemon outlives the app's process" }
  Ok "the daemon outlives the app's process"
  Stop-Process -Id $daemon -Force

  # --- The install line, seen by a stand-in for Windows PowerShell (a GitHub-hosted runner only)

  if ($env:GITHUB_ACTIONS -eq 'true' -and $env:RUNNER_ENVIRONMENT -eq 'github-hosted') {
    if (Get-ItemProperty -LiteralPath $ifeoKey -Name 'Debugger' -ErrorAction SilentlyContinue) {
      Fail 'powershell.exe has no Image File Execution Options debugger before the run'
    }
    $script:ifeo = if (Test-Path -LiteralPath $ifeoKey) { 'value' } else { 'key' }
    if ($script:ifeo -eq 'key') { New-Item -Path $ifeoKey | Out-Null }
    New-ItemProperty -LiteralPath $ifeoKey -Name 'Debugger' -PropertyType String -Value "`"$standIn`"" -Force | Out-Null
    # No CLI seen yet: the first launch installs, at once.
    Save-State $false $true $true
    Use-Fake $false
    Launch 'install'
    $record = Join-Path $tools 'powershell.record'
    $seen = Wait-For { Test-Path -LiteralPath $record }
    Remove-ItemProperty -LiteralPath $ifeoKey -Name 'Debugger'
    if ($script:ifeo -eq 'key') { Remove-Item -LiteralPath $ifeoKey }
    $script:ifeo = $null
    if (-not $seen) { Fail 'a first launch with no CLI runs the install line' }
    $lines = @(Lines-Of $record)
    $console = ($lines | Where-Object { $_.StartsWith('console: ') } | Select-Object -First 1).Substring(9)
    $ran = @($lines | Where-Object { $_.StartsWith('arg: ') } | ForEach-Object { $_.Substring(5) })
    if ($ran.Count -eq 0 -or $ran[0] -ine $powershell) { Fail "the install line runs $powershell, not $(if ($ran.Count) { $ran[0] })" }
    $rest = @($ran | Select-Object -Skip 1)
    if (($rest -join "`n") -cne ($INSTALL_ARGS -join "`n")) {
      Fail "Windows PowerShell gets the fixed arguments; it got: $($rest -join ' | ')"
    }
    Ok 'the install line runs Windows PowerShell by its full path with -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command and the desktop app''s line, as one argument'
    if ($console -eq 'visible') { Fail 'Windows PowerShell runs with no console window' }
    Ok "Windows PowerShell runs with no console window (its console: $console)"
    if (-not (Wait-For { Logged 'install: -Desktop exit 1' })) { Fail 'the log has install: -Desktop exit 1' }
    if (-not (Logged 'install: Downloading Harness 0.6.99 (e2e)...')) { Fail "the log keeps install.ps1's step line" }
    Ok "the log keeps install.ps1's step line and the run's exit"
    Stop-App
  } else {
    Note 'not a GitHub-hosted runner: the install line is not checked here (its stand-in is a machine-wide setting)'
  }

  # --- 6: no console window of the app's

  $theirs = @(Lines-Of $consoles | Where-Object { $_ -match '(^| )harness-device\.exe:' })
  if ($theirs.Count) { Fail "no console window of the app or of what it ran was shown: $($theirs[0])" }
  Ok "no console window of the app or of what it ran was shown from the first launch to here ($(@(Lines-Of $consoles).Count - 1) seen, all of other programs)"

  # --- 7: the silent uninstall

  if ($null -eq (Run-Value)) { Fail 'the Run value is there before the uninstall' }
  Start-Process -FilePath (Join-Path $installDir 'uninstall.exe') -ArgumentList '/S' | Out-Null
  $left = { @(@($installDir, $shortcut, $uninstallKey) | Where-Object { Test-Path -LiteralPath $_ }) + @(if ($null -ne (Run-Value)) { "the Run value $RUN_VALUE" }) }
  if (-not (Wait-For { (& $left).Count -eq 0 })) { Fail "uninstall.exe /S removes everything it installed: left $((& $left) -join ', ')" }
  $script:installed = $false
  Ok 'uninstall.exe /S removes the folder, the Start Menu shortcut, the uninstall entry and the Run value'
  Write-Host '0 FAILED'
} catch {
  Report-Failure $_
  $code = 1
} finally {
  Clean-Up
}
exit $code
