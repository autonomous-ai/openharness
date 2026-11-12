import { describe, expect, it, vi } from 'vitest'
import { createHachiWakes, WAKE_COALESCE_MS, WAKE_GAP_MS, WAKES_PER_HOUR, type WakeChild } from './hachiWakes.js'

const child = (name: string, machine = 'studio'): WakeChild => ({ key: `m/${name}`, name, machine })

function setup(over: { send?: (items: unknown[]) => Promise<boolean>; closedByHachi?: (c: WakeChild) => boolean } = {}) {
  let clock = 0
  const timers: Array<{ at: number; run: () => void; cancelled: boolean }> = []
  const sent: unknown[][] = []
  const count = vi.fn()
  const log = vi.fn()
  const wakes = createHachiWakes({
    now: () => clock,
    later: (ms, run) => { const t = { at: clock + ms, run, cancelled: false }; timers.push(t); return () => { t.cancelled = true } },
    send: over.send ?? (async (items) => { sent.push(items); return true }),
    closedByHachi: over.closedByHachi ?? (() => false),
    count, log,
  })
  /** Moves the clock on, running each timer that comes due, in order. */
  const advance = async (ms: number) => {
    const until = clock + ms
    for (;;) {
      const due = timers.filter((t) => !t.cancelled && t.at <= until).sort((a, b) => a.at - b.at)[0]
      if (!due) break
      clock = due.at
      due.cancelled = true
      due.run()
      await new Promise((done) => setImmediate(done))
    }
    clock = until
  }
  const counted = (metric: string) => count.mock.calls.filter(([m]) => m === metric).length
  return { wakes, sent, count, counted, log, advance, timers }
}

describe('Hachi\'s wakes', () => {
  it('wakes for a harness that needs the person, is done or stopped, after a first state it only learns', async () => {
    const t = setup()
    const api = child('api'), rev = child('rev', 'laptop'), gpu = child('gpu', 'box')
    for (const c of [api, rev, gpu]) t.wakes.heard(c, 'working')
    // What it was doing when first heard is no change: an idle harness found at a restart says nothing.
    t.wakes.heard(child('old'), 'idle')
    t.wakes.heard(api, 'idle')
    t.wakes.heard(rev, 'needs_person')
    t.wakes.heard(gpu, 'gone')
    // Still working, or working again: nothing to say.
    t.wakes.heard(child('old'), 'working')
    await t.advance(WAKE_COALESCE_MS)
    expect(t.sent).toEqual([[{ name: 'api', machine: 'studio', state: 'done' }, { name: 'rev', machine: 'laptop', state: 'needs_person' }, { name: 'gpu', machine: 'box', state: 'stopped' }]])
    expect([t.counted('hachi_wake_done'), t.counted('hachi_wake_needs_person'), t.counted('hachi_wake_stopped')]).toEqual([1, 1, 1])
  })

  it('coalesces the changes of 20 s into one line, the last state of each harness', async () => {
    const t = setup()
    const api = child('api'), rev = child('rev')
    t.wakes.heard(api, 'working'); t.wakes.heard(rev, 'working')
    t.wakes.heard(api, 'needs_person')
    await t.advance(WAKE_COALESCE_MS - 1)
    t.wakes.heard(api, 'working')
    t.wakes.heard(api, 'idle')
    t.wakes.heard(rev, 'idle')
    expect(t.sent).toEqual([])
    await t.advance(1)
    expect(t.sent).toEqual([[{ name: 'api', machine: 'studio', state: 'done' }, { name: 'rev', machine: 'studio', state: 'done' }]])
  })

  it('wakes at most once a minute, holding what comes meanwhile, and 30 times an hour, dropping the rest by count', async () => {
    const t = setup()
    const api = child('api')
    t.wakes.heard(api, 'working')
    t.wakes.heard(api, 'idle')
    await t.advance(WAKE_COALESCE_MS)
    t.wakes.heard(api, 'working')
    t.wakes.heard(api, 'needs_person')
    await t.advance(WAKE_COALESCE_MS)
    expect(t.sent).toHaveLength(1)
    await t.advance(WAKE_GAP_MS - WAKE_COALESCE_MS)
    expect(t.sent).toHaveLength(2)
    // Ten more than the hour holds, a minute apart: within one hour.
    for (let i = 0; i < WAKES_PER_HOUR + 10; i++) {
      t.wakes.heard(api, 'working')
      t.wakes.heard(api, 'idle')
      await t.advance(WAKE_GAP_MS)
    }
    expect(t.sent).toHaveLength(WAKES_PER_HOUR)
    expect(t.counted('hachi_wake_dropped_limit')).toBeGreaterThan(0)
    // An hour on, it wakes again.
    await t.advance(60 * 60_000)
    t.wakes.heard(api, 'working')
    t.wakes.heard(api, 'idle')
    await t.advance(WAKE_COALESCE_MS)
    expect(t.sent).toHaveLength(WAKES_PER_HOUR + 1)
  })

  it('does not wake Hachi for a harness it closed itself: that is counted as closed after reading it', async () => {
    const closed = new Set(['m/api'])
    const t = setup({ closedByHachi: (c) => closed.has(c.key) })
    const api = child('api'), rev = child('rev')
    t.wakes.heard(api, 'idle'); t.wakes.heard(rev, 'idle')
    t.wakes.heard(api, 'stopped')
    await t.advance(WAKE_COALESCE_MS)
    expect(t.sent).toEqual([])
    expect(t.counted('hachi_closed_started')).toBe(1)
    t.wakes.heard(rev, 'gone')
    await t.advance(WAKE_GAP_MS)
    expect(t.sent).toEqual([[{ name: 'rev', machine: 'studio', state: 'stopped' }]])
  })

  it('times how soon a question in a harness Hachi started was answered', async () => {
    const t = setup()
    const api = child('api')
    t.wakes.heard(api, 'working')
    for (const [after, metric] of [[30_000, 'hachi_needs_person_answer_under_1m'], [5 * 60_000, 'hachi_needs_person_answer_1m_to_15m'], [20 * 60_000, 'hachi_needs_person_answer_over_15m']] as const) {
      t.wakes.heard(api, 'needs_person')
      await t.advance(after)
      t.wakes.heard(api, 'working')
      expect(t.counted(metric)).toBe(1)
    }
    // Gone while it waited: no answer to time.
    t.wakes.heard(api, 'needs_person')
    t.wakes.heard(api, 'stopped')
    expect(t.count.mock.calls.filter(([m]) => String(m).startsWith('hachi_needs_person_answer_'))).toHaveLength(3)
  })

  it('counts a line the mailbox did not take, and drops what waits once Hachi is off, by count', async () => {
    const failing = setup({ send: async () => false })
    const api = child('api')
    failing.wakes.heard(api, 'working'); failing.wakes.heard(api, 'idle')
    await failing.advance(WAKE_COALESCE_MS)
    expect(failing.counted('hachi_mailbox_failed')).toBe(1)
    const throwing = setup({ send: async () => { throw new Error('no daemon') } })
    throwing.wakes.heard(api, 'working'); throwing.wakes.heard(api, 'idle')
    await throwing.advance(WAKE_COALESCE_MS)
    expect(throwing.counted('hachi_mailbox_failed')).toBe(1)
    expect(throwing.log).toHaveBeenCalledWith('[hachi] the wake was not delivered: no daemon')
    const off = setup()
    off.wakes.heard(api, 'working'); off.wakes.heard(api, 'idle'); off.wakes.heard(child('rev'), 'working'); off.wakes.heard(child('rev'), 'stopped')
    off.wakes.drop()
    await off.advance(WAKE_COALESCE_MS)
    expect(off.sent).toEqual([])
    expect(off.counted('hachi_wake_dropped_off')).toBe(2)
    // Forgotten, a harness's next state is a first one again.
    off.wakes.heard(api, 'working')
    await off.advance(WAKE_COALESCE_MS)
    expect(off.sent).toEqual([])
  })
})
