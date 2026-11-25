import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { guardHeld, type AgentLaunch, type RegisteredSession } from '../../lib/registry.js'
import { DID_NOT_START, heldLaunch, STARTING_AGAIN, type RestoreSummary } from '../../lib/restoreAgents.js'
import { createHeldLaunches, heldFor, heldPaneArgv, heldRetryMs } from './heldLaunches.js'

const running: ReturnType<typeof createHeldLaunches>[] = []
afterEach(() => { for (const held of running.splice(0)) held.close() })
const HELD = heldLaunch('models')
const row = (agentId: string, launch: AgentLaunch, over: Partial<RegisteredSession> = {}) =>
  ({ agentId, sessionId: `s-${agentId}`, launch, ...over }) as RegisteredSession
const summary = (over: Partial<RestoreSummary> = {}): RestoreSummary => ({ restored: [], skipped: [], failed: [], held: [], unsurveyed: [], ...over })
/** A launch the native guard held under [nativeToken] (lib/restoreAgents.ts `guardHold`), held again for [service]. */
const GUARD = (nativeToken: string, service = 'native'): AgentLaunch => ({ state: 'held', service, nativeToken, startsAgain: true, detail: STARTING_AGAIN })
/** A Codex first launch the guard held, or with [sessionId] a conversation's relaunch. */
const guardRow = (agentId: string, sessionId = '') => row(agentId, GUARD(`${agentId}-0`), { sessionId, engine: 'codex' })

/** A registry of rows and a restore that does to them what `answer` says, recording what it was asked and when. A
 *  dispatch of a launch the guard held starts under a new token; with [guardMs], the guard holds that one again so
 *  long after, and the watcher that sees it asks for it (`startAgain`). */
function setup(rows: RegisteredSession[], answer: (only: ReadonlySet<string>) => RestoreSummary = (only) => summary({ restored: [...only] }),
  { guardMs, now }: { guardMs?: number; now?: () => number } = {}) {
  const registry = new Map(rows.map((r) => [r.agentId, r]))
  const asked: string[][] = []
  const when: Array<[string, number]> = []
  const start = performance.now()
  const restore = vi.fn(async (only: ReadonlySet<string>, _current: () => boolean) => {
    asked.push([...only])
    for (const id of only) when.push([id, performance.now() - start])
    const result = answer(only)
    for (const id of result.restored) {
      const r = registry.get(id)
      if (!r) continue
      const guarded = guardHeld(r), nativeToken = `${id}-${asked.length}`
      r.launch = guarded ? { state: 'starting', nativeToken } : { state: 'starting' }
      if (guarded && guardMs !== undefined) setTimeout(() => {
        const later = registry.get(id)
        if (later?.launch?.state !== 'starting' || later.launch.nativeToken !== nativeToken) return
        later.launch = GUARD(nativeToken)
        held.startAgain(id)
      }, guardMs)
    }
    return result
  })
  const log = vi.fn()
  const announce = vi.fn()
  const setLaunch = (id: string, launch: AgentLaunch) => { const r = registry.get(id); if (r) r.launch = launch; return r ?? null }
  const held = createHeldLaunches({ registry: { list: () => [...registry.values()], byAgent: (id: string) => registry.get(id), setLaunch } as never, restore, announce, log, now })
  running.push(held)
  return { registry, asked, when, restore, log, announce, held }
}
/** When each attempt at [agentId] came, in ms from the setup. */
const timesOf = (h: ReturnType<typeof setup>, agentId: string) => h.when.filter(([id]) => id === agentId).map(([, at]) => at)
const lines = (h: ReturnType<typeof setup>, part: string) => h.log.mock.calls.map(([line]) => String(line)).filter((line) => line.includes(part))

describe('agents held until a service is ready', () => {
  it('says once why an agent stays held, and does not repeat a pass that changed nothing', async () => {
    let code = 'PANE_FAILED'
    const { held, log } = setup([row('a', HELD)], (only) => summary({ held: [...only], failed: [...only].map(agentId => ({ agentId, code, reason: 'the pty host has gone' })) }))
    await held.boot(async () => {})
    await held.restoreHeld(); await held.restoreHeld(); await held.restoreHeld()
    code = 'WAITING_PANE_FAILED'
    await held.restoreHeld()
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[restore] a · could not launch from held · PANE_FAILED',
      '[restore] held · every service · launched 0 of 1 · 1 still waiting',
      '[restore] a · could not launch from held · WAITING_PANE_FAILED',
    ])
  })

  it("a held agent is logged by its failure's code, never its reason", async () => {
    // The reasons come from the restore (a pane's refusal, a launch's detail): they can name the person's folders.
    let failure = { code: 'PANE_FAILED', reason: 'peer said /Users/sentinel/x' }
    const { held, log } = setup([row('a', HELD)], (only) => summary({ held: [...only], failed: [...only].map(agentId => ({ agentId, ...failure })) }))
    await held.boot(async () => {})
    await held.restoreHeld()
    // Another reason with the same code: the log has nothing new to say.
    failure = { code: 'PANE_FAILED', reason: 'peer said /Users/sentinel/y' }
    await held.restoreHeld()
    // A launch's own error is a code, but typed a string: one that is not a code is said by its length.
    failure = { code: 'refused at /Users/sentinel', reason: 'no way there' }
    await held.restoreHeld()
    const lines = log.mock.calls.map((call) => call.map(String).join(' ')).join('\n')
    expect(lines).not.toContain('sentinel')
    expect(log.mock.calls.map(([line]) => line).filter((line) => line.includes('could not launch'))).toEqual([
      '[restore] a · could not launch from held · PANE_FAILED',
      '[restore] a · could not launch from held · text(26)',
    ])
  })

  it.each(['removed', 'closed'] as const)('does not restore a queued row that was %s before its preparation', async state => {
    const h = setup([row('a', HELD)])
    await h.held.boot(async () => {})
    if (state === 'removed') vi.spyOn(h.registry, 'get').mockReturnValueOnce(undefined)
    const running = h.held.restoreHeld()
    if (state === 'closed') queueMicrotask(() => h.held.close())
    expect(await running).toMatchObject({ restored: [] })
    expect(h.restore).not.toHaveBeenCalled()
  })

  it('revokes the boot and every active restore authority immediately on close', async () => {
    const h = setup([row('a', HELD)])
    let bootCurrent!: () => boolean, flightCurrent!: () => boolean, finish!: () => void
    await h.held.boot(async current => { bootCurrent = current; expect(current()).toBe(true) })
    const restore = vi.fn(async (_only: ReadonlySet<string>, current: () => boolean) => {
      flightCurrent = current
      expect(current()).toBe(true)
      await new Promise<void>(done => { finish = done })
      return summary()
    })
    h.restore.mockImplementation(restore)
    const pending = h.held.restoreHeld()
    await vi.waitFor(() => expect(restore).toHaveBeenCalledOnce())
    h.held.close()
    expect(bootCurrent()).toBe(false)
    expect(flightCurrent()).toBe(false)
    finish(); await pending
  })

  it('bounds actual preparation flights and lets a later ready agent progress after one slot settles', async () => {
    vi.useFakeTimers()
    try {
      const h = setup(Array.from({ length: 5 }, (_, index) => row(String(index), HELD)))
      const complete: Array<() => void> = []
      h.restore.mockImplementation(only => new Promise(resolve => complete.push(() => {
        for (const id of only) h.registry.get(id)!.launch = { state: 'starting' }
        resolve(summary({ restored: [...only] }))
      })))
      await h.held.boot(async () => {})
      const first = h.held.restoreHeld()
      await vi.advanceTimersByTimeAsync(0)
      expect(h.restore).toHaveBeenCalledTimes(4)
      expect(await h.held.restartHeld('4')).toMatchObject({ error: 'SERVICE_UNAVAILABLE' })
      complete.shift()!()
      await vi.advanceTimersByTimeAsync(500)
      expect(h.restore).toHaveBeenCalledTimes(5)
      complete.splice(0).forEach(done => done())
      await first
      expect(h.registry.get('4')?.launch).toEqual({ state: 'starting' })
    } finally { vi.useRealTimers() }
  })

  it('names the service a row is held for, and none for any other', () => {
    expect(heldFor(row('a', HELD))).toBe('models')
    expect(heldFor(row('a', { state: 'ready' }))).toBeNull()
    expect(heldFor(row('a', { state: 'failed', error: 'X' }))).toBeNull()
    expect(heldFor(undefined)).toBeNull()
  })

  it("its pane says why, survives an interrupt, and idles: the agent's launch takes it over", () => {
    const argv = heldPaneArgv('Waiting for the models service.', undefined, 'linux')
    expect(argv.slice(0, 2)).toEqual(['/bin/sh', '-c'])
    if (process.platform === 'win32') return
    expect(argv[2]).toContain('trap "" INT QUIT TSTP')
    // The script itself, run with its loop cut short: it prints the reason as given, and nothing else.
    const once = argv[2]!.replace('while :; do sleep 3600; done', 'exit 0')
    expect(execFileSync('/bin/sh', ['-c', once, argv[3]!, argv[4]!], { encoding: 'utf8' })).toBe('Waiting for the models service.\n')
  })

  it('waits in the daemon\'s Node on Windows, which has no /bin/sh, still told by its start command', () => {
    const argv = heldPaneArgv('Waiting for the Store.', 'tok-1', 'win32')
    expect(argv.slice(1, 2)).toEqual(['-e'])
    expect(argv.slice(3)).toEqual(['harness-held', 'Waiting for the Store.', 'tok-1'])
    expect(argv).not.toContain('/bin/sh')
    expect(heldPaneArgv('Waiting for the Store.', undefined, 'linux').slice(0, 2)).toEqual(['/bin/sh', '-c'])
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
      expect(h.log).toHaveBeenLastCalledWith('[restore] core contention retry failed: Error')
    } finally { vi.useRealTimers() }
  })

  it('joins a flight for the same agent, and a failed flight permits the next attempt', async () => {
    let release!: () => void
    const order: string[] = []
    const { held, restore } = setup([row('a', HELD)])
    restore.mockImplementationOnce(async () => { order.push('first'); await new Promise<void>((done) => { release = done }); throw new Error('models hung up') })
    await held.boot(async () => {})
    const first = held.restoreHeld().catch(error => error)
    const second = held.restoreHeld().catch(error => error)
    await vi.waitFor(() => expect(order).toEqual(['first']))
    expect(restore).toHaveBeenCalledTimes(1)
    release()
    expect((await first).message).toBe('models hung up')
    expect((await second).message).toBe('models hung up')
    expect(await held.restoreHeld()).toMatchObject({ restored: ['a'] })
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
      const refused = setup([row('b', HELD)], (only) => summary({ failed: [...only].map((agentId) => ({ agentId, code: 'GRID_ENGINE_UNSUPPORTED', reason: 'no way there' })) }))
      refused.restore.mockImplementationOnce(async (only) => {
        refused.registry.get('b')!.launch = { state: 'failed', error: 'GRID_ENGINE_UNSUPPORTED', detail: 'no way there' }
        return summary({ failed: [...only].map((agentId) => ({ agentId, code: 'GRID_ENGINE_UNSUPPORTED', reason: 'no way there' })) })
      })
      await refused.held.boot(async () => {})
      expect(await refused.held.restartHeld('b')).toEqual({ ok: false, error: 'GRID_ENGINE_UNSUPPORTED', detail: 'no way there' })
      const bare = setup([row('c', HELD)])
      bare.restore.mockImplementationOnce(async () => { bare.registry.get('c')!.launch = { state: 'failed', error: 'START_TIMEOUT' }; return summary() })
      await bare.held.boot(async () => {})
      expect(await bare.held.restartHeld('c')).toEqual({ ok: false, error: 'START_TIMEOUT' })
      const lost = setup([row('d', HELD)], (only) => summary({ failed: [...only].map((agentId) => ({ agentId, code: 'PANE_FAILED', reason: 'tmux said no' })) }))
      lost.restore.mockImplementationOnce(async (only) => { lost.registry.get('d')!.launch = { state: 'ready' }; return summary({ failed: [...only].map((agentId) => ({ agentId, code: 'PANE_FAILED', reason: 'tmux said no' })) }) })
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


it('restores a sibling while another native preparation is stalled', async () => {
  const h = setup([row('a', heldLaunch('native')), row('b', heldLaunch('native'))])
  let finish!: (result: RestoreSummary) => void
  h.restore.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
  await h.held.boot(async () => {})
  const pass = h.held.restoreHeld()
  await vi.waitFor(() => expect(h.registry.get('b')?.launch?.state).toBe('starting'))
  expect(h.registry.get('a')?.launch?.state).toBe('held')
  finish(summary({ held: ['a'] }))
  expect(await pass).toMatchObject({ restored: ['b'], held: ['a'] })
})

it('retries a native hold without a service reconnect and stops scheduling at close', async () => {
  vi.useFakeTimers()
  try {
    const h = setup([row('a', heldLaunch('native'))])
    h.restore.mockResolvedValueOnce(summary({ held: ['a'] }))
    await h.held.boot(async () => {})
    await h.held.restoreHeld()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.restore).toHaveBeenCalledTimes(2)
    h.registry.get('a')!.launch = heldLaunch('native')
    h.held.close()
    expect(await h.held.restoreHeld()).toBeNull()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(h.restore).toHaveBeenCalledTimes(2)
  } finally { vi.useRealTimers() }
})

it('retries a held sibling while another agent’s observation has not settled', async () => {
  vi.useFakeTimers()
  try {
    const h = setup([row('a', heldLaunch('native')), row('b', heldLaunch('native'))])
    let finish!: (result: RestoreSummary) => void
    h.restore.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce(summary({ held: ['b'] }))
    await h.held.boot(async () => {})
    const pass = h.held.restoreHeld()
    await vi.advanceTimersByTimeAsync(2_001)
    expect(h.registry.get('b')?.launch?.state).toBe('starting')
    expect(h.restore.mock.calls.map(([only]) => [...only])).toEqual([['a'], ['b'], ['b']])
    finish(summary({ held: ['a'] }))
    await pass
  } finally { vi.useRealTimers() }
})

it('waits longer after each timer pass that launched nothing, up to half a minute', () => {
  expect([0, 1, 2, 3, 4, 5, 40].map(heldRetryMs)).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000])
})

it('backs off a hold nothing else wakes, and climbs again from the start once something changes', async () => {
  vi.useFakeTimers()
  try {
    const h = setup([row('a', heldLaunch('native'))], () => summary({ held: ['a'] }))
    await h.held.boot(async () => {})
    await h.held.restoreHeld()
    const passesAfter = async (ms: number) => { await vi.advanceTimersByTimeAsync(ms); return h.restore.mock.calls.length }
    // 2 s, 4 s, 8 s, 16 s, then every 30 s: a day of it is about 2,900 passes, not 43,000.
    expect(await passesAfter(1_999)).toBe(1)
    expect(await passesAfter(1)).toBe(2)
    expect(await passesAfter(4_000)).toBe(3)
    expect(await passesAfter(8_000)).toBe(4)
    expect(await passesAfter(16_000)).toBe(5)
    expect(await passesAfter(29_999)).toBe(5)
    expect(await passesAfter(1)).toBe(6)
    expect(await passesAfter(30_000)).toBe(7)
    // A service connecting is news: it is asked at once, the waiting pass keeps its time, and the one after
    // that is 4 s later again rather than 30.
    await h.held.restoreHeld('native')
    expect(h.restore).toHaveBeenCalledTimes(8)
    expect(await passesAfter(30_000)).toBe(9)
    expect(await passesAfter(3_999)).toBe(9)
    expect(await passesAfter(1)).toBe(10)
  } finally { vi.useRealTimers() }
})

it('climbs again from the start once a pass launches an agent, and when a person restarts a held one', async () => {
  vi.useFakeTimers()
  try {
    let launch = false
    const h = setup([row('a', heldLaunch('native')), row('b', heldLaunch('native'))],
      only => only.has('b') && launch ? summary({ restored: ['b'] }) : summary({ held: [...only] }))
    await h.held.boot(async () => {})
    await h.held.restoreHeld()
    await vi.advanceTimersByTimeAsync(2_000 + 4_000 + 8_000 + 16_000 + 30_000)
    // How long until the next pass, timer to timer. Stepping 1 ms at a time took 30,000 event-loop turns a call: at
    // load ~85 (MacBook-Pro-19, 2026-10-30) it ran 17 s and timed the test out.
    const nextPass = async () => {
      const before = h.restore.mock.calls.length, start = Date.now()
      while (vi.getTimerCount() > 0) {
        await vi.advanceTimersToNextTimerAsync()
        const waited = Date.now() - start
        if (waited > 30_000) return null
        if (h.restore.mock.calls.length > before) return waited
      }
      return null
    }
    launch = true
    expect(await nextPass()).toBe(30_000)
    expect(h.registry.get('b')?.launch?.state).toBe('starting')
    // The pass after the one that launched waits 4 s, not 30.
    expect(await nextPass()).not.toBeNull()
    expect(await nextPass()).toBe(4_000)
    await vi.advanceTimersByTimeAsync(8_000 + 16_000 + 30_000)
    expect(await h.held.restartHeld('a')).toMatchObject({ ok: false, error: 'SERVICE_UNAVAILABLE' })
    expect(await nextPass()).not.toBeNull()
    expect(await nextPass()).toBe(4_000)
  } finally { vi.useRealTimers() }
})

describe('a launch the guard held starts again on attempts of its own', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { for (const held of running.splice(0)) held.close(); vi.useRealTimers() })

  it('a hold seen at run time arms one attempt for that agent 2 s later', async () => {
    const h = setup([guardRow('a'), row('b', HELD)])
    await h.held.boot(async () => {})
    h.held.startAgain('a')
    await vi.advanceTimersByTimeAsync(1_999)
    expect(h.asked).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    // That agent alone: the one held for models waits for its own service.
    expect(h.asked).toEqual([['a']])
    expect(h.registry.get('a')?.launch).toEqual({ state: 'starting', nativeToken: 'a-1' })
    // Its recovery is starting: nothing is armed until the guard's next word on it.
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a recovery held again is the next attempt, not a new count', async () => {
    const h = setup([guardRow('a')], undefined, { guardMs: 1_000 })
    await h.held.boot(async () => {})
    h.held.startAgain('a')
    await vi.advanceTimersByTimeAsync(90_000)
    // Each dispatch is held again a second later: 2 s after the hold, then 4, 8, 16, 30 and 30 s after the attempt before.
    expect(timesOf(h, 'a')).toEqual([2_000, 6_000, 14_000, 30_000, 60_000, 90_000])
  })

  it("another agent's pass, a service's and the ready pass never try it sooner", async () => {
    const h = setup([guardRow('a'), row('b', heldLaunch('native'))], (only) => summary({ held: [...only] }))
    await h.held.boot(async () => {})
    h.held.startAgain('a')
    await h.held.restoreHeld()
    await h.held.restoreHeld('native')
    await h.held.restartHeld('b')
    expect(h.asked).toEqual([['b'], ['b'], ['b']])
    await vi.advanceTimersByTimeAsync(3_000)
    await h.held.restoreHeld('native')
    expect(timesOf(h, 'a')).toEqual([2_000])
    // Its evidence still changing: its own hold arms only its own next attempt, 4 s after the one before.
    await vi.advanceTimersByTimeAsync(3_000)
    expect(timesOf(h, 'a')).toEqual([2_000, 6_000])
  })

  it('a guard-held dispatch does not hurry the other held agents', async () => {
    const h = setup([row('b', heldLaunch('native')), row('a', { state: 'ready' }, { sessionId: '', engine: 'codex' })],
      (only) => only.has('a') ? summary({ restored: ['a'] }) : summary({ held: [...only] }))
    await h.held.boot(async () => {})
    await h.held.restoreHeld()
    await vi.advanceTimersByTimeAsync(6_500)
    h.registry.get('a')!.launch = GUARD('a-0')
    h.held.startAgain('a')
    await vi.advanceTimersByTimeAsync(30_000 - 6_500)
    expect(timesOf(h, 'a')).toEqual([8_500])
    // The shared schedule of the one held for native goes on climbing: 2, 4, 8, then 16 s.
    expect(timesOf(h, 'b')).toEqual([0, 2_000, 6_000, 14_000, 30_000])
  })

  it('a conversation the guard held has the same attempts, bounds and restart answers', async () => {
    // c's relaunch is held again by the guard after every dispatch; d's evidence never settles.
    const h = setup([guardRow('c', 's-c'), guardRow('d', 's-d')], (only) => only.has('d') ? summary({ held: ['d'] }) : summary({ restored: [...only] }), { guardMs: 1_000 })
    await h.held.boot(async () => {})
    h.held.startAgain('c')
    h.held.startAgain('d')
    // A person's restart: an attempt at once, answered as starting, its conversation kept.
    expect(await h.held.restartHeld('c')).toMatchObject({ ok: true, session: { agentId: 'c', sessionId: 's-c' }, resumed: true })
    expect(await h.held.restartHeld('d')).toMatchObject({ ok: true, session: { agentId: 'd', sessionId: 's-d' }, resumed: true })
    await vi.advanceTimersByTimeAsync(16 * 60_000)
    expect(timesOf(h, 'c').slice(0, 4)).toEqual([0, 4_000, 12_000, 28_000])
    expect(timesOf(h, 'c')).toHaveLength(10)
    expect(h.registry.get('c')?.launch).toEqual({ state: 'failed', ...DID_NOT_START })
    expect(h.registry.get('d')?.launch).toEqual({ state: 'failed', ...DID_NOT_START })
    expect([...lines(h, 'held again 10'), ...lines(h, '15 minutes')]).toEqual([
      '[restore] codex · agent c · relaunch held again 10 times · NATIVE_GUARD_REPEATED',
      '[restore] codex · agent d · relaunch held 15 minutes · NATIVE_EVIDENCE_UNSETTLED',
    ])
  })

  it('a guard-held row met with no record, after a core restart, starts one: that pass is attempt 1', async () => {
    const h = setup([guardRow('a')], (only) => summary({ held: [...only] }))
    await h.held.boot(async () => {})
    await h.held.restoreHeld()
    await vi.advanceTimersByTimeAsync(4_000)
    expect(timesOf(h, 'a')).toEqual([0, 4_000])
  })

  it('a held row without startsAgain keeps the shared schedule and its answers of today', async () => {
    const detail = 'Waiting to confirm the engine executable and native hooks.'
    const h = setup([row('a', { state: 'held', service: 'native', nativeToken: 'a-0', detail }, { sessionId: '' })], (only) => summary({ held: [...only] }))
    await h.held.boot(async () => {})
    // Not one the guard held: no attempts of its own.
    h.held.startAgain('a')
    await h.held.restoreHeld()
    await vi.advanceTimersByTimeAsync(6_000)
    expect(timesOf(h, 'a')).toEqual([0, 2_000, 6_000])
    expect(await h.held.restartHeld('a')).toEqual({ ok: false, error: 'SERVICE_UNAVAILABLE', detail })
  })

  it('fails the row on its 10th guard hold after a dispatch, once', async () => {
    const h = setup([guardRow('a')], undefined, { guardMs: 1_000 })
    await h.held.boot(async () => {})
    h.held.startAgain('a')
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(timesOf(h, 'a')).toEqual([2_000, 6_000, 14_000, 30_000, 60_000, 90_000, 120_000, 150_000, 180_000, 210_000])
    expect(h.registry.get('a')?.launch).toEqual({ state: 'failed', ...DID_NOT_START })
    expect(h.announce).toHaveBeenCalledOnce()
    expect(h.announce).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a', launch: { state: 'failed', ...DID_NOT_START } }))
    expect(lines(h, 'NATIVE_GUARD_REPEATED')).toEqual(['[restore] codex · agent a · first launch held again 10 times · NATIVE_GUARD_REPEATED'])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails a first launch whose evidence is still changing 15 minutes after its first hold', async () => {
    const h = setup([guardRow('a')], (only) => summary({ held: [...only] }))
    await h.held.boot(async () => {})
    h.held.startAgain('a')
    await vi.advanceTimersByTimeAsync(15 * 60_000 - 1)
    expect(h.registry.get('a')?.launch).toMatchObject({ state: 'held', startsAgain: true, detail: STARTING_AGAIN })
    expect(h.announce).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(timesOf(h, 'a').at(-1)).toBe(15 * 60_000)
    expect(h.registry.get('a')?.launch).toEqual({ state: 'failed', ...DID_NOT_START })
    expect(h.announce).toHaveBeenCalledOnce()
    expect(lines(h, 'NATIVE_EVIDENCE_UNSETTLED')).toEqual(['[restore] codex · agent a · first launch held 15 minutes · NATIVE_EVIDENCE_UNSETTLED'])
    const attempts = timesOf(h, 'a').length
    await vi.advanceTimersByTimeAsync(60_000)
    expect(timesOf(h, 'a')).toHaveLength(attempts)
  })

  it('says why it is held again once per change, by its service', async () => {
    const reasons = ['native', 'native', 'models', 'PANE_FAILED', 'models', 'store']
    let attempt = 0
    const h = setup([guardRow('a')], (only) => {
      const reason = reasons[attempt++]!
      if (reason === 'PANE_FAILED') return summary({ failed: [{ agentId: 'a', code: reason, reason: 'tmux said no at /Users/sentinel' }] })
      h.registry.get('a')!.launch = GUARD('a-0', reason)
      return summary({ held: [...only] })
    })
    await h.held.boot(async () => {})
    h.held.startAgain('a')
    await vi.advanceTimersByTimeAsync(90_000)
    expect(attempt).toBe(6)
    expect(lines(h, 'could not launch')).toEqual([
      '[restore] a · could not launch from held · native',
      '[restore] a · could not launch from held · models',
      '[restore] a · could not launch from held · PANE_FAILED',
      '[restore] a · could not launch from held · models',
      '[restore] a · could not launch from held · store',
    ])
    expect(lines(h, 'sentinel')).toEqual([])
  })

  it.each([
    ['ready', { state: 'ready' }],
    ['failed', { state: 'failed', error: 'START_TIMEOUT' }],
  ] as const)('forgets the count once the row is %s: a later hold starts at 2 s again', async (_, launch) => {
    const h = setup([guardRow('a')], undefined, { guardMs: 1_000 })
    await h.held.boot(async () => {})
    h.held.startAgain('a')
    // Attempts at 2 and 6 s, the first held again at 3 s; the second's engine comes up (or its start fails).
    await vi.advanceTimersByTimeAsync(6_500)
    h.registry.get('a')!.launch = launch
    await vi.advanceTimersByTimeAsync(60_000)
    // A later launch of it the guard held (a restart): 2 s after that hold, then 4 s, as a new one.
    h.registry.get('a')!.launch = GUARD('z')
    h.held.startAgain('a')
    await vi.advanceTimersByTimeAsync(7_000)
    expect(timesOf(h, 'a')).toEqual([2_000, 6_000, 68_500, 72_500])
  })

  it('forgets an agent stopped or closed while it waits: nothing more is tried', async () => {
    const h = setup([guardRow('a')], (only) => summary({ held: [...only] }))
    await h.held.boot(async () => {})
    h.held.startAgain('a')
    await vi.advanceTimersByTimeAsync(2_000)
    h.registry.delete('a')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(timesOf(h, 'a')).toEqual([2_000])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('logs an attempt that threw, and the next comes on its schedule', async () => {
    const h = setup([guardRow('a')], (only) => summary({ held: [...only] }))
    h.restore.mockRejectedValueOnce(new TypeError('the registry changed'))
    await h.held.boot(async () => {})
    h.held.startAgain('a')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(h.restore).toHaveBeenCalledTimes(2)
    expect(timesOf(h, 'a')).toEqual([6_000])
    expect(lines(h, 'could not launch')).toEqual(['[restore] a · could not launch from held · TypeError', '[restore] a · could not launch from held · native'])
  })

  it('a dispatch tmux turned away after its journal is an attempt: answered starting, its hold the next attempt', async () => {
    // The respawn journaled its new token, then tmux found the pane changed: failed in the summary, the row starting
    // under that token and watched (lib/restoreAgents.ts).
    const h = setup([guardRow('a')], (only) => {
      h.registry.get('a')!.launch = { state: 'starting', nativeToken: `a-turned-${h.asked.length}` }
      return summary({ failed: [...only].map((agentId) => ({ agentId, code: 'PANE_FAILED', reason: 'The waiting pane changed' })) })
    })
    await h.held.boot(async () => {})
    h.held.startAgain('a')
    await vi.advanceTimersByTimeAsync(500)
    expect(await h.held.restartHeld('a')).toMatchObject({ ok: true, session: { agentId: 'a', launch: { state: 'starting', nativeToken: 'a-turned-1' } }, resumed: false })
    // The watch sees the guard hold it at 1.5 s: the next attempt is 4 s after the restart's, not 2 s after that hold.
    await vi.advanceTimersByTimeAsync(1_000)
    h.registry.get('a')!.launch = GUARD('a-turned-1')
    h.held.startAgain('a')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(timesOf(h, 'a')).toEqual([500, 4_500])
  })

  it('a dispatch the terminal turned away with its pane still the held shell is held before dispatch: the next attempt comes', async () => {
    // Its evidence changed between the journal and the respawn: the row went starting under the new token, and the
    // restore put it back to its hold under the old one, which its pane still is (lib/restoreAgents.ts).
    const h = setup([guardRow('a', 's-a')], (only) => {
      h.registry.get('a')!.launch = { state: 'starting', nativeToken: `a-${h.asked.length}` }
      h.registry.get('a')!.launch = GUARD('a-0')
      return summary({ held: [...only] })
    })
    await h.held.boot(async () => {})
    h.held.startAgain('a')
    await vi.advanceTimersByTimeAsync(6_000)
    expect(timesOf(h, 'a')).toEqual([2_000, 6_000])
    expect(await h.held.restartHeld('a')).toMatchObject({ ok: true, session: { agentId: 'a', launch: GUARD('a-0') }, resumed: true })
  })

  it.each([
    ['its own attempt', async (h: ReturnType<typeof setup>) => { h.held.startAgain('a'); await vi.advanceTimersByTimeAsync(2_000) }],
    ['a pass', async (h: ReturnType<typeof setup>) => { await h.held.restoreHeld() }],
    ["a person's restart", async (h: ReturnType<typeof setup>) => { await h.held.restartHeld('a') }],
  ] as const)('announces a row %s failed, once: its pane, kept, tells discovery nothing', async (_, attempt) => {
    // Its request unreadable, its pane gone or not its held shell, its build refused: the restore failed it.
    const h = setup([guardRow('a')], (only) => {
      for (const id of only) h.registry.get(id)!.launch = { state: 'failed', ...DID_NOT_START }
      return summary({ failed: [...only].map((agentId) => ({ agentId, code: DID_NOT_START.error, reason: DID_NOT_START.detail })) })
    })
    await h.held.boot(async () => {})
    await attempt(h)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(h.announce).toHaveBeenCalledOnce()
    expect(h.announce).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a', launch: { state: 'failed', ...DID_NOT_START } }))
  })

  it('waits with no bound while held for another service: only its holds for native count toward the 15 minutes', async () => {
    let service = 'models'
    const h = setup([guardRow('a')], (only) => {
      h.registry.get('a')!.launch = GUARD('a-0', service)
      return summary({ held: [...only] })
    })
    await h.held.boot(async () => {})
    h.held.startAgain('a')
    await vi.advanceTimersByTimeAsync(60 * 60_000)
    expect(h.registry.get('a')?.launch).toEqual(GUARD('a-0', 'models'))
    // Held for native from here: its 15 minutes start now.
    service = 'native'
    await vi.advanceTimersByTimeAsync(14 * 60_000)
    expect(h.registry.get('a')?.launch).toEqual(GUARD('a-0'))
    expect(h.announce).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2 * 60_000)
    expect(h.registry.get('a')?.launch).toEqual({ state: 'failed', ...DID_NOT_START })
    expect(lines(h, 'NATIVE_EVIDENCE_UNSETTLED')).toEqual(['[restore] codex · agent a · first launch held 15 minutes · NATIVE_EVIDENCE_UNSETTLED'])
  })

  it('says nothing of a row its pass failed: the restore said it, once', async () => {
    const h = setup([row('a', HELD), guardRow('b')], (only) => {
      for (const id of only) h.registry.get(id)!.launch = { state: 'failed', error: 'GRID_ENGINE_UNSUPPORTED', detail: 'No way to its grid.' }
      return summary({ failed: [...only].map((agentId) => ({ agentId, code: 'GRID_ENGINE_UNSUPPORTED', reason: 'No way to its grid.' })) })
    })
    await h.held.boot(async () => {})
    await h.held.restoreHeld()
    expect(lines(h, 'could not launch')).toEqual([])
  })

  describe("a person's restart", () => {
    it("a person's restart runs an attempt at once, and it counts", async () => {
      const h = setup([guardRow('a')], undefined, { guardMs: 1_000 })
      await h.held.boot(async () => {})
      h.held.startAgain('a')
      await vi.advanceTimersByTimeAsync(500)
      expect(await h.held.restartHeld('a')).toMatchObject({ ok: true, session: { agentId: 'a', launch: { state: 'starting' } }, resumed: false })
      expect(h.log).toHaveBeenCalledWith('[restart] a launched from held')
      await vi.advanceTimersByTimeAsync(5_000)
      // Held again at 1.5 s: the next is 4 s after the restart's attempt, which was the first.
      expect(timesOf(h, 'a')).toEqual([500, 4_500])
    })

    it.each([
      ['dispatched', (id: string) => summary({ restored: [id] }), 'starting'],
      ['was held again by changing evidence', (id: string) => summary({ held: [id] }), 'held'],
      ['could not read its pane', (id: string) => summary({ unsurveyed: [id] }), 'held'],
    ] as const)('answers success when the attempt %s', async (_, answer, state) => {
      const h = setup([guardRow('a')], (only) => answer([...only][0]!))
      await h.held.boot(async () => {})
      h.held.startAgain('a')
      expect(await h.held.restartHeld('a')).toMatchObject({ ok: true, session: { agentId: 'a', launch: { state } }, resumed: false })
    })

    it('answers the failed state when the attempt or a bound failed the row', async () => {
      let offset = 0
      const h = setup([guardRow('a'), guardRow('b')], (only) => {
        if (!only.has('a')) return summary({ held: [...only] })
        // Its request could not be read (core/agents/restoreLaunch.ts): the restore failed the row.
        h.registry.get('a')!.launch = { state: 'failed', ...DID_NOT_START }
        return summary({ failed: [{ agentId: 'a', code: DID_NOT_START.error, reason: DID_NOT_START.detail }] })
      }, { now: () => performance.now() + offset })
      await h.held.boot(async () => {})
      expect(await h.held.restartHeld('a')).toEqual({ ok: false, ...DID_NOT_START })
      // A bound: its evidence still changing 15 minutes after its first hold, on its own clock.
      h.held.startAgain('b')
      offset = 15 * 60_000
      expect(await h.held.restartHeld('b')).toEqual({ ok: false, ...DID_NOT_START })
      expect(h.registry.get('b')?.launch).toEqual({ state: 'failed', ...DID_NOT_START })
      expect(lines(h, 'NATIVE_EVIDENCE_UNSETTLED')).toEqual(['[restore] codex · agent b · first launch held 15 minutes · NATIVE_EVIDENCE_UNSETTLED'])
    })
  })

  it('three first launches held by one upgrade keep their own counts; a pass turned away by full flights is no attempt', async () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f']
    const h = setup(ids.map((id) => guardRow(id)), (only) => summary({ held: [...only] }))
    const answer = h.restore.getMockImplementation()!
    const waiting: Array<() => void> = []
    let hang = true
    h.restore.mockImplementation(async (only, current) => {
      const result = await answer(only, current)
      if (hang) await new Promise<void>((done) => waiting.push(done))
      return result
    })
    await h.held.boot(async () => {})
    for (const id of ids) h.held.startAgain(id)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.asked.flat()).toEqual(['a', 'b', 'c', 'd'])
    // The two turned away wait for a flight's end: no timer spins meanwhile.
    expect(vi.getTimerCount()).toBe(0)
    hang = false
    waiting.splice(0).forEach((done) => done())
    await vi.advanceTimersByTimeAsync(0)
    expect(h.asked.flat()).toEqual(ids)
    await vi.advanceTimersByTimeAsync(5_000)
    // Each tried once so far, so each one's next came 4 s after its own (the two turned away again at 6 s as soon as a
    // flight ended), not 8 s: a pass turned away is no attempt.
    expect(timesOf(h, 'a')).toEqual([2_000, 6_000])
    for (const id of ids) expect(timesOf(h, id)).toHaveLength(2)
  })

  it('two restarts and a due attempt at once run one flight and dispatch once', async () => {
    const h = setup([guardRow('a')])
    const answer = h.restore.getMockImplementation()!
    let finish!: () => void
    h.restore.mockImplementationOnce(async (only, current) => { await new Promise<void>((done) => { finish = done }); return answer(only, current) })
    await h.held.boot(async () => {})
    h.held.startAgain('a')
    await vi.advanceTimersByTimeAsync(2_000)
    expect(h.restore).toHaveBeenCalledOnce()
    const restarts = [h.held.restartHeld('a')!, h.held.restartHeld('a')!]
    await vi.advanceTimersByTimeAsync(0)
    finish()
    const starting = { ok: true, session: { agentId: 'a', launch: { state: 'starting', nativeToken: 'a-1' } }, resumed: false }
    expect(await Promise.all(restarts)).toMatchObject([starting, starting])
    expect(h.restore).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('reads only its own clock: Date stepped back an hour, the attempt still comes on time', async () => {
    const h = setup([guardRow('a')], (only) => summary({ held: [...only] }))
    await h.held.boot(async () => {})
    h.held.startAgain('a')
    vi.setSystemTime(Date.now() - 3_600_000)
    await vi.advanceTimersByTimeAsync(2_000)
    expect(timesOf(h, 'a')).toEqual([2_000])
    // Stepped forward a day: nothing early, no burst.
    vi.setSystemTime(Date.now() + 86_400_000)
    await vi.advanceTimersByTimeAsync(3_999)
    expect(timesOf(h, 'a')).toEqual([2_000])
    await vi.advanceTimersByTimeAsync(1)
    expect(timesOf(h, 'a')).toEqual([2_000, 6_000])
  })
})
