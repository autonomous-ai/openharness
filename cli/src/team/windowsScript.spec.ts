/**
 * The Windows setup and removal scripts are tested as text here: nothing in this file creates a user, changes an ACL or
 * registers a task. Where PowerShell 7 (`pwsh`) is installed the built scripts are also parsed, never run. They are run
 * for real, elevated, on a Windows test PC (the PR records it).
 */
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { RemoveScriptInput, SetupScriptInput, TeamPlistInput } from './script.js'
import {
  WINDOWS_REMOVE_REFUSED, WINDOWS_STAGED, buildWindowsRemoveScript, buildWindowsSetupScript, ps, teamTaskXml, windowsTeamCopyScript,
  windowsTeamEnginesScript,
} from './windowsScript.js'

const OWNER_HOME = 'C:\\Users\\owner-placeholder'
const OWNER_SID = 'S-1-5-21-1111111111-2222222222-3333333333-1001'
const NODE_DIR = `${OWNER_HOME}\\.harness\\runtime\\node-v22.23.2-win32-x64`
const input = (over: Partial<SetupScriptInput & { ownerSid: string }> = {}): SetupScriptInput & { ownerSid: string } => ({
  user: 'harnessteam', realName: 'Harness Team', home: 'C:\\Users\\harnessteam', owner: 'owner-placeholder', ownerHome: OWNER_HOME,
  ownerSid: OWNER_SID, stageDir: `${OWNER_HOME}\\AppData\\Local\\Temp\\harness-team-x1`, nodeRuntimeDir: NODE_DIR, tmuxRuntimeDir: null,
  cliDir: `${OWNER_HOME}\\.harness\\cli\\0.4.97`, ownerNode: `${NODE_DIR}\\node.exe`, ownerCli: `${OWNER_HOME}\\.harness\\cli\\0.4.97\\cli.js`,
  mintEnv: {}, signIn: 'missing', ...over,
})
const removeInput = (over: Partial<RemoveScriptInput> = {}): RemoveScriptInput => ({
  user: 'harnessteam', home: 'C:\\Users\\harnessteam', ownerHome: OWNER_HOME, ...over,
})
const task = (over: Partial<TeamPlistInput> = {}): TeamPlistInput => ({
  user: 'harnessteam', home: 'C:\\Users\\harnessteam',
  node: 'C:\\Users\\harnessteam\\.harness\\runtime\\node-v22.23.2-win32-x64\\node.exe',
  cli: 'C:\\Users\\harnessteam\\.harness\\cli\\cli.js', port: 18493, env: {}, ...over,
})

const at = (script: string, needle: string): number => {
  const index = script.indexOf(needle)
  expect(index, needle).toBeGreaterThanOrEqual(0)
  return index
}
/** A `$name:` PowerShell reads as a drive-qualified variable, which fails to parse (`$TEAM:` did, on the PC). */
const driveLike = (script: string): string[] =>
  [...script.matchAll(/\$([A-Za-z_]+):/g)].map((m) => m[1]!).filter((name) => !['env', 'script', 'global', 'using'].includes(name))

/** The script's lines that are code, without its comments. */
const code = (script: string): string[] => script.split('\n').filter((line) => !line.trimStart().startsWith('#'))

const pwsh = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status === 0
/** Parses a script with PowerShell's own parser, running none of it. */
function parses(script: string): void {
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
    '$e = $null; [void][System.Management.Automation.Language.Parser]::ParseInput([Console]::In.ReadToEnd(), [ref]$null, [ref]$e); $e | ForEach-Object { $_.Message }; exit $e.Count'],
  { input: script, encoding: 'utf8' })
  expect(result.stdout).toBe('')
  expect(result.status).toBe(0)
}

describe('ps', () => {
  it('single-quotes a word, every single quote PowerShell knows doubled', () => {
    expect(ps('plain')).toBe("'plain'")
    expect(ps("it's")).toBe("'it''s'")
    // PowerShell ends a single-quoted string at a typographic quote too.
    expect(ps('a\u2019b\u2018c\u201ad\u201be')).toBe("'a\u2019\u2019b\u2018\u2018c\u201a\u201ad\u201b\u201be'")
    expect(ps('$env:x `n "y"')).toBe("'$env:x `n \"y\"'")
  })
})

describe('the Windows setup script', () => {
  it('names every value once, single-quoted with \' doubled, and refuses one that is not plain', () => {
    const script = buildWindowsSetupScript(input({ owner: 'Jo Smith', ownerHome: 'D:\\Users\\Jo Smith', nodeRuntimeDir: 'D:\\Users\\Jo Smith\\.harness\\runtime\\node-v22.23.2-win32-x64',
      cliDir: 'D:\\Users\\Jo Smith\\.harness\\cli\\0.4.97', stageDir: 'D:\\Users\\Jo Smith\\AppData\\Local\\Temp\\harness-team-x1' }))
    expect(script).toContain("$OWNER = 'Jo Smith'")
    expect(script).toContain("$OWNER_HOME = 'D:\\Users\\Jo Smith'")
    expect(script).toContain(`$OWNER_SID = '${OWNER_SID}'`)
    // Each value is assigned once and used through its variable from then on.
    expect(script.split("'D:\\Users\\Jo Smith'")).toHaveLength(2)
    for (const line of code(script).filter((l) => /^\$[A-Z_]+ = '/.test(l))) expect(line, line).toMatch(/^\$[A-Z_]+ = '([^']|'')*'$/)
    for (const bad of [{ ownerHome: "C:\\Users\\o'brien" }, { owner: "o'brien" }, { ownerSid: 'S-1-5-21-1 ' }, { nodeRuntimeDir: 'C:\\x\\..\\y' },
      { stageDir: '\\\\server\\share\\x' }, { cliDir: 'C:\\x%PATH%' }, { user: 'owner-placeholder' }, { home: 'C:\\Users\\owner-placeholder\\x' }]) {
      expect(() => buildWindowsSetupScript(input(bad)), JSON.stringify(bad)).toThrow()
    }
  })

  it('makes a standard listed user, never an administrator', () => {
    const script = buildWindowsSetupScript(input())
    const lines = code(script).join('\n')
    expect(lines).toContain('New-LocalUser -Name $TEAM -FullName $TEAM_NAME')
    expect(lines).toContain('-PasswordNeverExpires -AccountNeverExpires')
    expect(lines).toContain('Add-LocalGroupMember -SID $USERS -Member $TEAM')
    expect(lines).toContain('Remove-LocalGroupMember -SID $ADMINS -Member $TEAM')
    expect(lines).toContain("$ADMINS = 'S-1-5-32-544'")
    // Listed on the sign-in screen: an earlier hidden setup is made visible again.
    expect(lines).toContain("$USER_LIST = 'HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Winlogon\\SpecialAccounts\\UserList'")
    expect(lines).toContain('Remove-ItemProperty -LiteralPath $USER_LIST -Name $TEAM')
    expect(lines).not.toMatch(/Add-LocalGroupMember[^\n]*(ADMINS|544|Administrators)/)
    expect(lines).not.toMatch(/SpecialAccounts[^\n]*New-ItemProperty|Set-ItemProperty[^\n]*SpecialAccounts/)
  })

  it('makes the password in the script, never on a command line or in the output, and clears it', () => {
    const script = buildWindowsSetupScript(input())
    const lines = code(script)
    expect(script).toContain('[Security.Cryptography.RandomNumberGenerator]::Create()')
    expect(script).not.toMatch(/-Password '|ConvertTo-SecureString|-AsPlainText/)
    // Only these lines touch the plain password: made, handed to Task Scheduler through COM (a method call, which no
    // PowerShell module log records as a cmdlet's parameter would be), then cleared.
    const plain = lines.filter((l) => /\$pw\b/.test(l))
    expect(plain.length).toBeGreaterThan(0)
    for (const line of plain) {
      expect(line, line).toMatch(/\$pw = New-TeamPassword|\$secpw = |RegisterTask\(\$TASK_NAME, \$taskXml, 6, \$TEAM, \$pw, 1|RegisterTask\(\$name, \$runXml, 6, \$TEAM, \$pw, 1\)|\$pw = \$null|Remove-Variable/)
    }
    expect(lines.some((l) => /say[^\n]*\$(sec)?pw\b|Write-[A-Za-z]+[^\n]*\$(sec)?pw\b|Out-File[^\n]*\$(sec)?pw/.test(l))).toBe(false)
    expect(at(script, 'RegisterTask($TASK_NAME, $taskXml, 6, $TEAM, $pw, 1)')).toBeLessThan(at(script, '$pw = $null'))
    expect(script).toContain('Remove-Variable -Name pw, secpw')
    // Everything run as the team account runs through Task Scheduler with that password, never through a process's
    // arguments or a credential's process (Start-Process -Credential).
    expect(script).not.toMatch(/Start-Process|-Credential/)
  })

  it('refuses an existing harnessteam whose profile is elsewhere, exit 4, before changing it', () => {
    const script = buildWindowsSetupScript(input())
    const refusal = at(script, 'is not the Harness Team account; nothing was changed" 4')
    expect(refusal).toBeLessThan(at(script, 'Set-LocalUser -Name $TEAM'))
    expect(refusal).toBeLessThan(at(script, 'New-LocalUser'))
    // A folder already at its profile's place would make Windows give the account another one.
    expect(at(script, 'already exists and is not the profile of')).toBeLessThan(at(script, 'New-LocalUser'))
  })

  it('takes the owner\'s profile from Windows\' profile list, and refuses one another account owns', () => {
    const script = buildWindowsSetupScript(input())
    expect(script).toContain('$ownerProfile = @(Get-CimInstance Win32_UserProfile | Where-Object { $_.SID -eq $OWNER_SID })')
    expect(script).toContain('if ((Owner-Of $OWNER_HOME) -notin @($OWNER_SID, $SYSTEM_SID, $ADMINS)) { die "$OWNER_HOME belongs to another account" }')
  })

  it('exits NO_LOCAL_ACCOUNTS (5) when Windows will not make a local account, before it changes anything', () => {
    const script = buildWindowsSetupScript(input())
    expect(script).toContain('nothing was changed" 5')
    expect(at(script, 'New-LocalUser')).toBeLessThan(at(script, '# 3.'))
  })

  it('lets the account log on as a batch job before anything runs as it, through secedit, changing that one SID', () => {
    const script = buildWindowsSetupScript(input())
    expect(at(script, 'Set-BatchLogon $teamSid $true')).toBeLessThan(at(script, "As-Team 'profile'"))
    expect(script).toContain("$SECEDIT = Join-Path $env:SystemRoot 'System32\\secedit.exe'")
    expect(script).toContain('& $SECEDIT /configure /db')
    expect(script).toContain('$next = @($now | Where-Object { $_ -ne $entry })')
  })

  it('runs its steps in order: preflight, account, profile, owner private, stop, runtime, shared files, handover, task', () => {
    const script = buildWindowsSetupScript(input())
    const steps = ['IsInRole', '# 2.', '# 3.', '# 4.', '# 5.', '# 6.', '# 7.', '# 8.', '# 9.'].map((s) => at(script, s))
    expect(steps).toEqual([...steps].sort((a, b) => a - b))
  })

  it('keeps the sentinel\'s inherited ACL and gives it to the owner, and takes broad access off the profile', () => {
    const script = buildWindowsSetupScript(input())
    // Made new, and given to the owner on the handle that made it: a path the owner can write is never acted on twice, or
    // the owner could swap a junction in between and send icacls through it (to System32, say).
    expect(script).toContain('$sentinelFile = New-Object IO.FileStream($SENTINEL, [IO.FileMode]::CreateNew, $SENTINEL_RIGHTS, [IO.FileShare]::None, 4096, [IO.FileOptions]::None)')
    expect(script).toContain('$sentinelFile.SetAccessControl($sentinelOwner)')
    expect(script).toContain('$sentinelAcl = $sentinelFile.GetAccessControl()')
    expect(script).toContain('if (@($sentinelAcl.GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])).Count -ne 0)')
    expect(at(script, '$sentinelFile.SetAccessControl($sentinelOwner)')).toBeLessThan(at(script, '$sentinelFile.Dispose()'))
    expect(script).not.toMatch(/ICACLS[^\n]*SENTINEL/)
    // Any icacls left acts on the path itself, never through a link (/L).
    for (const line of code(script).filter((l) => l.includes('& $ICACLS'))) expect(line, line).toContain(' /L')
    for (const sid of ['S-1-1-0', 'S-1-5-11', "$USERS"]) expect(script).toContain(sid)
    expect(script).toContain('GetAccessRules($true, $false, [Security.Principal.SecurityIdentifier])')
  })

  it('never writes inside the team profile as the administrator: the team account copies its own files', () => {
    const script = buildWindowsSetupScript(input())
    for (const line of code(script)) {
      if (/TEAM_HOME/.test(line) && /Copy|Set-Content|WriteAll|Move-Item|New-Item|CreateDirectory/.test(line)) throw new Error(`writes in the team home: ${line}`)
    }
    expect(script).toContain("$copied = As-Team 'copy' (& $asScript (Join-Path $RT 'copy.ps1')) 15")
    expect(script).toContain("$installed = As-Team 'engines' (& $asScript (Join-Path $RT 'engines.ps1')) 30")
    // What it says goes to a file in the stage folder, which this script made and the team account may only write.
    expect(script).toContain('& $ICACLS $out /grant "*$($teamSid):(R,W)" /L /q')
  })

  it('stages the runtime in a folder only Administrators can change, and never copies through a link', () => {
    const script = buildWindowsSetupScript(input())
    expect(script).toContain('[IO.Directory]::CreateDirectory($path, $made)')
    expect(script).toMatch(/\$script:RT = Join-Path \$env:SystemRoot \('Temp\\harness-team-'/)
    expect(script).toContain('is a link; nothing was copied through it')
  })

  it('makes the shared files Administrators\' with Users read, the status folder the team account\'s, and the handover folder the owner\'s to write', () => {
    const script = buildWindowsSetupScript(input())
    expect(script).toContain("$SHARED = 'C:\\ProgramData\\Harness'")
    expect(script).toContain('Set-Folder $SHARED "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;BU)"')
    expect(script).toContain('Set-Folder $STATUS_DIR "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x1301bf;;;$teamSid)(A;OICI;0x1200a9;;;BU)"')
    expect(script).toContain('Set-Folder $HANDOFF_DIR "O:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;;0x1200ab;;;$OWNER_SID)(A;OIIO;0x1301bf;;;$OWNER_SID)(A;;0x1200a9;;;$teamSid)(A;OIIO;0x130189;;;$teamSid)"')
    expect(script).toContain(`$STAGED_CONFIG = Join-Path $STAGE '${WINDOWS_STAGED.config}'`)
  })

  it('never mints the sign-in code: the owner\'s own process does, after the prompt', () => {
    const script = buildWindowsSetupScript(input())
    expect(script).not.toContain('__handoff')
    expect(script).not.toContain('OWNER_CLI')
  })

  it('registers the task as the team account and does not start it', () => {
    const script = buildWindowsSetupScript(input())
    expect(script).toContain("$TASK_PATH = '\\Harness\\'")
    expect(script).toContain("$TASK_NAME = 'Harness Team'")
    expect(script).not.toContain('Start-ScheduledTask')
    // The one run is a one-shot task of setup's own (As-Team), never the daemon's.
    expect(script.match(/\.Run\(/g)).toHaveLength(1)
    expect(script).toContain('[void]$registered.Run($null)')
    expect(at(script, 'Stop-ScheduledTask')).toBeLessThan(at(script, '# 6.'))
  })

  it.skipIf(!pwsh)('parses', () => parses(buildWindowsSetupScript(input())))
})

describe('the scripts the team account runs itself', () => {
  it('copies the staged runtime and CLI into its own home, through a next folder, keeping a runtime already there', () => {
    const script = windowsTeamCopyScript({ home: 'C:\\Users\\harnessteam', nodeName: 'node-v22.23.2-win32-x64' })
    expect(script).toContain('$Stage = $PSScriptRoot')
    expect(script).toContain("$TeamHome = 'C:\\Users\\harnessteam'")
    expect(script).toContain("$NodeName = 'node-v22.23.2-win32-x64'")
    expect(script).toContain("foreach ($f in @('cli.js', 'notify.mjs', 'package.json'))")
    expect(script).toContain('current-node')
    expect(script).toContain('harness.cmd')
    expect(script).toContain('if (-not (Test-Path -LiteralPath $target))')
  })

  it('installs Claude Code and Codex with its own npm under its own home, and never fails setup', () => {
    const script = windowsTeamEnginesScript({ home: 'C:\\Users\\harnessteam', nodeName: 'node-v22.23.2-win32-x64', packages: ['@anthropic-ai/claude-code', '@openai/codex'] })
    expect(script).toContain("$Packages = @('@anthropic-ai/claude-code', '@openai/codex')")
    expect(script).toContain('install --global --prefix $prefix --no-fund --no-audit --loglevel=error $pkg')
    expect(script).toContain('exit 0')
  })

  it.skipIf(!pwsh)('parse', () => {
    parses(windowsTeamCopyScript({ home: 'C:\\Users\\harnessteam', nodeName: 'node-v22.23.2-win32-x64' }))
    parses(windowsTeamEnginesScript({ home: 'C:\\Users\\harnessteam', nodeName: 'node-v22.23.2-win32-x64', packages: ['@openai/codex'] }))
  })
})

describe('the team daemon\'s task', () => {
  it('runs node.exe as harnessteam at startup, restarts on failure, and never names harness.exe', () => {
    const xml = teamTaskXml(task({ env: { BACKEND_WS_URL: 'wss://example.invalid/ws' } }))
    expect(xml).toContain('<BootTrigger>')
    expect(xml).toContain('<UserId>harnessteam</UserId>')
    expect(xml).toContain('<LogonType>Password</LogonType>')
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>')
    expect(xml).toContain('<RestartOnFailure>\n      <Interval>PT1M</Interval>\n      <Count>999</Count>')
    expect(xml).toContain('<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>')
    expect(xml).not.toMatch(/harness(-launch)?\.exe/i)
    const commands = [...xml.matchAll(/<Command>([^<]*)<\/Command>/g)].map((m) => m[1])
    expect(commands).toEqual(['%SystemRoot%\\System32\\cmd.exe', '%SystemRoot%\\System32\\cmd.exe'])
    const args = [...xml.matchAll(/<Arguments>([^<]*)<\/Arguments>/g)].map((m) => m[1]!.replaceAll('&quot;', '"').replaceAll('&amp;', '&').replaceAll('&gt;', '>'))
    expect(args[0]).toContain('"C:\\Users\\harnessteam\\.harness\\runtime\\node-v22.23.2-win32-x64\\node.exe" "C:\\Users\\harnessteam\\.harness\\cli\\cli.js" team __start "C:\\ProgramData\\Harness\\Team\\handoff\\team-handoff" >>"C:\\Users\\harnessteam\\.harness\\cli\\data\\harness.log" 2>&1')
    expect(args[1]).toContain('"C:\\Users\\harnessteam\\.harness\\cli\\cli.js" __harnessd >>"C:\\Users\\harnessteam\\.harness\\cli\\data\\harness.log" 2>&1')
    for (const line of args) {
      expect(line.startsWith('/d /s /c "')).toBe(true)
      expect(line).toContain('set "PORT=18493"')
      expect(line).toContain('set "ADAPTER_DATA_DIR=C:\\Users\\harnessteam\\.harness\\cli\\data"')
      expect(line).toContain('set "BACKEND_WS_URL=wss://example.invalid/ws"')
      expect(line).not.toContain('HARNESSD_PLATFORM')
    }
    // Again after a crash, ten seconds apart, and not after a clean exit, as launchd's KeepAlive (Task Scheduler's own
    // restart does not see an action's exit code).
    expect(args[1]).toContain('for /l %i in (0,0,1) do ((')
    expect(args[1]).toContain('&& exit 0) & ping -n 11 127.0.0.1 >nul)')
  })

  it('lets every signed-in account read the task, so a standard owner\'s status sees it', () => {
    expect(teamTaskXml(task())).toContain('<SecurityDescriptor>D:(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;AU)</SecurityDescriptor>')
  })

  it('refuses a port the owner\'s daemon uses, and a value cmd.exe would expand or split', () => {
    expect(() => teamTaskXml(task({ port: 18473 }))).toThrow()
    for (const value of ['a%PATH%b', 'a&b', 'a"b', 'a^b', 'a|b', 'a!b', 'x\ny']) {
      expect(() => teamTaskXml(task({ env: { WEB_URL: value } })), value).toThrow(/cannot carry/)
    }
    expect(() => teamTaskXml(task({ node: 'C:\\x\\a&b\\node.exe' }))).toThrow()
  })
})

describe('the Windows remove script', () => {
  it('stops the task and the team account\'s processes, then the profile, then the account, then the task\'s definition', () => {
    const script = buildWindowsRemoveScript(removeInput())
    const order = ['Disable-ScheduledTask', 'GetOwnerSid', 'Remove-CimInstance', 'Remove-LocalUser', 'Unregister-ScheduledTask', 'Set-BatchLogon $teamSid $false',
      'Remove-Tree $STATUS_DIR']
      .map((s) => at(script, s))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('starts the task again and exits 9 when the profile is held, having removed nothing', () => {
    const script = buildWindowsRemoveScript(removeInput())
    expect(WINDOWS_REMOVE_REFUSED).toBe(9)
    const refusal = at(script, 'Nothing was removed: the Harness Team account and its daemon run as before" 9')
    expect(at(script, 'Enable-ScheduledTask')).toBeLessThan(refusal)
    expect(at(script, 'Start-ScheduledTask')).toBeLessThan(refusal)
    expect(refusal).toBeLessThan(at(script, 'Remove-LocalUser'))
  })

  it('finishes when only Windows still holds the profile\'s registry, leaving those files for the next restart', () => {
    const script = buildWindowsRemoveScript(removeInput())
    expect(script).toContain('$leftHive = [bool]$why -and $held -and @(Team-Processes).Count -eq 0')
    expect(script).toContain('if ($why -and -not $leftHive) {')
    expect(script).toContain('Remove-Item -LiteralPath "$PROFILE_LIST\\$teamSid" -Recurse -Force')
    expect(script).toContain('foreach ($path in $left) { $pending += "\\??\\$path"; $pending += \'\' }')
    expect(script).toContain('-Name PendingFileRenameOperations -PropertyType MultiString')
    expect(at(script, 'if ($leftHive) {')).toBeGreaterThan(at(script, 'Remove-LocalUser'))
  })

  it('leaves an account or a profile that is not the Harness Team account\'s alone, exit 4', () => {
    const script = buildWindowsRemoveScript(removeInput())
    expect(script).toContain('is not the Harness Team account\'s; nothing was removed" 4')
    expect(script).toContain('belongs to another account; nothing was removed" 4')
  })

  it('removes the shared files only when marked and empty, the relay folders and the sentinel, and names the team computer', () => {
    const script = buildWindowsRemoveScript(removeInput())
    expect(script).toContain("$SENTINEL = 'C:\\Users\\owner-placeholder\\.harness-team-privacy'")
    expect(script).toContain("Get-ChildItem -LiteralPath $SHARED -Force -Filter 'team-relay-*'")
    expect(script).toContain('say "team computer $computer"')
    expect(at(script, 'Test-Path -LiteralPath $SHARED_MARK')).toBeGreaterThan(at(script, 'Remove-Tree $STATUS_DIR'))
    // A line ending in LF alone: the owner's side reads it with ./script.ts TEAM_COMPUTER_LINE, whose $ stops before a CR.
    expect(script).toContain('[Console]::Out.Write("harness: $m`n")')
  })

  it('holds no variable PowerShell would read as a drive, in either script', () => {
    expect(driveLike(buildWindowsRemoveScript(removeInput()))).toEqual([])
    expect(driveLike(buildWindowsSetupScript(input()))).toEqual([])
  })

  it.skipIf(!pwsh)('parses', () => parses(buildWindowsRemoveScript(removeInput())))
})
