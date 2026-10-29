/**
 * The elevated scripts behind `harness team setup` and `harness team remove` on Windows, and the scheduled task that runs
 * the team daemon (docs/superpowers/plans/2026-10-28-harness-team-account-windows.md, Task 2). The Windows twins of
 * ./script.ts, built here as Windows PowerShell 5.1 text and run once elevated behind User Account Control.
 *
 * The same rules as the macOS scripts, in PowerShell's terms:
 * - Every value is checked first (./windowsLayout.ts) and goes into the script single-quoted (`ps`), assigned once to a
 *   variable that every later line uses. Nothing a person typed reaches PowerShell unquoted.
 * - The administrator never writes inside the team account's profile. That account may run a teammate's agent, which
 *   could plant a junction where the administrator is about to write. The runtime is staged in a folder only
 *   Administrators can change, made with its ACL in one step, and the team account copies it in itself.
 * - The account's password is random, made inside this script, and known to nobody: handed to Task Scheduler alone (which
 *   keeps it as an LSA secret, as Windows keeps every task's credentials), for the team daemon's task and for the one-shot
 *   tasks that run setup's steps as the account, then cleared. Never printed, logged, written to a file or put on a
 *   command line.
 * - Nothing unsigned is started: powershell.exe, cmd.exe and icacls.exe (Microsoft's) and node.exe (the OpenJS
 *   Foundation's). Smart App Control blocks an unsigned exe at random (DESKTOP-0TFH0OJ, 2026-10-28), and nobody watches
 *   a team daemon to start it again.
 * - Every step checks what is there, so a second run repairs a first one that stopped part-way.
 */
import { TEAM_ENGINES } from './engines.js'
import { SENTINEL_NAME, checkName, checkPort } from './layout.js'
import type { RemoveScriptInput, SetupScriptInput, TeamPlistInput } from './script.js'
import {
  SID, WINDOWS_TEAM_CONFIG_FILE, WINDOWS_TEAM_HANDOFF_DIR, WINDOWS_TEAM_HANDOFF_FILE, WINDOWS_TEAM_SHARED_DIR, WINDOWS_TEAM_SHARED_MARK,
  WINDOWS_TEAM_STATUS_DIR, WINDOWS_TEAM_TASK_NAME, WINDOWS_TEAM_TASK_PATH, checkSid, checkWindowsPath, checkWindowsUser, windowsTeamPaths,
  windowsTeamRelayDir,
} from './windowsLayout.js'

/** The single quotes PowerShell knows: `'` and the typographic ones, which also end a single-quoted string. */
const SINGLE_QUOTES = new Set(["'", '\u2018', '\u2019', '\u201a', '\u201b'])

/** PowerShell single quotes: nothing is special inside them but a single quote, which is doubled. */
export function ps(word: string): string {
  let quoted = "'"
  for (const char of word) quoted += SINGLE_QUOTES.has(char) ? char + char : char
  return `${quoted}'`
}

const psList = (words: readonly string[]): string => `@(${words.map(ps).join(', ')})`

const xml = (text: string): string =>
  text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')

const ENV_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/
// What cmd.exe passes through a `set "NAME=value"` untouched: no `%` or `!` (expanded even inside quotes), no quote,
// none of `&|<>^()`, no control character.
const ENV_VALUE = /^[A-Za-z0-9._~:/@+=, -]{0,1024}$/

function checkWindowsEnv(env: Record<string, string>): Record<string, string> {
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME.test(name) || !ENV_VALUE.test(value)) {
      throw new Error(`the team daemon cannot carry ${JSON.stringify(name)}=${JSON.stringify(value)} through cmd.exe`)
    }
  }
  return env
}

/** The files the owner's process stages for the setup script, by name, in its private staging folder. */
export const WINDOWS_STAGED = { config: 'team.json', task: 'team.xml' } as const

export const WINDOWS_SENTINEL_TEXT = 'Harness Team privacy check. The Harness Team account on this computer must not be able to read this'
  + ' file: if it can, your files are not private. It is removed with the account (harness team remove).'

/** The exit status of a removal that deleted nothing because Windows kept the profile: the team task runs again. */
export const WINDOWS_REMOVE_REFUSED = 9

// Allow ACEs, as SDDL access masks: 0x1200a9 read and list, 0x1301bf modify, 0x1200ab read, list and add a file,
// 0x130189 read and delete. Delete carries write-attributes: Node's unlink opens the file for DELETE and
// FILE_WRITE_ATTRIBUTES (to clear read-only), and without the second the team account read the code but could not delete
// it (EPERM, DESKTOP-0TFH0OJ, 2026-10-28).
const SDDL = {
  private: '"O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"',
  shared: '"O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)"',
  stage: '"O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;$teamSid)"',
  status: '"O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;$teamSid)(A;OICI;0x1200a9;;;BU)"',
  // The owner adds the code and may replace it; the team account reads it and deletes it, and can neither remove nor
  // rename the folder (no DELETE on it, and its modify on the status folder holds no delete-child).
  handoff: '"O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x1200ab;;;$OWNER_SID)(A;OIIO;0x1301bf;;;$OWNER_SID)(A;;0x1200a9;;;$teamSid)(A;OIIO;0x130189;;;$teamSid)"',
  relay: '"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;$OWNER_SID)(A;OICI;0x1200a9;;;$teamSid)"',
} as const

/** Every elevated script starts with these lines. */
const PRELUDE = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)',
  // LF alone: the owner's side matches the last line with ./script.ts TEAM_COMPUTER_LINE, whose `$` stops before a CR.
  'function say([string]$m) { [Console]::Out.Write("harness: $m`n") }',
  'function die([string]$m, [int]$code = 1) { Clear-Stage; [Console]::Error.Write("harness: $m`n"); exit $code }',
  '$script:RT = $null',
  'function Clear-Stage { if ($script:RT) { try { Remove-Tree $script:RT } catch { }; $script:RT = $null } }',
  'trap { die $_.Exception.Message 1 }',
  "$ADMINS = 'S-1-5-32-544'",
  "$USERS = 'S-1-5-32-545'",
  "$SYSTEM_SID = 'S-1-5-18'",
  "$ICACLS = Join-Path $env:SystemRoot 'System32\\icacls.exe'",
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

/** The parent folder of a Windows path. */
const parent = (path: string): string => path.slice(0, path.lastIndexOf('\\'))
const leaf = (path: string): string => path.slice(path.lastIndexOf('\\') + 1)

/**
 * What the team account runs, as itself, to copy the staged runtime into its own home: the PowerShell twin of
 * ./script.ts `TEAM_COPY`, with the same targets. A runtime folder already there is kept: its name is its Node version,
 * and a teammate's agent may be running its node.exe, which Windows would not let anyone replace. It runs from the stage
 * folder, whose name is made at run time: the folder it is in is the stage.
 */
export function windowsTeamCopyScript(input: { home: string; nodeName: string; ptyName?: string | null }): string {
  const home = checkWindowsPath(input.home, 'team home')
  const nodeName = checkName(input.nodeName, 'Node runtime folder')
  const ptyName = input.ptyName ? checkName(input.ptyName, 'terminal host version') : ''
  return [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    'trap { [Console]::Error.Write("harness: $($_.Exception.Message)`n"); exit 1 }',
    '$Stage = $PSScriptRoot',
    `$TeamHome = ${ps(home)}`,
    `$NodeName = ${ps(nodeName)}`,
    "$rt = Join-Path $TeamHome '.harness\\runtime'",
    "$cli = Join-Path $TeamHome '.harness\\cli'",
    "$bin = Join-Path $TeamHome '.local\\bin'",
    "foreach ($dir in @($rt, (Join-Path $cli 'data'), (Join-Path $TeamHome '.harness\\auth'), $bin)) { [void][IO.Directory]::CreateDirectory($dir) }",
    '$target = Join-Path $rt $NodeName',
    'if (-not (Test-Path -LiteralPath $target)) {',
    '  $next = "$target.next"',
    '  if (Test-Path -LiteralPath $next) { Remove-Item -LiteralPath $next -Recurse -Force }',
    "  Copy-Item -LiteralPath (Join-Path $Stage 'node') -Destination $next -Recurse",
    '  Move-Item -LiteralPath $next -Destination $target',
    '}',
    "$node = Join-Path $target 'node.exe'",
    "[IO.File]::WriteAllText((Join-Path $rt 'current-node.next'), \"$node`r`n\")",
    "Move-Item -LiteralPath (Join-Path $rt 'current-node.next') -Destination (Join-Path $rt 'current-node') -Force",
    "foreach ($f in @('cli.js', 'notify.mjs', 'package.json')) {",
    "  $from = Join-Path $Stage \"cli\\$f\"",
    '  if (Test-Path -LiteralPath $from) {',
    '    Copy-Item -LiteralPath $from -Destination (Join-Path $cli ".$f.next") -Force',
    '    Move-Item -LiteralPath (Join-Path $cli ".$f.next") -Destination (Join-Path $cli $f) -Force',
    '  }',
    '}',
    // The terminal host every agent runs in (lib/ptyHost/launch.ts `ptyHostBinary`: `runtime\pty\<current-pty>`). Its
    // updater replaces only a host that is there (lib/windows/ptyPayload.ts `ptyUpdateWanted`) and the account has no
    // installer, so the owner's is laid down for it, as tmux is on a Mac; a version already there is kept, as the Node one.
    `$PtyName = ${ps(ptyName)}`,
    "if ($PtyName -and (Test-Path -LiteralPath (Join-Path $Stage 'pty'))) {",
    "  $ptyRoot = Join-Path $rt 'pty'",
    '  [void][IO.Directory]::CreateDirectory($ptyRoot)',
    '  $ptyTarget = Join-Path $ptyRoot $PtyName',
    '  if (-not (Test-Path -LiteralPath $ptyTarget)) {',
    '    if (Test-Path -LiteralPath "$ptyTarget.next") { Remove-Item -LiteralPath "$ptyTarget.next" -Recurse -Force }',
    "    Copy-Item -LiteralPath (Join-Path $Stage 'pty') -Destination \"$ptyTarget.next\" -Recurse",
    '    Move-Item -LiteralPath "$ptyTarget.next" -Destination $ptyTarget',
    '  }',
    // The pointer as install.ps1 writes it: one line, the folder's name, CRLF, no byte order mark.
    "  [IO.File]::WriteAllText((Join-Path $ptyRoot 'current-pty.next'), \"$PtyName`r`n\")",
    "  Move-Item -LiteralPath (Join-Path $ptyRoot 'current-pty.next') -Destination (Join-Path $ptyRoot 'current-pty') -Force",
    '}',
    // The launcher the installer writes, so `harness` works in the team account's own terminals.
    "[IO.File]::WriteAllText((Join-Path $bin 'harness.cmd.next'), \"@`\"$node`\" `\"$(Join-Path $cli 'cli.js')`\" %*`r`n\")",
    "Move-Item -LiteralPath (Join-Path $bin 'harness.cmd.next') -Destination (Join-Path $bin 'harness.cmd') -Force",
    'exit 0',
    '',
  ].join('\n')
}

/**
 * Claude Code and Codex for the team account, installed by that account itself with its own copy of Harness's Node and
 * npm under its own home (`.local`): the twin of ./script.ts `TEAM_ENGINES_INSTALL`. A package that fails is said and
 * left, never failing setup.
 */
export function windowsTeamEnginesScript(input: { home: string; nodeName: string; packages: readonly string[] }): string {
  const home = checkWindowsPath(input.home, 'team home')
  const nodeName = checkName(input.nodeName, 'Node runtime folder')
  for (const pkg of input.packages) if (!/^@?[a-z0-9][a-z0-9._/-]{0,213}$/.test(pkg)) throw new Error(`not an npm package name: ${JSON.stringify(pkg)}`)
  return [
    "$ProgressPreference = 'SilentlyContinue'",
    `$TeamHome = ${ps(home)}`,
    `$NodeName = ${ps(nodeName)}`,
    `$Packages = ${psList(input.packages)}`,
    "$nodeDir = Join-Path $TeamHome \".harness\\runtime\\$NodeName\"",
    "$npm = Join-Path $nodeDir 'npm.cmd'",
    "$prefix = Join-Path $TeamHome '.local'",
    "if (-not (Test-Path -LiteralPath $npm)) { [Console]::Out.Write(\"harness: the team account's Node has no npm; Claude Code and Codex were not installed`n\"); exit 0 }",
    '$env:PATH = "$nodeDir;$env:SystemRoot\\System32;$env:SystemRoot"',
    'Set-Location -LiteralPath $TeamHome',
    'foreach ($pkg in $Packages) {',
    '  & $npm install --global --prefix $prefix --no-fund --no-audit --loglevel=error $pkg *> $null',
    '  if ($LASTEXITCODE -eq 0) { [Console]::Out.Write("harness: installed $pkg for the team account`n") }',
    '  else { [Console]::Out.Write("harness: could not install $pkg for the team account; harness team setup tries again`n") }',
    '}',
    'exit 0',
    '',
  ].join('\n')
}

/** A single-quoted here-string holding [text], which must not hold the line that would end it. */
function hereString(text: string): string {
  if (text.includes("\n'@")) throw new Error('the embedded script cannot hold a line starting with \'@')
  return `@'\n${text}\n'@`
}

/** What the setup script takes beyond the macOS one's input: the owner's SID, read by the owner's own process before
 *  elevation, because UAC may run the script as another administrator; and the owner's terminal host payload in use
 *  (`runtime\pty\<version>`), copied for the team account, or null without one. */
export type WindowsSetupScriptInput = SetupScriptInput & { ownerSid: string; ptyDir?: string | null }

export function buildWindowsSetupScript(input: WindowsSetupScriptInput): string {
  const user = checkWindowsUser(input.user, 'team account')
  const owner = checkWindowsUser(input.owner, 'owner account')
  if (user.toLowerCase() === owner.toLowerCase()) throw new Error('the team account must be a different account from the owner')
  if (!/^[A-Za-z0-9 ]{1,40}$/.test(input.realName)) throw new Error(`not a usable full name: ${JSON.stringify(input.realName)}`)
  const ownerSid = checkSid(input.ownerSid, 'owner account')
  const home = checkWindowsPath(input.home, 'team home')
  const ownerHome = checkWindowsPath(input.ownerHome, 'owner home')
  const lower = (path: string) => path.toLowerCase()
  if (lower(home) === lower(ownerHome) || lower(home).startsWith(`${lower(ownerHome)}\\`) || lower(ownerHome).startsWith(`${lower(home)}\\`)) {
    throw new Error('the team home and the owner home must be apart')
  }
  const stage = checkWindowsPath(input.stageDir, 'staging folder')
  const nodeDir = checkWindowsPath(input.nodeRuntimeDir, 'Node runtime')
  const nodeName = checkName(leaf(nodeDir), 'Node runtime folder')
  const cliDir = checkWindowsPath(input.cliDir, 'installed CLI')
  const ptyDir = input.ptyDir ? checkWindowsPath(input.ptyDir, 'terminal host') : null
  const ptyName = ptyDir ? checkName(leaf(ptyDir), 'terminal host version') : null
  // Not used here: the owner's own process mints the sign-in code after this script (step 8), and the terminal host is
  // the pty payload copied below, not a tmux copy. mintEnv, ownerNode, ownerCli, signIn and tmuxRuntimeDir stay in the
  // input so every platform's builder takes the same one.
  const lines = [
    '# Harness Team account setup (cli/src/team/windowsScript.ts), run once elevated behind User Account Control.',
    '# Running it again repairs what is there; `harness team remove` undoes it.',
    ...PRELUDE,
    `$TEAM = ${ps(user)}`,
    `$TEAM_NAME = ${ps(input.realName)}`,
    `$TEAM_HOME = ${ps(home)}`,
    `$OWNER = ${ps(owner)}`,
    `$OWNER_SID = ${ps(ownerSid)}`,
    `$OWNER_HOME = ${ps(ownerHome)}`,
    `$STAGE = ${ps(stage)}`,
    `$NODE_SRC = ${ps(nodeDir)}`,
    `$NODE_NAME = ${ps(nodeName)}`,
    `$CLI_SRC = ${ps(cliDir)}`,
    `$PTY_SRC = ${ps(ptyDir ?? '')}`,
    `$SHARED = ${ps(WINDOWS_TEAM_SHARED_DIR)}`,
    `$SHARED_MARK = ${ps(WINDOWS_TEAM_SHARED_MARK)}`,
    `$CONFIG = ${ps(WINDOWS_TEAM_CONFIG_FILE)}`,
    `$STATUS_DIR = ${ps(WINDOWS_TEAM_STATUS_DIR)}`,
    `$HANDOFF_DIR = ${ps(WINDOWS_TEAM_HANDOFF_DIR)}`,
    `$RELAY_DIR = ${ps(windowsTeamRelayDir(owner))}`,
    `$TASK_PATH = ${ps(WINDOWS_TEAM_TASK_PATH)}`,
    `$TASK_NAME = ${ps(WINDOWS_TEAM_TASK_NAME)}`,
    `$SENTINEL = ${ps(`${ownerHome}\\${SENTINEL_NAME}`)}`,
    `$SENTINEL_TEXT = ${ps(WINDOWS_SENTINEL_TEXT)}`,
    `$PROFILES = ${ps(parent(home))}`,
    `$USER_LIST = ${ps('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\SpecialAccounts\\UserList')}`,
    "$POWERSHELL = Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe'",
    "$CMD = Join-Path $env:SystemRoot 'System32\\cmd.exe'",
    `$STAGED_CONFIG = Join-Path $STAGE '${WINDOWS_STAGED.config}'`,
    `$STAGED_TASK = Join-Path $STAGE '${WINDOWS_STAGED.task}'`,
    '',
    // 40 letters and digits from the system's cryptographic generator, at least one of each kind, so a complexity policy
    // takes it. Made into a char array and kept as a SecureString for New-LocalUser and the credential; Task Scheduler's
    // COM call takes the plain string, which is dropped right after.
    'function New-TeamPassword {',
    "  $alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'",
    '  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()',
    '  $byte = New-Object byte[] 1',
    '  try {',
    '    do {',
    '      $chars = New-Object char[] 40',
    '      for ($i = 0; $i -lt 40; ) { $rng.GetBytes($byte); if ($byte[0] -lt 248) { $chars[$i] = $alphabet[$byte[0] % 62]; $i++ } }',
    '      $text = New-Object string (, $chars)',
    '      [Array]::Clear($chars, 0, 40)',
    '    } until ($text -cmatch \'[A-Z]\' -and $text -cmatch \'[a-z]\' -and $text -match \'[0-9]\')',
    '    return $text',
    '  } finally { $rng.Dispose() }',
    '}',
    'function Secure-Text([string]$text) { $s = New-Object Security.SecureString; foreach ($c in $text.ToCharArray()) { $s.AppendChar($c) }; $s.MakeReadOnly(); return $s }',
    // Copies a file or folder, refusing any link inside: the owner's folders must not lead the administrator elsewhere.
    'function Copy-Plain([string]$from, [string]$to) {',
    '  $item = Get-Item -LiteralPath $from -Force',
    '  if ($item.Attributes -band $REPARSE) { die "$from is a link; nothing was copied through it" 6 }',
    '  if ($item.PSIsContainer) {',
    '    [void][IO.Directory]::CreateDirectory($to)',
    '    foreach ($child in @(Get-ChildItem -LiteralPath $from -Force)) { Copy-Plain $child.FullName (Join-Path $to $child.Name) }',
    '  } else { [IO.File]::Copy($from, $to, $true) }',
    '}',
    // A staged file's text: a plain file, small, never a link.
    'function Read-Staged([string]$path) {',
    '  $item = Item-At $path',
    '  if (-not $item -or $item.PSIsContainer -or ($item.Attributes -band $REPARSE) -or $item.Length -gt 65536) { die "$path is not a staged file" 6 }',
    '  return [IO.File]::ReadAllText($path)',
    '}',
    // Runs a cmd.exe line as the team account, in its own profile, which Windows makes at its first sign-in, and waits for
    // its exit status. A one-shot task with the in-memory password, not Start-Process -Credential: from a session without
    // the interactive desktop (an SSH session on DESKTOP-0TFH0OJ, 2026-10-28) a -Credential powershell.exe died as it
    // started (0xC0000142, STATUS_DLL_INIT_FAILED), because the secondary logon can open only the interactive desktop to
    // the new logon. Task Scheduler gives the run a desktop of its own from any session, as it does the team daemon.
    // The output is appended to a file this process made in the stage folder, writable by the team account alone, so
    // nothing is written in the team account's home as the administrator.
    'function As-Team([string]$what, [string]$line, [int]$minutes) {',
    "  if (-not $script:scheduler) { $script:scheduler = New-Object -ComObject Schedule.Service; $script:scheduler.Connect() }",
    '  $out = Join-Path $script:RT "$what.out"',
    "  [IO.File]::WriteAllText($out, '')",
    '  & $ICACLS $out /grant "*$($teamSid):(R,W)" /L /q | Out-Null',
    '  $arguments = [Security.SecurityElement]::Escape("/d /s /c `"$line >>`"$out`" 2>&1`"")',
    "  $runXml = '<?xml version=\"1.0\" encoding=\"UTF-16\"?><Task version=\"1.2\" xmlns=\"http://schemas.microsoft.com/windows/2004/02/mit/task\">' +",
    "    '<RegistrationInfo><Description>harness team setup, as the Harness Team account; removed when it ends</Description></RegistrationInfo>' +",
    "    '<Principals><Principal id=\"Team\"><LogonType>Password</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>' +",
    "    '<Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><ExecutionTimeLimit>PT1H</ExecutionTimeLimit><Priority>4</Priority></Settings>' +",
    "    \"<Actions Context=`\"Team`\"><Exec><Command>$CMD</Command><Arguments>$arguments</Arguments></Exec></Actions></Task>\"",
    '  $root = $script:scheduler.GetFolder(\'\\\')',
    '  $name = "Harness Team setup $what " + [guid]::NewGuid().ToString(\'N\')',
    '  $registered = $root.RegisterTask($name, $runXml, 6, $TEAM, $pw, 1)',
    '  try {',
    '    $since = (Get-Date).AddSeconds(-2)',
    '    [void]$registered.Run($null)',
    '    $deadline = (Get-Date).AddMinutes($minutes)',
    // 4 is running, 2 queued, and 0x41301 the result of a run still going.
    '    do { Start-Sleep -Milliseconds 500 } while (($registered.State -in @(2, 4) -or $registered.LastTaskResult -eq 0x41301 -or $registered.LastRunTime -lt $since) -and (Get-Date) -lt $deadline)',
    '    $late = (Get-Date) -ge $deadline',
    '    if ($late) { $registered.Stop(0) }',
    '    $status = $registered.LastTaskResult',
    '  } finally { $root.DeleteTask($name, 0) }',
    '  if ($late) { die "the team account\'s $what did not finish in $minutes minutes" }',
    '  $lines = @(Get-Content -LiteralPath $out -ErrorAction SilentlyContinue | Where-Object { $_ })',
    '  return @($status, $lines)',
    '}',
    '',
    `if (-not ([Environment]::ExpandEnvironmentVariables((Get-ItemProperty -LiteralPath 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList').ProfilesDirectory) -eq $PROFILES)) {`,
    '  die "Windows keeps profiles somewhere other than $PROFILES here" 3',
    '}',
    '$ownerItem = Item-At $OWNER_HOME',
    'if (-not $ownerItem -or -not $ownerItem.PSIsContainer -or ($ownerItem.Attributes -band $REPARSE)) { die "$OWNER_HOME is not a folder" }',
    // Windows makes a profile folder owned by SYSTEM or Administrators, not by its user (DESKTOP-0TFH0OJ, 2026-10-28:
    // C:\Users\DELL is SYSTEM's): what ties it to the owner is Windows' profile list, which only they can change.
    'if ((Owner-Of $OWNER_HOME) -notin @($OWNER_SID, $SYSTEM_SID, $ADMINS)) { die "$OWNER_HOME belongs to another account" }',
    '$ownerProfile = @(Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $OWNER_SID })',
    'if ($ownerProfile.Count -ne 1 -or $ownerProfile[0].LocalPath -ne $OWNER_HOME) { die "$OWNER_HOME is not the profile of $OWNER" }',
    "if (-not (Test-Path -LiteralPath (Join-Path $CLI_SRC 'cli.js'))) { die \"no installed Harness CLI at $CLI_SRC\" }",
    "if (-not (Test-Path -LiteralPath (Join-Path $NODE_SRC 'node.exe'))) { die \"no Harness Node runtime at $NODE_SRC\" }",
    '',
    '# 2. The account: a standard user named Harness Team, listed on the sign-in screen. Its password is random and nobody',
    '#    knows it, so nobody signs in to it. An account by this name that is not ours is left alone.',
    '$account = Get-LocalUser -Name $TEAM -ErrorAction SilentlyContinue',
    'if ($account) {',
    '  $existing = @(Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $account.SID.Value })',
    '  $ours = if ($existing.Count -gt 0) { $existing[0].LocalPath -eq $TEAM_HOME } else { $account.FullName -eq $TEAM_NAME }',
    '  if (-not $ours) { die "an account named $TEAM already exists and is not the Harness Team account; nothing was changed" 4 }',
    '} elseif (Test-Path -LiteralPath $TEAM_HOME) {',
    // What `harness team remove` leaves when Windows held the profile's registry (./windowsScript.ts remove, step 5).
    "  $pending = @((Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Session Manager' -Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations)",
    '  if ($pending -contains "\\??\\$TEAM_HOME") { die "$TEAM_HOME, left by a Harness Team account removed earlier, goes when Windows restarts: restart, then set up again; nothing was changed" 4 }',
    '  die "$TEAM_HOME already exists and is not the profile of an account named $TEAM, so Windows would give the account another folder; nothing was changed" 4',
    '}',
    '$pw = New-TeamPassword',
    '$secpw = Secure-Text $pw',
    'if (-not $account) {',
    '  say "creating the account $TEAM_NAME ($TEAM)"',
    '  try {',
    "    New-LocalUser -Name $TEAM -FullName $TEAM_NAME -Description 'Swarm work for teammates (harness team setup)' -Password $secpw -PasswordNeverExpires -AccountNeverExpires -UserMayNotChangePassword | Out-Null",
    '  } catch {',
    '    die "Windows would not make a local account here ($($_.Exception.Message)); nothing was changed" 5',
    '  }',
    '} else {',
    // A repair: the old password is known to nobody, and the task needs one.
    '  Set-LocalUser -Name $TEAM -Password $secpw -PasswordNeverExpires $true -FullName $TEAM_NAME',
    '  Enable-LocalUser -Name $TEAM',
    '}',
    'try { Add-LocalGroupMember -SID $USERS -Member $TEAM } catch {',
    "  if ($_.FullyQualifiedErrorId -notlike 'MemberExists*') {",
    '    if (-not $account) { Remove-LocalUser -Name $TEAM -ErrorAction SilentlyContinue }',
    '    die "Windows would not add $TEAM to Users ($($_.Exception.Message)); nothing was changed" 5',
    '  }',
    '}',
    "try { Remove-LocalGroupMember -SID $ADMINS -Member $TEAM; say \"took $TEAM out of Administrators\" } catch { if ($_.FullyQualifiedErrorId -notlike 'MemberNotFound*') { throw } }",
    // Visible on purpose (see ./layout.ts): an earlier hidden setup is made visible again.
    'Remove-ItemProperty -LiteralPath $USER_LIST -Name $TEAM -ErrorAction SilentlyContinue',
    '$teamSid = (Get-LocalUser -Name $TEAM).SID.Value',
    // This run's files (the runtime it copies, what the account says) are staged where only Administrators can change them.
    `$RT = New-Stage ${SDDL.stage}`,
    // The account runs only as Task Scheduler's tasks, whose password logon is a batch logon.
    'Set-BatchLogon $teamSid $true',
    '',
    '# 3. Its profile, made by Windows with its own private ACL: the account signs in once to run nothing.',
    '$teamProfile = @(Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $teamSid })',
    'if ($teamProfile.Count -eq 0) {',
    "  $signedIn = As-Team 'profile' 'exit 0' 5",
    '  if ($signedIn[0] -ne 0) { die "Windows did not sign the account $TEAM in to make its profile (result $($signedIn[0]))" 4 }',
    '  $teamProfile = @(Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $teamSid })',
    '}',
    'if ($teamProfile.Count -ne 1 -or $teamProfile[0].LocalPath -ne $TEAM_HOME) { die "Windows did not make the profile of $TEAM at $TEAM_HOME" 4 }',
    '',
    '# 4. The owner\'s profile, private: an explicit ACE that lets Everyone, Users or Authenticated Users in is taken off,',
    '#    and said. The sentinel keeps the ACL it inherits, not a world-readable one as on a Mac: every account has',
    '#    "Bypass traverse checking", so a file that grants Everyone read opens by its full path in a folder the reader',
    '#    cannot list. It proves that the ACL every file in the profile inherits refuses the team account.',
    "$broad = @('S-1-1-0', $USERS, 'S-1-5-11')",
    "$ownerAcl = $ownerItem.GetAccessControl('Access')",
    '$removed = 0',
    'foreach ($rule in @($ownerAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier]))) {',
    "  if ($rule.AccessControlType -eq 'Allow' -and $broad -contains $rule.IdentityReference.Value) {",
    '    [void]$ownerAcl.RemoveAccessRuleSpecific($rule)',
    '    $removed++',
    '    say "took $($rule.IdentityReference.Translate([Security.Principal.NTAccount]).Value)\'s access ($($rule.FileSystemRights)) off $OWNER_HOME"',
    '  }',
    '}',
    'if ($removed -gt 0) { $ownerItem.SetAccessControl($ownerAcl) }',
    // Written new (CreateNew never opens what is there, so never a link the owner left), then given to the owner and
    // checked on the handle that made it, never again by its path. The owner may write the profile: between a close and
    // a path-based icacls it could swap in a junction (no privilege needed), and icacls would follow it, to System32 say
    // (review, 2026-10-28). Not written as the owner: UAC may run this as another administrator, and nobody else has the
    // owner's password. Its ACL is the one it inherits from the profile, with no ACE of its own.
    '$old = Item-At $SENTINEL',
    'if ($old) { if ($old.PSIsContainer) { if ($old.Attributes -band $REPARSE) { [IO.Directory]::Delete($SENTINEL) } else { die "$SENTINEL is a folder" 6 } } else { [IO.File]::Delete($SENTINEL) } }',
    "$SENTINEL_RIGHTS = [Security.AccessControl.FileSystemRights]'Write, ReadPermissions, ChangePermissions, TakeOwnership, Synchronize'",
    '$sentinelFile = New-Object IO.FileStream($SENTINEL, [IO.FileMode]::CreateNew, $SENTINEL_RIGHTS, [IO.FileShare]::None, 4096, [IO.FileOptions]::None)',
    'try {',
    '  $bytes = [Text.Encoding]::UTF8.GetBytes("$SENTINEL_TEXT`r`n")',
    '  $sentinelFile.Write($bytes, 0, $bytes.Length)',
    '  $sentinelOwner = New-Object Security.AccessControl.FileSecurity',
    '  $sentinelOwner.SetOwner((New-Object Security.Principal.SecurityIdentifier($OWNER_SID)))',
    '  $sentinelFile.SetAccessControl($sentinelOwner)',
    '  $sentinelAcl = $sentinelFile.GetAccessControl()',
    '  if ($sentinelAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $OWNER_SID) { die "could not give $SENTINEL to $OWNER" 6 }',
    '  if (@($sentinelAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])).Count -ne 0) { die "$SENTINEL has ACEs of its own" 6 }',
    '} finally { $sentinelFile.Dispose() }',
    '',
    '# 5. The team daemon stops while its files are replaced.',
    'if (Get-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME -ErrorAction SilentlyContinue) {',
    '  Stop-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME',
    '  Disable-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME | Out-Null',
    '}',
    '',
    '# 6. The Harness runtime, staged where only Administrators can change it, then copied in by the team account itself.',
    "Copy-Plain $NODE_SRC (Join-Path $RT 'node')",
    "[void][IO.Directory]::CreateDirectory((Join-Path $RT 'cli'))",
    "foreach ($f in @('cli.js', 'notify.mjs', 'package.json')) { $from = Join-Path $CLI_SRC $f; if (Test-Path -LiteralPath $from) { Copy-Plain $from (Join-Path $RT \"cli\\$f\") } }",
    "if ($PTY_SRC -and (Test-Path -LiteralPath (Join-Path $PTY_SRC 'harness-pty.exe'))) { Copy-Plain $PTY_SRC (Join-Path $RT 'pty') }",
    `$copyScript = ${hereString(windowsTeamCopyScript({ home, nodeName, ptyName }))}`,
    "[IO.File]::WriteAllText((Join-Path $RT 'copy.ps1'), $copyScript)",
    '$asScript = { param($file) "`"$POWERSHELL`" -NoProfile -NonInteractive -ExecutionPolicy Bypass -File `"$file`"" }',
    "$copied = As-Team 'copy' (& $asScript (Join-Path $RT 'copy.ps1')) 15",
    'if ($copied[0] -ne 0) { die "the team account could not copy the Harness runtime into its home (exit $($copied[0])): $($copied[1] -join \' \')" }',
    '',
    '# 6b. Claude Code and Codex, installed by the team account itself into its own home: the owner\'s copies are inside the',
    '#     owner\'s private profile. None of the owner\'s sign-ins is copied.',
    `$enginesScript = ${hereString(windowsTeamEnginesScript({ home, nodeName, packages: TEAM_ENGINES.map((e) => e.packageName) }))}`,
    "[IO.File]::WriteAllText((Join-Path $RT 'engines.ps1'), $enginesScript)",
    "$installed = As-Team 'engines' (& $asScript (Join-Path $RT 'engines.ps1')) 30",
    'foreach ($line in $installed[1]) { [Console]::Out.Write("$line`n") }',
    '',
    '# 7. What setup made (Administrators\' and SYSTEM\'s, every account may read it), and the team account\'s status folder.',
    '#    A shared folder setup made says so, so that removal takes it away again once it is empty.',
    '$madeShared = -not (Item-At $SHARED)',
    `Set-Folder $SHARED ${SDDL.shared}`,
    "if ($madeShared) { [IO.File]::WriteAllText($SHARED_MARK, '') }",
    '$configText = Read-Staged $STAGED_CONFIG',
    'if ((ConvertFrom-Json $configText).user -ne $TEAM) { die "the staged team.json is not for $TEAM" 6 }',
    '[IO.File]::WriteAllText("$CONFIG.next", $configText)',
    'Move-Item -LiteralPath "$CONFIG.next" -Destination $CONFIG -Force',
    `Set-Folder $STATUS_DIR ${SDDL.status}`,
    // The owner's daemon leaves its subscription relay here for the team account (./relay.ts): the owner's folder, which a
    // standard owner could not make in C:\ProgramData\Harness.
    '$relay = Item-At $RELAY_DIR',
    'if ($relay -and (-not $relay.PSIsContainer -or ($relay.Attributes -band $REPARSE) -or ((Owner-Of $RELAY_DIR) -notin @($OWNER_SID, $ADMINS)))) { die "$RELAY_DIR is not the owner\'s folder" 6 }',
    'if (-not $relay) { $made = New-Object Security.AccessControl.DirectorySecurity; $made.SetSecurityDescriptorSddlForm("O:BA" + ' + SDDL.relay + '); [void][IO.Directory]::CreateDirectory($RELAY_DIR, $made) }',
    `$relayAcl = New-Object Security.AccessControl.DirectorySecurity; $relayAcl.SetSecurityDescriptorSddlForm(${SDDL.relay}, 'Access'); (Item-At $RELAY_DIR).SetAccessControl($relayAcl)`,
    // /L: on the folder itself, even if the owner (who may change it) has made it a junction since.
    '& $ICACLS $RELAY_DIR /setowner "*$OWNER_SID" /L /q | Out-Null',
    'if ($LASTEXITCODE -ne 0) { die "could not give $RELAY_DIR to $OWNER" 6 }',
    '',
    '# 8. The sign-in handover folder. The owner\'s own process writes the single-use code here after this script, so its',
    '#    90 seconds start after the prompt, and from the right person: UAC may run this script as another administrator,',
    '#    whose sign-in is not the owner\'s. This script never mints it.',
    `Set-Folder $HANDOFF_DIR ${SDDL.handoff}`,
    '',
    '# 9. The task that runs the team daemon as the team account from startup, registered and not started: it starts once',
    '#    the owner has handed the sign-in over. Through Task Scheduler\'s COM interface, so the password is a method\'s',
    '#    argument, which no PowerShell module log records, as it would a cmdlet\'s parameter.',
    '$taskXml = Read-Staged $STAGED_TASK',
    '$taskDoc = [xml]$taskXml',
    '$principal = $taskDoc.Task.Principals.Principal',
    "if ($principal.UserId -ne $TEAM -or $principal.LogonType -ne 'Password' -or $principal.RunLevel -ne 'LeastPrivilege') { die 'the staged task does not run as the team account alone' 6 }",
    '$scheduler = New-Object -ComObject Schedule.Service',
    '$scheduler.Connect()',
    "$folderName = $TASK_PATH.Trim('\\')",
    "try { $folder = $scheduler.GetFolder(\"\\$folderName\") } catch { $folder = $scheduler.GetFolder('\\').CreateFolder($folderName) }",
    'try {',
    '  [void]$folder.RegisterTask($TASK_NAME, $taskXml, 6, $TEAM, $pw, 1)',
    '} catch {',
    '  die "Task Scheduler would not take the team daemon\'s task ($($_.Exception.Message))" 8',
    '} finally {',
    '  $pw = $null',
    '  $secpw.Dispose()',
    '  Remove-Variable -Name pw, secpw -ErrorAction SilentlyContinue',
    '}',
    `say "the team daemon's task $TASK_PATH$TASK_NAME runs as $TEAM from startup; it starts once the sign-in is handed over"`,
    'Clear-Stage',
    'exit 0',
    '',
  ]
  return lines.join('\n')
}

/**
 * The scheduled task: Task Scheduler runs the team daemon as the team account from startup, whether or not anyone is
 * signed in. Two actions in order, as the macOS job wrapper runs them: `team __start` (redeem a handed-over sign-in, run
 * the privacy check), then the daemon. Both through cmd.exe, which appends their output to the team log as the team
 * account and sets the environment a task's XML cannot.
 *
 * Task Scheduler's RestartOnFailure restarts a task that could not start, never one whose action exited with an error
 * (DESKTOP-0TFH0OJ, 2026-10-28: an action exiting 1 under `RestartOnFailure PT1M x3` ran once in 140 seconds). So the
 * daemon's action loops itself: again ten seconds after a crash, and not after a clean exit, as launchd's KeepAlive
 * (`SuccessfulExit false`, `ThrottleInterval 10`) does on a Mac.
 */
export function teamTaskXml(input: TeamPlistInput & { ownerSid?: string }): string {
  // Every signed-in account may read the task (the owner's `harness team status`, standard or not), and its owner start
  // it, once the sign-in is handed over (./command.ts): unelevated, even an administrator holds Administrators as
  // deny-only, so the owner is named by SID.
  const runner = input.ownerSid ? `(A;;FRFX;;;${checkSid(input.ownerSid, 'owner account')})` : ''
  const user = checkWindowsUser(input.user, 'team account')
  const home = checkWindowsPath(input.home, 'team home')
  const node = checkWindowsPath(input.node, 'team Node')
  const cli = checkWindowsPath(input.cli, 'team CLI')
  const port = checkPort(input.port)
  const paths = windowsTeamPaths(home)
  const environment = {
    ADAPTER_DATA_DIR: paths.data, PORT: String(port),
    // The team account's Node and its engines (npm's --global --prefix) first, then whatever the system's PATH holds.
    PATH: `${parent(node)};${paths.npmPrefix};${paths.bin};%PATH%`,
    ...checkWindowsEnv(input.env),
  }
  const sets = Object.entries(environment).map(([name, value]) => `set "${name}=${value}"`).join(' & ')
  const run = (args: string) => `"${node}" "${cli}" ${args} >>"${paths.log}" 2>&1`
  const start = `/d /s /c "${sets} & ${run(`team __start "${WINDOWS_TEAM_HANDOFF_FILE}"`)}"`
  const daemon = `/d /s /c "${sets} & for /l %i in (0,0,1) do ((${run('__harnessd')} && exit 0) & ping -n 11 127.0.0.1 >nul)"`
  const exec = (args: string) => `    <Exec>
      <Command>%SystemRoot%\\System32\\cmd.exe</Command>
      <Arguments>${xml(args)}</Arguments>
      <WorkingDirectory>${xml(home)}</WorkingDirectory>
    </Exec>`
  return `<?xml version="1.0" encoding="UTF-16"?>
<!-- The Harness Team account's daemon: Swarm work on this computer runs as the separate user "${xml(user)}", which cannot
     read the owner's files. Registered by "harness team setup"; "harness team status" shows it, "harness team remove"
     removes it with the account. -->
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(`${input.label ?? 'Harness Team'}: the Harness Team account's daemon, as ${user}. Its log: ${paths.log}`)}</Description>
    <SecurityDescriptor>D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;AU)${runner}</SecurityDescriptor>
  </RegistrationInfo>
  <Triggers>
    <BootTrigger>
      <Enabled>true</Enabled>
    </BootTrigger>
  </Triggers>
  <Principals>
    <Principal id="Team">
      <UserId>${xml(user)}</UserId>
      <LogonType>Password</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <!-- Normal priority: Task Scheduler's default, 7, runs the daemon and every agent it starts below normal
         (harnessd/platform.ts). -->
    <Priority>4</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>999</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Team">
${exec(start)}
${exec(daemon)}
  </Actions>
</Task>
`
}

/**
 * Removal, in the order that lets a refusal change nothing. The task is disabled, not unregistered, until the account is
 * gone: registering it again would need a password, and nobody knows the account's. The profile goes before the account,
 * so a profile Windows keeps (a process still holds it) leaves the account and its task as they were, running again.
 */
export function buildWindowsRemoveScript(input: RemoveScriptInput): string {
  const user = checkWindowsUser(input.user, 'team account')
  const home = checkWindowsPath(input.home, 'team home')
  const ownerHome = checkWindowsPath(input.ownerHome, 'owner home')
  const paths = windowsTeamPaths(home)
  return [
    '# Harness Team account removal (cli/src/team/windowsScript.ts), run once elevated behind User Account Control.',
    '# It leaves the owner\'s profile private, as setup made it.',
    ...PRELUDE,
    `$TEAM = ${ps(user)}`,
    `$TEAM_HOME = ${ps(home)}`,
    `$SENTINEL = ${ps(`${ownerHome}\\${SENTINEL_NAME}`)}`,
    `$SHARED = ${ps(WINDOWS_TEAM_SHARED_DIR)}`,
    `$SHARED_MARK = ${ps(WINDOWS_TEAM_SHARED_MARK)}`,
    `$CONFIG = ${ps(WINDOWS_TEAM_CONFIG_FILE)}`,
    `$STATUS_DIR = ${ps(WINDOWS_TEAM_STATUS_DIR)}`,
    `$TASK_PATH = ${ps(WINDOWS_TEAM_TASK_PATH)}`,
    `$TASK_NAME = ${ps(WINDOWS_TEAM_TASK_NAME)}`,
    `$COMPUTER_ID = ${ps(paths.computerId)}`,
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
    // Read by the administrator only from a plain file the team account owns, never through a link, and only in the
    // form a computer id has.
    '$computer = $null',
    "$idDir = Item-At (Join-Path $TEAM_HOME '.harness')",
    '$idFile = Item-At $COMPUTER_ID',
    'if ($teamSid -and $idDir -and $idFile -and -not ($idDir.Attributes -band $REPARSE) -and -not ($idFile.Attributes -band $REPARSE) -and -not $idFile.PSIsContainer -and $idFile.Length -le 1024 -and (Owner-Of $COMPUTER_ID) -eq $teamSid) {',
    '  $line = @(Get-Content -LiteralPath $COMPUTER_ID -TotalCount 1)',
    "  if ($line.Count -eq 1 -and $line[0] -cmatch '^[A-Za-z0-9_-]{1,128}$') { $computer = $line[0] }",
    '}',
    '',
    '# 1. The team daemon\'s task stops and is disabled, so it starts nothing while the account goes.',
    '$task = Get-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME -ErrorAction SilentlyContinue',
    'if ($task) {',
    '  Disable-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME | Out-Null',
    '  Stop-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME',
    '}',
    '',
    '# 2. Every process running as the team account: its daemon, its terminal host, teammates\' agents.',
    'function Team-Processes {',
    '  if (-not $teamSid) { return @() }',
    '  @(Get-CimInstance Win32_Process | Where-Object { $o = Invoke-CimMethod -InputObject $_ -MethodName GetOwnerSid -ErrorAction SilentlyContinue; $o -and $o.Sid -eq $teamSid })',
    '}',
    'foreach ($process in @(Team-Processes)) { Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue }',
    'Start-Sleep -Seconds 1',
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
    '    if ($task) { Enable-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME | Out-Null; Start-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME }',
    `    die "could not remove the profile $TEAM_HOME ($why). Nothing was removed: the Harness Team account and its daemon run as before" ${WINDOWS_REMOVE_REFUSED}`,
    '  }',
    '  if (-not $why) { say "removed the profile $TEAM_HOME" }',
    '}',
    '',
    '# 4. The account.',
    'if ($account) {',
    '  try { Remove-LocalUser -Name $TEAM } catch {',
    '    if ($task) { Enable-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME | Out-Null; Start-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME }',
    `    die "could not delete the account $TEAM ($($_.Exception.Message)). Its profile was removed; harness team setup makes it again" ${WINDOWS_REMOVE_REFUSED}`,
    '  }',
    '  say "deleted the account $TEAM"',
    '}',
    '',
    '# 5. What it left: its task\'s definition, its batch logon right, a profile folder Windows did not take, what setup',
    '#    made and the sentinel.',
    'if ($task) { Unregister-ScheduledTask -TaskPath $TASK_PATH -TaskName $TASK_NAME -Confirm:$false }',
    `if ($teamSid) { [void](New-Stage ${SDDL.private}); Set-BatchLogon $teamSid $false }`,
    "try { $scheduler = New-Object -ComObject Schedule.Service; $scheduler.Connect(); $scheduler.GetFolder('\\').DeleteFolder($TASK_PATH.Trim('\\'), 0) } catch { }",
    // A folder Windows left behind when it removed the profile record, which named this folder as the team account's.
    'if ($teamProfile.Count -eq 1 -and -not $leftHive -and (Item-At $TEAM_HOME)) { Remove-Tree $TEAM_HOME }',
    // The profile Windows would not delete: its record, then every file it lets go of now, and the ones it holds (the
    // registry files) at the next restart, through the Session Manager's pending deletions as MoveFileEx records them.
    'if ($leftHive) {',
    '  Remove-Item -LiteralPath "$PROFILE_LIST\\$teamSid" -Recurse -Force -ErrorAction SilentlyContinue',
    '  $left = New-Object System.Collections.ArrayList',
    '  Remove-Tree $TEAM_HOME $left',
    '  if ($left.Count -gt 0) {',
    '    $existing = (Get-ItemProperty -LiteralPath $SESSION_MANAGER -Name PendingFileRenameOperations -ErrorAction SilentlyContinue).PendingFileRenameOperations',
    '    $pending = if ($existing) { @($existing) } else { @() }',
    '    foreach ($path in $left) { $pending += "\\??\\$path"; $pending += \'\' }',
    '    New-ItemProperty -LiteralPath $SESSION_MANAGER -Name PendingFileRenameOperations -PropertyType MultiString -Value ([string[]]$pending) -Force | Out-Null',
    '    say "Windows still holds the registry of ${TEAM}; the rest of $TEAM_HOME ($($left.Count) items) is removed at the next restart"',
    '  } else { say "removed the profile $TEAM_HOME" }',
    '}',
    'Remove-Tree $STATUS_DIR',
    'Remove-Tree $CONFIG',
    "if (Item-At $SHARED) { foreach ($relay in @(Get-ChildItem -LiteralPath $SHARED -Force -Filter 'team-relay-*')) { Remove-Tree $relay.FullName } }",
    '$sentinel = Item-At $SENTINEL',
    'if ($sentinel -and -not $sentinel.PSIsContainer) { [IO.File]::Delete($SENTINEL) }',
    // The shared folder, only when setup made it and nothing else has been put in it since.
    'if ((Test-Path -LiteralPath $SHARED_MARK) -and -not ((Item-At $SHARED).Attributes -band $REPARSE)) {',
    '  $others = @(Get-ChildItem -LiteralPath $SHARED -Force | Where-Object { $_.FullName -ne $SHARED_MARK })',
    '  if ($others.Count -eq 0) { [IO.File]::Delete($SHARED_MARK); [IO.Directory]::Delete($SHARED) }',
    '}',
    'if ($computer) { say "team computer $computer" }',
    'say "removed the Harness Team account, its profile and its daemon\'s task"',
    'Clear-Stage',
    'exit 0',
    '',
  ].join('\n')
}
