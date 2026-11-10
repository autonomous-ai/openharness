/**
 * The Windows removal script, tested as text: nothing in this file creates a user, changes an ACL or registers a task.
 * Where PowerShell 7 (`pwsh`) is installed the built script is also parsed, never run.
 */
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import { REMOVE_REFUSED, type RemoveScriptInput } from './removeScript.js'
import { buildWindowsRemoveScript } from './windowsRemoveScript.js'

const OWNER_HOME = 'C:\\Users\\owner-placeholder'
const removeInput = (over: Partial<RemoveScriptInput> = {}): RemoveScriptInput => ({
  user: 'harnessteam', home: 'C:\\Users\\harnessteam', owner: 'owner-placeholder', ownerHome: OWNER_HOME, ...over,
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

describe('the Windows remove script', () => {
  it('stops the task and the team account\'s processes, then the profile, then the account, then the task\'s definition', () => {
    const script = buildWindowsRemoveScript(removeInput())
    const order = ['Disable-ScheduledTask', 'GetOwnerSid', 'Remove-CimInstance', 'Remove-LocalUser', 'Unregister-ScheduledTask', 'Set-BatchLogon $teamSid $false',
      'Remove-Held $STATUS_DIR']
      .map((s) => at(script, s))
    expect(order).toEqual([...order].sort((a, b) => a - b))
  })

  it('starts the task again and exits 9 when the profile is held, having removed nothing', () => {
    const script = buildWindowsRemoveScript(removeInput())
    expect(REMOVE_REFUSED).toBe(9)
    const refusal = at(script, 'Nothing was removed" 9')
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

  it('removes the shared files only when marked and empty, the relay folders and the sentinel', () => {
    const script = buildWindowsRemoveScript(removeInput())
    expect(script).toContain("$SENTINEL = 'C:\\Users\\owner-placeholder\\.harness-team-privacy'")
    expect(script).toContain("Get-ChildItem -LiteralPath $SHARED -Force -Filter 'team-relay-*'")
    // Nothing the team account wrote is read as an administrator to name a machine to remove (audit L3).
    expect(script).not.toContain('computer-id')
    expect(script).not.toContain('$COMPUTER_ID')
    expect(at(script, 'Test-Path -LiteralPath $SHARED_MARK')).toBeGreaterThan(at(script, 'Remove-Held $STATUS_DIR'))
    // A line ending in LF alone: the owner's side splits this output at LF.
    expect(script).toContain('[Console]::Out.Write("harness: $m`n")')
  })

  it('holds no variable PowerShell would read as a drive', () => {
    expect(driveLike(buildWindowsRemoveScript(removeInput()))).toEqual([])
  })

  it.skipIf(!pwsh)('parses', () => parses(buildWindowsRemoveScript(removeInput())))
})

// Audit W5: removal runs as an administrator on folders the Team account could write.
describe('what the elevated removal deletes of the Team account\'s', () => {
  const script = () => buildWindowsRemoveScript(removeInput())

  it('compiles its helper before anything changes, and stops with nothing removed if it cannot', () => {
    const text = script()
    expect(text).toContain('Add-Type -TypeDefinition $HELPER')
    expect(text).toMatch(/try \{ Load-Helper \} catch \{ die "[^"]*nothing was removed/)
    expect(text.indexOf('try { Load-Helper }')).toBeLessThan(text.indexOf('# 1. The team daemon'))
  })

  it('never walks them by path', () => {
    const text = script()
    for (const path of ['$TEAM_HOME', '$STATUS_DIR', '$relay.FullName']) {
      expect(text).toContain(`Remove-Held ${path}`)
      expect(text).not.toContain(`Remove-Tree ${path}`)
    }
  })

  it('renames first, into a name nobody knows, and goes on where Windows will not let it', () => {
    const text = script()
    expect(text).toContain('[guid]::NewGuid()')
    expect(text).toMatch(/try \{ \[IO\.Directory\]::Move\(\$path, \$moved\); \$at = \$moved \} catch \{ \}/)
    expect(text.indexOf('[IO.Directory]::Move($path, $moved)')).toBeLessThan(text.indexOf('[HarnessTeamRemove]::Delete($at)'))
  })

  it('opens each child relative to its parent\'s handle, never following a link', () => {
    const text = script()
    expect(text).toContain('NtOpenFile')
    expect(text).toContain('RootDirectory')
    expect(text).toContain('FILE_OPEN_REPARSE_POINT')
    expect(text).toContain('FILE_FLAG_OPEN_REPARSE_POINT')
    expect(text).toContain('SetFileInformationByHandle')
  })

  it('keeps what cannot be deleted for the next restart, and says what could not go elsewhere', () => {
    const text = script()
    expect(text).toContain('Remove-Held $TEAM_HOME $left')
    expect(text).toMatch(/throw "could not delete/)
  })

  it('stops the tasks the Team account registered before its processes, and restores them if removal stops', () => {
    const text = script()
    expect(text).toContain('function Team-Tasks')
    expect(text).toMatch(/\$_\.Principal\.UserId/)
    expect(text.indexOf('Disable-ScheduledTask -InputObject')).toBeLessThan(text.indexOf('# 2. Every process running as the team account'))
    expect(text.match(/Restore-Tasks/g)!.length).toBeGreaterThanOrEqual(3)
  })

  it('deletes them once the account is gone, its own daemon\'s task apart', () => {
    const text = script()
    expect(text).toContain('Delete-Task $own')
    expect(text.indexOf('foreach ($own in @($script:seenTasks')).toBeGreaterThan(text.indexOf('# 4. The account.'))
  })

  it('takes what a removal that stopped partway left renamed, by its own prefix alone', () => {
    const text = script()
    expect(text).toContain("-Filter '.harness-removing-*'")
    expect(text).toContain('Remove-Renamed (Split-Path -Parent $TEAM_HOME)')
    expect(text).toContain('Remove-Renamed $SHARED')
  })

  it('matches a task by the Team account alone: this computer\'s, never a same-named domain account', () => {
    const text = script()
    expect(text).toContain("$parts = $user -split '\\\\'")
    expect(text).toContain('($teamSid -and $user -eq $teamSid) -or ($parts[-1] -eq $TEAM -and ($parts.Count -eq 1 -or $parts[0] -eq $env:COMPUTERNAME))')
  })

  // A Team process alive at the first look can register a task after it (security review of #2579).
  it('looks for its tasks again after the processes stop, and stops what is still running before step 5', () => {
    const text = script()
    const kill = text.indexOf('foreach ($process in @(Team-Processes)) { Stop-Process')
    const again = text.indexOf('Hold-Tasks', kill)
    expect(again).toBeGreaterThan(kill)
    expect(again).toBeLessThan(text.indexOf('# 3. The profile.'))
    const fifth = text.indexOf('# 5. What it left')
    const last = text.lastIndexOf('foreach ($process in @(Team-Processes)) { Stop-Process', fifth)
    expect(last).toBeGreaterThan(text.indexOf('# 4. The account.'))
  })

  it('unregisters the tasks it found while the account was there, as the name may not match once it has gone', () => {
    const text = script()
    expect(text).toContain('foreach ($own in @($script:seenTasks + @(Team-Tasks)))')
    expect(text).toContain('Task-There $_')
  })

  // These take wildcards: a Team task named [G]oogleUpdate could match the real GoogleUpdate (security review 2 of #2579).
  it('never passes a task name the Team account chose to a command that reads wildcards', () => {
    const text = script()
    expect(text).not.toContain('-TaskName $own.TaskName')
    expect(text).toContain('.DeleteTask($own.TaskName, 0)')
    expect(text).toContain('.GetTask($own.TaskName)')
  })

  it('cleans what the Team account named before printing it', () => {
    const text = script()
    expect(text).toContain('function Clean-Line')
    expect(text).toContain('Clean-Line $failed[0]')
    expect(text).toContain('Clean-Line $_.TaskName')
  })
})

describe('the Windows remove script\'s values', () => {
  it('refuses a value that is not plain before writing a line', () => {
    expect(() => buildWindowsRemoveScript(removeInput({ home: 'C:\\Users\\a%b' }))).toThrow()
    expect(() => buildWindowsRemoveScript(removeInput({ user: 'DOMAIN\\x' }))).toThrow()
    expect(() => buildWindowsRemoveScript(removeInput({ ownerHome: "C:\\Users\\o'b" }))).toThrow()
  })

  it('stops with exit 1, not 9, when the account is refused after its profile went: something was removed', () => {
    expect(buildWindowsRemoveScript(removeInput())).toContain('Its profile was removed" 1')
  })

  it('stops with exit 1, not 9, when its safe delete cannot be compiled: nothing kept the account', () => {
    expect(buildWindowsRemoveScript(removeInput())).toMatch(/try \{ Load-Helper \} catch \{ die "[^"]*nothing was removed" 1 \}/)
  })
})
