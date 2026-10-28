import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readTeamConfig, teamConfigJson, type TeamConfig } from './config.js'
import {
  PRIVACY_RECHECK_MS, TeamPrivacyObserver, adminGroupIds, privacyProbes, readTeamStatus, realPrivacyDeps, runPrivacyCheck, writeTeamStatus,
  type PrivacyDeps, type PrivacyResult,
} from './privacy.js'

const OWNER_HOME = '/Users/owner-placeholder'
const config = { ownerHome: OWNER_HOME, sentinel: `${OWNER_HOME}/.harness-team-privacy` }
const errno = (code: string) => Object.assign(new Error(code), { code })
const refusedEverywhere = (over: Partial<PrivacyDeps> = {}): PrivacyDeps => ({
  open: () => { throw errno('EACCES') }, list: () => { throw errno('EACCES') }, groups: () => [20], now: () => 5, ...over,
})

const cleanup: string[] = []
afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    try { chmodSync(dir, 0o700) } catch { /* gone */ }
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('privacy check', () => {
  it('passes only when every probe is refused', () => {
    expect(runPrivacyCheck(config, refusedEverywhere())).toEqual({ passed: true, checkedAt: 5 })
    expect(runPrivacyCheck(config, refusedEverywhere({ list: () => { throw errno('EPERM') } }))).toEqual({ passed: true, checkedAt: 5 })
  })

  it('tries the sentinel, the home listing, ~/.gitconfig, ~/.ssh, project folders, the Keychain, Chrome and Safari', () => {
    const tried: string[] = []
    runPrivacyCheck(config, refusedEverywhere({
      open: (p) => { tried.push(`open ${p}`); throw errno('EACCES') }, list: (p) => { tried.push(`list ${p}`); throw errno('EACCES') },
    }))
    expect(tried).toEqual([
      `open ${OWNER_HOME}/.harness-team-privacy`, `list ${OWNER_HOME}`, `open ${OWNER_HOME}/.gitconfig`, `list ${OWNER_HOME}/.ssh`,
      ...['code', 'Code', 'Developer', 'Projects', 'projects', 'src', 'Documents'].map((name) => `list ${OWNER_HOME}/${name}`),
      `list ${OWNER_HOME}/Library/Keychains`, `list ${OWNER_HOME}/Library/Application Support/Google/Chrome`, `list ${OWNER_HOME}/Library/Safari`,
    ])
    expect(privacyProbes(config).map((p) => p.item)).toEqual(['sentinel', 'home-listing', 'gitconfig', 'ssh', 'projects', 'keychain', 'chrome', 'safari'])
  })

  it('reports the first item it could read, without the owner\'s path', () => {
    const result = runPrivacyCheck(config, refusedEverywhere({ list: (p) => { if (p.endsWith('/Developer')) return; throw errno('EACCES') } }))
    expect(result).toMatchObject({ passed: false, item: 'projects', detail: 'The team account could read your project folders (~/code and the like).' })
    const sentinel = runPrivacyCheck(config, refusedEverywhere({ open: () => {} }))
    expect(sentinel).toMatchObject({ passed: false, item: 'sentinel' })
    for (const r of [result, sentinel]) expect(JSON.stringify(r)).not.toContain(OWNER_HOME)
  })

  it('fails on any answer but a refusal: a missing file means the folder above it was searchable', () => {
    const result = runPrivacyCheck(config, refusedEverywhere({ open: (p) => { throw errno(p.endsWith('.gitconfig') ? 'ENOENT' : 'EACCES') } }))
    expect(result).toMatchObject({ passed: false, item: 'gitconfig' })
    expect((result as { detail: string }).detail).toContain('ENOENT')
  })

  describe('on Linux', () => {
    const LINUX_HOME = '/home/owner-placeholder'
    const linuxConfig = { ownerHome: LINUX_HOME, sentinel: `${LINUX_HOME}/.harness-team-privacy` }
    const onLinux = (over: Partial<PrivacyDeps> = {}) => refusedEverywhere({ platform: 'linux', adminGids: () => [27, 10], ...over })

    it('tries the Linux places: the keyring, Chrome\'s and Firefox\'s profiles, in place of the Keychain, Chrome and Safari', () => {
      const tried: string[] = []
      expect(runPrivacyCheck(linuxConfig, onLinux({
        open: (p) => { tried.push(`open ${p}`); throw errno('EACCES') }, list: (p) => { tried.push(`list ${p}`); throw errno('EACCES') },
      }))).toEqual({ passed: true, checkedAt: 5 })
      expect(tried).toEqual([
        `open ${LINUX_HOME}/.harness-team-privacy`, `list ${LINUX_HOME}`, `open ${LINUX_HOME}/.gitconfig`, `list ${LINUX_HOME}/.ssh`,
        ...['code', 'Code', 'Developer', 'Projects', 'projects', 'src', 'Documents'].map((name) => `list ${LINUX_HOME}/${name}`),
        // GNOME Keyring's folder, then KWallet's.
        `list ${LINUX_HOME}/.local/share/keyrings`, `list ${LINUX_HOME}/.local/share/kwalletd`,
        `list ${LINUX_HOME}/.config/google-chrome`, `list ${LINUX_HOME}/.mozilla`,
      ])
      expect(privacyProbes(linuxConfig, 'linux').map((p) => p.item))
        .toEqual(['sentinel', 'home-listing', 'gitconfig', 'ssh', 'projects', 'keychain', 'chrome', 'firefox'])
      expect(JSON.stringify(privacyProbes(linuxConfig, 'linux').map((p) => p.what))).not.toMatch(/Keychain|Safari|Library/)
    })

    it('fails on a KWallet folder it can list, or one it is not refused (ENOENT under a home it can search)', () => {
      const kwallet = `${LINUX_HOME}/.local/share/kwalletd`
      expect(runPrivacyCheck(linuxConfig, onLinux({ list: (p) => { if (p === kwallet) return; throw errno('EACCES') } })))
        .toMatchObject({ passed: false, item: 'keychain', detail: 'The team account could read your login keyring folder.' })
      expect(runPrivacyCheck(linuxConfig, onLinux({ list: (p) => { throw errno(p === kwallet ? 'ENOENT' : 'EACCES') } })))
        .toMatchObject({ passed: false, item: 'keychain' })
    })

    it('fails a home folder others can list, and passes one that is 700', () => {
      // 755, the sentinel kept away by its own mode: the listing is what gives the folder away.
      const open = runPrivacyCheck(linuxConfig, onLinux({ list: (p) => { if (p === LINUX_HOME) return; throw errno('EACCES') } }))
      expect(open).toMatchObject({ passed: false, item: 'home-listing', detail: 'The team account could read the list of files in your home folder.' })
      // 755 as it is, the sentinel readable by everyone on purpose: that comes first.
      expect(runPrivacyCheck(linuxConfig, onLinux({ open: () => {}, list: (p) => { if (p === LINUX_HOME) return; throw errno('EACCES') } })))
        .toMatchObject({ passed: false, item: 'sentinel' })
      expect(runPrivacyCheck(linuxConfig, onLinux())).toEqual({ passed: true, checkedAt: 5 })
    })

    it('fails a team account in sudo, wheel or admin, by those groups\' ids, and not for macOS\'s group 80', () => {
      expect(runPrivacyCheck(linuxConfig, onLinux({ groups: () => [1001, 27] }))).toMatchObject({ passed: false, item: 'standard-user' })
      expect(runPrivacyCheck(linuxConfig, onLinux({ groups: () => [1001, 80] }))).toEqual({ passed: true, checkedAt: 5 })
    })

    it('keeps a failed Firefox probe in the status file the owner reads', () => {
      const failed = { passed: false, item: 'firefox', detail: 'The team account could read Firefox\'s profile folder.', checkedAt: 5 }
      expect(readTeamStatus('/x', () => JSON.stringify({ version: 1, privacy: failed }))).toEqual({ version: 1, privacy: failed })
    })

    it('reads the administrator groups\' ids from getent\'s answer', () => {
      expect(adminGroupIds('sudo:x:27:owner-placeholder\nadmin:x:118:\n')).toEqual([27, 118])
      expect(adminGroupIds('')).toEqual([])
      expect(adminGroupIds('broken\nwheel:x:abc:\n')).toEqual([])
    })
  })

  it('fails an administrator team account', () => {
    expect(runPrivacyCheck(config, refusedEverywhere({ groups: () => [20, 80] }))).toMatchObject({ passed: false, item: 'standard-user' })
  })

  it('reads real permission bits: a closed home passes, an open one fails at its first readable item', () => {
    // As the folder's owner the owner bits decide, so they stand in for "another account" here. Root reads anything.
    if (process.getuid?.() === 0) return
    const home = mkdtempSync(join(tmpdir(), 'team-owner-home-'))
    cleanup.push(home)
    writeFileSync(join(home, '.harness-team-privacy'), 'sentinel', { mode: 0o644 })
    writeFileSync(join(home, '.gitconfig'), '[user]', { mode: 0o644 })
    for (const dir of ['code', '.ssh', 'Library/Keychains', 'Library/Safari', 'Library/Application Support/Google/Chrome']) mkdirSync(join(home, dir), { recursive: true })
    const real = { ...realPrivacyDeps, groups: () => [] }
    const target = { ownerHome: home, sentinel: join(home, '.harness-team-privacy') }
    chmodSync(home, 0o000)
    expect(runPrivacyCheck(target, real)).toMatchObject({ passed: true })
    chmodSync(home, 0o700)
    expect(runPrivacyCheck(target, real)).toMatchObject({ passed: false, item: 'sentinel' })
    // Searchable but not listable, its sentinel closed: the listing is refused, ~/.gitconfig is not.
    chmodSync(join(home, '.harness-team-privacy'), 0o000)
    chmodSync(home, 0o100)
    expect(runPrivacyCheck(target, real)).toMatchObject({ passed: false, item: 'gitconfig' })
  })
})

describe('status file', () => {
  it('merges each report into the file, readable by others, through a rename', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-status-'))
    cleanup.push(dir)
    const file = join(dir, 'Team', 'status.json')
    expect(readTeamStatus(file)).toBeNull()
    writeTeamStatus(file, { signIn: { state: 'signed-in', at: 1 } })
    writeTeamStatus(file, { privacy: { passed: false, item: 'ssh', detail: 'x', checkedAt: 2 } })
    expect(readTeamStatus(file)).toEqual({ version: 1, signIn: { state: 'signed-in', at: 1 }, privacy: { passed: false, item: 'ssh', detail: 'x', checkedAt: 2 } })
    expect(statSync(file).mode & 0o777).toBe(0o644)
  })

  it('drops what it does not recognise', () => {
    expect(readTeamStatus('/x', () => 'not json')).toBeNull()
    expect(readTeamStatus('/x', () => '{"version":2}')).toBeNull()
    expect(readTeamStatus('/x', () => JSON.stringify({ version: 1, signIn: { state: 'odd', at: 1 }, privacy: { passed: false, item: 'other', detail: 'x', checkedAt: 1 } })))
      .toEqual({ version: 1 })
    expect(readTeamStatus('/x', () => JSON.stringify({ version: 1, privacy: { passed: true, checkedAt: 3 }, signIn: { state: 'failed', at: 2, detail: 'expired' } })))
      .toEqual({ version: 1, privacy: { passed: true, checkedAt: 3 }, signIn: { state: 'failed', at: 2, detail: 'expired' } })
  })
})

const teamConfig: TeamConfig = {
  version: 1, user: 'harnessteam', realName: 'Harness Team', home: '/Users/harnessteam', owner: 'owner-placeholder', ownerHome: OWNER_HOME,
  sentinel: `${OWNER_HOME}/.harness-team-privacy`, port: 18493, label: 'ai.autonomous.harness.team',
  plist: '/Library/LaunchDaemons/ai.autonomous.harness.team.plist', statusFile: '/Library/Application Support/Harness/Team/status.json',
  node: '/Users/harnessteam/.harness/runtime/node-v1/bin/node', cli: '/Users/harnessteam/.harness/cli/cli.js', env: { AUTONOMOUS_ENV: 'stag' },
  createdAt: '2026-10-24T00:00:00.000Z',
}

describe('team config', () => {
  it('reads back what setup writes, and nothing it did not', () => {
    expect(readTeamConfig('/x', () => teamConfigJson(teamConfig))).toEqual(teamConfig)
    expect(readTeamConfig('/x', () => { throw errno('ENOENT') })).toBeNull()
    expect(readTeamConfig('/x', () => JSON.stringify({ ...teamConfig, version: 2 }))).toBeNull()
    expect(readTeamConfig('/x', () => JSON.stringify({ ...teamConfig, ownerHome: '/Users/../etc' }))).toBeNull()
    expect(readTeamConfig('/x', () => JSON.stringify({ ...teamConfig, port: 18473 }))).toBeNull()
    expect(readTeamConfig('/x', () => JSON.stringify({ ...teamConfig, user: '' }))).toBeNull()
    expect(readTeamConfig('/x', () => JSON.stringify({ ...teamConfig, env: { BACKEND_WS_URL: 'javascript:x' } }))).toBeNull()
  })
})

describe('privacy observer', () => {
  function observer(over: { user?: string; config?: TeamConfig | null; team?: boolean; result?: PrivacyResult | (() => PrivacyResult) } = {}) {
    let now = 1_000
    const given = over.result
    const check = vi.fn((): PrivacyResult => typeof given === 'function' ? given() : given ?? { passed: true, checkedAt: now })
    const writeStatus = vi.fn()
    const o = new TeamPrivacyObserver({
      config: () => over.config === undefined ? teamConfig : over.config, user: () => over.user ?? 'harnessteam',
      teamSession: () => over.team ?? false, check, writeStatus, now: () => now,
    })
    return { o, check, writeStatus, step: (ms: number) => { now += ms } }
  }

  it('checks in the team account, at most every five minutes, and reports it for the owner', () => {
    const f = observer()
    expect(f.o.observe()).toEqual({ mode: 'account', passed: true, checkedAt: 1_000 })
    f.step(PRIVACY_RECHECK_MS - 1)
    f.o.observe()
    expect(f.check).toHaveBeenCalledTimes(1)
    f.step(1)
    f.o.observe()
    expect(f.check).toHaveBeenCalledTimes(2)
    expect(f.writeStatus).toHaveBeenLastCalledWith(teamConfig.statusFile, { privacy: { passed: true, checkedAt: 1_000 + PRIVACY_RECHECK_MS } })
  })

  it('reports a check that throws as unchecked, never as private', () => {
    const f = observer({ result: () => { throw new Error('boom') } })
    expect(f.o.observe()).toMatchObject({ mode: 'account', passed: false, item: 'unchecked' })
  })

  it('keeps reporting when the status file cannot be written', () => {
    const f = observer()
    f.writeStatus.mockImplementation(() => { throw new Error('read-only') })
    expect(f.o.observe()).toMatchObject({ mode: 'account', passed: true })
  })

  it('reports a dedicated computer, and nothing for the owner\'s own daemon', () => {
    expect(observer({ user: 'owner-placeholder', team: true }).o.observe()).toEqual({ mode: 'dedicated' })
    expect(observer({ config: null, team: true }).o.observe()).toEqual({ mode: 'dedicated' })
    const owner = observer({ user: 'owner-placeholder' })
    expect(owner.o.observe()).toBeNull()
    expect(owner.check).not.toHaveBeenCalled()
  })

  it('writes its status through the real file helpers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'team-observer-'))
    cleanup.push(dir)
    const file = join(dir, 'status.json')
    const o = new TeamPrivacyObserver({ config: () => ({ ...teamConfig, statusFile: file }), user: () => 'harnessteam', teamSession: () => false,
      check: () => ({ passed: true, checkedAt: 7 }), writeStatus: writeTeamStatus, now: () => 7 })
    o.observe()
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, privacy: { passed: true, checkedAt: 7 } })
  })
})
