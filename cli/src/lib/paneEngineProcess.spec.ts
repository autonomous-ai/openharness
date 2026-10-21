import { afterEach, describe, expect, it, vi } from 'vitest'
import { checkSessionRuntime, lookupPaneEngineProcess } from './paneEngineProcess.js'
import { setProcessTableSource } from './processTable.js'
import { registry, type RegisteredSession } from './registry.js'
import type { TerminalBackend } from './terminalBackend.js'
import type { TmuxRuntimeRef } from './terminalTypes.js'

const runtime = { backend: 'tmux' as const, paneId: '%1' }
function backendWithRoot(root: number | 'missing' | null): TerminalBackend {
  return { rootProcess: async () => root } as unknown as TerminalBackend
}

describe('lookupPaneEngineProcess', () => {
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
