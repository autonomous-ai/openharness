import { afterEach, describe, expect, it, vi } from 'vitest'
import { IdentityReadUnavailable } from '../engines/kit/identityScan.js'
import { checkSessionRuntime, EngineRenamed, lookupPaneEngineProcess, publishEngine, renamedEngine } from './paneEngineProcess.js'
import { setProcessTableSource } from './processTable.js'
import { registry, RegistryOwnershipChanged, type LaunchPublication, type ProcessIdentity, type RegisteredSession } from './registry.js'
import { REGISTRY_WRITE_DEADLINE_MS, RegistryPersistenceUnavailable } from './registryPersistence.js'
import type { TerminalBackend } from './terminalBackend.js'
import type { TmuxRuntimeRef } from './terminalTypes.js'

const runtime = { backend: 'tmux' as const, paneId: '%1' }
function backendWithRoot(root: number | 'missing' | null): TerminalBackend {
  return { rootProcess: async () => root } as unknown as TerminalBackend
}

describe('lookupPaneEngineProcess', () => {
  it('reads the table a backend holds (a guest host) rather than the machine\'s own', async () => {
    const rows = [
      { pid: 10, parentPid: 1, args: 'engine', startMarker: 'm10', executable: 'engine' },
      { pid: 20, parentPid: 10, args: 'claude', startMarker: 'w:2', executable: 'claude' },
    ]
    const backend = { rootProcess: async () => 10, processTable: () => async () => rows as never }
    expect(await lookupPaneEngineProcess(backend, runtime, 'claude')).toMatchObject({ ok: true })
  })

  it('says gone when the backend has no such pane', async () => {
    const found = await lookupPaneEngineProcess(backendWithRoot('missing'), runtime, 'claude')
    expect(found).toEqual({ ok: false, unknown: false, reason: 'tmux:%1 has no pane' })
  })

  it('says unknown when the backend could not be asked', async () => {
    const found = await lookupPaneEngineProcess(backendWithRoot(null), runtime, 'claude')
    expect(found).toMatchObject({ ok: false, unknown: true })
  })

  it('finds the engine below the pane root', async () => {
    setProcessTableSource(async () => [
      { pid: 10, parentPid: 1, executable: 'zsh', startMarker: 'm10', args: '-zsh' },
      { pid: 11, parentPid: 10, executable: 'claude', startMarker: 'm11', args: 'claude' },
    ])
    try {
      const found = await lookupPaneEngineProcess(backendWithRoot(10), runtime, 'claude')
      expect(found).toMatchObject({ ok: true, identity: { pid: 11, startMarker: 'm11' } })
    } finally { setProcessTableSource(null) }
  })
})

describe('lookupPaneEngineProcess, a pane with no engine in it', () => {
  it('names the processes in the pane, and none outside it', async () => {
    setProcessTableSource(async () => [
      { pid: 10, parentPid: 1, executable: 'zsh', startMarker: 'm10', args: '-zsh' },
      { pid: 11, parentPid: 10, executable: 'unshare', startMarker: 'm11', args: 'unshare --fork hermes-ns' },
      { pid: 30, parentPid: 1, executable: 'unshare', startMarker: 'm30', args: 'unshare' },
    ])
    try {
      const found = await lookupPaneEngineProcess(backendWithRoot(10), runtime, 'hermes')
      expect(found).toMatchObject({ ok: false, unknown: false, reason: 'no hermes process under tmux:%1' })
      expect(found.ok ? null : found.paneProcesses?.map((process) => [process.pid, process.startMarker])).toEqual([[10, 'm10'], [11, 'm11']])
    } finally { setProcessTableSource(null) }
  })
})

describe('checkSessionRuntime', () => {
  const LSTART = 'Mon Aug 10 10:00:11 2026'
  const session = (over: Partial<RegisteredSession>): RegisteredSession => ({
    sessionId: 'sess-1', engine: 'claude', runtimes: [runtime], processIdentity: null, ...over,
  } as RegisteredSession)
  const withEngine = async <T>(run: () => Promise<T>): Promise<T> => {
    setProcessTableSource(async () => [
      { pid: 10, parentPid: 1, executable: 'zsh', startMarker: 'Mon Aug 10 10:00:10 2026', args: '-zsh' },
      { pid: 11, parentPid: 10, executable: 'claude', startMarker: LSTART, args: 'claude' },
    ])
    try { return await run() } finally { setProcessTableSource(null) }
  }
  afterEach(() => vi.restoreAllMocks())

  it('asks about the runtime it is given, not the row\'s first one', async () => {
    const pty = { backend: 'ptyhost' as const, instance: 'p1', paneId: '%4' }
    const rootProcess = vi.fn(async () => 'missing' as const)
    const found = await checkSessionRuntime({ rootProcess }, session({ runtimes: [pty, runtime] }), runtime)
    expect(rootProcess).toHaveBeenCalledExactlyOnceWith(runtime)
    expect(found).toEqual({ state: 'gone', reason: 'tmux:%1 has no pane' })
  })

  it('never lets a tmux backend be handed another backend\'s pane', () => {
    const tmuxOnly = backendWithRoot(10) as Pick<TerminalBackend<TmuxRuntimeRef>, 'rootProcess'>
    const pty = { backend: 'ptyhost' as const, instance: 'p1', paneId: '%1' }
    // @ts-expect-error a ptyhost runtime does not type-check against a tmux backend (tsc --noEmit)
    expect(typeof (() => checkSessionRuntime(tmuxOnly, session({ runtimes: [pty] }), pty))).toBe('function')
  })

  it('adopts the live identity over a saved marker that is not a C-locale lstart', async () => {
    const update = vi.spyOn(registry, 'updateProcessIdentity').mockReturnValue(undefined as never)
    const saved = { pid: 11, executable: 'claude', startMarker: '10 Aug 2026 10:00:11' }
    const found = await withEngine(() => checkSessionRuntime(backendWithRoot(10), session({ processIdentity: saved }), runtime))
    expect(found).toEqual({ state: 'alive' })
    expect(update).toHaveBeenCalledWith('sess-1', expect.objectContaining({ pid: 11, startMarker: LSTART }))
  })

  it('says gone when another process now runs under the pane', async () => {
    const update = vi.spyOn(registry, 'updateProcessIdentity').mockReturnValue(undefined as never)
    const saved = { pid: 9, executable: 'claude', startMarker: 'Mon Aug 10 09:00:00 2026' }
    const found = await withEngine(() => checkSessionRuntime(backendWithRoot(10), session({ processIdentity: saved }), runtime))
    expect(found).toEqual({
      state: 'gone',
      reason: `process changed under tmux:%1 (was pid 9 @ Mon Aug 10 09:00:00 2026, now pid 11 @ ${LSTART})`,
    })
    expect(update).not.toHaveBeenCalled()
  })

  it('records the live identity when the row has none yet', async () => {
    const update = vi.spyOn(registry, 'updateProcessIdentity').mockReturnValue(undefined as never)
    const found = await withEngine(() => checkSessionRuntime(backendWithRoot(10), session({ processIdentity: null }), runtime))
    expect(found).toEqual({ state: 'alive' })
    expect(update).toHaveBeenCalledWith('sess-1', expect.objectContaining({ pid: 11, startMarker: LSTART }))
  })
})

describe('renamedEngine', () => {
  const at = (executable: string, over: Partial<ProcessIdentity> = {}): ProcessIdentity => ({ pid: 11, startMarker: 'm11', executable, ...over })
  it.each([
    ['node', 'claude'], ['nodejs', 'codex'], ['/usr/bin/node', 'claude'], ['node.exe', 'claude.exe'],
    ['C:\\Program Files\\nodejs\\NODE.EXE', 'C:\\tools\\claude.exe'],
  ])('reads %s, now %s, as the recorded engine renamed', (recorded, observed) => {
    expect(renamedEngine(at(recorded), at(observed))).toBe(true)
  })
  it.each([
    ['the same name', at('claude'), at('claude')],
    ['a Node runtime still', at('node'), at('node')],
    ['one Node runtime for another', at('node'), at('nodejs')],
    ['a different pid', at('node'), at('claude', { pid: 12 })],
    ['a different start', at('node'), at('claude', { startMarker: 'm12' })],
    ['a rename from another program', at('/bin/claude'), at('other')],
    ['a rename to a Node runtime', at('claude'), at('node')],
  ])('refuses %s', (_case, recorded, observed) => {
    expect(renamedEngine(recorded, observed)).toBe(false)
  })
  // Linux: the start is the ticks; the marker moves when the wall clock is stepped (terminalTypes.ts `startTicks`).
  it('compares the start as sameProcessIdentity does: the ticks, over a marker the clock moved', () => {
    expect(renamedEngine(at('node', { startTicks: 500, startMarker: 'before the step' }),
      at('claude', { startTicks: 500, startMarker: 'after the step' }))).toBe(true)
    expect(renamedEngine(at('node', { startTicks: 500 }), at('claude', { startTicks: 501 }))).toBe(false)
  })
})

describe('publishEngine', () => {
  const node: ProcessIdentity = { pid: 11, startMarker: 'm11', executable: 'node' }
  const claude: ProcessIdentity = { ...node, executable: 'claude' }
  const reasons = { gone: 'the engine is gone', changed: 'the engine changed' }
  const held = (reason: string) => new IdentityReadUnavailable(reason).message
  /** Stands in for `registry.confirmLaunch`: runs the refresh, then confirms the identity it was handed. */
  const registryWrite = () => vi.fn(async (identity: ProcessIdentity, refresh: () => Promise<void>, _expires: number): Promise<LaunchPublication> => {
    await refresh()
    return { state: 'confirmed', entry: { processIdentity: identity } as RegisteredSession }
  })

  it('publishes once when the look still sees the recorded process', async () => {
    const publish = registryWrite()
    expect(await publishEngine(node, async () => ({ ...node }), reasons, publish)).toEqual({ state: 'confirmed', entry: { processIdentity: node } })
    expect(publish).toHaveBeenCalledExactlyOnceWith(node, expect.any(Function), expect.any(Number))
  })

  it('writes once more, the observed identity under the same expires, when the engine named itself before the refresh', async () => {
    const publish = registryWrite(), look = vi.fn(async () => claude)
    const before = performance.now()
    expect(await publishEngine(node, look, reasons, publish)).toEqual({ state: 'confirmed', entry: { processIdentity: claude } })
    expect(publish.mock.calls.map(([identity]) => identity)).toEqual([node, claude])
    const [first, second] = publish.mock.calls.map(call => call[2])
    expect(second).toBe(first)   // computed once, before the first write: never renewed
    expect(first).toBeGreaterThanOrEqual(before + REGISTRY_WRITE_DEADLINE_MS)
    expect(first).toBeLessThanOrEqual(performance.now() + REGISTRY_WRITE_DEADLINE_MS)
    expect(look).toHaveBeenCalledTimes(2)   // each write's refresh looks; nothing waits between them
  })

  it('takes the caller\'s expires in place of its own, for both writes', async () => {
    const publish = registryWrite()
    await publishEngine(node, async () => claude, reasons, publish, 42)
    expect(publish.mock.calls.map(call => call[2])).toEqual([42, 42])
  })

  it('refuses a second rename on the re-write, in the changed words', async () => {
    const publish = registryWrite()
    const look = vi.fn<() => Promise<ProcessIdentity | null>>().mockResolvedValueOnce(claude).mockResolvedValue({ ...node, executable: 'codex' })
    const refused = await publishEngine(node, look, reasons, publish).catch(error => error)
    expect(refused).toBeInstanceOf(IdentityReadUnavailable)
    expect(refused).not.toBeInstanceOf(EngineRenamed)
    expect(refused.message).toBe(held(reasons.changed))
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['no process', node, null, reasons.gone],
    ['a different pid', node, { ...claude, pid: 12 }, reasons.changed],
    ['a different start', node, { ...claude, startMarker: 'm12' }, reasons.changed],
    ['a rename from another program', { ...node, executable: '/bin/claude' }, { ...node, executable: 'other' }, reasons.changed],
  ])('refuses %s as today, with one write', async (_case, recorded, observed, reason) => {
    const publish = registryWrite()
    const refused = await publishEngine(recorded, async () => observed, reasons, publish).catch(error => error)
    expect(refused).toBeInstanceOf(IdentityReadUnavailable)
    expect(refused).not.toBeInstanceOf(EngineRenamed)
    expect(refused).toMatchObject({ code: 'IDENTITY_UNAVAILABLE', message: held(reason) })
    expect(publish).toHaveBeenCalledOnce()
  })

  it('throws, from the refresh, an EngineRenamed that carries the observed identity and reads as the changed hold', async () => {
    let seen: unknown
    await publishEngine(node, async () => claude, reasons, async (identity, refresh) => {
      seen = await refresh().catch(error => error)
      return { state: 'confirmed', entry: { processIdentity: identity } as RegisteredSession }
    })
    expect(seen).toBeInstanceOf(EngineRenamed)
    expect(seen).toMatchObject({ observed: claude, code: 'IDENTITY_UNAVAILABLE', message: held(reasons.changed) })
  })

  it('lets a re-write that ran out of the budget through as the registry\'s own error: not a hold, no third write', async () => {
    // The registry's words for a write past `expires` (registryPersistence.ts). The same object must come out.
    const expired = new RegistryPersistenceUnavailable('write deadline exceeded')
    const publish = registryWrite()
    publish.mockImplementationOnce(publish.getMockImplementation()!).mockRejectedValueOnce(expired)
    await expect(publishEngine(node, async () => claude, reasons, publish)).rejects.toBe(expired)
    expect(publish).toHaveBeenCalledTimes(2)
  })

  it('retries nothing but a rename: another failure, a look that throws, a write that published nothing', async () => {
    const owner = new RegistryOwnershipChanged('the registry owner changed while its write was being prepared')
    const failing = vi.fn(async (): Promise<LaunchPublication> => { throw owner })
    await expect(publishEngine(node, async () => node, reasons, failing)).rejects.toBe(owner)
    expect(failing).toHaveBeenCalledOnce()
    const probe = new Error('no terminal backend restores tmux:%1'), publish = registryWrite()
    await expect(publishEngine(node, async () => { throw probe }, reasons, publish)).rejects.toBe(probe)
    expect(publish).toHaveBeenCalledOnce()
    const unpublished = vi.fn(async (): Promise<LaunchPublication> => ({ state: 'not-published' }))
    expect(await publishEngine(node, async () => node, reasons, unpublished)).toEqual({ state: 'not-published' })
    expect(unpublished).toHaveBeenCalledOnce()
  })
})
