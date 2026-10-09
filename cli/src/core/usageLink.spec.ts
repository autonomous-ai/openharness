import { afterEach, describe, expect, it, vi } from 'vitest'
import { createUsageLink } from './usageLink.js'
import { usageTarget, type AgentUsageTarget } from '../lib/agentUsageWire.js'

const target = usageTarget({ agentId: 'a', sessionId: 's', engine: 'claude', transcriptPath: '/fixture/a.jsonl', registeredAt: 1, cwd: '/fixture' })
const value = { totalTokens: 12, updatedAt: '2026-10-01T00:00:00Z' }
const deferred = <T>() => { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }

describe('usage snapshots across the optional service', () => {
  afterEach(() => vi.useRealTimers())

  it('publishes progress throughout continuous transcript changes instead of starving the reading', async () => {
    vi.useFakeTimers()
    let now = 0
    const pending: Array<ReturnType<typeof deferred<Record<string, unknown>>>> = []
    const link = createUsageLink({ call: () => { const task = deferred<Record<string, unknown>>(); pending.push(task); return task.promise }, changed: vi.fn(), now: () => now })
    link.port.changed(target)
    for (let round = 0; round < 4; round++) {
      await Promise.resolve()
      for (let second = 0; second < 16; second++) {
        now += 1000; link.port.changed(target); await vi.advanceTimersByTimeAsync(1000)
      }
      pending[round].resolve({ target, value: { ...value, totalTokens: round + 1 } })
      await Promise.resolve(); await Promise.resolve()
      expect(link.port.get(target)?.totalTokens).toBe(round + 1)
      await Promise.resolve(); await Promise.resolve()
    }
    link.port.stop()
    for (const task of pending) task.resolve({ target, value })
    await link.settled()
  })

  it('serves copied snapshots to inline services for exact rows with omitted optional fields', async () => {
    const raw: AgentUsageTarget = { agentId: 'a', sessionId: 's', engine: 'claude', transcriptPath: '/fixture/a.jsonl', registeredAt: 1, cwd: '/fixture' }
    const link = createUsageLink({ call: async payload => ({ ...payload, value }), changed: vi.fn() })
    expect(await link.readSnapshot(raw, [raw])).toBeNull()
    await link.settled()
    const copy = await link.readSnapshot(raw, [raw])
    expect(copy).toEqual(value)
    copy!.totalTokens = 99
    expect(link.port.get(raw)).toEqual(value)
    expect(await link.readSnapshot(raw, [{ ...raw, registeredAt: 2 }])).toBeNull()
    link.port.stop()
  })

  it('reads memory on a cold frame, validates replies, keeps outages from changing a warm value, and never polls', async () => {
    const changed = vi.fn(), call = vi.fn(async (payload: Record<string, unknown>) => ({ ...payload, value }))
    let now = 0
    const link = createUsageLink({ call, changed, now: () => now })
    expect(link.port.get(target)).toBeNull()
    await link.settled()
    expect(link.port.get(target)).toEqual(value)
    expect(changed).toHaveBeenCalledWith(target)
    for (let i = 0; i < 100; i++) link.port.get(target)
    expect(call).toHaveBeenCalledOnce()
    const bad = [{ error: 'SERVICE_UNAVAILABLE' }, { target, value: { totalTokens: -1 } }, { target: { ...target, cwd: '/other' }, value }]
    for (const answer of bad) {
      call.mockResolvedValueOnce(answer as never)
      now += 20_000; link.port.changed(target); await link.settled()
      expect(link.port.get(target)).toEqual(value)
    }
    call.mockRejectedValueOnce(new Error('worker crashed'))
    now += 20_000; link.port.changed(target); await link.settled()
    expect(link.port.get(target)).toEqual(value)
    now += 20_000; link.port.changed(target); await link.settled()
    expect(changed).toHaveBeenCalledOnce()
    call.mockResolvedValueOnce({ target, value: null } as never)
    now += 20_000; link.port.changed(target); await link.settled()
    expect(link.port.get(target)).toBeNull()
    expect(changed).toHaveBeenCalledTimes(2)
    link.port.stop()
    expect(link.port.get(target)).toBeNull()
    link.port.changed(target); link.connected()
  })

  it('refreshes warm workers after reconnect and drops old connections, rebinds, and retains progress when newer transcript events arrive', async () => {
    const pending: Array<{ payload: Record<string, unknown>; done: ReturnType<typeof deferred<Record<string, unknown>>> }> = []
    const link = createUsageLink({ call: payload => { const done = deferred<Record<string, unknown>>(); pending.push({ payload, done }); return done.promise }, changed: vi.fn(), now: () => 0 })
    const tick = async () => { await Promise.resolve(); await Promise.resolve() }
    link.port.get(target); await tick()
    link.connected(); await tick()
    pending[0].done.resolve({ target, value }); await tick()
    expect(link.port.get(target)).toBeNull()
    pending[1].done.resolve({ target, value }); await link.settled()
    expect(link.port.get(target)).toEqual(value)
    const rebound = { ...target, transcriptPath: '/fixture/other.jsonl', codexHome: '/fixture/profile', registeredAt: 2 }
    expect(link.port.get(rebound)).toBeNull(); await tick()
    const newer = { ...rebound, sessionId: 'new' }
    expect(link.port.get(newer)).toBeNull(); await tick()
    pending[2].done.resolve({ target: rebound, value }); await tick()
    expect(link.port.get(newer)).toBeNull()
    vi.useFakeTimers()
    link.port.changed(newer)
    pending[3].done.resolve({ target: newer, value }); await tick()
    expect(link.port.get(newer)).toEqual(value)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(pending).toHaveLength(5)
    pending[4].done.resolve({ target: newer, value }); await link.settled()
    expect(link.port.get(newer)).toEqual(value)
    link.port.changed(newer)
    link.disconnected()
    expect(vi.getTimerCount()).toBe(0)
    expect(link.port.get(newer)).toEqual(value)
    link.connected(); await tick()
    link.port.stop()
    pending[5].done.resolve({ target: newer, value: null }); await link.settled()
  })

  it('coalesces bursts into one bounded delayed read, copies inputs, and cancels timers on replacement and stop', async () => {
    vi.useFakeTimers()
    let now = 0
    const call = vi.fn(async (payload: Record<string, unknown>) => ({ ...payload, value }))
    const link = createUsageLink({ call, changed: vi.fn(), now: () => now })
    link.port.changed(target); await link.settled()
    for (let i = 0; i < 50; i++) link.port.changed(target)
    expect(vi.getTimerCount()).toBe(1)
    now = 15_000; await vi.advanceTimersByTimeAsync(15_000); await link.settled()
    expect(call).toHaveBeenCalledTimes(2)
    now = 29_900; link.port.changed(target)
    now = 30_400; await vi.advanceTimersByTimeAsync(500); await link.settled()
    expect(call).toHaveBeenCalledTimes(3)
    link.port.changed(target)
    link.port.get({ ...target, cwd: '/fixture/rebound' }); await link.settled()
    expect(vi.getTimerCount()).toBe(0)
    link.port.changed({ ...target, cwd: '/fixture/rebound' })
    link.port.stop()
    expect(vi.getTimerCount()).toBe(0)
    expect(link.port.get({ ...target, engine: 'hermes' })).toBeNull()
  })

  it('bounds interests and concurrent reads, evicting old identities without accepting their replies', async () => {
    const release = deferred<void>()
    let running = 0, maximum = 0
    const call = vi.fn(async (payload: Record<string, unknown>) => {
      running++; maximum = Math.max(maximum, running)
      await release.promise
      running--
      return { ...payload, value }
    })
    const link = createUsageLink({ call, changed: vi.fn() })
    expect(link.port.get({ ...target, sessionId: '' })).toBeNull()
    link.port.changed({ ...target, engine: 'hermes' })
    for (let i = 0; i < 520; i++) link.port.get({ ...target, agentId: `agent-${i}` })
    await Promise.resolve()
    expect(call).toHaveBeenCalledTimes(4)
    release.resolve(); await link.settled()
    expect(maximum).toBe(4)
    expect(link.port.get({ ...target, agentId: 'agent-519' })).toEqual(value)
    expect(link.port.get({ ...target, agentId: 'agent-0' })).toBeNull()
    await link.settled()
    link.port.stop()
  })
})
