/**
 * The plugin's pass against a fake `claude`: a ClaudeRun whose `plugin list` follows its own installs, uninstalls and
 * updates. The real `claude` and ~/.claude are never touched.
 */
import { describe, expect, it } from 'vitest'
import type { ClaudeRun } from '../devices/claudePlugin.js'
import type { SetupCount } from '../devices/dialSkillFiles.js'
import { createDialPluginSetup, type DialPluginSetupDeps } from './dialPluginSetup.js'

const ADD = 'plugin marketplace add autonomous-ai/openharness --sparse .claude-plugin plugins'
const INSTALL = 'plugin install harness-device@openharness --scope user'
const UNINSTALL = 'plugin uninstall harness-device@openharness --scope user'
const PULL = 'plugin marketplace update openharness'
const UPDATE = 'plugin update harness-device@openharness --scope user'
const HOUR = 3_600_000

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

function rig(claude: ReturnType<typeof fakeClaude> | null = fakeClaude(), over: Partial<DialPluginSetupDeps> = {}) {
  const state = { wanted: true, recorded: undefined as string | undefined, saves: true, now: 0, lookups: 0, found: claude }
  const counted: Array<[SetupCount] | [SetupCount, string]> = []
  const setup = createDialPluginSetup({
    platform: 'darwin',
    version: '0.6.59',
    claude: async () => {
      state.lookups++
      return state.found?.run ?? null
    },
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
  return { setup, state, counted }
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
