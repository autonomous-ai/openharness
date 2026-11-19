/**
 * Harness Device's plugin for Orca set up from the devices' process, in memory: Orca's set-up and removal answer from a
 * queue, and the records the pass reads and writes are in memory too. orcaPluginParts runs the real orcaSetUp and
 * orcaRemove against an in-memory `run` in a throwaway data folder. The real `orca` is never run: every session here
 * runs inside it.
 */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { type DialRemoved, type Read, type SetupCount, writeSetup } from '../devices/dialSkillFiles.js'
import type { OrcaPluginDeps, OrcaPluginFiles, OrcaRemove, OrcaSetUp } from '../devices/orcaPlugin.js'
import { createOrcaPluginSetup, orcaPluginParts } from './orcaPluginSetup.js'

const HOUR = 3_600_000
const VERSION = '9.9.9'
const SET_UP: OrcaSetUp = { orca: 'on', did: 'set up' }

/** Lets a timer's pass finish. */
const settled = () => new Promise((resolve) => setImmediate(resolve))

type Recorded = { dial: boolean; version?: string; held?: string }

/**
 * A computer that had a dial attached here ([dial]), the plugin recorded at [version] or held at [held], and a CLI that
 * carries the plugin at 9.9.9. Orca answers each set-up and removal from a queue: set up, and off, when it is empty.
 */
function rig({ platform = 'darwin', dial = true, version, held }: {
  platform?: NodeJS.Platform; dial?: boolean; version?: string; held?: string
} = {}) {
  const state = {
    build: VERSION as string | null,
    removed: {} as Read<DialRemoved>,
    connected: { connected: false } as Read<{ connected: boolean }>,
    record: { dial, version, held } as Recorded | undefined,
    saves: true,
    setUps: [] as OrcaSetUp[],
    removes: [] as OrcaRemove[],
    /** What happens while Orca sets the plugin up, before it answers. */
    during: undefined as (() => void) | undefined,
    /** Held until the test lets Orca answer. */
    hold: undefined as Promise<void> | undefined,
    /** What a read of dial-setup.json throws. */
    fault: undefined as Error | undefined,
  }
  const counted: Array<[SetupCount] | [SetupCount, string]> = []
  const timers: Array<{ ms: number; run: () => void }> = []
  const setUp = vi.fn(async (): Promise<OrcaSetUp> => {
    state.during?.()
    await state.hold
    return state.setUps.shift() ?? SET_UP
  })
  const remove = vi.fn(async (): Promise<OrcaRemove> => state.removes.shift() ?? { orca: 'off' })
  const save = (field: 'version' | 'held', version: string): boolean => {
    if (state.saves && state.record) state.record = { ...state.record, [field]: version }
    return state.saves
  }
  const setup = createOrcaPluginSetup({
    platform,
    version: () => state.build,
    setUp,
    remove,
    removed: () => state.removed,
    connected: () => state.connected,
    recorded: () => {
      if (state.fault) throw state.fault
      return state.record
    },
    record: (version) => save('version', version),
    recordHeld: (version) => save('held', version),
    after: (ms, run) => { timers.push({ ms, run }) },
    count: (kind, reason) => { counted.push(reason === undefined ? [kind] : [kind, reason]) },
  })
  return { state, counted, timers, setUp, remove, setup }
}

describe('Harness Device\'s plugin for Orca, set up from the devices\' process', () => {
  it('a dial attached here: set up once, recorded at this version and counted set up', async () => {
    const r = rig()
    await r.setup.pass()
    expect(r.setUp).toHaveBeenCalledTimes(1)
    expect(r.state.record).toEqual({ dial: true, version: VERSION })
    expect(r.counted).toEqual([['set up']])

    // The passes after, at a start, an attach or Orca's settle, find it recorded and ask Orca nothing.
    await r.setup.pass()
    await r.setup.pass()
    expect(r.setUp).toHaveBeenCalledTimes(1)
    expect(r.counted).toEqual([['set up']])
    expect(r.timers).toEqual([])
  })

  it('no dial yet: nothing runs, nothing is recorded; set up before by orcaConnected, it is brought current', async () => {
    const r = rig({ dial: false })
    await r.setup.pass()
    expect(r.setUp).not.toHaveBeenCalled()
    expect(r.state.record).toEqual({ dial: false })
    expect(r.counted).toEqual([])

    // 0.1.9's click, or an `enable`.
    r.state.connected = { connected: true }
    r.state.setUps.push({ orca: 'on', did: 'updated' })
    await r.setup.pass()
    expect(r.setUp).toHaveBeenCalledTimes(1)
    expect(r.state.record).toEqual({ dial: false, version: VERSION })
    expect(r.counted).toEqual([['updated']])
  })

  it.each([
    ['recorded', { version: VERSION }],
    ['held', { held: VERSION }],
  ])('%s at this version: no Orca run', async (_, given) => {
    const r = rig(given)
    await r.setup.pass()
    expect(r.setUp).not.toHaveBeenCalled()
    expect(r.remove).not.toHaveBeenCalled()
    expect(r.counted).toEqual([])
    expect(r.timers).toEqual([])
  })

  it('recorded at another version: brought current and counted updated, a dial here or not', async () => {
    const r = rig({ dial: false, version: '9.9.8' })
    r.state.setUps.push({ orca: 'on', did: 'updated' })
    await r.setup.pass()
    expect(r.setUp).toHaveBeenCalledTimes(1)
    expect(r.state.record).toEqual({ dial: false, version: VERSION })
    expect(r.counted).toEqual([['updated']])
  })

  it('found current: recorded, with nothing counted', async () => {
    const r = rig()
    r.state.setUps.push({ orca: 'on' })
    await r.setup.pass()
    expect(r.state.record).toEqual({ dial: true, version: VERSION })
    expect(r.counted).toEqual([])
  })

  it('removed by harness device orca disable: nothing runs, at this version or another', async () => {
    for (const version of [undefined, '9.9.8', VERSION]) {
      const r = rig({ version })
      r.state.removed = { orca: true }
      await r.setup.pass()
      expect(r.setUp, version).not.toHaveBeenCalled()
      expect(r.remove, version).not.toHaveBeenCalled()
      expect(r.state.record, version).toEqual({ dial: true, version })
      expect(r.counted, version).toEqual([])
    }
  })

  it('uninstalled or disabled in Orca (off): recorded, left removed counted once a version', async () => {
    const r = rig({ version: '9.9.8' })
    r.state.setUps.push({ orca: 'off' })
    await r.setup.pass()
    await r.setup.pass()
    expect(r.setUp).toHaveBeenCalledTimes(1)
    expect(r.state.record).toEqual({ dial: true, version: VERSION })
    expect(r.counted).toEqual([['left removed']])

    // A CLI update, then its start and an attach.
    r.state.build = '9.9.10'
    r.state.setUps.push({ orca: 'off' })
    await r.setup.pass()
    await r.setup.pass()
    expect(r.setUp).toHaveBeenCalledTimes(2)
    expect(r.remove).not.toHaveBeenCalled()
    expect(r.state.record).toEqual({ dial: true, version: '9.9.10' })
    expect(r.counted).toEqual([['left removed'], ['left removed']])
  })

  it('a disable that lands during the install: removed again, nothing recorded', async () => {
    const r = rig()
    r.state.during = () => { r.state.removed = { orca: true } }
    await r.setup.pass()
    expect(r.setUp).toHaveBeenCalledTimes(1)
    expect(r.remove).toHaveBeenCalledTimes(1)
    expect(r.state.record).toEqual({ dial: true })
    expect(r.counted).toEqual([])

    await r.setup.pass()
    expect(r.setUp).toHaveBeenCalledTimes(1)
    expect(r.remove).toHaveBeenCalledTimes(1)
  })

  it('the removal it owes is tried again after its hour when it fails', async () => {
    const r = rig()
    r.state.during = () => { r.state.removed = { orca: true } }
    r.state.removes.push({ orca: 'off', error: 'timeout' })
    await r.setup.pass()
    expect(r.remove).toHaveBeenCalledTimes(1)
    expect(r.counted).toEqual([['failed', 'timeout']])
    expect(r.timers.map(({ ms }) => ms)).toEqual([HOUR])

    // A start or an attach within the hour runs nothing.
    await r.setup.pass()
    expect(r.remove).toHaveBeenCalledTimes(1)

    r.timers[0].run()
    await settled()
    expect(r.remove).toHaveBeenCalledTimes(2)
    expect(r.state.record).toEqual({ dial: true })

    // Owed no more: the passes after leave it removed.
    await r.setup.pass()
    expect(r.setUp).toHaveBeenCalledTimes(1)
    expect(r.remove).toHaveBeenCalledTimes(2)
    expect(r.counted).toEqual([['failed', 'timeout']])
  })

  it('a removal that cannot be read after the install: nothing undone, nothing recorded; the next pass records it', async () => {
    const r = rig()
    r.state.during = () => { r.state.removed = { unread: true } }
    await r.setup.pass()
    expect(r.remove).not.toHaveBeenCalled()
    expect(r.state.record).toEqual({ dial: true })
    expect(r.counted).toEqual([])

    r.state.during = undefined
    r.state.removed = {}
    r.state.setUps.push({ orca: 'on' })
    await r.setup.pass()
    expect(r.state.record).toEqual({ dial: true, version: VERSION })
  })

  it('held is recorded once, as orcaHeld, never as the version, and counted failed · access', async () => {
    const r = rig()
    r.state.setUps.push({ orca: 'held' })
    await r.setup.pass()
    await r.setup.pass()
    expect(r.setUp).toHaveBeenCalledTimes(1)
    expect(r.state.record).toEqual({ dial: true, held: VERSION })
    expect(r.counted).toEqual([['failed', 'access']])
    expect(r.timers).toEqual([])

    // A later CLI whose pinned access covers it sets it up.
    r.state.build = '9.9.10'
    await r.setup.pass()
    expect(r.setUp).toHaveBeenCalledTimes(2)
    expect(r.state.record).toEqual({ dial: true, held: VERSION, version: '9.9.10' })
    expect(r.counted).toEqual([['failed', 'access'], ['set up']])
  })

  it('held alone is not set up before: with no dial, nothing runs', async () => {
    const r = rig({ dial: false, held: '9.9.8' })
    await r.setup.pass()
    expect(r.setUp).not.toHaveBeenCalled()
  })

  it('Orca not running: nothing recorded or counted, and the next pass runs', async () => {
    const r = rig()
    r.state.setUps.push({ orca: 'absent', error: 'not-running' })
    await r.setup.pass()
    expect(r.state.record).toEqual({ dial: true })
    expect(r.counted).toEqual([])
    expect(r.timers).toEqual([])

    // Orca settles in front.
    await r.setup.pass()
    expect(r.setUp).toHaveBeenCalledTimes(2)
    expect(r.counted).toEqual([['set up']])
  })

  it.each(['old', 'other'] as const)('Orca too old, or a plugin Orca keeps as it is (%s): an hour, nothing counted', async (error) => {
    const r = rig()
    r.state.setUps.push({ orca: 'absent', error })
    await r.setup.pass()
    expect(r.state.record).toEqual({ dial: true })
    expect(r.counted).toEqual([])
    expect(r.timers.map(({ ms }) => ms)).toEqual([HOUR])

    // Each settle within the hour asks Orca nothing.
    await r.setup.pass()
    expect(r.setUp).toHaveBeenCalledTimes(1)

    r.timers[0].run()
    await settled()
    expect(r.setUp).toHaveBeenCalledTimes(2)
    expect(r.counted).toEqual([['set up']])
  })

  it.each(['timeout', 'failed', 'folder'] as const)('the failed hour (%s): counted with its reason; a pass within it runs nothing; the hour runs one', async (error) => {
    const r = rig()
    r.state.setUps.push({ orca: 'failed', error })
    await r.setup.pass()
    expect(r.counted).toEqual([['failed', error]])
    expect(r.state.record).toEqual({ dial: true })
    expect(r.timers.map(({ ms }) => ms)).toEqual([HOUR])

    // An attach or a settle within the hour runs nothing.
    await r.setup.pass()
    expect(r.setUp).toHaveBeenCalledTimes(1)

    r.timers[0].run()
    await settled()
    expect(r.setUp).toHaveBeenCalledTimes(2)
    expect(r.state.record).toEqual({ dial: true, version: VERSION })
    expect(r.counted).toEqual([['failed', error], ['set up']])
    expect(r.timers).toHaveLength(1)
  })

  it.each<[string, OrcaSetUp]>([
    ['on', SET_UP],
    ['off', { orca: 'off' }],
    ['held', { orca: 'held' }],
  ])('a record not saved (%s): failed · save, and an hour', async (_, result) => {
    const r = rig()
    r.state.saves = false
    r.state.setUps.push(result)
    await r.setup.pass()
    expect(r.counted).toEqual([['failed', 'save']])
    expect(r.state.record).toEqual({ dial: true })
    expect(r.timers.map(({ ms }) => ms)).toEqual([HOUR])

    r.state.saves = true
    r.timers[0].run()
    await settled()
    expect(r.setUp).toHaveBeenCalledTimes(2)
    expect(r.state.record).toEqual({ dial: true, version: VERSION })
  })

  it.each<[string, (r: ReturnType<typeof rig>, error: Error) => void]>([
    ['a record read', (r, error) => { r.state.fault = error }],
    ['the set-up', (r, error) => { r.setUp.mockRejectedValueOnce(error) }],
  ])('a throw in %s: failed · error, never its words, and an hour', async (_, given) => {
    const r = rig()
    given(r, new Error('EACCES /SECRET-MARKER'))
    await r.setup.pass()
    expect(r.counted).toEqual([['failed', 'error']])
    expect(JSON.stringify(r.counted)).not.toContain('SECRET')
    expect(r.timers.map(({ ms }) => ms)).toEqual([HOUR])
  })

  it.each<[string, (r: ReturnType<typeof rig>) => void]>([
    ['unread removals', (r) => { r.state.removed = { unread: true } }],
    ['an unread orcaConnected', (r) => { r.state.connected = { connected: false, unread: true } }],
    ['a record not yet read', (r) => { r.state.record = undefined }],
  ])('%s: nothing', async (_, given) => {
    const r = rig({ version: '9.9.8' })
    given(r)
    await r.setup.pass()
    expect(r.setUp).not.toHaveBeenCalled()
    expect(r.remove).not.toHaveBeenCalled()
    expect(r.counted).toEqual([])
    expect(r.timers).toEqual([])
  })

  it.each([
    ['Windows', 'win32' as const, VERSION],
    ['a run from the sources', 'darwin' as const, null],
  ])('%s: nothing', async (_, platform, build) => {
    const r = rig({ version: '9.9.8', platform })
    r.state.build = build
    await r.setup.pass()
    expect(r.setUp).not.toHaveBeenCalled()
    expect(r.state.record).toEqual({ dial: true, version: '9.9.8' })
    expect(r.counted).toEqual([])
  })

  it('one pass at a time: one asked while another sets up runs nothing', async () => {
    const r = rig()
    let answer!: () => void
    r.state.hold = new Promise((resolve) => { answer = resolve })
    const first = r.setup.pass()
    await r.setup.pass()
    answer()
    await first
    expect(r.setUp).toHaveBeenCalledTimes(1)
    expect(r.counted).toEqual([['set up']])
  })
})

describe('orcaPluginParts', () => {
  const KEY = 'local.harness-device'
  const FILES: OrcaPluginFiles = {
    'orca-plugin.json': JSON.stringify({ manifestVersion: 2, id: 'harness-device', name: 'Harness Device', version: '1.2.3', engines: { orca: '>=1.4.248' }, main: 'src/worker.ts' }),
    'src/worker.ts': 'export const worker = true\n',
  }
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })

  /** The plugin's deps on an Orca at 1.4.262 that answers from memory and lists [listed]; its calls by their words. */
  function plugin(listed: unknown[], over: Partial<OrcaPluginDeps> = {}) {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'orca-plugin-setup-')))
    roots.push(root)
    const calls: string[] = []
    const answers: Record<string, unknown> = {
      status: { runtime: { reachable: true, appVersion: '1.4.262' } },
      'plugin inspect': { plugin: { pluginKey: KEY } },
      'plugin list': { plugins: listed },
      'plugin uninstall': {},
    }
    const deps: OrcaPluginDeps = {
      platform: 'darwin',
      orca: () => '/nowhere/orca',
      run: async (_file, args) => {
        calls.push(args.join(' '))
        const result = answers[args[0] === 'plugin' ? `plugin ${args[1]}` : args[0]]
        return { code: 0, stdout: JSON.stringify(result === undefined ? {} : { ok: true, result }), timedOut: false }
      },
      files: () => FILES,
      dataDir: root,
      folder: join(root, 'orca-plugin'),
      err: () => {},
      ...over,
    }
    return { deps, calls }
  }

  it('the carried version, null from the sources', () => {
    const { deps } = plugin([])
    expect(orcaPluginParts(deps).version()).toBe('1.2.3')
    expect(orcaPluginParts(deps).platform).toBe('darwin')
    expect(orcaPluginParts({ ...deps, files: () => null }).version()).toBeNull()
  })

  it('sets up without force: a plugin set up before and gone from Orca stays removed', async () => {
    const { deps, calls } = plugin([])
    writeSetup(deps.dataDir, { dial: true, orca: '1.2.2', homes: { claude: [], codex: [] }, pluginHomes: [] })
    expect(await orcaPluginParts(deps).setUp()).toEqual({ orca: 'off' })
    expect(calls.filter((call) => call.startsWith('plugin install'))).toEqual([])
  })

  it('removes the plugin by its key', async () => {
    const { deps, calls } = plugin([{ pluginKey: KEY, version: '1.2.3', status: 'running' }])
    expect(await orcaPluginParts(deps).remove()).toEqual({ orca: 'off' })
    expect(calls.at(-1)).toBe(`plugin uninstall ${KEY} --json`)
  })
})
