import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { GuestRunResult } from '../lib/guestAccounts.js'
import type { AdminResult } from '../lib/windows/elevated.js'
import type { TeamConfig } from './config.js'
import { TEAM_REMOVAL_PROMPT, removeTeamAccount, teamRemovalDeps, type TeamRemovalDeps } from './remove.js'

const MAC_CONFIG = {
  version: 1, user: 'harnessteam', realName: 'Harness Team', home: '/Users/harnessteam', owner: 'ken', ownerHome: '/Users/ken',
  sentinel: '/Users/ken/.harness-team-privacy', port: 18493, label: 'ai.autonomous.harness.team',
  plist: '/Library/LaunchDaemons/ai.autonomous.harness.team.plist', statusFile: '/Library/Application Support/Harness/Team/status.json',
  node: '/Users/harnessteam/.harness/runtime/current-node', cli: '/Users/harnessteam/.harness/cli/cli.js', env: {}, createdAt: '2026-10-30T00:00:00Z',
} satisfies TeamConfig
const LINUX_CONFIG: TeamConfig = { ...MAC_CONFIG, home: '/home/harnessteam', ownerHome: '/home/ken', sentinel: '/home/ken/.harness-team-privacy' }
const WINDOWS_CONFIG: TeamConfig = { ...MAC_CONFIG, home: 'C:\\Users\\harnessteam', ownerHome: 'C:\\Users\\ken', ownerSid: 'S-1-5-21-1-2-3-1001' }

const stages: string[] = []
afterEach(() => { for (const dir of stages.splice(0)) rmSync(dir, { recursive: true, force: true }) })

/** A computer with [config], whose commands answer [answer], recording each call and the script it was handed. */
function computer(platform: NodeJS.Platform, config: TeamConfig | null, answer: (command: string) => GuestRunResult, over: Partial<TeamRemovalDeps> = {}) {
  const calls: { command: string; args: readonly string[]; script?: string }[] = []
  const removed: string[] = []
  const deps: TeamRemovalDeps = {
    platform,
    readConfig: () => config,
    runner: async (command, args) => {
      const path = args.find((a) => a.endsWith('remove.sh')) ?? /quoted form of "([^"]+)"/.exec(args.join(' '))?.[1]
      calls.push({ command, args, ...path && existsSync(path) ? { script: readFileSync(path, 'utf8') } : {} })
      if (path) expect(statSync(path).mode & 0o777).toBe(0o700)
      return answer(command)
    },
    windowsAdmin: async () => { throw new Error('not Windows') },
    graphical: () => true,
    makeStage: () => { const dir = mkdtempSync(join(tmpdir(), 'team-stage-')); stages.push(dir); return dir },
    removeStage: (dir) => { removed.push(dir); rmSync(dir, { recursive: true, force: true }) },
    ...over,
  }
  return { deps, calls, removed }
}
const ok = (stdout = ''): GuestRunResult => ({ code: 0, stdout, stderr: '' })
const fail = (code: number | null, stderr: string): GuestRunResult => ({ code, stdout: '', stderr })

describe('removing an old Team account', () => {
  it('does nothing where there is none', async () => {
    const c = computer('darwin', null, () => ok())
    expect(await removeTeamAccount(c.deps)).toEqual({ ok: true, removed: false })
    expect(c.calls).toEqual([])
  })

  it('does nothing on a system that never had one', async () => {
    const c = computer('freebsd', MAC_CONFIG, () => ok())
    expect(await removeTeamAccount(c.deps)).toEqual({ ok: true, removed: false })
    expect(c.calls).toEqual([])
  })

  describe('on a Mac', () => {
    it('runs the removal once as root behind the administrator prompt, from a private folder it then deletes', async () => {
      const c = computer('darwin', MAC_CONFIG, () => ok('harness: removed the Harness Team account, its home folder and its daemon\n'))
      expect(await removeTeamAccount(c.deps)).toEqual({ ok: true, removed: true })
      expect(c.calls.map((call) => call.command)).toEqual(['osascript'])
      const [line] = c.calls[0]!.args.slice(1)
      expect(line).toContain('with administrator privileges')
      expect(line).toContain(TEAM_REMOVAL_PROMPT)
      expect(c.calls[0]!.script).toContain("TEAM='harnessteam'")
      expect(c.calls[0]!.script).toContain("SENTINEL='/Users/ken/.harness-team-privacy'")
      expect(c.removed).toHaveLength(1)
      expect(existsSync(c.removed[0]!)).toBe(false)
    })

    it('says the person cancelled when they did', async () => {
      const c = computer('darwin', MAC_CONFIG, () => fail(1, 'execution error: User canceled. (-128)'))
      expect(await removeTeamAccount(c.deps)).toEqual({ ok: false, code: 'CANCELLED', message: 'Nothing was removed: the administrator prompt was cancelled.' })
      expect(c.removed).toHaveLength(1)
    })

    it('when macOS keeps the account, says where to delete it by the name Users & Groups shows', async () => {
      const c = computer('darwin', MAC_CONFIG, () => fail(1, 'harness: could not delete the account harnessteam: macOS did not allow it (eDSPermissionError). Nothing was removed (9)'))
      expect(await removeTeamAccount(c.deps)).toEqual({ ok: false, code: 'KEPT',
        message: 'macOS kept the account. Delete "Harness Team" in System Settings > Users & Groups, then try again.' })
    })

    it('gives any other stop in the script\'s own words, from its last line', async () => {
      const c = computer('darwin', MAC_CONFIG, () => fail(1, 'first line\rharness: /Users/harnessteam belongs to someone; nothing was removed (4)'))
      expect(await removeTeamAccount(c.deps)).toEqual({ ok: false, code: 'FAILED', message: '/Users/harnessteam belongs to someone; nothing was removed' })
      const silent = computer('darwin', MAC_CONFIG, () => fail(null, ''))
      expect(await removeTeamAccount(silent.deps)).toEqual({ ok: false, code: 'FAILED', message: 'The removal stopped (exit null).' })
    })

    it('runs nothing for a config whose values no check passes', async () => {
      const c = computer('darwin', { ...MAC_CONFIG, home: '/Users/../etc' }, () => ok())
      expect(await removeTeamAccount(c.deps)).toEqual({ ok: false, code: 'FAILED', message: 'the team home must be a plain absolute path: "/Users/../etc"' })
      expect(c.calls).toEqual([])
    })
  })

  describe('on Linux', () => {
    it('asks through polkit, and runs the Linux removal', async () => {
      const c = computer('linux', LINUX_CONFIG, () => ok())
      expect(await removeTeamAccount(c.deps)).toEqual({ ok: true, removed: true })
      expect(c.calls[0]!.command).toBe('pkexec')
      expect(c.calls[0]!.args[0]).toBe('/bin/sh')
      expect(c.calls[0]!.script).toContain("RELAY_DIR='/var/lib/harness/team-relay-ken'")
    })

    it('stages and runs nothing where polkit has no desktop to ask on', async () => {
      const c = computer('linux', LINUX_CONFIG, () => ok(), { graphical: () => false })
      expect(await removeTeamAccount(c.deps)).toMatchObject({ ok: false, code: 'NO_PROMPT' })
      expect(c.calls).toEqual([])
      expect(c.removed).toEqual([])
    })

    it('reads a dismissed dialog as cancelled, but no agent to ask with as a failure', async () => {
      expect(await removeTeamAccount(computer('linux', LINUX_CONFIG, () => fail(126, '')).deps)).toMatchObject({ code: 'CANCELLED' })
      expect(await removeTeamAccount(computer('linux', LINUX_CONFIG,
        () => fail(127, 'Error executing command as another user: Request dismissed')).deps)).toMatchObject({ code: 'CANCELLED' })
      expect(await removeTeamAccount(computer('linux', LINUX_CONFIG,
        () => fail(127, 'Error creating textual authentication agent')).deps)).toEqual({ ok: false, code: 'FAILED', message: 'Error creating textual authentication agent' })
    })

    it('when userdel keeps the user, asks for a restart', async () => {
      const c = computer('linux', LINUX_CONFIG, () => fail(9, 'harness: could not delete the account harnessteam: busy. Nothing was removed'))
      expect(await removeTeamAccount(c.deps)).toEqual({ ok: false, code: 'KEPT',
        message: 'Something still runs as the account, so nothing was removed. Restart this computer, then try again.' })
    })
  })

  describe('on Windows', () => {
    const SID_LINE = '"desktop\\ken","S-1-5-21-1-2-3-1001"\r\n'
    function windows(admin: AdminResult, whoami: GuestRunResult = ok(SID_LINE)) {
      const handed: { script: string; sid: string }[] = []
      const c = computer('win32', WINDOWS_CONFIG, () => whoami, {
        windowsAdmin: async () => async (script, sid) => { handed.push({ script, sid }); return admin },
      })
      return { ...c, handed }
    }

    it('runs the Windows removal behind User Account Control, its staging folder the owner\'s by SID', async () => {
      const w = windows({ ok: true, stdout: 'harness: removed the Harness Team account, its profile and its daemon\'s task\n' })
      expect(await removeTeamAccount(w.deps)).toEqual({ ok: true, removed: true })
      expect(w.calls.map((call) => call.command)).toEqual(['whoami'])
      expect(w.handed).toHaveLength(1)
      expect(w.handed[0]!.sid).toBe('S-1-5-21-1-2-3-1001')
      expect(w.handed[0]!.script).toContain("$TEAM_HOME = 'C:\\Users\\harnessteam'")
      expect(w.handed[0]!.script).toContain('Remove-LocalUser -Name $TEAM')
    })

    it('says what Windows removes only at the next restart', async () => {
      const w = windows({ ok: true, stdout: 'harness: Windows still holds the registry of harnessteam; the rest of C:\\Users\\harnessteam (3 items) is removed at the next restart\n' })
      expect(await removeTeamAccount(w.deps)).toEqual({ ok: true, removed: true,
        later: 'Windows still holds the registry of harnessteam; the rest of C:\\Users\\harnessteam (3 items) is removed at the next restart' })
    })

    it('reads a No at User Account Control as cancelled, and a kept profile as kept', async () => {
      expect(await removeTeamAccount(windows({ ok: false, code: 'CANCELLED', message: 'x' }).deps)).toMatchObject({ code: 'CANCELLED' })
      expect(await removeTeamAccount(windows({ ok: false, code: 'FAILED', message: 'could not remove the profile', status: 9 }).deps)).toMatchObject({ code: 'KEPT' })
      expect(await removeTeamAccount(windows({ ok: false, code: 'FAILED', message: 'icacls said no' }).deps)).toEqual({ ok: false, code: 'FAILED', message: 'icacls said no' })
    })

    it('elevates nothing when this account\'s SID cannot be read', async () => {
      const w = windows({ ok: true, stdout: '' }, fail(1, 'whoami failed'))
      expect(await removeTeamAccount(w.deps)).toEqual({ ok: false, code: 'FAILED', message: 'Could not read this account\'s SID (whoami /user).' })
      expect(w.handed).toEqual([])
    })
  })

  it('is wired to this computer\'s own config, commands and temporary folder', () => {
    const deps = teamRemovalDeps()
    expect(deps.platform).toBe(process.platform)
    const stage = deps.makeStage()
    expect(existsSync(stage)).toBe(true)
    deps.removeStage(stage)
    expect(existsSync(stage)).toBe(false)
  })
})
