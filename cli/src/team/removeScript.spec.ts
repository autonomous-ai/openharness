/**
 * The root removal scripts, run whole against a temporary folder: every path they name is moved into it, and every system
 * command they call (dscl, launchctl, systemctl, userdel, pkill, id, stat, getent…) is a stand-in shell function, defined
 * before the script's first line runs, that records the call and keeps the account's state in files. Nothing here touches
 * a real account, job or folder, and nothing runs as root.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { REMOVE_REFUSED, buildLinuxRemoveScript, buildRemoveScript, sh, type RemoveScriptInput } from './removeScript.js'

const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'team-remove-'))
  cleanup.push(dir)
  return dir
}
const at = (script: string, needle: string): number => {
  const index = script.indexOf(needle)
  expect(index, needle).toBeGreaterThanOrEqual(0)
  return index
}

const MAC: RemoveScriptInput = { user: 'harnessteam', home: '/Users/harnessteam', owner: 'owner-placeholder', ownerHome: '/Users/owner-placeholder' }
const LINUX: RemoveScriptInput = { user: 'harnessteam', home: '/home/harnessteam', owner: 'owner-placeholder', ownerHome: '/home/owner-placeholder' }

describe('sh', () => {
  it('single-quotes every word, a quote inside included', () => {
    expect(sh("it's")).toBe("'it'\\''s'")
    expect(execFileSync('/bin/sh', ['-c', `printf '%s' ${sh("x'; touch /nope; '$(id)`")}`], { encoding: 'utf8' })).toBe("x'; touch /nope; '$(id)`")
  })
})

/** [script] with every `NAME=` line of [paths] pointed into the sandbox, and [stubs] defined right after `cd /`. */
function sandboxed(script: string, paths: Record<string, string>, stubs: string): string {
  for (const [name, value] of Object.entries(paths)) {
    expect(script, name).toMatch(new RegExp(`^${name}=`, 'm'))
    script = script.replace(new RegExp(`^${name}=.*$`, 'm'), `${name}=${sh(value)}`)
  }
  expect(script).toContain('\ncd /\n')
  script = script.replace('\ncd /\n', `\ncd /\n${stubs}\n`)
  // Nothing left that names a real place: every path is in the temporary folder.
  expect(script).not.toMatch(/'\/(Users|Library|home|etc|var\/lib)\//)
  return script
}
const stub = (log: string, name: string, body: string) => `${name}() { printf '%s %s\\n' ${name} "$*" >> ${sh(log)}; ${body}\n}`
function run(root: string, script: string, log: string) {
  const file = join(root, 'remove.sh')
  writeFileSync(file, script)
  const result = spawnSync('/bin/sh', [file], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } })
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []
  return { result, calls }
}

describe('the macOS removal', () => {
  it('pins PATH to the system\'s folders before its first command, and deletes the account before anything it cannot undo', () => {
    const script = buildRemoveScript(MAC)
    const lines = script.split('\n')
    const pin = lines.indexOf('PATH=/usr/sbin:/usr/bin:/sbin:/bin; export PATH')
    expect(lines.slice(0, pin).filter((l) => l && !l.startsWith('#'))).toEqual(['set -eu'])
    const order = ['launchctl bootout "system/$LABEL"', 'dscl . -delete "/Users/$TEAM"', 'pkill -KILL -u "$team_uid"', 'rm -f "$PLIST"',
      'rm -rf "$TEAM_HOME" "$STATUS_DIR"', 'rm -f "$CONFIG" "$SENTINEL"', 'rmdir "$SHARED"'].map((needle) => at(script, needle))
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // The owner's home folder stays private: nothing here changes a mode.
    expect(script).not.toMatch(/chmod/)
  })

  it('refuses a value that is not plain before writing a line', () => {
    expect(() => buildRemoveScript({ ...MAC, user: 'root' })).toThrow()
    expect(() => buildRemoveScript({ ...MAC, home: '/Users/a b/../c' })).toThrow()
    expect(() => buildRemoveScript({ ...MAC, ownerHome: "/Users/o'b" })).toThrow()
  })

  function mac(over: { account?: boolean; refuse?: boolean; mark?: boolean; otherShared?: boolean; keptHome?: boolean; otherOwner?: boolean } = {}) {
    const root = temp()
    const state = join(root, 'state'), log = join(root, 'calls')
    mkdirSync(state)
    const shared = join(root, 'Application Support', 'Harness')
    const paths = {
      TEAM_HOME: join(root, 'Users', 'harnessteam'), PLIST: join(root, 'LaunchDaemons', 'ai.autonomous.harness.team.plist'),
      CONFIG: join(shared, 'team.json'), STATUS_DIR: join(shared, 'Team'), SHARED: shared,
      SHARED_MARK: join(shared, '.made-by-harness-team-setup'), SENTINEL: join(root, 'Users', 'owner', '.harness-team-privacy'),
      DELETED_HOME: `${join(root, 'Users', 'harnessteam')} (Deleted)`,
    }
    // Users & Groups, told to keep the home folder of an account it deletes, renames it.
    if (over.keptHome) mkdirSync(join(paths.DELETED_HOME, '.harness'), { recursive: true })
    mkdirSync(join(paths.TEAM_HOME, '.harness', 'cli', 'data'), { recursive: true })
    mkdirSync(join(root, 'LaunchDaemons'))
    mkdirSync(paths.STATUS_DIR, { recursive: true })
    mkdirSync(join(root, 'Users', 'owner'))
    writeFileSync(paths.PLIST, '<plist/>')
    writeFileSync(paths.CONFIG, '{}')
    writeFileSync(paths.SENTINEL, 'x')
    if (over.mark !== false) writeFileSync(paths.SHARED_MARK, '')
    if (over.otherShared) writeFileSync(join(shared, 'other.json'), '{}')
    if (over.account !== false) writeFileSync(join(state, 'account'), '')
    writeFileSync(join(state, 'loaded'), '')
    const s = (name: string, body: string) => stub(log, name, body)
    const stubs = [
      // The home's owner by number, and that number's name: the team account's, nobody's once it is deleted, or someone else's.
      s('id', ['case "$*" in', "  '-u') echo 0 ;;", "  '-u harnessteam') echo 600 ;;",
        `  '-un 600') if [ -e ${sh(`${state}/account`)} ]; then echo harnessteam; else return 1; fi ;;`, "  '-un 701') echo someone ;;",
        '  *) return 1 ;;', 'esac'].join('\n')),
      s('stat', `[ "$1 $2" = '-f %u' ] && echo ${over.otherOwner ? 701 : 600}`),
      s('dscl', ['case "$*" in',
        `  *-read*UniqueID*) [ -e ${sh(`${state}/account`)} ] && echo 'UniqueID: 600' ;;`,
        `  *-read*NFSHomeDirectory*) [ -e ${sh(`${state}/account`)} ] && echo ${sh(`NFSHomeDirectory: ${paths.TEAM_HOME}`)} ;;`,
        `  *-delete*) ${over.refuse ? "echo '<dscl_cmd> DS Error: -14120 (eDSPermissionError)' >&2; return 40" : `rm ${sh(`${state}/account`)}`} ;;`,
        'esac'].join('\n')),
      s('launchctl', ['case "$1" in', `  bootout) rm -f ${sh(`${state}/loaded`)} ;;`, `  bootstrap) : > ${sh(`${state}/loaded`)} ;;`, 'esac'].join('\n')),
      s('pkill', ':'),
      s('sleep', ':'),
    ].join('\n')
    // The script's dscl reads NFSHomeDirectory from the sandbox's home, so the account is the Team account's.
    const out = run(root, sandboxed(buildRemoveScript(MAC), paths, stubs), log)
    return { ...out, paths, state, gone: (path: string) => !existsSync(path) }
  }

  it('removes the account, its daemon and everything setup made', () => {
    const m = mac()
    expect(m.result.stderr).toBe('')
    expect(m.result.status).toBe(0)
    expect(m.result.stdout).toContain('harness: removed the Harness Team account, its home folder and its daemon')
    for (const path of [m.paths.TEAM_HOME, m.paths.PLIST, m.paths.CONFIG, m.paths.STATUS_DIR, m.paths.SENTINEL, m.paths.SHARED]) expect(m.gone(path), path).toBe(true)
    const deleted = m.calls.indexOf('dscl . -delete /Users/harnessteam')
    expect(deleted).toBeGreaterThan(m.calls.indexOf('launchctl bootout system/ai.autonomous.harness.team'))
    expect(m.calls.indexOf('pkill -KILL -u 600')).toBeGreaterThan(deleted)
    expect(m.calls.some((c) => c.startsWith('launchctl bootstrap'))).toBe(false)
  })

  it('when macOS refuses the deletion, exits 9 having removed nothing, and starts the team daemon again', () => {
    const m = mac({ refuse: true })
    expect(m.result.status).toBe(REMOVE_REFUSED)
    expect(m.result.stderr).toBe('harness: could not delete the account harnessteam: macOS did not allow it (eDSPermissionError). Nothing was removed\n')
    for (const path of [m.paths.TEAM_HOME, m.paths.PLIST, m.paths.CONFIG, m.paths.STATUS_DIR, m.paths.SENTINEL, m.paths.SHARED_MARK]) expect(m.gone(path), path).toBe(false)
    expect(existsSync(join(m.state, 'loaded'))).toBe(true)
    expect(m.calls.some((c) => c.startsWith('pkill'))).toBe(false)
  })

  it('finishes after the account was deleted in Users & Groups, stopping what still runs under its old id', () => {
    const m = mac({ account: false, keptHome: true })
    expect(m.result.status).toBe(0)
    expect(m.calls.some((c) => c.startsWith('dscl . -delete'))).toBe(false)
    expect(m.calls).toContain('pkill -KILL -u 600')
    for (const path of [m.paths.TEAM_HOME, m.paths.DELETED_HOME, m.paths.PLIST, m.paths.CONFIG, m.paths.SHARED]) expect(m.gone(path), path).toBe(true)
  })

  it('leaves a home folder that belongs to another account, and everything else, alone', () => {
    const m = mac({ account: false, otherOwner: true })
    expect(m.result.status).toBe(4)
    expect(m.result.stderr).toBe(`harness: ${m.paths.TEAM_HOME} belongs to someone; nothing was removed\n`)
    for (const path of [m.paths.TEAM_HOME, m.paths.PLIST, m.paths.CONFIG]) expect(m.gone(path), path).toBe(false)
    expect(m.calls.some((c) => c.startsWith('launchctl') || c.startsWith('pkill'))).toBe(false)
  })

  it('removes the shared folder only when setup made it and nothing else is in it', () => {
    const notMade = mac({ mark: false })
    expect(notMade.result.status).toBe(0)
    expect(notMade.gone(notMade.paths.SHARED)).toBe(false)
    const other = mac({ otherShared: true })
    expect(other.result.status).toBe(0)
    expect(other.gone(other.paths.SHARED)).toBe(false)
    expect(other.gone(other.paths.CONFIG)).toBe(true)
  })
})

describe('the Linux removal', () => {
  it('refuses a value that is not plain before writing a line', () => {
    expect(() => buildLinuxRemoveScript({ ...LINUX, user: 'root' })).toThrow()
    expect(() => buildLinuxRemoveScript({ ...LINUX, owner: 'a;b' })).toThrow()
    expect(buildLinuxRemoveScript(LINUX)).toContain("RELAY_DIR='/var/lib/harness/team-relay-owner-placeholder'")
    expect(buildLinuxRemoveScript(LINUX)).not.toMatch(/dscl|launchctl|stat -f|chmod/)
  })

  function linux(over: { account?: boolean; refuse?: boolean; otherOwner?: boolean } = {}) {
    const root = temp()
    const state = join(root, 'state'), log = join(root, 'calls')
    mkdirSync(state)
    const etc = join(root, 'etc', 'harness'), lib = join(root, 'var', 'lib', 'harness')
    const paths = {
      TEAM_HOME: join(root, 'home', 'harnessteam'), UNIT: join(root, 'systemd', 'harness-team.service'),
      CONFIG: join(etc, 'team.json'), STATUS_DIR: join(lib, 'team'), RELAY_DIR: join(lib, 'team-relay-owner-placeholder'),
      SHARED: etc, SHARED_MARK: join(etc, '.made-by-harness-team-setup'), STATE: lib, STATE_MARK: join(lib, '.made-by-harness-team-setup'),
      SENTINEL: join(root, 'home', 'owner', '.harness-team-privacy'),
    }
    for (const dir of [paths.TEAM_HOME, join(root, 'systemd'), etc, paths.STATUS_DIR, paths.RELAY_DIR, join(root, 'home', 'owner')]) mkdirSync(dir, { recursive: true })
    for (const file of [paths.UNIT, paths.CONFIG, paths.SHARED_MARK, paths.STATE_MARK, paths.SENTINEL, join(paths.TEAM_HOME, 'left')]) writeFileSync(file, 'x')
    if (over.account !== false) writeFileSync(join(state, 'account'), '')
    const account = sh(`${state}/account`)
    const s = (name: string, body: string) => stub(log, name, body)
    const stubs = [
      s('id', ['case "$*" in', "  '-u') echo 0 ;;", "  '-u harnessteam') echo 1001 ;;",
        `  '-un 1001') if [ -e ${account} ]; then echo harnessteam; else return 1; fi ;;`, "  '-un 1002') echo someone ;;", '  *) return 1 ;;', 'esac'].join('\n')),
      s('stat', `[ "$1 $2" = '-c %u' ] && echo ${over.otherOwner ? 1002 : 1001}`),
      s('getent', ['case "$1" in', `  passwd) [ -e ${account} ] && echo ${sh(`harnessteam:x:1001:1001::${paths.TEAM_HOME}:/bin/bash`)} ;;`,
        '  group) return 2 ;;', 'esac'].join('\n')),
      s('userdel', over.refuse ? "echo 'userdel: user harnessteam is currently used by process 4242' >&2; return 8" : `rm ${account}`),
      s('systemctl', ':'),
      s('groupdel', ':'),
      s('pkill', ':'),
      s('sleep', ':'),
    ].join('\n')
    const out = run(root, sandboxed(buildLinuxRemoveScript(LINUX), paths, stubs), log)
    return { ...out, paths, gone: (path: string) => !existsSync(path) }
  }

  it('stops the daemon and the account\'s processes, deletes the user, then everything setup made', () => {
    const l = linux()
    expect(l.result.stderr).toBe('')
    expect(l.result.status).toBe(0)
    for (const path of [l.paths.TEAM_HOME, l.paths.UNIT, l.paths.CONFIG, l.paths.STATUS_DIR, l.paths.RELAY_DIR, l.paths.SENTINEL, l.paths.SHARED, l.paths.STATE]) {
      expect(l.gone(path), path).toBe(true)
    }
    const order = ['systemctl disable --now harness-team.service', 'pkill -KILL -u 1001', 'userdel -r harnessteam'].map((call) => l.calls.indexOf(call))
    expect(order.every((i) => i >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })

  it('when userdel keeps the user, starts the daemon again and exits 9 having removed nothing', () => {
    const l = linux({ refuse: true })
    expect(l.result.status).toBe(REMOVE_REFUSED)
    expect(l.result.stderr).toBe('harness: could not delete the account harnessteam: userdel: user harnessteam is currently used by process 4242. Nothing was removed\n')
    for (const path of [l.paths.TEAM_HOME, l.paths.UNIT, l.paths.CONFIG]) expect(l.gone(path), path).toBe(false)
    expect(l.calls).toContain('systemctl enable --now harness-team.service')
  })

  it('leaves a home folder that belongs to another account, and everything else, alone', () => {
    const l = linux({ account: false, otherOwner: true })
    expect(l.result.status).toBe(4)
    expect(l.result.stderr).toBe(`harness: ${l.paths.TEAM_HOME} belongs to someone; nothing was removed\n`)
    expect(l.gone(l.paths.UNIT)).toBe(false)
    expect(l.calls.some((c) => c.startsWith('systemctl') || c.startsWith('pkill'))).toBe(false)
  })
})
