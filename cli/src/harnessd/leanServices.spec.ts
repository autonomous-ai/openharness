import { describe, expect, it } from 'vitest'
import { LEAN_EARLY_DEATHS, leanServices, type LeanServicesDeps } from './leanServices.js'
import type { CoreHandle } from './supervisor.js'

const CLI = '/cli/cli.js'
const LEAN = '/data/lean/aaaa/harnessd.mjs'

function fakeProcess() {
  const messages: Array<(message: unknown) => void> = []
  const exits: Array<(code: number | null, signal: NodeJS.Signals | null) => void> = []
  const handle = {
    pid: 1, send: () => {}, kill: () => {},
    onMessage: (listener: (message: unknown) => void) => { messages.push(listener) },
    onExit: (listener: (code: number | null, signal: NodeJS.Signals | null) => void) => { exits.push(listener) },
  } as unknown as CoreHandle
  return {
    handle,
    beat: () => { for (const listener of messages) listener({ type: 'harnessd:heartbeat', rssBytes: 1, heapUsedBytes: 1 }) },
    say: (message: unknown) => { for (const listener of messages) listener(message) },
    exit: (code: number | null, signal: NodeJS.Signals | null = null) => { for (const listener of exits) listener(code, signal) },
  }
}

function make(over: Partial<LeanServicesDeps> = {}) {
  const logs: string[] = []
  const world = { fingerprint: 'f' as string | null, same: true, exists: true }
  const lean = leanServices({
    scriptPath: CLI, leanPath: LEAN, leanFingerprint: 'f',
    folderFingerprint: (folder) => { expect(folder).toBe('/data/lean/aaaa'); return world.fingerprint },
    exists: () => world.exists,
    sameBundle: () => world.same,
    log: (line) => logs.push(line),
    ...over,
  })
  return { lean, logs, world }
}

describe('the file a service starts from', () => {
  it('is the lean bundle while its files are the ones the master started with, and cli.js is the bundle they came from', () => {
    const { lean, logs } = make()
    expect(lean.scriptFor('search')).toBe(LEAN)
    expect(logs).toEqual([])
  })

  it('is cli.js when there is no lean bundle, or it is cli.js itself (from the sources)', () => {
    expect(make({ leanPath: undefined }).lean.scriptFor('search')).toBe(CLI)
    expect(make({ leanPath: CLI }).lean.scriptFor('search')).toBe(CLI)
  })

  it('is cli.js once the lean bundle is gone or changed, saying why once, and the lean bundle again once it is back', () => {
    // A folder gone from under a master that lives for weeks failed every restart with MODULE_NOT_FOUND.
    const { lean, logs, world } = make()
    world.fingerprint = null
    expect(lean.scriptFor('search')).toBe(CLI)
    expect(lean.scriptFor('viewers')).toBe(CLI)
    world.fingerprint = 'changed'
    expect(lean.scriptFor('search')).toBe(CLI)
    expect(logs).toEqual([
      `[harnessd] the lean bundle ${LEAN} cannot be used (it is gone): services start from ${CLI}`,
      `[harnessd] the lean bundle ${LEAN} cannot be used (its files changed): services start from ${CLI}`,
    ])
    world.fingerprint = 'f'
    expect(lean.scriptFor('search')).toBe(LEAN)
    world.fingerprint = null
    expect(lean.scriptFor('search')).toBe(CLI)
    expect(logs).toHaveLength(3)
  })

  it('is cli.js once cli.js is another bundle than the one the lean bundle came from', () => {
    // An update this master did not re-execute on (no `process.execve`, or a re-execution kept back): the
    // services must not run the old lean code against the new core.
    const { lean, logs, world } = make()
    world.same = false
    expect(lean.scriptFor('search')).toBe(CLI)
    expect(logs).toEqual([`[harnessd] the lean bundle ${LEAN} cannot be used (${CLI} is no longer the bundle it came from): services start from ${CLI}`])
  })

  it('checks only that the entry is there when it has no fingerprint to check against', () => {
    const { lean, world } = make({ leanFingerprint: undefined })
    expect(lean.scriptFor('search')).toBe(LEAN)
    world.exists = false
    expect(lean.scriptFor('search')).toBe(CLI)
  })

  it('is cli.js for a service that died twice running from the lean bundle before it ever beat', () => {
    const { lean, logs } = make()
    for (let death = 1; death <= LEAN_EARLY_DEATHS; death++) {
      expect(lean.scriptFor('search')).toBe(LEAN)
      const child = fakeProcess()
      lean.started('search', LEAN, child.handle)
      child.say({ type: 'not a beat' })
      child.exit(1)
    }
    expect(logs).toEqual([`[harnessd] service search died ${LEAN_EARLY_DEATHS} times from the lean bundle before it beat: it starts from ${CLI} from now on`])
    expect(lean.scriptFor('search')).toBe(CLI)
    // Only that service: the others still start from the lean bundle.
    expect(lean.scriptFor('viewers')).toBe(LEAN)
  })

  it('counts only deaths in a row before a beat, and never the master\'s own stop', () => {
    const { lean } = make()
    const early = fakeProcess()
    lean.started('search', LEAN, early.handle)
    early.exit(1)
    // A process that beat, then crashed: not the bundle's fault, and the count starts again.
    const beat = fakeProcess()
    lean.started('search', LEAN, beat.handle)
    beat.beat()
    beat.beat()
    beat.exit(1)
    const stopped = fakeProcess()
    lean.started('search', LEAN, stopped.handle)
    stopped.exit(null, 'SIGTERM')
    const again = fakeProcess()
    lean.started('search', LEAN, again.handle)
    again.exit(null, 'SIGKILL')
    expect(lean.scriptFor('search')).toBe(LEAN)
    // One started from cli.js is not watched.
    const fromCli = fakeProcess()
    lean.started('search', CLI, fromCli.handle)
    fromCli.exit(1)
    expect(lean.scriptFor('search')).toBe(LEAN)
  })
})
