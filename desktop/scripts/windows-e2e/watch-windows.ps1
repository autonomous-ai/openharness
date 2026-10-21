# watch-windows.ps1 [-Seconds 90] [-Probe]: every top-level window that appears in this desktop session while it runs,
# with its process and that process's parents. Run in the session (session-run.ps1, with RUN_TIMEOUT above -Seconds).
# The check is "no console window may flash": a CONSOLE line is a console or terminal window, and a FLASH line is one
# whose process descends from harness-desktop.exe or Harness.exe. Event-driven (EVENT_OBJECT_SHOW), so a window shown
# for one frame is still seen. -Probe starts a console of its own once hooked and says whether it was seen: the
# detector's positive control.
param([int]$Seconds = 90, [switch]$Probe)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'ownership.ps1')
Assert-OwnedSession | Out-Null
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
public static class HxWatch {
  delegate void WinEventProc(IntPtr hook, uint ev, IntPtr hwnd, int idObject, int idChild, uint thread, uint time);
  [StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public int x; public int y; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)] struct PROCESSENTRY32 {
    public uint dwSize; public uint cntUsage; public uint th32ProcessID; public IntPtr th32DefaultHeapID; public uint th32ModuleID;
    public uint cntThreads; public uint th32ParentProcessID; public int pcPriClassBase; public uint dwFlags;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string szExeFile;
  }
  [DllImport("user32.dll")] static extern IntPtr SetWinEventHook(uint min, uint max, IntPtr module, WinEventProc proc, uint pid, uint tid, uint flags);
  [DllImport("user32.dll")] static extern bool UnhookWinEvent(IntPtr hook);
  [DllImport("user32.dll")] static extern bool PeekMessage(out MSG m, IntPtr h, uint min, uint max, uint remove);
  [DllImport("user32.dll")] static extern bool TranslateMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr DispatchMessage(ref MSG m);
  [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW")] static extern bool Process32First(IntPtr snap, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32NextW")] static extern bool Process32Next(IntPtr snap, ref PROCESSENTRY32 e);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);

  static Dictionary<uint, KeyValuePair<uint, string>> Processes() {
    var all = new Dictionary<uint, KeyValuePair<uint, string>>();
    IntPtr snap = CreateToolhelp32Snapshot(2, 0);   // TH32CS_SNAPPROCESS
    var e = new PROCESSENTRY32();
    e.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
    if (Process32First(snap, ref e)) {
      do { all[e.th32ProcessID] = new KeyValuePair<uint, string>(e.th32ParentProcessID, e.szExeFile); } while (Process32Next(snap, ref e));
    }
    CloseHandle(snap);
    return all;
  }

  // "name(pid) < parent(pid) < ..." while the process lives, at most eight levels.
  public static string Chain(uint pid) {
    var all = Processes();
    var parts = new List<string>();
    for (int level = 0; level < 8; level++) {
      KeyValuePair<uint, string> p;
      if (!all.TryGetValue(pid, out p)) { parts.Add("(" + pid + ", exited)"); break; }
      parts.Add(p.Value + "(" + pid + ")");
      if (p.Key == 0 || p.Key == pid) break;
      pid = p.Key;
    }
    return string.Join(" < ", parts.ToArray());
  }

  static List<string> seen;
  static WinEventProc keep;

  public static List<string> Run(int milliseconds, bool probe) {
    seen = new List<string>();
    keep = delegate (IntPtr hook, uint ev, IntPtr h, int idObject, int idChild, uint thread, uint time) {
      if (idObject != 0 || h == IntPtr.Zero || GetAncestor(h, 2) != h) return;   // OBJID_WINDOW, top-level (GA_ROOT)
      var cls = new StringBuilder(256);
      GetClassName(h, cls, 256);
      var title = new StringBuilder(256);
      GetWindowText(h, title, 256);
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      seen.Add(DateTime.Now.ToString("HH:mm:ss.fff") + "\t" + cls + "\t" + Chain(pid) + "\t" + title);
    };
    IntPtr hookHandle = SetWinEventHook(0x8002, 0x8002, IntPtr.Zero, keep, 0, 0, 0);   // EVENT_OBJECT_SHOW, out of context
    if (probe) System.Diagnostics.Process.Start("cmd.exe", "/c ping -n 3 127.0.0.1 >nul");
    var end = DateTime.UtcNow.AddMilliseconds(milliseconds);
    MSG m;
    while (DateTime.UtcNow < end) {
      while (PeekMessage(out m, IntPtr.Zero, 0, 0, 1)) { TranslateMessage(ref m); DispatchMessage(ref m); }
      Thread.Sleep(5);
    }
    UnhookWinEvent(hookHandle);
    return seen;
  }
}
'@
$consoleClasses = @('ConsoleWindowClass', 'CASCADIA_HOSTING_WINDOW_CLASS', 'PseudoConsoleWindow')
Write-Output "watching for $Seconds s from $((Get-Date).ToString('HH:mm:ss.fff'))"
$lines = [HxWatch]::Run($Seconds * 1000, [bool]$Probe)
$consoles = 0
$flashes = 0
foreach ($line in $lines) {
  $class = $line.Split("`t")[1]
  $tag = 'WINDOW'
  if ($consoleClasses -contains $class) {
    $consoles++
    $tag = 'CONSOLE'
    # The app is harness-desktop.exe and its launcher Harness.exe (capital H); the CLI's bin\harness.exe is not it.
    if ($line -match '(?i)harness-desktop\.exe\(' -or $line -cmatch 'Harness\.exe\(') { $flashes++; $tag = 'FLASH' }
  }
  Write-Output "$tag`t$line"
}
Write-Output "windows shown: $($lines.Count); console windows: $consoles; from Harness: $flashes"
if ($Probe) { Write-Output "probe: $(if ($consoles -gt 0) { 'seen' } else { 'NOT seen: the detector missed a console window' })" }
