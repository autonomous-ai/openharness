/**
 * The elevated script that removes an old Harness Team account from Windows (./remove.ts runs it once behind User
 * Account Control, through lib/windows/elevated.ts). The Windows twin of ./removeScript.ts, and the removal `harness team
 * remove` ran until the command went (anh Dee, 2026-11-10), as Windows PowerShell 5.1 text.
 *
 * - Every value is checked first (./layout.ts) and goes into the script single-quoted (`ps`), assigned once to a variable
 *   that every later line uses.
 * - What the Team account could write is deleted through handles, never walked by path, so a junction it planted cannot
 *   turn the administrator's delete into one elsewhere (audit W5).
 * - Removal goes in the order that lets a refusal change nothing: the task is disabled, not unregistered, until the
 *   account is gone (registering it again would need a password nobody knows), and the profile goes before the account.
 */
import { ps } from '../lib/windows/powershellQuote.js'
import { TEAM_CONFIG_FILES, checkWindowsPath, checkWindowsUser } from './layout.js'
import { REMOVE_REFUSED, SENTINEL_NAME, type RemoveScriptInput } from './removeScript.js'

export const WINDOWS_TEAM = {
  sharedDir: 'C:\\ProgramData\\Harness',
  sharedMark: 'C:\\ProgramData\\Harness\\.made-by-harness-team-setup',
  statusDir: 'C:\\ProgramData\\Harness\\Team',
  taskPath: '\\Harness\\',
  taskName: 'Harness Team',
} as const

// An allow-only SDDL for this run's own staging folder: SYSTEM and Administrators.
const PRIVATE_SDDL = '"O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"'

const PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
  // LF alone: the owner's side splits this output into lines at LF, and a CR would stay in what it prints.
  'function say([string]$m) { [Console]::Out.Write("harness: $m`n") }',
  'function die([string]$m, [int]$code = 1) { Clear-Stage; [Console]::Error.Write("harness: $m`n"); exit $code }',
  '$script:RT = $null',
  'function Clear-Stage { if ($script:RT) { try { Remove-Tree $script:RT } catch { }; $script:RT = $null } }',
  'trap { die $_.Exception.Message 1 }',
  "$ADMINS = 'S-1-5-32-544'",
  "$SYSTEM_SID = 'S-1-5-18'",
  '$REPARSE = [IO.FileAttributes]::ReparsePoint',
  'function Owner-Of([string]$path) { (Get-Acl -LiteralPath $path).GetOwner([Security.Principal.SecurityIdentifier]).Value }',
  'function Item-At([string]$path) { Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }',
  // Deletes a folder and what is in it, never through a link: a junction is removed as itself, its target left. Given a
  // list, what cannot be deleted is added to it, deepest first, rather than stopping the script.
  'function Remove-Tree([string]$path, $left = $null) {',
  '  $item = Item-At $path',
  '  if (-not $item) { return }',
  '  try {',
  '    if ($item.Attributes -band $REPARSE) { if ($item.PSIsContainer) { [IO.Directory]::Delete($path) } else { [IO.File]::Delete($path) }; return }',
  '    if ($item.PSIsContainer) {',
  '      foreach ($child in @(Get-ChildItem -LiteralPath $path -Force)) { Remove-Tree $child.FullName $left }',
  '      [IO.Directory]::Delete($path)',
  '    } else { $item.Attributes = [IO.FileAttributes]::Normal; [IO.File]::Delete($path) }',
  '  } catch { if ($null -eq $left) { throw }; [void]$left.Add($path) }',
  '}',
  // A folder this script relies on is made with its ACL in one step (CreateDirectory with a security descriptor), so no
  // other account can put anything in it first. One already there must be a plain folder, Administrators' or SYSTEM's.
  'function Set-Folder([string]$path, [string]$sddl) {',
  '  $item = Item-At $path',
  '  if ($item) {',
  '    if (-not $item.PSIsContainer -or ($item.Attributes -band $REPARSE)) { die "$path is not a plain folder" 6 }',
  '    $owner = Owner-Of $path',
  '    if ($owner -ne $ADMINS -and $owner -ne $SYSTEM_SID) { die "$path does not belong to Administrators" 6 }',
  '  } else {',
  '    $made = New-Object Security.AccessControl.DirectorySecurity',
  '    $made.SetSecurityDescriptorSddlForm($sddl)',
  '    [void][IO.Directory]::CreateDirectory($path, $made)',
  '  }',
  '  $acl = New-Object Security.AccessControl.DirectorySecurity',
  "  $acl.SetSecurityDescriptorSddlForm($sddl, 'Access')",
  '  (Item-At $path).SetAccessControl($acl)',
  '}',
  // This run's own files, in a folder of the system's temporary folder that it makes with its ACL, removed as it ends.
  'function New-Stage([string]$sddl) {',
  "  $script:RT = Join-Path $env:SystemRoot ('Temp\\harness-team-' + [guid]::NewGuid().ToString('N'))",
  '  Set-Folder $script:RT $sddl',
  '  return $script:RT',
  '}',
  // "Log on as a batch job", which a task's password logon needs and which Windows gives only Administrators, Backup
  // Operators and Performance Log Users: registering a task does not grant it (DESKTOP-0TFH0OJ, 2026-10-28: the team
  // task never ran, and the Security log said 4625, "not been granted the requested logon type", 0xC000015B). Set
  // through secedit, Microsoft's, with the right's whole list as it is plus or less this one SID.
  "$SECEDIT = Join-Path $env:SystemRoot 'System32\\secedit.exe'",
  'function Set-BatchLogon([string]$sid, [bool]$grant) {',
  "  $inf = Join-Path $script:RT 'rights.inf'",
  '  & $SECEDIT /export /areas USER_RIGHTS /cfg $inf /quiet | Out-Null',
  '  if ($LASTEXITCODE -ne 0) { die "could not read who may log on as a batch job (secedit $LASTEXITCODE)" 8 }',
  "  $line = @(Get-Content -LiteralPath $inf | Where-Object { $_ -like 'SeBatchLogonRight*' })",
  "  $listed = if ($line.Count -gt 0) { @(($line[0] -split '=', 2)[1].Split(',') | ForEach-Object { $_.Trim() } | Where-Object { $_ }) } else { @() }",
  // secedit names an account it can resolve (`harnessteam`) and a SID it cannot (`*S-1-…`): each by SID, to compare.
  "  $now = @(foreach ($e in $listed) { if ($e.StartsWith('*')) { $e } else { try { '*' + (New-Object Security.Principal.NTAccount($e)).Translate([Security.Principal.SecurityIdentifier]).Value } catch { $e } } })",
  '  $entry = "*$sid"',
  '  if ($grant -eq ($now -contains $entry)) { return }',
  '  $next = @($now | Where-Object { $_ -ne $entry })',
  '  if ($grant) { $next += $entry }',
  "  Set-Content -LiteralPath $inf -Encoding Unicode -Value @('[Unicode]', 'Unicode=yes', '[Version]', 'signature=\"$CHICAGO$\"', 'Revision=1', '[Privilege Rights]', \"SeBatchLogonRight = $($next -join ',')\")",
  "  & $SECEDIT /configure /db (Join-Path $script:RT 'rights.sdb') /cfg $inf /areas USER_RIGHTS /quiet | Out-Null",
  '  if ($LASTEXITCODE -ne 0) { die "could not change who may log on as a batch job (secedit $LASTEXITCODE)" 8 }',
  '}',
  "if ($env:OS -ne 'Windows_NT') { die 'the Harness Team account on Windows is for Windows' 3 }",
  'if (-not ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {',
  "  die 'run as an administrator (User Account Control)' 3",
  '}',
  "if ($env:ProgramData -ne 'C:\\ProgramData') { die \"the Harness Team account needs C:\\ProgramData (this computer's is $env:ProgramData)\" 3 }",
]

/** A single-quoted here-string holding [text], which must not hold the line that would end it. */
function hereString(text: string): string {
  if (text.includes("\n'@")) throw new Error('the embedded script cannot hold a line starting with \'@')
  return `@'\n${text}\n'@`
}

/**
 * Deletes what the Team account could write, as an administrator (audit W5): renamed first where Windows allows, then through
 * handles opened relative to each parent and never through a link. Compiled by Windows PowerShell's Add-Type (Microsoft's
 * csc.exe), so it is C# 5. Not walked by path as Remove-Tree does: a Team process could swap a checked folder for a junction,
 * and the administrator would delete what is behind it.
 */
const TEAM_REMOVE_HELPER = String.raw`using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class HarnessTeamRemove {
  const uint DELETE = 0x00010000, FILE_LIST_DIRECTORY = 0x1, FILE_READ_ATTRIBUTES = 0x80, FILE_WRITE_ATTRIBUTES = 0x100, SYNCHRONIZE = 0x00100000;
  const uint WALK = DELETE | FILE_LIST_DIRECTORY | FILE_READ_ATTRIBUTES | FILE_WRITE_ATTRIBUTES | SYNCHRONIZE, BARE = DELETE | FILE_READ_ATTRIBUTES | SYNCHRONIZE;
  const uint SHARE_ALL = 7, OPEN_EXISTING = 3, FILE_FLAG_BACKUP_SEMANTICS = 0x02000000, FILE_FLAG_OPEN_REPARSE_POINT = 0x00200000;
  const uint OBJ_CASE_INSENSITIVE = 0x40, FILE_SYNCHRONOUS_IO_NONALERT = 0x20, FILE_OPEN_FOR_BACKUP_INTENT = 0x4000, FILE_OPEN_REPARSE_POINT = 0x00200000;
  const uint ATTR_DIRECTORY = 0x10, ATTR_REPARSE = 0x400, ATTR_NORMAL = 0x80;
  const int INFO_BASIC = 0, INFO_DISPOSITION = 4, INFO_FULL_DIRECTORY = 14, ERROR_NO_MORE_FILES = 18, MAX_DEPTH = 512;

  [StructLayout(LayoutKind.Sequential)] struct UNICODE_STRING { public ushort Length; public ushort MaximumLength; public IntPtr Buffer; }
  [StructLayout(LayoutKind.Sequential)] struct OBJECT_ATTRIBUTES { public int Length; public IntPtr RootDirectory; public IntPtr ObjectName; public uint Attributes; public IntPtr SecurityDescriptor; public IntPtr SecurityQualityOfService; }
  [StructLayout(LayoutKind.Sequential)] struct IO_STATUS_BLOCK { public IntPtr Status; public IntPtr Information; }

  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
  [DllImport("ntdll.dll")]
  static extern int NtOpenFile(out SafeFileHandle handle, uint access, ref OBJECT_ATTRIBUTES attributes, out IO_STATUS_BLOCK status, uint share, uint options);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, byte[] buffer, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetFileInformationByHandle(SafeFileHandle handle, int kind, byte[] buffer, uint size);

  // What could not be deleted, deepest first. A link is deleted as itself and nothing behind it is touched: every child opens
  // relative to its parent's open handle and without following a link, so swapping a folder for a junction changes nothing.
  public static string[] Delete(string path) {
    List<string> left = new List<string>();
    string native = path.Length > 2 && path[1] == ':' ? "\\\\?\\" + path : path;
    SafeFileHandle top = CreateFileW(native, WALK, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (top.IsInvalid) top = CreateFileW(native, BARE, SHARE_ALL, IntPtr.Zero, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, IntPtr.Zero);
    if (top.IsInvalid) { left.Add(path); return left.ToArray(); }
    using (top) { Finish(top, path, 0, left); }
    return left.ToArray();
  }

  static void Finish(SafeFileHandle item, string at, int depth, List<string> left) {
    uint attributes;
    if (!Attributes(item, out attributes)) { left.Add(at); return; }
    if ((attributes & ATTR_DIRECTORY) != 0 && (attributes & ATTR_REPARSE) == 0) {
      if (depth >= MAX_DEPTH) { left.Add(at); return; }
      Empty(item, at, depth, left);
    }
    if (!MarkDeleted(item)) left.Add(at);
  }

  static void Empty(SafeFileHandle folder, string at, int depth, List<string> left) {
    List<string> names = new List<string>();
    byte[] buffer = new byte[64 * 1024];
    while (true) {
      if (!GetFileInformationByHandleEx(folder, INFO_FULL_DIRECTORY, buffer, (uint)buffer.Length)) {
        if (Marshal.GetLastWin32Error() != ERROR_NO_MORE_FILES) left.Add(at);
        break;
      }
      for (int offset = 0; ; ) {
        int next = BitConverter.ToInt32(buffer, offset), length = BitConverter.ToInt32(buffer, offset + 60);
        string name = Encoding.Unicode.GetString(buffer, offset + 68, length);
        if (name != "." && name != "..") names.Add(name);
        if (next == 0) break;
        offset += next;
      }
    }
    foreach (string name in names) {
      string child = at + "\\" + name;
      SafeFileHandle item = OpenChild(folder, name, WALK);
      if (item.IsInvalid) item = OpenChild(folder, name, BARE);
      if (item.IsInvalid) { left.Add(child); continue; }
      using (item) { Finish(item, child, depth + 1, left); }
    }
  }

  static SafeFileHandle OpenChild(SafeFileHandle folder, string name, uint access) {
    IntPtr text = Marshal.StringToHGlobalUni(name), unicode = IntPtr.Zero;
    bool added = false;
    try {
      folder.DangerousAddRef(ref added);
      UNICODE_STRING label = new UNICODE_STRING();
      label.Length = (ushort)(name.Length * 2);
      label.MaximumLength = label.Length;
      label.Buffer = text;
      unicode = Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UNICODE_STRING)));
      Marshal.StructureToPtr(label, unicode, false);
      OBJECT_ATTRIBUTES attributes = new OBJECT_ATTRIBUTES();
      attributes.Length = Marshal.SizeOf(typeof(OBJECT_ATTRIBUTES));
      attributes.RootDirectory = folder.DangerousGetHandle();
      attributes.ObjectName = unicode;
      attributes.Attributes = OBJ_CASE_INSENSITIVE;
      SafeFileHandle item;
      IO_STATUS_BLOCK status;
      int result = NtOpenFile(out item, access, ref attributes, out status, SHARE_ALL, FILE_SYNCHRONOUS_IO_NONALERT | FILE_OPEN_FOR_BACKUP_INTENT | FILE_OPEN_REPARSE_POINT);
      if (result >= 0) return item;
      if (item != null) item.Dispose();
      return new SafeFileHandle(IntPtr.Zero, true);
    } finally {
      if (added) folder.DangerousRelease();
      if (unicode != IntPtr.Zero) Marshal.FreeHGlobal(unicode);
      Marshal.FreeHGlobal(text);
    }
  }

  static bool Attributes(SafeFileHandle item, out uint attributes) {
    byte[] basic = new byte[40];
    attributes = 0;
    if (!GetFileInformationByHandleEx(item, INFO_BASIC, basic, 40)) return false;
    attributes = BitConverter.ToUInt32(basic, 32);
    return true;
  }

  // A read-only file refuses deletion until that is cleared.
  static bool MarkDeleted(SafeFileHandle item) {
    byte[] yes = new byte[] { 1 };
    if (SetFileInformationByHandle(item, INFO_DISPOSITION, yes, 1)) return true;
    uint attributes;
    if (!Attributes(item, out attributes)) return false;
    byte[] basic = new byte[40];
    BitConverter.GetBytes(ATTR_NORMAL).CopyTo(basic, 32);
    return SetFileInformationByHandle(item, INFO_BASIC, basic, 40) && SetFileInformationByHandle(item, INFO_DISPOSITION, yes, 1);
  }
}`

/** The PowerShell around that helper, needing Item-At and `die` from the prelude. */
const windowsRemoveHelperLines = (): string[] => [
  // What the Team account named reaches the administrator's console from here too (security review of #2579).
  WINDOWS_CLEAN_LINE,
  `$HELPER = ${hereString(TEAM_REMOVE_HELPER)}`,
  'function Load-Helper { Add-Type -TypeDefinition $HELPER -Language CSharp -ErrorAction Stop }',
  'function Remove-Held([string]$path, $left = $null) {',
  '  if (-not (Item-At $path)) { return }',
  '  $at = $path',
  "  $moved = Join-Path (Split-Path -Parent $path) ('.harness-removing-' + [guid]::NewGuid().ToString('N'))",
  '  try { [IO.Directory]::Move($path, $moved); $at = $moved } catch { }',
  '  $failed = @([HarnessTeamRemove]::Delete($at))',
  '  if ($failed.Count -eq 0) { return }',
  '  if ($null -eq $left) { throw "could not delete $(Clean-Line $failed[0]) and $($failed.Count - 1) more" }',
  '  foreach ($one in $failed) { [void]$left.Add($one) }',
  '}',
  // A removal that stopped partway left its renamed folders: only this script makes those names, in folders others cannot write.
  "function Remove-Renamed([string]$parent) { if (Item-At $parent) { foreach ($old in @(Get-ChildItem -LiteralPath $parent -Force -Filter '.harness-removing-*')) { Remove-Held $old.FullName } } }",
  // By the Task Scheduler service and the exact name, as setup deletes its own: the ScheduledTasks commands read -TaskName as a
  // wildcard, so a Team task named [G]oogleUpdate could match the real GoogleUpdate (security review 2 of #2579).
  'function Task-Folder($own) {',
  '  if (-not $script:taskService) { $script:taskService = New-Object -ComObject Schedule.Service; $script:taskService.Connect() }',
  "  $folder = ([string]$own.TaskPath).TrimEnd('\\')",
  "  $script:taskService.GetFolder($(if ($folder) { $folder } else { '\\' }))",
  '}',
  'function Delete-Task($own) { try { (Task-Folder $own).DeleteTask($own.TaskName, 0) } catch { } }',
  'function Task-There($own) { try { [void](Task-Folder $own).GetTask($own.TaskName); $true } catch { $false } }',
  // Tasks the account registered for itself: any of them could start it again while it goes. By name or SID, as Windows shows either.
  'function Team-Tasks {',
  '  @(Get-ScheduledTask -ErrorAction SilentlyContinue | Where-Object {',
  '    $user = [string]$_.Principal.UserId',
  "    $parts = $user -split '\\\\'",
  '    $user -and ($_.TaskPath -ne $TASK_PATH -or $_.TaskName -ne $TASK_NAME) -and (($teamSid -and $user -eq $teamSid) -or ($parts[-1] -eq $TEAM -and ($parts.Count -eq 1 -or $parts[0] -eq $env:COMPUTERNAME)))',
  '  })',
  '}',
]

/** Removes control and format characters from what the Team account wrote, then cuts it, before it is printed. */
const WINDOWS_CLEAN_LINE = "function Clean-Line([string]$text) { $clean = [regex]::Replace($text, '[\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}]', ''); if ($clean.Length -gt 2000) { $clean.Substring(0, 2000) } else { $clean } }"

export function buildWindowsRemoveScript(input: RemoveScriptInput): string {
  const user = checkWindowsUser(input.user, 'team account')
  const home = checkWindowsPath(input.home, 'team home')
  const ownerHome = checkWindowsPath(input.ownerHome, 'owner home')
  return [
    '# Harness Team account removal (cli/src/team/windowsRemoveScript.ts), run once elevated behind User Account Control.',
    '# It leaves the owner\'s profile private, as setup made it.',
    ...PRELUDE,
    `$TEAM = ${ps(user)}`,
    `$TEAM_HOME = ${ps(home)}`,
    `$SENTINEL = ${ps(`${ownerHome}\\${SENTINEL_NAME}`)}`,
    `$SHARED = ${ps(WINDOWS_TEAM.sharedDir)}`,
    `$SHARED_MARK = ${ps(WINDOWS_TEAM.sharedMark)}`,
    `$CONFIG = ${ps(TEAM_CONFIG_FILES.win32)}`,
    `$STATUS_DIR = ${ps(WINDOWS_TEAM.statusDir)}`,
    `$TASK_PATH = ${ps(WINDOWS_TEAM.taskPath)}`,
    `$TASK_NAME = ${ps(WINDOWS_TEAM.taskName)}`,
    `$PROFILE_LIST = ${ps('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList')}`,
    `$SESSION_MANAGER = ${ps('HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager')}`,
    '$account = Get-LocalUser -Name $TEAM -ErrorAction SilentlyContinue',
    '$teamSid = if ($account) { $account.SID.Value } else { $null }',
    '$teamProfile = @(Get-CimInstance Win32_UserProfile | Where-Object { $_.LocalPath -eq $TEAM_HOME -or ($teamSid -and $_.SID -eq $teamSid) })',
    'if ($teamProfile.Count -gt 1) { die "more than one profile is $TEAM_HOME or belongs to $TEAM; nothing was removed" 4 }',
    'if ($teamProfile.Count -eq 1) {',
    '  if ($teamSid -and ($teamProfile[0].SID -ne $teamSid -or $teamProfile[0].LocalPath -ne $TEAM_HOME)) { die "the account $TEAM or the profile $TEAM_HOME is not the Harness Team account\'s; nothing was removed" 4 }',
    // A profile left by a team account deleted elsewhere: ours only when its SID names no account any more.
    '  if (-not $teamSid) {',
    '    $mapped = $true',
    '    try { [void](New-Object Security.Principal.SecurityIdentifier($teamProfile[0].SID)).Translate([Security.Principal.NTAccount]) } catch { $mapped = $false }',
    '    if ($mapped) { die "$TEAM_HOME belongs to another account; nothing was removed" 4 }',
    '    $teamSid = $teamProfile[0].SID',
    '  }',
    '}',
    '',
    ...windowsRemoveHelperLines(),
    `try { Load-Helper } catch { die "could not prepare the safe delete ($($_.Exception.Message)); nothing was removed" 1 }`,
    '',
    '# 1. The team daemon\'s task stops and is disabled, so it starts nothing while the account goes.',
    '$task = Get-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME -ErrorAction SilentlyContinue',
    'if ($task) {',
    '  Disable-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME | Out-Null',
    '  Stop-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME',
    '}',
    '',
    // Run again after the kill: a process alive at the first look can register a task before it dies (security review of #2579).
    '$script:seenTasks = @()',
    '$script:heldTasks = @()',
    'function Hold-Tasks {',
    '  foreach ($own in @(Team-Tasks)) {',
    '    if ($script:seenTasks | Where-Object { $_.TaskPath -eq $own.TaskPath -and $_.TaskName -eq $own.TaskName }) { continue }',
    '    $script:seenTasks += $own',
    "    if ($own.State -ne 'Disabled') { $script:heldTasks += $own }",
    '    Disable-ScheduledTask -InputObject $own -ErrorAction SilentlyContinue | Out-Null',
    '    Stop-ScheduledTask -InputObject $own -ErrorAction SilentlyContinue',
    '  }',
    '}',
    'function Restore-Tasks { foreach ($own in $script:heldTasks) { Enable-ScheduledTask -InputObject $own -ErrorAction SilentlyContinue | Out-Null } }',
    'Hold-Tasks',
    '',
    '# 2. Every process running as the team account: its daemon, its terminal host, teammates\' agents.',
    'function Team-Processes {',
    '  if (-not $teamSid) { return @() }',
    '  @(Get-CimInstance Win32_Process | Where-Object { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue; $o -and $o.Sid -eq $teamSid })',
    '}',
    'foreach ($process in @(Team-Processes)) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }',
    'Start-Sleep -Seconds 1',
    'Hold-Tasks',
    'foreach ($process in @(Team-Processes)) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }',
    '',
    '# 3. The profile. When something of the account still runs and holds it, the task runs again and nothing was removed.',
    // Windows keeps a profile's registry loaded after its account's last process has gone, and for good: on
    // DESKTOP-0TFH0OJ three other accounts' stayed loaded for days, and the team account's for as long as it was watched
    // after its tasks had run (2026-10-28), so Win32_UserProfile refused to delete it ("being used by another process").
    // With nothing of the account running, that hold is Windows' own: the profile goes as far as Windows lets it now
    // (step 5), and the files it holds at the next restart.
    '$leftHive = $false',
    'if ($teamProfile.Count -eq 1) {',
    '  $why = $null',
    '  $held = $false',
    '  for ($try = 0; $try -lt 10; $try++) {',
    '    $current = @(Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $teamSid })',
    '    if ($current.Count -eq 0) { $why = $null; break }',
    '    try { Remove-CimInstance -InputObject $current[0]; $why = $null; break } catch { $why = $_.Exception.Message; $held = [bool]$current[0].Loaded; Start-Sleep -Seconds 3 }',
    '  }',
    '  $leftHive = [bool]$why -and $held -and @(Team-Processes).Count -eq 0',
    '  if ($why -and -not $leftHive) {',
    '    Restore-Tasks',
    '    if ($task) { Enable-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME | Out-Null; Start-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME }',
    `    die "could not remove the profile $TEAM_HOME ($why). Nothing was removed" ${REMOVE_REFUSED}`,
    '  }',
    '  if (-not $why) { say "removed the profile $TEAM_HOME" }',
    '}',
    '',
    '# 4. The account.',
    'if ($account) {',
    '  try { Remove-LocalUser -Name $TEAM } catch {',
    '    Restore-Tasks',
    '    if ($task) { Enable-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME | Out-Null; Start-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME }',
    `    die "could not delete the account $TEAM ($($_.Exception.Message)). Its profile was removed" ${REMOVE_REFUSED}`,
    '  }',
    '  say "deleted the account $TEAM"',
    '}',
    '',
    // A task that started in the moment before the last look may have left a process with no account.
    'foreach ($process in @(Team-Processes)) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }',
    '',
    '# 5. What it left: its task\'s definition, its batch logon right, a profile folder Windows did not take, what setup',
    '#    made and the sentinel.',
    'if ($task) { Unregister-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME -Confirm:$false }',
    // The ones found while the account was there too: its name may not match once it has gone.
    'foreach ($own in @($script:seenTasks + @(Team-Tasks))) { Delete-Task $own }',
    '$stayed = @(@($script:seenTasks) + @(Team-Tasks) | Where-Object { Task-There $_ })',
    'if ($stayed.Count -gt 0) { say "could not remove $($stayed.Count) task(s) the team account registered: $(($stayed | ForEach-Object { Clean-Line $_.TaskName }) -join \', \')" }',
    `if ($teamSid) { [void](New-Stage ${PRIVATE_SDDL}); Set-BatchLogon $teamSid $false }`,
    "try { $scheduler = New-Object -ComObject Schedule.Service; $scheduler.Connect(); $scheduler.GetFolder('\\').DeleteFolder($TASK_PATH.Trim('\\'), 0) } catch { }",
    // A folder Windows left behind when it removed the profile record, which named this folder as the team account's.
    'if ($teamProfile.Count -eq 1 -and -not $leftHive -and (Item-At $TEAM_HOME)) { Remove-Held $TEAM_HOME }',
    'Remove-Renamed (Split-Path -Parent $TEAM_HOME)',
    'Remove-Renamed $SHARED',
    // The profile Windows would not delete: its record, then every file it lets go of now, and the ones it holds (the
    // registry files) at the next restart, through the Session Manager's pending deletions as MoveFileEx records them.
    'if ($leftHive) {',
    '  Remove-Item -LiteralPath "$PROFILE_LIST\\$teamSid" -Recurse -Force -ErrorAction SilentlyContinue',
    '  $left = New-Object System.Collections.ArrayList',
    '  Remove-Held $TEAM_HOME $left',
    '  if ($left.Count -gt 0) {',
    '    $existing = (Get-ItemProperty -LiteralPath $SESSION_MANAGER -Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations',
    '    $pending = if ($existing) { @($existing) } else { @() }',
    '    foreach ($path in $left) { $pending += "\\??\\$path"; $pending += \'\' }',
    '    New-ItemProperty -LiteralPath $SESSION_MANAGER -Name PendingFileRenameOperations -PropertyType MultiString -Value ([string[]]$pending) -Force | Out-Null',
    '    say "Windows still holds the registry of ${TEAM}; the rest of $TEAM_HOME ($($left.Count) items) is removed at the next restart"',
    '  } else { say "removed the profile $TEAM_HOME" }',
    '}',
    'Remove-Held $STATUS_DIR',
    'Remove-Tree $CONFIG',
    "if (Item-At $SHARED) { foreach ($relay in @(Get-ChildItem -LiteralPath $SHARED -Force -Filter 'team-relay-*')) { Remove-Held $relay.FullName } }",
    '$sentinel = Item-At $SENTINEL',
    'if ($sentinel -and -not $sentinel.PSIsContainer) { [IO.File]::Delete($SENTINEL) }',
    // The shared folder, only when setup made it and nothing else has been put in it since.
    'if ((Test-Path -LiteralPath $SHARED_MARK) -and -not ((Item-At $SHARED).Attributes -band $REPARSE)) {',
    '  $others = @(Get-ChildItem -LiteralPath $SHARED -Force | Where-Object { $_.FullName -ne $SHARED_MARK })',
    '  if ($others.Count -eq 0) { [IO.File]::Delete($SHARED_MARK); [IO.Directory]::Delete($SHARED) }',
    '}',
    'say "removed the Harness Team account, its profile and its daemon\'s task"',
    'Clear-Stage',
    'exit 0',
    '',
  ].join('\n')
}
