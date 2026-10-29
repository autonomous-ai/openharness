import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { CODEX_RELAY_ACCOUNT, type SubscriptionRelay } from '../lib/subscriptionRelay.js'
import { engineAccount } from '../lib/engineAccount.js'
import type { TeamConfig } from './config.js'
import {
  publishTeamRelay, publishWindowsTeamRelay, readTeamRelay, readWindowsTeamRelay, setfaclGrant, TEAM_RELAY_GUEST, teamRelayDir, teamRelayFile,
  teamRelayLaunch, teamRelayPublished, NO_PM_RELAY, type OwnerRelayLaunch, TeamRelayPublisher, prepareCodexHome, installedCodexVersion,
  CODEX_CLIENT_VERSION_FALLBACK,
  type TeamRelayLaunchDeps, type TeamRelayPublisherDeps, type TeamRelayReadDeps, type WindowsRelayFs,
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

describe('on Windows', () => {
  const OWNER_SID = 'S-1-5-21-1-2-3-1001'
  const DIR = 'C:\\ProgramData\\Harness\\team-relay-DELL'
  const winConfig = { user: 'harnessteam', owner: 'DELL', ownerSid: OWNER_SID, ownerHome: 'C:\\Users\\DELL' } as TeamConfig
  const entry = (kind: 'file' | 'dir' | 'link') => ({ isFile: () => kind === 'file', isDirectory: () => kind === 'dir', isSymbolicLink: () => kind === 'link' })
  function windowsFs(over: Partial<WindowsRelayFs> = {}, owners: Record<string, string> = { [DIR]: OWNER_SID, [`${DIR}\\relay.json`]: OWNER_SID }) {
    const files: Record<string, string> = {}
    const fs: WindowsRelayFs = {
      lstat: (path) => path === DIR ? entry('dir') : path in files ? entry('file') : (() => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) })(),
      ownerSid: (path) => owners[path] ?? null,
      setAcl: vi.fn(async () => {}),
      write: (path, text) => { files[path] = text },
      rename: (from, to) => { files[to] = files[from]!; delete files[from] },
      read: (path) => files[path] ?? '',
      ...over,
    }
    return { fs, files }
  }

  it('names the owner\'s folder setup made under C:\\ProgramData\\Harness', () => {
    expect(teamRelayDir('DELL', 'win32')).toBe(DIR)
  })

  it('the owner\'s daemon sets the folder\'s ACL with icacls and writes the grant, only in a folder that is the owner\'s', async () => {
    const f = windowsFs()
    await publishWindowsTeamRelay(winConfig, { url: 'http://127.0.0.1:9', token: TOKEN }, f.fs, DIR)
    expect(f.fs.setAcl).toHaveBeenCalledWith(DIR, OWNER_SID, 'harnessteam')
    expect(JSON.parse(f.files[`${DIR}\\relay.json`]!)).toEqual({ url: 'http://127.0.0.1:9', token: TOKEN })
    await expect(publishWindowsTeamRelay(winConfig, { url: 'http://127.0.0.1:9', token: TOKEN }, windowsFs({}, { [DIR]: 'S-1-5-21-9-9-9-1002' }).fs, DIR))
      .rejects.toThrow(/not this account's/)
    await expect(publishWindowsTeamRelay(winConfig, { url: 'http://127.0.0.1:9', token: TOKEN }, windowsFs({ lstat: () => entry('link') }).fs, DIR))
      .rejects.toThrow(/not this account's/)
  })

  it('the team side reads it only when the folder and the file are the configured owner\'s', async () => {
    const f = windowsFs()
    await publishWindowsTeamRelay(winConfig, { url: 'http://127.0.0.1:9', token: TOKEN }, f.fs, DIR)
    expect(readWindowsTeamRelay(winConfig, f.fs, DIR)).toEqual({ url: 'http://127.0.0.1:9', token: TOKEN })
    expect(readWindowsTeamRelay(winConfig, { ...f.fs, ownerSid: (path) => path === DIR ? OWNER_SID : 'S-1-5-21-9-9-9-1002' }, DIR)).toBeNull()
    expect(readWindowsTeamRelay({ ...winConfig, ownerSid: undefined }, f.fs, DIR)).toBeNull()
    expect(readWindowsTeamRelay(winConfig, { ...f.fs, read: () => '{"url":"http://evil.example","token":"x"}' }, DIR)).toBeNull()
  })
})

describe('a launch in the team account', () => {
  const grant = { url: 'http://127.0.0.1:9', token: TOKEN }
  const launchDeps = (over: Partial<TeamRelayLaunchDeps> = {}): TeamRelayLaunchDeps => ({
    team: () => true, config: () => config, signedIn: async () => false, read: () => grant, onboarded: vi.fn(), codexHome: vi.fn(async () => {}), ...over,
  })

  it('spends the owner\'s subscription for an engine it has not signed in itself', async () => {
    const deps = launchDeps()
    expect(await teamRelayLaunch('claude', deps)).toEqual({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/claude', ANTHROPIC_AUTH_TOKEN: TOKEN }, args: [] })
    expect(deps.onboarded).toHaveBeenCalledWith('claude')
    const codex = await teamRelayLaunch('codex', deps) as OwnerRelayLaunch | null
    expect(codex?.env).toEqual({ HARNESS_RELAY_TOKEN: TOKEN })
    expect(codex?.args).toContain('model_provider="harness_owner"')
    // Its home is made ready first (the owner's model list), and Codex stays an API-key provider of the relay.
    expect(deps.codexHome).toHaveBeenCalledWith(grant)
    expect(codex?.args).toContain('model_providers.harness_owner.env_key="HARNESS_RELAY_TOKEN"')
    expect(codex?.args.join(' ')).not.toContain('requires_openai_auth')
    // A home that could not be made ready still launches, as before.
    expect((await teamRelayLaunch('codex', launchDeps({ codexHome: async () => { throw new Error('read-only') } })) as OwnerRelayLaunch | null)?.args).toContain('model_provider="harness_owner"')
    // A first-run screen that cannot be recorded is left for the engine to ask.
    expect(await teamRelayLaunch('claude', launchDeps({ onboarded: () => { throw new Error('read-only') } }))).not.toBeNull()
    expect(await teamRelayLaunch('codex', launchDeps({ signedIn: async () => { throw new Error('keychain') } }))).not.toBeNull()
  })

  // Security re-check of #2089: a Codex Product Manager in a Team account runs in an engine home of its own (superTabs/
  // teamDaemon.ts pmEngineHome). Whether it is signed in, and the owner's model list, are that home's, not the daemon's: it
  // started signed out when the Team user had a Codex sign-in of its own, and without the owner's models.
  it('for a launch in a Codex home of its own, asks that home whether it is signed in and readies that home', async () => {
    const signedIn = vi.fn(async (_engine: 'claude' | 'codex', home?: string) => home === undefined)
    const deps = launchDeps({ signedIn })
    const codex = await teamRelayLaunch('codex', deps, '/Users/team/.harness-pm-homes/super-1/codex') as OwnerRelayLaunch | null
    expect(signedIn).toHaveBeenCalledWith('codex', '/Users/team/.harness-pm-homes/super-1/codex')
    expect(deps.codexHome).toHaveBeenCalledWith(grant, '/Users/team/.harness-pm-homes/super-1/codex')
    expect(codex?.env).toEqual({ HARNESS_RELAY_TOKEN: TOKEN })
    // The daemon's own Codex home, signed in itself, still launches on its own sign-in.
    expect(await teamRelayLaunch('codex', deps)).toBeNull()
  })

  // Security re-check 2 of 9e49723b8: a launch in a Codex home of its own holds no sign-in there, so with no relay it is refused
  // with why (create.ts and launchOverrides.ts honour it), never started signed out.
  it('refuses a launch in a Codex home of its own that no relay and no sign-in there can sign in', async () => {
    const home = '/Users/team/.harness-pm-homes/super-1/codex'
    expect(await teamRelayLaunch('codex', launchDeps({ read: () => null }), home)).toEqual({ refused: NO_PM_RELAY })
    expect(await teamRelayLaunch('codex', launchDeps({ config: () => null }), home)).toEqual({ refused: NO_PM_RELAY })
    expect(NO_PM_RELAY).toBe('The owner\'s subscription relay is not available on this machine, so a Codex Product Manager cannot sign in here.')
    // Signed in in that home, or not a Team daemon, or no home of its own: nothing to refuse.
    expect(await teamRelayLaunch('codex', launchDeps({ read: () => null, signedIn: async () => true }), home)).toBeNull()
    expect(await teamRelayLaunch('codex', launchDeps({ read: () => null, team: () => false }), home)).toBeNull()
    expect(await teamRelayLaunch('codex', launchDeps({ read: () => null }))).toBeNull()
  })

  it('readies a Product Manager\'s own Codex home with the owner\'s models, and leaves the daemon\'s alone', async () => {
    const root = mkdtempSync(join(tmpdir(), 'team-pm-')), pm = join(root, '.harness-pm-homes', 'super-1', 'codex'), own = join(root, '.codex')
    onTestFinished(() => rmSync(root, { recursive: true, force: true }))
    const fetch = vi.fn(async () => new Response(JSON.stringify({ models: [{ slug: 'gpt-6.1-sol', visibility: 'list' }] }), { status: 200 }))
    const codex = await teamRelayLaunch('codex', launchDeps({ codexHome: (g, home) => prepareCodexHome(home ?? own, g, { fetch: fetch as never, version: () => '0.165.0', now: () => 0 }) }), pm) as OwnerRelayLaunch | null
    expect(codex?.args).toContain('model_provider="harness_owner"')
    expect(JSON.parse(readFileSync(join(pm, 'models_cache.json'), 'utf8')).models).toEqual([{ slug: 'gpt-6.1-sol', visibility: 'list' }])
    expect(existsSync(own)).toBe(false)
  })

  it('adds nothing elsewhere: another engine, the owner\'s own daemon, no team account, its own sign-in, no relay', async () => {
    expect(await teamRelayLaunch('opencode', launchDeps())).toBeNull()
    expect(await teamRelayLaunch('claude', launchDeps({ team: () => false }))).toBeNull()
    expect(await teamRelayLaunch('claude', launchDeps({ config: () => null }))).toBeNull()
    expect(await teamRelayLaunch('claude', launchDeps({ signedIn: async () => true }))).toBeNull()
    expect(await teamRelayLaunch('claude', launchDeps({ read: () => null }))).toBeNull()
  })
})

describe('Codex\'s home for the relay', () => {
  const home = () => { const dir = mkdtempSync(join(tmpdir(), 'team-codex-')); onTestFinished(() => rmSync(dir, { recursive: true, force: true })); return dir }
  const grant = { url: 'http://127.0.0.1:9', token: TOKEN }
  const models = [{ slug: 'gpt-6.1-sol', visibility: 'list' }, { slug: 'gpt-6-astra', visibility: 'list' }]
  const answer = (status = 200, body: unknown = { models }) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

  // 2026-10-29: Codex on the relay knew only its built-in models, so a start's gpt-6.1-sol could not be chosen and it ran
  // gpt-5.5, which ChatGPT refuses for the owner's account.
  it('keeps the owner\'s model list where Codex reads it, asked through the relay with the relay token', async () => {
    const dir = join(home(), '.codex'), fetch = answer()
    await prepareCodexHome(dir, grant, { fetch: fetch as never, version: () => '0.165.0', now: () => Date.parse('2026-10-29T05:00:00Z') })
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:9/codex/models?client_version=0.165.0', expect.objectContaining({
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' } }))
    const cache = JSON.parse(readFileSync(join(dir, 'models_cache.json'), 'utf8'))
    expect(cache).toEqual({ fetched_at: '2026-10-29T05:00:00.000Z', client_version: '0.165.0', models })
    expect(statSync(join(dir, 'models_cache.json')).mode & 0o777).toBe(0o600)
    // An answer that is not a list, a refusal or no answer leaves the list there was.
    for (const fetch of [answer(503), answer(200, { models: [] }), answer(200, { nope: 1 }), vi.fn(async () => { throw new Error('down') })]) {
      await prepareCodexHome(dir, grant, { fetch: fetch as never, version: () => null, now: () => 0 })
      expect(JSON.parse(readFileSync(join(dir, 'models_cache.json'), 'utf8')).client_version).toBe('0.165.0')
    }
  })

  it('removes the relay sign-in CLI 0.5.1 wrote, which Codex\'s screen could not start with, and never the account\'s own', async () => {
    const dir = join(home(), '.codex')
    mkdirSync(dir)
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: TOKEN, account_id: CODEX_RELAY_ACCOUNT } }))
    await prepareCodexHome(dir, grant, { fetch: answer(503) as never, version: () => null, now: () => 0 })
    expect(existsSync(join(dir, 'auth.json'))).toBe(false)
    writeFileSync(join(dir, 'auth.json'), JSON.stringify({ tokens: { access_token: 'own', account_id: 'acct-1' } }))
    await prepareCodexHome(dir, grant, { fetch: answer(503) as never, version: () => null, now: () => 0 })
    expect(JSON.parse(readFileSync(join(dir, 'auth.json'), 'utf8')).tokens.account_id).toBe('acct-1')
  })

  it('asks for the version of the Codex the account installed, or a known one', async () => {
    const root = home()
    expect(installedCodexVersion(root)).toBeNull()
    mkdirSync(join(root, '.local', 'lib', 'node_modules', '@openai', 'codex'), { recursive: true })
    writeFileSync(join(root, '.local', 'lib', 'node_modules', '@openai', 'codex', 'package.json'), JSON.stringify({ version: '0.165.0' }))
    expect(installedCodexVersion(root)).toBe('0.165.0')
    const fetch = answer()
    await prepareCodexHome(join(root, '.codex'), grant, { fetch: fetch as never, version: () => null, now: () => 0 })
    expect(String((fetch.mock.calls[0] as unknown[])[0])).toContain(`client_version=${CODEX_CLIENT_VERSION_FALLBACK}`)
  })

  it('reads the relay\'s left-over sign-in as Codex not signed in', async () => {
    const root = home()
    mkdirSync(join(root, '.codex'))
    writeFileSync(join(root, '.codex', 'auth.json'), JSON.stringify({ tokens: { access_token: TOKEN, account_id: CODEX_RELAY_ACCOUNT } }))
    expect((await engineAccount('codex', { home: root, env: {}, lastUsed: false })).signedIn).toBe(false)
  })
})
