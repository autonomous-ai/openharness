import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { DEVICES_HARNESS_ID, HACHI_BUILTIN_SOURCE, HACHI_ID, MEMORIES_BUILTIN_SOURCE, MEMORIES_ID, MODEL_MANAGER_BUILTIN_SOURCE, MODEL_MANAGER_ID } from '../dsh/builtinIds.js'
import type { InstalledDshRecord } from '../dsh/installed.js'
import { setAgentSettingsForTest } from '../testing/agentSettings.js'
import { bundledPending, createViewersWake, VIEWER_LEDGER, VIEWERS_ON_DEMAND, wakeViewers, type BundledState } from './viewersWake.js'

const record = (over: Partial<InstalledDshRecord>): InstalledDshRecord =>
  ({ id: MODEL_MANAGER_ID, dir: '/dsh/x', source: MODEL_MANAGER_BUILTIN_SOURCE, ref: null, commit: null, revision: 'r1', linked: false, installedAt: 1, ...over }) as InstalledDshRecord

const state = (index: InstalledDshRecord[], over: Partial<BundledState> = {}): Partial<BundledState> =>
  ({ revisions: { models: 'r1' }, index: () => index, broken: () => false, ...over })

describe('the release\'s own harnesses, as the core checks them for the Store', () => {
  it('has nothing to put in place in a build from the sources, which bundles none', () => {
    expect(bundledPending(state([], { revisions: {} }))).toBeNull()
    // The real index and this build's revisions: a test's own throwaway folder, and none.
    expect(bundledPending()).toBeNull()
  })

  it('asks for one missing, from another release or broken', () => {
    expect(bundledPending(state([]))).toBe('Model Manager to put in place')
    expect(bundledPending(state([record({ revision: 'r0' })]))).toBe('Model Manager to bring to this release')
    expect(bundledPending(state([record({ revision: undefined })]))).toBe('Model Manager to bring to this release')
    expect(bundledPending(state([record({})], { broken: () => true }))).toBe('Model Manager to repair')
    // Read as the installed index reads a record: a package whose folder is gone is broken.
    expect(bundledPending({ revisions: { models: 'r1' }, index: () => [record({ dir: join(tmpdir(), 'no-such-harness') })] })).toBe('Model Manager to repair')
  })

  it('has nothing to do when the index has this build\'s of each', () => {
    const revisions = { models: 'r1', memories: 'm1' }
    expect(bundledPending(state([record({}), record({ id: MEMORIES_ID, source: MEMORIES_BUILTIN_SOURCE, revision: 'm1' })], { revisions }))).toBeNull()
    expect(bundledPending(state([record({})], { revisions }))).toBe('Memories to put in place')
  })

  it('counts Hachi only while its switch is on: off, no package of it is generated', () => {
    const revisions = { hachi: 'h1' }
    expect(bundledPending(state([], { revisions }))).toBeNull()
    expect(bundledPending(state([], { revisions, hachi: true }))).toBe('Hachi to put in place')
    expect(bundledPending(state([record({ id: HACHI_ID, source: HACHI_BUILTIN_SOURCE, revision: 'h1' })], { revisions, hachi: true }))).toBeNull()
  })

  it('leaves a developer\'s linked checkout and a package of another source to the Store, which never replaces them', () => {
    const broken = vi.fn(() => true)
    expect(bundledPending(state([record({ linked: true, revision: 'r0' })], { broken }))).toBeNull()
    expect(bundledPending(state([record({ source: 'https://example.com/fork', revision: 'r0' })], { broken }))).toBeNull()
    expect(broken).not.toHaveBeenCalled()
    // Another harness's record is not this one's.
    expect(bundledPending(state([record({ id: DEVICES_HARNESS_ID })]))).toBe('Model Manager to put in place')
  })
})

describe('when the viewers\' process is asked for', () => {
  const setup = (outOfProcess: string[] = ['viewers', 'store']) => {
    const want = vi.fn()
    const log = vi.fn()
    const wake = createViewersWake({ want, outOfProcess: new Set(outOfProcess), log })
    return { want, log, wake }
  }

  it('asks once for each service, saying why, however often a harness is attached', () => {
    const { want, log, wake } = setup()
    wake.ask('viewers', 'a harness here')
    wake.ask('viewers', 'a harness here')
    wake.ask('store', 'Memories to put in place')
    expect(want.mock.calls).toEqual([['viewers'], ['store']])
    expect(log.mock.calls).toEqual([["[viewers] a harness here: asking for the viewers' process"], ["[viewers] Memories to put in place: asking for the viewers' process"]])
  })

  it('asks nothing for a service in the core\'s process, or one that has connected', () => {
    const inCore = setup([])
    inCore.wake.ask('viewers', 'a harness here')
    expect(inCore.want).not.toHaveBeenCalled()
    const connected = setup()
    connected.wake.connected('search')
    connected.wake.connected('viewers')
    connected.wake.ask('viewers', 'a harness here')
    connected.wake.ask('store', 'Memories to put in place')
    expect(connected.want.mock.calls).toEqual([['store']])
    expect(VIEWERS_ON_DEMAND).toEqual(['viewers', 'store'])
  })

  it('logs to the console unless told otherwise', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const want = vi.fn()
      createViewersWake({ want, outOfProcess: new Set(['viewers']) }).ask('viewers', 'a harness here')
      expect(log).toHaveBeenCalledWith("[viewers] a harness here: asking for the viewers' process")
    } finally { log.mockRestore() }
  })
})

describe('the viewers\' process as the core starts', () => {
  const data = () => mkdtempSync(join(tmpdir(), 'viewers-wake-'))
  const nothing = state([], { revisions: {} })

  it('is asked for when an agent the registry kept has a harness', () => {
    const ask = vi.fn()
    wakeViewers({ wake: { ask }, agents: () => [{ dsh: undefined }, { dsh: 'acme/blender' }], dataDir: data(), bundled: nothing })
    expect(ask.mock.calls).toEqual([['viewers', 'a harness here']])
  })

  it('is asked for when an earlier process left viewer servers in its ledger, to stop them', () => {
    const dir = data()
    writeFileSync(join(dir, VIEWER_LEDGER), JSON.stringify([{ pid: 4242, startedAt: 1, agentId: 'a1', dshId: 'acme/blender', viewerDir: '/x' }]))
    const ask = vi.fn()
    wakeViewers({ wake: { ask }, agents: () => [], dataDir: dir, bundled: nothing })
    expect(ask.mock.calls).toEqual([['viewers', 'viewer servers an earlier process left running']])
    // An empty ledger, as a clean stop and the reaping leave it, asks nothing.
    writeFileSync(join(dir, VIEWER_LEDGER), '[]')
    ask.mockClear()
    wakeViewers({ wake: { ask }, agents: () => [], dataDir: dir, bundled: nothing })
    expect(ask).not.toHaveBeenCalled()
  })

  it('asks for the Store when the release\'s harnesses are not in place, and for nothing on an idle computer', () => {
    const ask = vi.fn()
    wakeViewers({ wake: { ask }, agents: () => [], dataDir: data(), bundled: state([]) })
    expect(ask.mock.calls).toEqual([['store', 'Model Manager to put in place']])
    ask.mockClear()
    // Hachi, as this computer keeps the account's switch: nothing while it is off, the Store once it is on.
    const dir = data()
    const hachi = state([], { revisions: { hachi: 'h1' } })
    wakeViewers({ wake: { ask }, agents: () => [], dataDir: dir, bundled: hachi })
    expect(ask).not.toHaveBeenCalled()
    setAgentSettingsForTest(dir, { hachi: true })
    wakeViewers({ wake: { ask }, agents: () => [], dataDir: dir, bundled: hachi })
    expect(ask.mock.calls).toEqual([['store', 'Hachi to put in place']])
    ask.mockClear()
    // The real index and this build's revisions, a throwaway folder and none: nothing.
    wakeViewers({ wake: { ask }, agents: () => [{ dsh: null }], dataDir: data() })
    expect(ask).not.toHaveBeenCalled()
  })
})
