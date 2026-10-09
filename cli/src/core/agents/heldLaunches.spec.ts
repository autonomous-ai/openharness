import { execFileSync } from 'node:child_process'
import { describe, expect, it, vi } from 'vitest'
import type { AgentLaunch, RegisteredSession } from '../../lib/registry.js'
import { heldLaunch, type RestoreSummary } from '../../lib/restoreAgents.js'
import { createHeldLaunches, heldFor, heldPaneArgv } from './heldLaunches.js'

const HELD = heldLaunch('models')
const row = (agentId: string, launch: AgentLaunch, over: Partial<RegisteredSession> = {}) =>
  ({ agentId, sessionId: `s-${agentId}`, launch, ...over }) as RegisteredSession
const summary = (over: Partial<RestoreSummary> = {}): RestoreSummary => ({ restored: [], skipped: [], failed: [], held: [], unsurveyed: [], ...over })

/** A registry of rows and a restore that does to them what `answer` says, recording what it was asked. */
function setup(rows: RegisteredSession[], answer: (only: ReadonlySet<string>) => RestoreSummary = (only) => summary({ restored: [...only] })) {
  const registry = new Map(rows.map((r) => [r.agentId, r]))
  const asked: string[][] = []
  const restore = vi.fn(async (only: ReadonlySet<string>) => {
    asked.push([...only])
    const result = answer(only)
    for (const id of result.restored) { const r = registry.get(id); if (r) r.launch = { state: 'starting' } }
    return result
  })
  const log = vi.fn()
  const held = createHeldLaunches({ registry: { list: () => [...registry.values()], byAgent: (id: string) => registry.get(id) } as never, restore, log })
  return { registry, asked, restore, log, held }
}

describe('agents held until a service is ready', () => {
  it('names the service a row is held for, and none for any other', () => {
    expect(heldFor(row('a', HELD))).toBe('models')
    expect(heldFor(row('a', { state: 'ready' }))).toBeNull()
    expect(heldFor(row('a', { state: 'failed', error: 'X' }))).toBeNull()
    expect(heldFor(undefined)).toBeNull()
  })

  it("its pane says why, survives an interrupt, and idles: the agent's launch takes it over", () => {
    const argv = heldPaneArgv('Waiting for the models service.')
    expect(argv.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    expect(argv[2]).toContain('trap "" INT QUIT TSTP')
    // The script itself, run with its loop cut short: it prints the reason as given, and nothing else.
    const once = argv[2]!.replace('while :; do sleep 3600; done', 'exit 0')
    expect(execFileSync('/bin/sh', ['-c', once, argv[3]!, argv[4]!], { encoding: 'utf8' })).toBe('Waiting for the models service.\n')
  })

  it('runs no pass before the boot has restored, whatever it asked meanwhile', async () => {
    const { held, asked } = setup([row('a', HELD)])
    const pass = held.restoreHeld()
    await Promise.resolve()
    expect(asked).toEqual([])
    expect(await held.boot(async () => 'booted')).toBe('booted')
    expect(await pass).toMatchObject({ restored: ['a'] })
    // A boot that throws opens them all the same.
    const failing = setup([row('b', HELD)])
    const later = failing.held.restoreHeld()
    await expect(failing.held.boot(async () => { throw new Error('restore broke') })).rejects.toThrow('restore broke')
    expect(await later).toMatchObject({ restored: ['b'] })
  })

  it('launches every held agent once the core is ready, or those held for one service when it connects', async () => {
    const { held, asked, log } = setup([row('a', HELD), row('b', heldLaunch('store')), row('c', { state: 'ready' })])
    await held.boot(async () => {})
    expect(await held.restoreHeld('store')).toMatchObject({ restored: ['b'] })
    expect(await held.restoreHeld()).toMatchObject({ restored: ['a'] })
    expect(asked).toEqual([['b'], ['a']])
    // Nothing held: no pass at all.
    expect(await held.restoreHeld()).toBeNull()
    expect(asked).toHaveLength(2)
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[restore] held · store · launched 1 of 1',
      '[restore] held · every service · launched 1 of 1',
    ])
  })

  it('says what is still waiting after a pass that could not ask', async () => {
    const { held, log } = setup([row('a', HELD), row('b', HELD)], (only) => summary({ held: [...only] }))
    await held.boot(async () => {})
    await held.restoreHeld('models')
    expect(log).toHaveBeenLastCalledWith('[restore] held · models · launched 0 of 2 · 2 still waiting')
  })

  it.each(['prepared', 'restart'] as const)('retries transient core contention after the only %s notice, coalescing retries', async trigger => {
    vi.useFakeTimers()
    try {
      const h = setup([row('a', HELD)])
      h.restore.mockResolvedValueOnce(summary({ retry: true, held: ['a'] }))
        .mockResolvedValueOnce(summary({ retry: true, held: ['a'] }))
      await h.held.boot(async () => {})
      if (trigger === 'prepared') await h.held.restoreHeld('models')
      else await h.held.restartHeld('a')
      await h.held.restoreHeld('models')
      expect(h.restore).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(500)
      expect(h.restore).toHaveBeenCalledTimes(3)
      expect(h.registry.get('a')?.launch?.state).toBe('starting')
    } finally { vi.useRealTimers() }
  })

  it('logs a failed core-contention retry without an unhandled rejection', async () => {
    vi.useFakeTimers()
    try {
      const h = setup([row('a', HELD)])
      h.restore.mockResolvedValueOnce(summary({ retry: true })).mockRejectedValueOnce(new Error('test retry failure'))
      await h.held.boot(async () => {})
      await h.held.restoreHeld()
      await vi.advanceTimersByTimeAsync(500)
      expect(h.log).toHaveBeenLastCalledWith(expect.stringContaining('test retry failure'))
    } finally { vi.useRealTimers() }
  })

  it('runs one pass at a time, and a pass that fails does not stop the next', async () => {
    let release!: () => void
    const order: string[] = []
    const { held, restore } = setup([row('a', HELD)])
    restore.mockImplementationOnce(async () => { order.push('first'); await new Promise<void>((done) => { release = done }); throw new Error('models hung up') })
    await held.boot(async () => {})
    const first = held.restoreHeld()
    const second = held.restoreHeld()
    await vi.waitFor(() => expect(order).toEqual(['first']))
    expect(restore).toHaveBeenCalledTimes(1)
    release()
    await expect(first).rejects.toThrow('models hung up')
    expect(await second).toMatchObject({ restored: ['a'] })
  })

  describe("a person's restart of a held agent", () => {
    it('is not one for an agent that is not held: it restarts as it always has', () => {
      const { held } = setup([row('a', { state: 'ready' })])
      expect(held.restartHeld('a')).toBeNull()
      expect(held.restartHeld('nobody')).toBeNull()
    })

    it('launches it, and answers it as a restart would', async () => {
      const { held, log } = setup([row('a', HELD)])
      await held.boot(async () => {})
      expect(await held.restartHeld('a')).toMatchObject({ ok: true, session: { agentId: 'a' }, resumed: true })
      expect(log).toHaveBeenCalledWith('[restart] a launched from held')
      const fresh = setup([row('b', HELD, { sessionId: '' })])
      await fresh.held.boot(async () => {})
      expect(await fresh.held.restartHeld('b')).toMatchObject({ ok: true, resumed: false })
    })

    it('says it still waits, or why its launch failed, or that it could not be launched', async () => {
      const waiting = setup([row('a', HELD)], (only) => summary({ held: [...only] }))
      await waiting.held.boot(async () => {})
      expect(await waiting.held.restartHeld('a')).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE', detail: HELD.state === 'held' ? HELD.detail : '' })
      const refused = setup([row('b', HELD)], (only) => summary({ failed: [...only].map((agentId) => ({ agentId, reason: 'no way there' })) }))
      refused.restore.mockImplementationOnce(async (only) => {
        refused.registry.get('b')!.launch = { state: 'failed', error: 'GRID_ENGINE_UNSUPPORTED', detail: 'no way there' }
        return summary({ failed: [...only].map((agentId) => ({ agentId, reason: 'no way there' })) })
      })
      await refused.held.boot(async () => {})
      expect(await refused.held.restartHeld('b')).toEqual({ ok: false, error: 'GRID_ENGINE_UNSUPPORTED', detail: 'no way there' })
      const bare = setup([row('c', HELD)])
      bare.restore.mockImplementationOnce(async () => { bare.registry.get('c')!.launch = { state: 'failed', error: 'START_TIMEOUT' }; return summary() })
      await bare.held.boot(async () => {})
      expect(await bare.held.restartHeld('c')).toEqual({ ok: false, error: 'START_TIMEOUT' })
      const lost = setup([row('d', HELD)], (only) => summary({ failed: [...only].map((agentId) => ({ agentId, reason: 'tmux said no' })) }))
      lost.restore.mockImplementationOnce(async (only) => { lost.registry.get('d')!.launch = { state: 'ready' }; return summary({ failed: [...only].map((agentId) => ({ agentId, reason: 'tmux said no' })) }) })
      await lost.held.boot(async () => {})
      expect(await lost.held.restartHeld('d')).toEqual({ ok: false, error: 'RESTART_FAILED', detail: 'tmux said no' })
      const none = setup([row('e', HELD)], () => summary())
      none.restore.mockImplementationOnce(async () => { none.registry.get('e')!.launch = { state: 'ready' }; return summary() })
      await none.held.boot(async () => {})
      expect(await none.held.restartHeld('e')).toEqual({ ok: false, error: 'RESTART_FAILED', detail: 'The harness could not be launched.' })
    })

    it('leaves an agent a pass launched meanwhile, or that was stopped or closed meanwhile, as it is', async () => {
      const { held, registry, restore } = setup([row('a', HELD), row('b', HELD)])
      const launchedMeanwhile = held.restartHeld('a')!
      const closedMeanwhile = held.restartHeld('b')!
      registry.get('a')!.launch = { state: 'ready' }
      registry.delete('b')
      await held.boot(async () => {})
      expect(await launchedMeanwhile).toMatchObject({ ok: true, session: { agentId: 'a' } })
      expect(await closedMeanwhile).toEqual({ ok: false, error: 'AGENT_NOT_FOUND' })
      expect(restore).not.toHaveBeenCalled()
      // Closed while its own pass ran.
      const gone = setup([row('c', HELD)])
      gone.restore.mockImplementationOnce(async () => { gone.registry.delete('c'); return summary({ restored: ['c'] }) })
      await gone.held.boot(async () => {})
      expect(await gone.held.restartHeld('c')).toEqual({ ok: false, error: 'AGENT_NOT_FOUND' })
    })
  })

  it('restores only rows still held when the pass runs: one stopped or closed since is left alone', async () => {
    const { held, registry, asked } = setup([row('a', HELD), row('b', HELD)])
    const pass = held.restoreHeld()
    registry.delete('b')
    await held.boot(async () => {})
    await pass
    expect(asked).toEqual([['a']])
  })
})
