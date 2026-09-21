import { describe, expect, it, vi } from 'vitest'
import { AttachTracker } from './attachTracker.js'

type Engine = 'opencode' | 'claude'
const subject = (sessionId: string, engine: Engine = 'claude') => ({ sessionId, agentId: `agent-${sessionId}`, engine })

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

describe('AttachTracker', () => {
  it('a second plain attach of the same session joins the one in flight', async () => {
    const tracker = new AttachTracker<Engine>()
    const first = deferred<boolean>()
    const start = vi.fn(() => first.promise)
    const a = tracker.attach(subject('s1'), false, start)
    const b = tracker.attach(subject('s1'), false, start)
    expect(start).toHaveBeenCalledTimes(1)
    first.resolve(true)
    expect(await Promise.all([a, b])).toEqual([true, true])
    expect(tracker.attaching()).toEqual([])
  })

  it('a reset waits for the attach in flight, then folds afresh', async () => {
    const tracker = new AttachTracker<Engine>()
    const first = deferred<boolean>()
    const order: string[] = []
    const a = tracker.attach(subject('s1'), false, () => first.promise)
    const b = tracker.attach(subject('s1'), true, async () => { order.push('reset'); return true })
    await Promise.resolve()
    expect(order).toEqual([])
    first.resolve(true)
    expect(await Promise.all([a, b])).toEqual([true, true])
    expect(order).toEqual(['reset'])
  })

  it('a reset still runs after the attach it waited on failed', async () => {
    const tracker = new AttachTracker<Engine>()
    const first = deferred<boolean>()
    const a = tracker.attach(subject('s1'), false, () => first.promise).catch(() => 'failed')
    const b = tracker.attach(subject('s1'), true, async () => true)
    first.reject(new Error('boom'))
    expect(await a).toBe('failed')
    expect(await b).toBe(true)
  })

  it('a start that throws synchronously frees the slot', async () => {
    const tracker = new AttachTracker<Engine>()
    await expect(tracker.attach(subject('s1'), false, () => { throw new Error('sync') })).rejects.toThrow('sync')
    expect(tracker.attaching()).toEqual([])
    expect(await tracker.attach(subject('s1'), false, async () => true)).toBe(true)
  })

  it('different sessions run side by side', async () => {
    const tracker = new AttachTracker<Engine>()
    const one = deferred<boolean>()
    const two = deferred<boolean>()
    const starts = vi.fn()
    const a = tracker.attach(subject('s1'), false, () => { starts('s1'); return one.promise })
    const b = tracker.attach(subject('s2'), false, () => { starts('s2'); return two.promise })
    expect(starts.mock.calls.map((c) => c[0])).toEqual(['s1', 's2'])
    two.resolve(false)
    one.resolve(true)
    expect(await Promise.all([a, b])).toEqual([true, false])
  })

  // What `/api/status` shows: the store that is slow, by name, longest-running first.
  it('reports what is being read, longest-running first', async () => {
    let clock = 1_000
    const tracker = new AttachTracker<Engine>({ now: () => clock })
    const slow = deferred<boolean>()
    const fast = deferred<boolean>()
    void tracker.attach(subject('ses_slow', 'opencode'), false, () => slow.promise)
    clock += 40_000
    void tracker.attach(subject('ses_fast'), false, () => fast.promise)
    clock += 500
    expect(tracker.attaching()).toEqual([
      { sessionId: 'ses_slow', agentId: 'agent-ses_slow', engine: 'opencode', sinceMs: 40_500 },
      { sessionId: 'ses_fast', agentId: 'agent-ses_fast', engine: 'claude', sinceMs: 500 },
    ])
    fast.resolve(true)
    await vi.waitFor(() => expect(tracker.attaching().map((a) => a.sessionId)).toEqual(['ses_slow']))
    slow.resolve(true)
  })

  it('runs at most `concurrency` at once, in the order asked, and a stuck one holds only its own slot', async () => {
    const tracker = new AttachTracker<Engine>({ concurrency: 2 })
    const gates = new Map<string, ReturnType<typeof deferred<boolean>>>()
    const started: string[] = []
    const results = ['a', 'b', 'c', 'd'].map((id) => tracker.attach(subject(id), false, () => {
      started.push(id)
      const gate = deferred<boolean>()
      gates.set(id, gate)
      return gate.promise
    }))
    await Promise.resolve()
    expect(started).toEqual(['a', 'b'])
    expect(tracker.queued()).toBe(2)
    expect(tracker.attaching().map((a) => a.sessionId).sort()).toEqual(['a', 'b'])
    // 'a' is the agent whose store hangs. Everything behind it still gets read, through b's slot.
    gates.get('b')!.resolve(true)
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c']))
    expect(tracker.queued()).toBe(1)
    gates.get('c')!.resolve(true)
    await vi.waitFor(() => expect(started).toEqual(['a', 'b', 'c', 'd']))
    expect(tracker.queued()).toBe(0)
    gates.get('d')!.resolve(false)
    expect(await Promise.all(results.slice(1))).toEqual([true, true, false])
    expect(tracker.attaching().map((a) => a.sessionId)).toEqual(['a'])
    gates.get('a')!.resolve(true)
    expect(await results[0]).toBe(true)
  })

  it('a joiner takes no slot, and a newcomer cannot jump the queue', async () => {
    const tracker = new AttachTracker<Engine>({ concurrency: 1 })
    const first = deferred<boolean>()
    const started: string[] = []
    const run = (id: string) => tracker.attach(subject(id), false, () => {
      started.push(id)
      return id === 'a' ? first.promise : Promise.resolve(true)
    })
    const a = run('a')
    const b = run('b')
    const joiner = run('a')
    await Promise.resolve()
    expect(started).toEqual(['a'])
    expect(tracker.queued()).toBe(1)
    first.resolve(true)
    // 'c' asks the instant 'a' finishes; 'b' was first in line.
    await a
    const c = run('c')
    await Promise.all([b, c, joiner])
    expect(started).toEqual(['a', 'b', 'c'])
  })

  it('names an attach that runs long, once, and not one that finished', async () => {
    vi.useFakeTimers()
    try {
      const onSlow = vi.fn()
      const tracker = new AttachTracker<Engine>({ slowMs: 15_000, onSlow })
      const stuck = deferred<boolean>()
      const quick = deferred<boolean>()
      void tracker.attach(subject('stuck', 'opencode'), false, () => stuck.promise)
      const done = tracker.attach(subject('quick'), false, () => quick.promise)
      quick.resolve(true)
      await done
      await vi.advanceTimersByTimeAsync(15_000)
      expect(onSlow).toHaveBeenCalledTimes(1)
      expect(onSlow.mock.calls[0][0]).toMatchObject({ sessionId: 'stuck', engine: 'opencode' })
      await vi.advanceTimersByTimeAsync(60_000)
      expect(onSlow).toHaveBeenCalledTimes(1)
      stuck.resolve(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
