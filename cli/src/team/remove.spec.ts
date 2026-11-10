import { execFileSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import type { GuestRunResult } from '../lib/guestAccounts.js'
import type { AdminResult } from '../lib/windows/elevated.js'
import type { TeamConfig } from './config.js'
import { TEAM_REMOVAL_PROMPT, removeTeamAccount, rootLine, teamRemovalDeps, teamRemovalTarget, type TeamRemovalDeps, type TeamRemovalTarget } from './remove.js'

const MAC_CONFIG = {
  version: 1, user: 'harnessteam', realName: 'Harness Team', home: '/Users/harnessteam', owner: 'ken', ownerHome: '/Users/ken',
  sentinel: '/Users/ken/.harness-team-privacy', port: 18493, label: 'ai.autonomous.harness.team',
  plist: '/Library/LaunchDaemons/ai.autonomous.harness.team.plist', statusFile: '/Library/Application Support/Harness/Team/status.json',
  node: '/Users/harnessteam/.harness/runtime/current-node', cli: '/Users/harnessteam/.harness/cli/cli.js', env: {}, createdAt: '2026-10-30T00:00:00Z',
} satisfies TeamConfig
const LINUX_CONFIG: TeamConfig = { ...MAC_CONFIG, home: '/home/harnessteam', ownerHome: '/home/ken', sentinel: '/home/ken/.harness-team-privacy' }
const WINDOWS_CONFIG: TeamConfig = { ...MAC_CONFIG, home: 'C:\\Users\\harnessteam', ownerHome: 'C:\\Users\\ken', ownerSid: 'S-1-5-21-1-2-3-1001' }

/** The account each config names, as the removal reads it. */
const target = (config: TeamConfig): TeamRemovalTarget => ({ user: config.user, home: config.home, owner: config.owner, ownerHome: config.ownerHome, realName: config.realName })

/** The script a root line carries (`rootLine`), decoded as root would. */
const carried = (line: string): string | undefined => {
  const b64 = /printf %s ([A-Za-z0-9+/=]+) \|/.exec(line)?.[1]
  return b64 ? Buffer.from(b64, 'base64').toString('utf8') : undefined
}

/** A computer with [config], whose commands answer [answer], recording each call and the script it carries. */
function computer(platform: NodeJS.Platform, config: TeamConfig | null, answer: (command: string) => GuestRunResult, over: Partial<TeamRemovalDeps> = {}) {
  const calls: { command: string; args: readonly string[]; script?: string }[] = []
  const deps: TeamRemovalDeps = {
    platform,
    target: () => config && target(config),
    runner: async (command, args) => {
      const script = carried(args.join(' '))
      calls.push({ command, args, ...script ? { script } : {} })
      return answer(command)
    },
    windowsAdmin: async () => { throw new Error('not Windows') },
    graphical: () => true,
    ...over,
  }
  return { deps, calls }
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
    it('runs the removal once as root behind the administrator prompt, the script carried in the line itself', async () => {
      const c = computer('darwin', MAC_CONFIG, () => ok('harness: removed the Harness Team account, its home folder and its daemon\n'))
      expect(await removeTeamAccount(c.deps)).toEqual({ ok: true, removed: true })
      expect(c.calls.map((call) => call.command)).toEqual(['osascript'])
      const [line] = c.calls[0]!.args.slice(1)
      expect(line).toMatch(/^do shell script "\/bin\/sh -c \\"\$\(printf %s [A-Za-z0-9+/=]+ \| \/usr\/bin\/base64 --decode\)\\"" with prompt /)
      expect(line).toContain(`with prompt "${TEAM_REMOVAL_PROMPT}" with administrator privileges`)
      expect(c.calls[0]!.script).toContain("TEAM='harnessteam'")
      expect(c.calls[0]!.script).toContain("SENTINEL='/Users/ken/.harness-team-privacy'")
      // No file: nothing of this account's could swap it before root reads it.
      expect(c.calls[0]!.args.join(' ')).not.toMatch(/remove\.sh|\/tmp\/|\/var\/folders\//)
    })

    it('says the person cancelled when they did', async () => {
      const c = computer('darwin', MAC_CONFIG, () => fail(1, 'execution error: User canceled. (-128)'))
      expect(await removeTeamAccount(c.deps)).toEqual({ ok: false, code: 'CANCELLED', message: 'Nothing was removed: the administrator prompt was cancelled.' })
      // Only the prompt's own status is a Cancel, not a -128 inside a reason.
      const other = computer('darwin', MAC_CONFIG, () => fail(1, 'harness: dscl said -1280 at x (1)'))
      expect(await removeTeamAccount(other.deps)).toEqual({ ok: false, code: 'FAILED', message: 'dscl said -1280 at x' })
    })

    it('when macOS keeps the account, says where to delete it by the name Users & Groups shows', async () => {
      for (const said of ['Nothing was removed (9)', 'Nothing was removed, and the team daemon stays stopped (9)']) {
        const c = computer('darwin', MAC_CONFIG, () => fail(1, `harness: could not delete the account harnessteam: macOS did not allow it (eDSPermissionError). ${said}`))
        expect(await removeTeamAccount(c.deps)).toEqual({ ok: false, code: 'KEPT',
          message: 'macOS kept the account. Delete "Harness Team" in System Settings > Users & Groups, then try again.' })
      }
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
      expect(c.calls[0]!.args.slice(0, 2)).toEqual(['/bin/sh', '-c'])
      expect(c.calls[0]!.script).toContain("RELAY_DIR='/var/lib/harness/team-relay-ken'")
    })

    it('stages and runs nothing where polkit has no desktop to ask on', async () => {
      const c = computer('linux', LINUX_CONFIG, () => ok(), { graphical: () => false })
      expect(await removeTeamAccount(c.deps)).toMatchObject({ ok: false, code: 'NO_PROMPT' })
      expect(c.calls).toEqual([])
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
      // pkexec's own status is the script's: a "(9)" in a reason is not one.
      const other = computer('linux', LINUX_CONFIG, () => fail(1, 'harness: stopped at (9)'))
      expect(await removeTeamAccount(other.deps)).toMatchObject({ code: 'FAILED' })
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

    it('says what Windows removes only at the next restart, and a task it could not remove', async () => {
      const w = windows({ ok: true, stdout: 'harness: deleted the account harnessteam\n'
        + 'harness: could not remove 1 task(s) the team account registered: Updater\n'
        + 'harness: Windows still holds the registry of harnessteam; the rest of C:\\Users\\harnessteam (3 items) is removed at the next restart\n' })
      expect(await removeTeamAccount(w.deps)).toEqual({ ok: true, removed: true,
        left: 'could not remove 1 task(s) the team account registered: Updater. '
          + 'Windows still holds the registry of harnessteam; the rest of C:\\Users\\harnessteam (3 items) is removed at the next restart' })
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

  it('is wired to this computer\'s own config and commands', () => {
    expect(teamRemovalDeps().platform).toBe(process.platform)
  })
})

describe('the line root runs', () => {
  it('carries the script whole, quotes and all, and runs it', () => {
    const script = 'set -eu\nprintf \'%s|\' "a b" \'it\'"\'"\'s\' "$((1 + 1))"\n'
    expect(execFileSync('/bin/sh', ['-c', rootLine(script)], { encoding: 'utf8' })).toBe("a b|it's|2|")
  })
})

describe('which account is removed', () => {
  it('is the one the config names', () => {
    expect(teamRemovalTarget('darwin', () => true, () => MAC_CONFIG)).toEqual(target(MAC_CONFIG))
  })

  it('is setup\'s own names when the config is there but no check passes, and none without a config', () => {
    const owner = () => ({ user: 'ken', home: '/Users/ken' })
    expect(teamRemovalTarget('darwin', () => true, () => null, owner)).toEqual({
      user: 'harnessteam', home: '/Users/harnessteam', owner: 'ken', ownerHome: '/Users/ken', realName: 'Harness Team' })
    expect(teamRemovalTarget('linux', (path) => path === '/etc/harness/team.json', () => null, owner)).toMatchObject({ home: '/home/harnessteam' })
    expect(teamRemovalTarget('win32', () => true, () => null, () => ({ user: 'ken', home: 'C:\\Users\\ken' }))).toMatchObject({ home: 'C:\\Users\\harnessteam' })
    expect(teamRemovalTarget('darwin', () => false, () => null, owner)).toBeNull()
    expect(teamRemovalTarget('freebsd', () => true, () => null, owner)).toBeNull()
  })
})
