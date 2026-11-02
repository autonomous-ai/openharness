import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readTeamStatus, readTeamStatusOffThread } from './privacy.js'
import { buildWindowsRemoveScript, buildWindowsSetupScript, windowsRemoveHelperLines } from './windowsScript.js'

/**
 * Audit W4, W5 and W7 on real Windows, in Windows PowerShell 5.1 as the elevated scripts run: the C# helper compiled by Add-Type,
 * real junctions and a real task. The Windows workflow runs it (.github/workflows/windows.yml). It removes only its own throwaway
 * folder and its own task; nothing here creates an account or changes an ACL.
 */
const OWNER_HOME = 'C:\\Users\\someone', NODE_DIR = `${OWNER_HOME}\\.harness\\runtime\\node-v22.23.2-win32-x64`

describe.runIf(process.platform === 'win32')('the Team account\'s removal on Windows', { timeout: 120_000 }, () => {
  let root: string, script: string
  const powershell = (body: string) => {
    writeFileSync(script, ['$ErrorActionPreference = \'Stop\'', "function Item-At([string]$path) { Get-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue }",
      '$TEAM = $env:USERNAME', '$teamSid = $null', "$TASK_PATH = '\\Harness\\'", "$TASK_NAME = 'not-this-one'", ...windowsRemoveHelperLines(), 'Load-Helper', body].join('\r\n'))
    const run = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { encoding: 'utf8' })
    if (run.status !== 0) throw new Error(`exit ${run.status}: ${run.stdout}\n${run.stderr}`)
    return run.stdout
  }
  const junction = (link: string, target: string) => execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', link, target], { stdio: 'ignore' })

  beforeAll(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'team-remove-'))); script = join(root, 'run.ps1') })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('both scripts parse in Windows PowerShell 5.1', () => {
    const setup = join(root, 'setup.ps1'), remove = join(root, 'remove.ps1')
    writeFileSync(setup, buildWindowsSetupScript({ user: 'harnessteam', realName: 'Harness Team', home: 'C:\\Users\\harnessteam', owner: 'someone', ownerHome: OWNER_HOME,
      ownerSid: 'S-1-5-21-1111111111-2222222222-3333333333-1001', stageDir: `${OWNER_HOME}\\AppData\\Local\\Temp\\harness-team-x1`, nodeRuntimeDir: NODE_DIR, tmuxRuntimeDir: null,
      cliDir: `${OWNER_HOME}\\.harness\\cli\\0.4.97`, ownerNode: `${NODE_DIR}\\node.exe`, ownerCli: `${OWNER_HOME}\\.harness\\cli\\0.4.97\\cli.js`, mintEnv: {}, signIn: 'missing' }))
    writeFileSync(remove, buildWindowsRemoveScript({ user: 'harnessteam', home: 'C:\\Users\\harnessteam', ownerHome: OWNER_HOME }))
    for (const file of [setup, remove]) {
      const errors = powershell(`$errors = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$errors); $errors.Count`)
      expect(errors.trim(), file).toBe('0')
    }
  })

  it('deletes a tree with a read-only file, and leaves what a junction in it points at', () => {
    const outside = join(root, 'outside'), tree = join(root, 'tree'), deep = join(tree, 'a', 'b')
    mkdirSync(outside); writeFileSync(join(outside, 'kept'), 'kept')
    mkdirSync(deep, { recursive: true }); writeFileSync(join(deep, 'file'), 'x')
    writeFileSync(join(deep, 'locked'), 'x'); chmodSync(join(deep, 'locked'), 0o444)
    junction(join(deep, 'link'), outside)
    expect(powershell(`@([HarnessTeamRemove]::Delete('${tree}')).Count`).trim()).toBe('0')
    expect(existsSync(tree)).toBe(false)
    expect(readFileSync(join(outside, 'kept'), 'utf8')).toBe('kept')
  })

  it('removes a junction in the folder\'s own place as itself', () => {
    const outside = join(root, 'outside-2'), link = join(root, 'top-link')
    mkdirSync(outside); writeFileSync(join(outside, 'kept'), 'kept')
    junction(link, outside)
    powershell(`Remove-Held '${link}'`)
    expect(existsSync(link)).toBe(false)
    expect(existsSync(join(outside, 'kept'))).toBe(true)
  })

  it('renames first, and leaves no renamed folder behind', () => {
    const parent = join(root, 'parent'), tree = join(parent, 'status')
    mkdirSync(tree, { recursive: true }); writeFileSync(join(tree, 'status.json'), '{}')
    powershell(`Remove-Held '${tree}'`)
    expect(execFileSync('cmd.exe', ['/d', '/c', 'dir', '/a', '/b', parent], { encoding: 'utf8' }).trim()).toBe('')
  })

  it('takes a renamed folder a stopped removal left, and nothing else there', () => {
    const parent = join(root, 'parent-2'), old = join(parent, '.harness-removing-abc'), other = join(parent, 'keep-me')
    mkdirSync(old, { recursive: true }); mkdirSync(other); writeFileSync(join(old, 'status.json'), '{}')
    powershell(`Remove-Renamed '${parent}'`)
    expect(existsSync(old)).toBe(false)
    expect(existsSync(other)).toBe(true)
  })

  it('reports what it cannot delete: a file held open without sharing', () => {
    const tree = join(root, 'held')
    mkdirSync(tree); writeFileSync(join(tree, 'open'), 'x')
    const said = powershell(`$open = [IO.File]::Open('${join(tree, 'open')}', 'Open', 'Read', 'None'); $failed = @([HarnessTeamRemove]::Delete('${tree}')); $open.Close(); $failed -join '|'`)
    expect(said).toContain('open')
  })

  it('stops at a depth it can handle rather than crash the removal', () => {
    let deep = join(root, 'deep')
    const top = deep
    // Longer than a plain path can name: made from inside, as a process can.
    const made = powershell(`$at = '\\\\?\\${top}'; [void][IO.Directory]::CreateDirectory($at); for ($i = 0; $i -lt 60; $i++) { $at = "$at\\${'d'.repeat(100)}"; [void][IO.Directory]::CreateDirectory($at) }; @([HarnessTeamRemove]::Delete('${top}')).Count`)
    expect(made.trim()).toBe('0')
    deep = top
    expect(existsSync(deep)).toBe(false)
  })

  it('finds a task the account registered, and not its own daemon\'s', () => {
    const name = `HarnessW5Test-${process.pid}`
    const said = powershell(`
      $action = New-ScheduledTaskAction -Execute 'cmd.exe' -Argument '/c exit 0'
      $task = Register-ScheduledTask -TaskName '${name}' -Action $action -Force
      try {
        $found = @(Team-Tasks | Where-Object { $_.TaskName -eq '${name}' }).Count
        $TEAM = 'somebody-else'
        $other = @(Team-Tasks | Where-Object { $_.TaskName -eq '${name}' }).Count
        "$found $other"
      } finally { Unregister-ScheduledTask -TaskName '${name}' -Confirm:$false }`)
    expect(said.trim()).toBe('1 0')
  })

  it('removes escape codes, bells and format characters from a line (W7)', () => {
    const said = powershell(`Clean-Line ([string][char]27 + '[31mred' + [char]7 + [char]0x202e + ' text')`)
    expect(said.trim()).toBe('[31mred text')
  })

  it('reads the status file in a child (W4)', async () => {
    const file = join(root, 'status.json')
    writeFileSync(file, JSON.stringify({ version: 1, privacy: { passed: true, checkedAt: 3 } }))
    expect(readTeamStatus(file)).toEqual({ version: 1, privacy: { passed: true, checkedAt: 3 } })
    expect(await readTeamStatusOffThread(file)).toEqual({ version: 1, privacy: { passed: true, checkedAt: 3 } })
  })
})
