/**
 * The plugin's pass against a fake `claude`: a ClaudeRun whose `plugin list` follows its own installs, uninstalls and
 * updates, and one pointed at each Orca home, whose entry follows its own enables and disables. The homes are throwaway
 * folders. The real `claude`, ~/.claude and Orca's profiles are never touched.
 */
import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ClaudeRun } from '../devices/claudePlugin.js'
import { MAX_HOMES, readPluginHomes, readRemoved, type Read, type SetupCount } from '../devices/dialSkillFiles.js'
import { createDialPluginSetup, type DialPluginSetupDeps } from './dialPluginSetup.js'

// A copy of the module, so a test can watch the file calls a pass makes.
vi.mock('node:fs', async (original) => ({ ...await original<object>() }))

const folders: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of folders.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const ADD = 'plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins'
const INSTALL = 'plugin install harness-device@openharness --scope user'
const UNINSTALL = 'plugin uninstall harness-device@openharness --scope user'
const PULL = 'plugin marketplace update openharness'
const UPDATE = 'plugin update harness-device@openharness --scope user'
const ENABLE = 'plugin enable harness-device@openharness --scope user'
const DISABLE = 'plugin disable harness-device@openharness --scope user'
const PLUGIN_ON = JSON.stringify({ enabledPlugins: { 'harness-device@openharness': true } })
const HOUR = 3_600_000

function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dial-plugin-'))
  folders.push(dir)
  return dir
}

const real = (path: string): string => realpathSync(path)

type Entry = { id: string; scope: string; enabled: boolean; version: string }
const entry = (version: string): Entry => ({ id: 'harness-device@openharness', scope: 'user', enabled: true, version })

/**
 * A `claude` whose user-scope entry is [installed] at first and changes as the calls it is given would change it: an
 * update brings [pulled]. A call in [fail] exits 1; [on] sees each call before it is answered.
 */
function fakeClaude({ version = '2.1.287', installed, pulled = '9f2c1d0e7a4b', fail = [], on }: {
  version?: string; installed?: Entry; pulled?: string; fail?: string[]; on?: (call: string) => void
} = {}) {
  const calls: string[] = []
  let plugin = installed
  const answer = (stdout = '') => ({ code: 0, stdout, stderr: '' })
  const run: ClaudeRun = async (args) => {
    const call = args.join(' ')
    calls.push(call)
    on?.(call)
    if (fail.includes(call)) return { code: 1, stdout: '', stderr: 'Error: no network\n' }
    if (call === '--version') return answer(`${version} (Claude Code)\n`)
    if (call === 'plugin list --json') return answer(JSON.stringify(plugin ? [plugin] : []))
    if (call === 'plugin marketplace list --json') return answer('[]')
    if (call === INSTALL) plugin = entry('16a92abfab3f')
    if (call === UNINSTALL) plugin = undefined
    if (call === UPDATE && plugin) plugin = { ...plugin, version: pulled }
    return answer()
  }
  /** The calls that change something. */
  const writes = () => calls.filter((call) => !/^(--version|plugin (marketplace )?list --json)$/.test(call))
  return { run, calls, writes }
}

/** Every synchronous file call from here on, by name and first argument, until the test ends. */
function fileCalls(): [string, unknown][] {
  const calls: [string, unknown][] = []
  const module = fs as unknown as Record<string, (...args: unknown[]) => unknown>
  for (const [name, real] of Object.entries(module)) {
    if (typeof real !== 'function' || !name.endsWith('Sync')) continue
    vi.spyOn(module, name).mockImplementation((...args) => {
      calls.push([name, args[0]])
      return real(...args)
    })
  }
  return calls
}

/** A setup whose default home is a throwaway folder, its plugin on in its settings as the install leaves it, and Orca
 *  listing no home until a spec sets one. */
function rig(claude: ReturnType<typeof fakeClaude> | null = fakeClaude(), over: Partial<DialPluginSetupDeps> = {}) {
  const home = folder()
  writeFileSync(join(home, 'settings.json'), PLUGIN_ON)
  const state = {
    wanted: true as boolean | undefined, recorded: undefined as string | undefined, saves: true, now: 0, lookups: 0, found: claude,
    /** Orca's last read: a new read is a new list. */
    orca: { homes: [] as readonly string[], answered: true },
    pluginHomes: [] as string[],
    homesSave: true,
    /** dial-skill.json's list, which `harness device claude enable` writes. */
    command: { homes: [] } as Read<{ homes: string[] }>,
  }
  const counted: Array<[SetupCount] | [SetupCount, string]> = []
  const setup = createDialPluginSetup({
    platform: 'darwin',
    version: '0.6.59',
    home,
    claude: async () => {
      state.lookups++
      return state.found?.run ?? null
    },
    claudeIn: async () => null,
    orca: () => state.orca,
    pluginHomes: () => state.pluginHomes,
    recordPluginHomes: (homes) => {
      if (state.homesSave) state.pluginHomes = [...homes]
      return state.homesSave
    },
    enabledByCommand: () => state.command,
    wanted: () => state.wanted,
    recorded: () => state.recorded,
    record: (version) => {
      if (state.saves) state.recorded = version
      return state.saves
    },
    now: () => state.now,
    count: (kind, reason) => { counted.push(reason === undefined ? [kind] : [kind, reason]) },
    ...over,
  })
  return { setup, state, counted, home }
}

/**
 * Claude Code pointed at each Orca home: the plugin listed in every home, as its files are the default home's, and on
 * where that home's entry is; `enable` and `disable` change that entry alone. Each call is kept with its home, as
 * `<home> <call>`. A call in [fail] fails with a line naming the home, as Claude Code's own does; [on] sees each call
 * before it is answered.
 */
function fakeHomes({ fail = [], on }: { fail?: string[]; on?: (home: string, call: string) => void } = {}) {
  const entries = new Map<string, boolean>()
  const calls: string[] = []
  const answer = (stdout = '') => ({ code: 0, stdout, stderr: '' })
  const runIn = (home: string): ClaudeRun => async (args) => {
    const call = args.join(' ')
    calls.push(`${home} ${call}`)
    on?.(home, call)
    if (fail.includes(`${home} ${call}`)) return { code: 1, stdout: '', stderr: `Error: ${home}/settings.json is read-only\n` }
    if (call === '--version') return answer('2.1.287 (Claude Code)\n')
    if (call === 'plugin list --json') return answer(JSON.stringify([{ ...entry('16a92abfab3f'), enabled: entries.get(home) === true }]))
    if (call === ENABLE) entries.set(home, true)
    if (call === DISABLE) entries.set(home, false)
    return answer()
  }
  /** The calls in [home] that change something. */
  const writes = (home: string) => calls.filter((call) => call.startsWith(`${home} `)).map((call) => call.slice(home.length + 1))
    .filter((call) => !/^(--version|plugin list --json)$/.test(call))
  return { runIn, entries, calls, fail, writes }
}

/** The default home set up by this CLI and current, and Orca listing [listed]: Claude Code found in each Orca home, and
 *  [looked] the homes it was asked for. */
function orcaRig(listed: string[], fake = fakeHomes(), over: Partial<DialPluginSetupDeps> = {}) {
  const looked: string[] = []
  const r = rig(fakeClaude({ installed: entry('16a92abfab3f') }), {
    claudeIn: async (home) => {
      looked.push(home)
      return fake.runIn(home)
    },
    ...over,
  })
  r.state.recorded = '0.6.59'
  r.state.orca = { homes: listed, answered: true }
  return { ...r, fake, looked }
}

describe('createDialPluginSetup', () => {
  it('installs once, records this CLI\'s version and counts set up', async () => {
    const claude = fakeClaude()
    const { setup, state, counted } = rig(claude)
    expect(await setup.pass()).toBe(true)
    expect(claude.writes()).toEqual([ADD, INSTALL])
    expect(state.recorded).toBe('0.6.59')
    expect(counted).toEqual([['set up']])
    const before = claude.calls.length
    expect(await setup.pass()).toBe(false)
    expect(claude.calls).toHaveLength(before)
    expect(state.lookups).toBe(1)
  })

  it('a pass with this version recorded, or within the hour after a failure, reads no file', async () => {
    // wanted() as the devices compose it: dial-skill.json, read anew at each call.
    const dataDir = mkdtempSync(join(tmpdir(), 'dial-plugin-'))
    folders.push(dataDir)
    const { setup, state, counted } = rig(fakeClaude({ fail: [INSTALL] }), { wanted: () => readRemoved(dataDir).claude !== true })
    await setup.pass()
    expect(counted).toEqual([['failed', 'install']])
    const calls = fileCalls()

    state.now = HOUR - 1
    await setup.pass()
    expect(calls).toEqual([])

    state.recorded = '0.6.59'
    state.now = HOUR
    await setup.pass()
    expect(calls).toEqual([])
  })

  it('a computer that never had a dial, or a removed Claude Code: no lookup', async () => {
    const { setup, state, counted } = rig()
    state.wanted = false
    expect(await setup.pass()).toBe(false)
    expect(state.lookups).toBe(0)
    expect(counted).toEqual([])
  })

  it('claude appearing later is set up at the next pass', async () => {
    const claude = fakeClaude()
    const { setup, state, counted } = rig(null)
    expect(await setup.pass()).toBe(false)
    expect(counted).toEqual([])
    state.found = claude
    expect(await setup.pass()).toBe(true)
    expect(claude.writes()).toEqual([ADD, INSTALL])
    expect(counted).toEqual([['set up']])
  })

  // Turned off through /plugin before the first dial: the person's, as an uninstall is.
  it('a plugin the person turned off before the first setup is left removed, and not turned on', async () => {
    const claude = fakeClaude({ installed: { ...entry('16a92abfab3f'), enabled: false } })
    const { setup, state, counted } = rig(claude)
    expect(await setup.pass()).toBe(false)
    expect(claude.writes()).toEqual([])
    expect(state.recorded).toBe('0.6.59')
    expect(counted).toEqual([['left removed']])
  })

  it('a plugin already on at the first setup is recorded and counts nothing', async () => {
    const claude = fakeClaude({ installed: entry('16a92abfab3f') })
    const { setup, state, counted } = rig(claude)
    expect(await setup.pass()).toBe(false)
    expect(claude.writes()).toEqual([])
    expect(state.recorded).toBe('0.6.59')
    expect(counted).toEqual([])
  })

  // A computer with a dial and no Claude Code looks at every scan: a login shell that fails is started, and logged, once
  // in ten minutes at most, and at once when a dial attaches.
  it('the login shell\'s PATH is read at the first pass, then at most every ten minutes, and at once at an attach', async () => {
    const shells: boolean[] = []
    const { setup, state } = rig(null, { claude: async (shell) => { shells.push(shell); return null } })
    const at = async (ms: number, attached?: boolean) => {
      state.now = ms
      await setup.pass(attached)
    }
    const TEN_MINUTES = 600_000
    await at(0)
    await at(60_000)
    await at(TEN_MINUTES - 2)
    await at(TEN_MINUTES - 1, true)
    await at(TEN_MINUTES)
    await at(2 * TEN_MINUTES - 2)
    await at(2 * TEN_MINUTES - 1)
    expect(shells).toEqual([true, false, false, true, false, false, true])
  })

  it('a plugin the person uninstalled is not installed again', async () => {
    const claude = fakeClaude()
    const { setup, state, counted } = rig(claude)
    state.recorded = '0.6.59'
    expect(await setup.pass()).toBe(false)
    expect(state.lookups).toBe(0)
    expect(claude.calls).toEqual([])
    expect(counted).toEqual([])
  })

  it('after a CLI update the plugin is brought current once', async () => {
    const claude = fakeClaude({ installed: entry('16a92abfab3f') })
    const { setup, state, counted } = rig(claude)
    state.recorded = '0.6.58'
    expect(await setup.pass()).toBe(true)
    expect(claude.writes()).toEqual([PULL, UPDATE])
    expect(state.recorded).toBe('0.6.59')
    expect(counted).toEqual([['updated']])
    const before = claude.calls.length
    expect(await setup.pass()).toBe(false)
    expect(claude.calls).toHaveLength(before)
  })

  it('a plugin already current is recorded and counts nothing', async () => {
    const claude = fakeClaude({ installed: entry('16a92abfab3f'), pulled: '16a92abfab3f' })
    const { setup, state, counted } = rig(claude)
    state.recorded = '0.6.58'
    expect(await setup.pass()).toBe(false)
    expect(state.recorded).toBe('0.6.59')
    expect(counted).toEqual([])
  })

  it('after a CLI update an uninstalled plugin is left removed, and asked no more', async () => {
    const claude = fakeClaude()
    const { setup, state, counted } = rig(claude)
    state.recorded = '0.6.58'
    expect(await setup.pass()).toBe(false)
    expect(claude.writes()).toEqual([])
    expect(state.recorded).toBe('0.6.59')
    expect(counted).toEqual([['left removed']])
    expect(await setup.pass()).toBe(false)
    expect(state.lookups).toBe(1)
  })

  it('after a CLI update a list that cannot be read is failed · list, the old version kept, and tried an hour later', async () => {
    const fail = ['plugin list --json']
    const claude = fakeClaude({ installed: entry('16a92abfab3f'), fail })
    const { setup, state, counted } = rig(claude)
    state.recorded = '0.6.58'
    expect(await setup.pass()).toBe(false)
    expect(claude.writes()).toEqual([])
    expect(state.recorded).toBe('0.6.58')
    expect(counted).toEqual([['failed', 'list']])
    state.now = HOUR - 1
    await setup.pass()
    expect(state.lookups).toBe(1)
    fail.pop()
    state.now = HOUR
    expect(await setup.pass()).toBe(true)
    expect(claude.writes()).toEqual([PULL, UPDATE])
    expect(state.recorded).toBe('0.6.59')
    expect(counted).toEqual([['failed', 'list'], ['updated']])
  })

  it('a failed install is counted with its step and tried no sooner than an hour later', async () => {
    const fail = [INSTALL]
    const claude = fakeClaude({ fail })
    const { setup, state, counted } = rig(claude)
    expect(await setup.pass()).toBe(false)
    expect(counted).toEqual([['failed', 'install']])
    expect(state.recorded).toBeUndefined()
    const before = claude.calls.length
    state.now = HOUR - 1
    expect(await setup.pass()).toBe(false)
    expect(claude.calls).toHaveLength(before)
    expect(state.lookups).toBe(1)
    fail.pop()
    state.now = HOUR
    expect(await setup.pass()).toBe(true)
    expect(claude.writes()).toEqual([ADD, INSTALL, ADD, INSTALL])
    expect(state.recorded).toBe('0.6.59')
    expect(counted).toEqual([['failed', 'install'], ['set up']])
  })

  it('an old Claude Code: one --version, failed · unsupported', async () => {
    const claude = fakeClaude({ version: '2.1.286' })
    const { setup, state, counted } = rig(claude)
    expect(await setup.pass()).toBe(false)
    expect(claude.calls).toEqual(['--version'])
    expect(counted).toEqual([['failed', 'unsupported']])
    state.now = HOUR - 1
    await setup.pass()
    expect(claude.calls).toEqual(['--version'])
  })

  it('disable landing while the install runs: the plugin is uninstalled again, nothing recorded', async () => {
    const { setup, state, counted } = rig(null)
    const claude = fakeClaude({ on: (call) => { if (call === INSTALL) state.wanted = false } })
    state.found = claude
    expect(await setup.pass()).toBe(false)
    expect(claude.writes()).toEqual([ADD, INSTALL, UNINSTALL])
    expect(state.recorded).toBeUndefined()
    expect(counted).toEqual([])
  })

  it('disable landing while the update runs: the plugin is uninstalled again, nothing recorded', async () => {
    const { setup, state, counted } = rig(null)
    const claude = fakeClaude({ installed: entry('16a92abfab3f'), on: (call) => { if (call === UPDATE) state.wanted = false } })
    state.found = claude
    state.recorded = '0.6.58'
    expect(await setup.pass()).toBe(false)
    expect(claude.writes()).toEqual([PULL, UPDATE, UNINSTALL])
    expect(state.recorded).toBe('0.6.58')
    expect(counted).toEqual([])
  })

  // undefined: dial-skill.json is there but could not be read (EACCES, EIO, EMFILE), so whether disable ran is not known.
  it('a dial-skill.json that cannot be read while the update runs: nothing undone or recorded, and current at the next pass', async () => {
    const { setup, state, counted } = rig(null)
    let updates = 0
    const claude = fakeClaude({ installed: entry('16a92abfab3f'), on: (call) => { if (call === UPDATE && updates++ === 0) state.wanted = undefined } })
    state.found = claude
    state.recorded = '0.6.58'
    expect(await setup.pass()).toBe(false)
    expect(claude.writes()).toEqual([PULL, UPDATE])
    expect(state.recorded).toBe('0.6.58')
    expect(counted).toEqual([])

    state.wanted = true
    await setup.pass()
    expect(claude.writes()).toEqual([PULL, UPDATE, PULL, UPDATE])
    expect(state.recorded).toBe('0.6.59')
  })

  it('a dial-skill.json that cannot be read while the install runs leaves the plugin installed, and nothing recorded', async () => {
    const { setup, state, counted } = rig(null)
    const claude = fakeClaude({ on: (call) => { if (call === INSTALL) state.wanted = undefined } })
    state.found = claude
    expect(await setup.pass()).toBe(false)
    expect(claude.writes()).toEqual([ADD, INSTALL])
    expect(state.recorded).toBeUndefined()
    expect(counted).toEqual([])
  })

  it('an undo owed waits while dial-skill.json cannot be read', async () => {
    const fail = [UNINSTALL]
    const { setup, state } = rig(null)
    const claude = fakeClaude({ fail, on: (call) => { if (call === INSTALL) state.wanted = false } })
    state.found = claude
    await setup.pass()
    state.wanted = undefined
    state.now = HOUR
    expect(await setup.pass()).toBe(false)
    expect(state.lookups).toBe(1)
  })

  it('an undo that failed is tried again after the hour though Claude Code is not wanted, and not once it is done', async () => {
    const fail = [UNINSTALL]
    const { setup, state, counted } = rig(null)
    const claude = fakeClaude({ fail, on: (call) => { if (call === INSTALL) state.wanted = false } })
    state.found = claude
    expect(await setup.pass()).toBe(false)
    expect(counted).toEqual([['failed', 'uninstall']])
    state.now = HOUR - 1
    await setup.pass()
    expect(state.lookups).toBe(1)

    fail.pop()
    state.now = HOUR
    expect(await setup.pass()).toBe(false)
    expect(claude.writes()).toEqual([ADD, INSTALL, UNINSTALL, UNINSTALL])
    expect(state.recorded).toBeUndefined()
    expect(counted).toEqual([['failed', 'uninstall']])

    state.now = 3 * HOUR
    await setup.pass()
    expect(state.lookups).toBe(2)
  })

  it('two passes at once run one install', async () => {
    const claude = fakeClaude()
    const { setup } = rig(claude)
    expect(await Promise.all([setup.pass(), setup.pass()])).toEqual([true, false])
    expect(claude.writes()).toEqual([ADD, INSTALL])
  })

  it('a record that is not saved is failed · save', async () => {
    const claude = fakeClaude()
    const { setup, state, counted } = rig(claude)
    state.saves = false
    expect(await setup.pass()).toBe(true)
    expect(counted).toEqual([['failed', 'save']])
    const before = claude.calls.length
    state.now = HOUR - 1
    expect(await setup.pass()).toBe(false)
    expect(claude.calls).toHaveLength(before)
  })

  it('a lookup that throws is failed · error, and the pass does not reject', async () => {
    const { setup, counted } = rig(null, { claude: async () => { throw new Error('lookup') } })
    expect(await setup.pass()).toBe(false)
    expect(counted).toEqual([['failed', 'error']])
  })

  it('on Windows nothing is looked for', async () => {
    const { setup, state, counted } = rig(fakeClaude(), { platform: 'win32' })
    expect(await setup.pass()).toBe(false)
    expect(state.lookups).toBe(0)
    expect(counted).toEqual([])
  })
})

describe('the plugin in each Orca account\'s home', () => {
  it('each Orca home is turned on once, with that home alone, and recorded', async () => {
    const [a, b] = [folder(), folder()]
    const r = orcaRig([a, b])
    expect(await r.setup.pass()).toBe(false)
    expect(r.looked).toEqual([real(a), real(b)])
    // enable alone: the files are the default home's, so nothing is installed, added or updated here.
    for (const home of [a, b]) expect(r.fake.writes(real(home))).toEqual([ENABLE])
    expect(r.state.pluginHomes).toEqual([real(a), real(b)])
    expect(r.counted).toEqual([])
    const calls = r.fake.calls.length
    await r.setup.pass()
    expect(r.fake.calls).toHaveLength(calls)
  })

  it('nothing runs in an Orca home before the default home is recorded, and the pass that sets it up turns them on', async () => {
    const a = folder()
    const r = orcaRig([a])
    r.state.recorded = undefined
    r.state.found = null
    await r.setup.pass()
    expect(r.looked).toEqual([])

    const claude = fakeClaude()
    r.state.found = claude
    expect(await r.setup.pass()).toBe(true)
    expect(claude.writes()).toEqual([ADD, INSTALL])
    expect(r.fake.writes(real(a))).toEqual([ENABLE])
    expect(r.state.pluginHomes).toEqual([real(a)])
  })

  it('nothing while Claude Code is removed, not wanted or not known', async () => {
    for (const wanted of [false, undefined]) {
      const r = orcaRig([folder()])
      r.state.wanted = wanted
      await r.setup.pass()
      expect(r.looked).toEqual([])
      expect(r.counted).toEqual([])
    }
  })

  it('nothing on Windows', async () => {
    const r = orcaRig([folder()], fakeHomes(), { platform: 'win32' })
    await r.setup.pass()
    expect(r.looked).toEqual([])
  })

  // The person turned it off or removed it in the default home: that said no for every home, and a removal takes the
  // files each Orca home's entry names.
  it('nothing runs in Orca homes while the default home\'s plugin reads off, removed or not known, and nothing is counted', async () => {
    const a = folder()
    const r = orcaRig([a])
    const settings = join(r.home, 'settings.json')
    for (const plugins of [{ 'harness-device@openharness': false }, {}]) {
      writeFileSync(settings, JSON.stringify({ enabledPlugins: plugins }))
      await r.setup.pass()
    }
    rmSync(settings)
    await r.setup.pass()
    expect(r.looked).toEqual([])
    expect(r.counted).toEqual([])

    writeFileSync(settings, PLUGIN_ON)
    await r.setup.pass()
    expect(r.fake.writes(real(a))).toEqual([ENABLE])
  })

  it('a recorded home is never enabled again', async () => {
    const a = folder()
    const r = orcaRig([a])
    // Its entry off: the person turned it off through /plugin.
    r.state.pluginHomes = [real(a)]
    await r.setup.pass()
    expect(r.looked).toEqual([])
    expect(r.state.pluginHomes).toEqual([real(a)])
  })

  it('a home the command recorded is not run, and stays out of the devices\' record', async () => {
    const [a, b] = [folder(), folder()]
    const r = orcaRig([a, b])
    r.state.command = { homes: [real(a)] }
    await r.setup.pass()
    expect(r.looked).toEqual([real(b)])
    expect(r.state.pluginHomes).toEqual([real(b)])
  })

  it('a command list that cannot be read runs nothing in Orca homes', async () => {
    const r = orcaRig([folder()])
    r.state.command = { homes: [], unread: true }
    await r.setup.pass()
    expect(r.looked).toEqual([])
    expect(r.counted).toEqual([])
  })

  it('an Orca home already on is recorded with no enable', async () => {
    const a = folder()
    const r = orcaRig([a])
    r.fake.entries.set(real(a), true)
    await r.setup.pass()
    expect(r.fake.writes(real(a))).toEqual([])
    expect(r.state.pluginHomes).toEqual([real(a)])
  })

  it('the default home listed as an Orca account is never run as one', async () => {
    const a = folder()
    const r = orcaRig([])
    const link = join(folder(), 'claude')
    symlinkSync(r.home, link)
    r.state.orca = { homes: [r.home, link, a], answered: true }
    await r.setup.pass()
    expect(r.looked).toEqual([real(a)])
  })

  it('a home listed twice or through a link is one home', async () => {
    const a = folder()
    const link = join(folder(), 'orca-home')
    symlinkSync(a, link)
    const r = orcaRig([a, link, a])
    await r.setup.pass()
    expect(r.looked).toEqual([real(a)])
    expect(r.state.pluginHomes).toEqual([real(a)])
  })

  it('a home that is not there, or whose real path no record could hold, is not run', async () => {
    // Listed through a link, as Orca lists it, to a folder whose name holds a control character.
    const odd = join(folder(), 'a\nb')
    mkdirSync(odd)
    const link = join(folder(), 'orca-home')
    symlinkSync(odd, link)
    const r = orcaRig([join(folder(), 'gone'), link])
    await r.setup.pass()
    expect(r.looked).toEqual([])
    expect(r.state.pluginHomes).toEqual([])
  })

  it('a new Orca home is turned on at the next pass', async () => {
    const [a, b] = [folder(), folder()]
    const r = orcaRig([a])
    await r.setup.pass()
    r.state.orca = { homes: [a, b], answered: true }
    await r.setup.pass()
    expect(r.looked).toEqual([real(a), real(b)])
    expect(r.state.pluginHomes).toEqual([real(a), real(b)])
  })

  it('a home Orca no longer lists leaves the record', async () => {
    const [a, b] = [folder(), folder()]
    const r = orcaRig([a])
    r.state.pluginHomes = [real(a), real(b)]
    await r.setup.pass()
    expect(r.state.pluginHomes).toEqual([real(a)])
    expect(r.looked).toEqual([])
  })

  it('a record not saved as Orca\'s list shrinks is counted, and saved at the next read', async () => {
    const [a, b] = [folder(), folder()]
    const r = orcaRig([a])
    r.state.pluginHomes = [real(a), real(b)]
    r.state.homesSave = false
    await r.setup.pass()
    expect(r.counted).toEqual([['failed', 'save']])
    expect(r.state.pluginHomes).toEqual([real(a), real(b)])

    r.state.homesSave = true
    r.state.orca = { homes: [a], answered: true }
    await r.setup.pass()
    expect(r.state.pluginHomes).toEqual([real(a)])
  })

  // A failed read lists no home: taken as Orca's answer, the next good read would turn on again a home the person
  // turned off.
  it('a failed Orca read drops no recorded home', async () => {
    const a = folder()
    const r = orcaRig([])
    r.state.pluginHomes = [real(a)]
    r.state.orca = { homes: [], answered: false }
    await r.setup.pass()
    expect(r.state.pluginHomes).toEqual([real(a)])

    r.state.orca = { homes: [a], answered: true }
    await r.setup.pass()
    expect(r.looked).toEqual([])
    expect(r.state.pluginHomes).toEqual([real(a)])
  })

  it('a failing home waits its hour and the others are still tried', async () => {
    const [a, b, c] = [folder(), folder(), folder()]
    const fake = fakeHomes({ fail: [`${real(a)} ${ENABLE}`, `${real(c)} ${ENABLE}`] })
    const r = orcaRig([a, b], fake)
    await r.setup.pass()
    // A fixed word: Claude Code's own line named the home.
    expect(r.counted).toEqual([['failed', 'enable']])
    expect(r.state.pluginHomes).toEqual([real(b)])

    // c, listed half an hour later, fails on its own clock.
    r.state.now = HOUR / 2
    r.state.orca = { homes: [a, b, c], answered: true }
    await r.setup.pass()
    expect(r.counted).toEqual([['failed', 'enable'], ['failed', 'enable']])

    fake.fail.length = 0
    r.state.now = HOUR - 1
    await r.setup.pass()
    expect(fake.writes(real(a))).toEqual([ENABLE])
    r.state.now = HOUR
    await r.setup.pass()
    expect(fake.writes(real(a))).toEqual([ENABLE, ENABLE])
    expect(fake.writes(real(c))).toEqual([ENABLE])
    r.state.now = HOUR + HOUR / 2
    await r.setup.pass()
    expect(fake.writes(real(c))).toEqual([ENABLE, ENABLE])
    expect(r.state.pluginHomes).toEqual([real(b), real(a), real(c)])
  })

  // `disable` found the home still off and left it, then this pass turned it on.
  it('a disable that lands during an Orca home\'s enable turns that home off again', async () => {
    const [a, b] = [folder(), folder()]
    const state = { wanted: true }
    const fake = fakeHomes({ on: (_home, call) => { if (call === ENABLE) state.wanted = false } })
    const r = orcaRig([a, b], fake, { wanted: () => state.wanted })
    await r.setup.pass()
    expect(fake.writes(real(a))).toEqual([ENABLE, DISABLE])
    expect(fake.writes(real(b))).toEqual([])
    expect(r.state.pluginHomes).toEqual([])
    expect(r.counted).toEqual([])
  })

  it('a turn-off after a disable landed that fails is counted with its step', async () => {
    const a = folder()
    const state = { wanted: true }
    const fake = fakeHomes({ fail: [`${real(a)} ${DISABLE}`], on: (_home, call) => { if (call === ENABLE) state.wanted = false } })
    const r = orcaRig([a], fake, { wanted: () => state.wanted })
    await r.setup.pass()
    expect(r.counted).toEqual([['failed', 'disable']])
    expect(r.state.pluginHomes).toEqual([])
  })

  it('a dial-skill.json that cannot be read after an Orca home\'s enable: nothing undone or recorded, and recorded at the next pass', async () => {
    const a = folder()
    const state = { wanted: true as boolean | undefined, enables: 0 }
    const fake = fakeHomes({ on: (_home, call) => { if (call === ENABLE && state.enables++ === 0) state.wanted = undefined } })
    const r = orcaRig([a], fake, { wanted: () => state.wanted })
    await r.setup.pass()
    expect(fake.writes(real(a))).toEqual([ENABLE])
    expect(r.state.pluginHomes).toEqual([])
    expect(r.counted).toEqual([])

    state.wanted = true
    await r.setup.pass()
    expect(fake.writes(real(a))).toEqual([ENABLE])
    expect(r.state.pluginHomes).toEqual([real(a)])
  })

  it('no claude for an Orca home ends the step and counts nothing, and the next pass tries it', async () => {
    const [a, b] = [folder(), folder()]
    const fake = fakeHomes()
    const looked: string[] = []
    let found = false
    const r = orcaRig([a, b], fake, { claudeIn: async (home) => {
      looked.push(home)
      return found ? fake.runIn(home) : null
    } })
    await r.setup.pass()
    // One lookup: the next home's would find none either.
    expect(looked).toEqual([real(a)])
    expect(r.counted).toEqual([])
    found = true
    r.state.now = 1
    await r.setup.pass()
    expect(r.state.pluginHomes).toEqual([real(a), real(b)])
  })

  it('an Orca home\'s lookup reads the login shell\'s PATH as the default home\'s does, once a pass', async () => {
    const shells: string[] = []
    const r = orcaRig([folder()], fakeHomes(), {
      claude: async (shell) => { shells.push(`default ${shell}`); return null },
      claudeIn: async (_home, shell) => { shells.push(`orca ${shell}`); return null },
    })
    // A CLI update, so the default home's lookup runs too.
    r.state.recorded = '0.6.58'
    await r.setup.pass()
    r.state.now = 60_000
    await r.setup.pass()
    r.state.now = 120_000
    await r.setup.pass(true)
    expect(shells).toEqual(['default true', 'orca true', 'default false', 'orca false', 'default true', 'orca true'])
  })

  it('the default home\'s update still runs with Orca homes due, and after one failed', async () => {
    const [a, b] = [folder(), folder()]
    const order: string[] = []
    const fake = fakeHomes({ fail: [`${real(a)} ${ENABLE}`], on: (home, call) => { order.push(`${home} ${call}`) } })
    const r = orcaRig([a, b], fake)
    const claude = fakeClaude({ installed: entry('16a92abfab3f'), on: (call) => { order.push(`default ${call}`) } })
    r.state.found = claude
    r.state.recorded = '0.6.58'
    expect(await r.setup.pass()).toBe(true)
    expect(r.state.recorded).toBe('0.6.59')
    // The default home first: an Orca home's plugin is its files.
    expect(order.indexOf(`default ${UPDATE}`)).toBeLessThan(order.indexOf(`${real(a)} --version`))
    expect(r.counted).toEqual([['updated'], ['failed', 'enable']])
    expect(r.state.pluginHomes).toEqual([real(b)])

    // The next CLI update, within a's hour: the default home keeps its own clock.
    r.state.recorded = '0.6.58'
    r.state.now = 1
    await r.setup.pass()
    expect(claude.writes()).toEqual([PULL, UPDATE, PULL, UPDATE])
  })

  it('a scan with every Orca home recorded reads no file', async () => {
    // wanted() and the command's list as the devices compose them: dial-skill.json, read anew at each call.
    const dataDir = folder()
    const [a, b] = [folder(), folder()]
    const r = orcaRig([a, b], fakeHomes(), { wanted: () => readRemoved(dataDir).claude !== true, enabledByCommand: () => readPluginHomes(dataDir) })
    await r.setup.pass()
    expect(r.state.pluginHomes).toEqual([real(a), real(b)])
    const calls = fileCalls()

    await r.setup.pass()
    r.state.now = HOUR
    await r.setup.pass()
    expect(calls).toEqual([])
  })

  it('a record that cannot be saved counts failed save, and a pass after its hour records the home with no enable', async () => {
    const a = folder()
    const r = orcaRig([a])
    r.state.homesSave = false
    await r.setup.pass()
    expect(r.counted).toEqual([['failed', 'save']])
    expect(r.state.pluginHomes).toEqual([])

    r.state.homesSave = true
    r.state.now = HOUR - 1
    await r.setup.pass()
    expect(r.state.pluginHomes).toEqual([])
    r.state.now = HOUR
    await r.setup.pass()
    expect(r.fake.writes(real(a))).toEqual([ENABLE])
    expect(r.state.pluginHomes).toEqual([real(a)])
  })

  // Turned on and not recorded, a home the person turns off would be turned on again.
  it('a full record turns on no home, and counts failed full', async () => {
    const root = folder()
    const listed = Array.from({ length: MAX_HOMES + 1 }, (_, i) => {
      const home = join(root, `home-${i}`)
      mkdirSync(home)
      return home
    })
    const r = orcaRig(listed)
    r.state.pluginHomes = listed.slice(0, MAX_HOMES).map(real)
    await r.setup.pass()
    expect(r.looked).toEqual([])
    expect(r.counted).toEqual([['failed', 'full']])
    expect(r.state.pluginHomes).toHaveLength(MAX_HOMES)
  })
})
