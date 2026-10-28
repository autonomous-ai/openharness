import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubscriptionRelay } from '../lib/subscriptionRelay.js'
import type { TeamConfig } from './config.js'
import {
  publishTeamRelay, readTeamRelay, setfaclGrant, TEAM_RELAY_GUEST, teamRelayDir, teamRelayFile, teamRelayLaunch, teamRelayPublished, TeamRelayPublisher,
  type TeamRelayLaunchDeps, type TeamRelayPublisherDeps, type TeamRelayReadDeps,
} from './relay.js'

const config = { user: 'harnessteam', owner: 'owner', ownerHome: '/Users/owner' } as TeamConfig
const TOKEN = 'a'.repeat(43)
const cleanup: string[] = []
afterEach(() => { for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function relay(): SubscriptionRelay {
  return { port: 9, url: 'http://127.0.0.1:9', mintToken: vi.fn(() => TOKEN), revoke: vi.fn(), close: vi.fn(async () => {}) }
}

function publisher(over: Partial<TeamRelayPublisherDeps> = {}) {
  const running = relay()
  let present = false
  const deps: TeamRelayPublisherDeps = {
    config: () => config, user: () => 'owner', team: () => false,
    startRelay: vi.fn(async () => running),
    publish: vi.fn(async () => { present = true }),
    published: () => present,
    withdraw: vi.fn(() => { present = false }),
    log: vi.fn(), intervalMs: 60_000, ...over,
  }
  return { p: new TeamRelayPublisher(deps), deps, running, remove: () => { present = false } }
}

describe('the owner\'s daemon, for the Harness Team account', () => {
  it('starts a relay, mints the team account\'s token and leaves it for the team account, once', async () => {
    const f = publisher()
    await f.p.tick()
    expect(f.running.mintToken).toHaveBeenCalledWith(TEAM_RELAY_GUEST)
    expect(f.deps.publish).toHaveBeenCalledWith(config, { url: 'http://127.0.0.1:9', token: TOKEN })
    await f.p.tick()
    expect(f.deps.publish).toHaveBeenCalledTimes(1)
    // The folder removed by someone: left again, with the same token.
    f.remove()
    await f.p.tick()
    expect(f.deps.publish).toHaveBeenCalledTimes(2)
    expect(f.deps.startRelay).toHaveBeenCalledTimes(1)
  })

  it('publishes nothing in the team account itself, on a Mac without one, or as another account than its owner', async () => {
    for (const over of [{ team: () => true }, { config: () => null }, { user: () => 'someone' }] as Array<Partial<TeamRelayPublisherDeps>>) {
      const f = publisher(over)
      f.p.start()
      await f.p.tick()
      await f.p.stop()
      expect(f.deps.startRelay).not.toHaveBeenCalled()
    }
  })

  it('takes the relay away once the team account is gone, and on stop', async () => {
    let present: TeamConfig | null = config
    const f = publisher({ config: () => present })
    await f.p.tick()
    present = null
    await f.p.tick()
    expect(f.deps.withdraw).toHaveBeenCalledWith('owner')
    expect(f.running.close).toHaveBeenCalledOnce()
    present = config
    f.p.start()
    await f.p.tick()
    await f.p.stop()
    expect(f.deps.withdraw).toHaveBeenCalledTimes(2)
  })

  it('starts a relay that failed again on the next look, and says why', async () => {
    const f = publisher()
    vi.mocked(f.deps.startRelay).mockRejectedValueOnce(new Error('no port'))
    await f.p.tick()
    expect(f.deps.log).toHaveBeenCalledWith('team relay: no port')
    await f.p.tick()
    expect(f.deps.publish).toHaveBeenCalledOnce()
    vi.mocked(f.deps.publish).mockRejectedValueOnce('odd')
    f.remove()
    await f.p.tick()
    expect(f.deps.log).toHaveBeenCalledWith('team relay: odd')
  })

  it('writes the grant readable by this user and, through an ACL, the team account alone', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'team-relay-')), 'relay')
    cleanup.push(dir)
    const allowed: string[][] = []
    await publishTeamRelay(config, { url: 'http://127.0.0.1:9', token: TOKEN }, process.getuid!(),
      async (path, user, rights) => { allowed.push([path.endsWith('.next') ? 'file' : path, user, rights]) }, dir)
    expect(JSON.parse(readFileSync(join(dir, 'relay.json'), 'utf8'))).toEqual({ url: 'http://127.0.0.1:9', token: TOKEN })
    expect(statSync(dir).mode & 0o777).toBe(0o700)
    expect(statSync(join(dir, 'relay.json')).mode & 0o777).toBe(0o600)
    expect(allowed).toEqual([[dir, 'harnessteam', 'list,search,readattr'], ['file', 'harnessteam', 'read,readattr']])
    // Again, over its own folder; never into one another user made.
    await publishTeamRelay(config, { url: 'http://127.0.0.1:9', token: TOKEN }, process.getuid!(), async () => {}, dir)
    await expect(publishTeamRelay(config, { url: 'http://127.0.0.1:9', token: TOKEN }, process.getuid!() + 1, async () => {}, dir))
      .rejects.toThrow('is not this account\'s')
    await expect(publishTeamRelay(config, { url: 'u', token: TOKEN }, 0, async () => {}, join(dir, 'missing', 'deeper')))
      .rejects.toThrow()
  })

  it('after each look, says when it last published, for a team account on an older build to be updated', async () => {
    const afterPass = vi.fn(async () => {})
    let present: TeamConfig | null = config
    const f = publisher({ afterPass, now: () => 7, config: () => present })
    await f.p.tick()
    expect(afterPass).toHaveBeenLastCalledWith(7)
    await f.p.tick()
    expect(afterPass).toHaveBeenCalledTimes(2)
    present = null
    await f.p.tick()
    expect(afterPass).toHaveBeenCalledTimes(2)
  })

  it('names one folder per owner under /Users/Shared', () => {
    expect(teamRelayDir('owner')).toBe('/Users/Shared/.harness-team-relay-owner')
    expect(teamRelayFile('owner')).toBe('/Users/Shared/.harness-team-relay-owner/relay.json')
    expect(teamRelayPublished(config, (path) => path === teamRelayFile('owner'))).toBe(true)
    expect(teamRelayPublished(config, () => false)).toBe(false)
  })
})

describe('the team daemon, reading its owner\'s relay', () => {
  const entry = (uid: number, mode: number, dir: boolean) => ({ uid, mode, isDirectory: () => dir, isFile: () => !dir })
  function reader(over: { dir?: ReturnType<typeof entry>; file?: ReturnType<typeof entry>; text?: string } = {}): TeamRelayReadDeps {
    return {
      ownerUid: () => 501,
      lstat: (path) => path.endsWith('relay.json') ? over.file ?? entry(501, 0o100600, false) : over.dir ?? entry(501, 0o40700, true),
      read: () => over.text ?? JSON.stringify({ url: 'http://127.0.0.1:9', token: TOKEN }),
    }
  }

  it('reads it only from the owner the root-owned config names, private to them', () => {
    expect(readTeamRelay(config, reader())).toEqual({ url: 'http://127.0.0.1:9', token: TOKEN })
    for (const over of [
      { dir: entry(502, 0o40700, true) }, { dir: entry(501, 0o40777, true) }, { dir: entry(501, 0o100600, false) },
      { file: entry(502, 0o100600, false) }, { file: entry(501, 0o100644, false) }, { file: entry(501, 0o40700, true) },
      { text: JSON.stringify({ url: 'http://evil.example:9', token: TOKEN }) }, { text: JSON.stringify({ url: 'http://127.0.0.1:9', token: 'short' }) },
      { text: '{' },
    ]) expect(readTeamRelay(config, reader(over)), JSON.stringify(over)).toBeNull()
  })
})

describe('on Linux', () => {
  const linuxConfig = { user: 'harnessteam', owner: 'owner', ownerHome: '/home/owner' } as TeamConfig

  it('names the owner\'s folder setup made under /var/lib/harness', () => {
    expect(teamRelayDir('owner', 'linux')).toBe('/var/lib/harness/team-relay-owner')
    expect(teamRelayFile('owner', 'linux')).toBe('/var/lib/harness/team-relay-owner/relay.json')
    expect(teamRelayPublished(linuxConfig, (path) => path === '/var/lib/harness/team-relay-owner/relay.json', 'linux')).toBe(true)
  })

  it('sets the folder\'s and the file\'s whole ACL with setfacl: the owner, and harnessteam reading, nobody else', async () => {
    const calls: string[][] = []
    const grant = setfaclGrant(async (file, args) => { calls.push([file, ...args]) })
    const dir = join(mkdtempSync(join(tmpdir(), 'team-relay-')), 'relay')
    cleanup.push(dir)
    await publishTeamRelay(linuxConfig, { url: 'http://127.0.0.1:9', token: TOKEN }, process.getuid!(), grant, dir)
    expect(calls).toEqual([
      ['setfacl', '--set', 'u::rwx,g::---,o::---,u:harnessteam:r-x', dir],
      ['setfacl', '--set', 'u::rw-,g::---,o::---,u:harnessteam:r--', expect.stringMatching(/\.next$/)],
    ])
    await expect(setfaclGrant(async () => { throw new Error('exit 1') })(dir, 'harnessteam', 'read,readattr')).rejects.toThrow('could not let harnessteam read')
  })

  it('the team side reads it only from the configured owner, allowing the group bits an ACL shows', () => {
    const entry = (uid: number, mode: number, dir: boolean) => ({ uid, mode, isDirectory: () => dir, isFile: () => !dir })
    const reader = (over: { dir?: ReturnType<typeof entry>; file?: ReturnType<typeof entry> } = {}): TeamRelayReadDeps => ({
      platform: 'linux', ownerUid: () => 1001,
      // With an ACL entry, the group bits are the ACL's mask: r-x on the folder, r-- on the file.
      lstat: (path) => path.endsWith('relay.json') ? over.file ?? entry(1001, 0o100640, false) : over.dir ?? entry(1001, 0o40750, true),
      read: (path) => { expect(path).toBe('/var/lib/harness/team-relay-owner/relay.json'); return JSON.stringify({ url: 'http://127.0.0.1:9', token: TOKEN }) },
    })
    expect(readTeamRelay(linuxConfig, reader())).toEqual({ url: 'http://127.0.0.1:9', token: TOKEN })
    for (const over of [
      { dir: entry(1002, 0o40750, true) }, { file: entry(1002, 0o100640, false) }, { dir: entry(0, 0o40750, true) },
      { dir: entry(1001, 0o40770, true) }, { file: entry(1001, 0o100660, false) }, { file: entry(1001, 0o100644, false) },
    ]) expect(readTeamRelay(linuxConfig, reader(over)), JSON.stringify(over)).toBeNull()
  })
})

describe('a launch in the team account', () => {
  const grant = { url: 'http://127.0.0.1:9', token: TOKEN }
  const launchDeps = (over: Partial<TeamRelayLaunchDeps> = {}): TeamRelayLaunchDeps => ({
    team: () => true, config: () => config, signedIn: async () => false, read: () => grant, onboarded: vi.fn(), ...over,
  })

  it('spends the owner\'s subscription for an engine it has not signed in itself', async () => {
    const deps = launchDeps()
    expect(await teamRelayLaunch('claude', deps)).toEqual({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/claude', ANTHROPIC_AUTH_TOKEN: TOKEN }, args: [] })
    expect(deps.onboarded).toHaveBeenCalledWith('claude')
    const codex = await teamRelayLaunch('codex', deps)
    expect(codex?.env).toEqual({ HARNESS_RELAY_TOKEN: TOKEN })
    expect(codex?.args).toContain('model_provider="harness_owner"')
    // A first-run screen that cannot be recorded is left for the engine to ask.
    expect(await teamRelayLaunch('claude', launchDeps({ onboarded: () => { throw new Error('read-only') } }))).not.toBeNull()
    expect(await teamRelayLaunch('codex', launchDeps({ signedIn: async () => { throw new Error('keychain') } }))).not.toBeNull()
  })

  it('adds nothing elsewhere: another engine, the owner\'s own daemon, no team account, its own sign-in, no relay', async () => {
    expect(await teamRelayLaunch('opencode', launchDeps())).toBeNull()
    expect(await teamRelayLaunch('claude', launchDeps({ team: () => false }))).toBeNull()
    expect(await teamRelayLaunch('claude', launchDeps({ config: () => null }))).toBeNull()
    expect(await teamRelayLaunch('claude', launchDeps({ signedIn: async () => true }))).toBeNull()
    expect(await teamRelayLaunch('claude', launchDeps({ read: () => null }))).toBeNull()
  })
})
