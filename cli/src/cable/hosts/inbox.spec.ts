import { describe, expect, it } from 'vitest'
import { Inbox } from './inbox.js'

/** A fake clock: `advance` runs each timer that falls due, and `pending` counts those still set. */
function setup() {
  let clock = 0
  const timers: Array<{ at: number; run: () => void; on: boolean }> = []
  const inbox = new Inbox({
    now: () => clock,
    after: (ms, run) => {
      const timer = { at: clock + ms, run, on: true }
      timers.push(timer)
      return () => { timer.on = false }
    },
  })
  const advance = (ms: number): void => {
    clock += ms
    for (const timer of timers) if (timer.on && timer.at <= clock) { timer.on = false; timer.run() }
  }
  const pending = (): number => timers.filter((timer) => timer.on).length
  return { inbox, advance, pending }
}

/** The promise's answer, read after the work it started has run; `undefined` while it waits. */
function track<T>(answer: Promise<T>) {
  const state: { value?: T } = {}
  void answer.then((value) => { state.value = value })
  return state
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve))

/** A session whose poll ran its 25 s and closed just now. */
function polledOnce(t: ReturnType<typeof setup>, sessionId: string): void {
  void t.inbox.poll(`first-${sessionId}`, sessionId)
  t.advance(25_000)
}

describe('Inbox', () => {
  it('a poll is held 25 s and then answers {}', async () => {
    const t = setup()
    const poll = track(t.inbox.poll('p1', 's1'))
    t.advance(24_999)
    await settle()
    expect(poll.value).toBeUndefined()
    t.advance(1)
    await settle()
    expect(poll.value).toEqual({})
    expect(t.pending()).toBe(0)
  })

  it('a newer poll answers the older {}', async () => {
    const t = setup()
    const older = track(t.inbox.poll('p1', 's1'))
    const other = track(t.inbox.poll('p2', 's2'))
    const newer = track(t.inbox.poll('p3', 's1'))
    await settle()
    expect(older.value).toEqual({})
    // Held, not answered at once: the mod would ask again at once.
    expect(newer.value).toBeUndefined()
    expect(other.value).toBeUndefined()
    expect(t.pending()).toBe(2)
    // The core tells the older one gone too; the newer one stays held.
    t.inbox.gone('p1')
    await settle()
    expect(newer.value).toBeUndefined()
    t.advance(25_000)
    await settle()
    expect(newer.value).toEqual({})
  })

  it('gone ends the poll', async () => {
    const t = setup()
    const poll = track(t.inbox.poll('p1', 's1'))
    const other = track(t.inbox.poll('p2', 's2'))
    t.inbox.gone('p1')
    t.inbox.gone('never-opened')
    await settle()
    expect(poll.value).toEqual({})
    expect(other.value).toBeUndefined()
    expect(t.pending()).toBe(1)
  })

  it('a transcript answers the open poll and deliver is taken', async () => {
    const t = setup()
    const poll = track(t.inbox.poll('p1', 's1'))
    const other = track(t.inbox.poll('p2', 's2'))
    expect(await t.inbox.deliver('s1', 'run the tests')).toBe('taken')
    await settle()
    expect(poll.value).toEqual({ text: 'run the tests' })
    expect(other.value).toBeUndefined()
    expect(t.pending()).toBe(1)
    // The mod opens its next poll at once.
    expect(t.inbox.ready('s1')).toBe(true)
  })

  it('a transcript waits for the poll that opens within 5 s', async () => {
    const t = setup()
    polledOnce(t, 's1')
    const sent = track(t.inbox.deliver('s1', 'hello'))
    t.advance(4_999)
    await settle()
    expect(sent.value).toBeUndefined()
    const next = track(t.inbox.poll('p2', 's1'))
    await settle()
    expect(next.value).toEqual({ text: 'hello' })
    expect(sent.value).toBe('taken')
    expect(t.pending()).toBe(0)
    // Taken once: the poll after it is held.
    const after = track(t.inbox.poll('p3', 's1'))
    await settle()
    expect(after.value).toBeUndefined()
  })

  it('no poll in 5 s is missed and the transcript is dropped', async () => {
    const t = setup()
    polledOnce(t, 's1')
    const sent = track(t.inbox.deliver('s1', 'hello'))
    t.advance(5_000)
    await settle()
    expect(sent.value).toBe('missed')
    const late = track(t.inbox.poll('p2', 's1'))
    await settle()
    expect(late.value).toBeUndefined()
  })

  it('ready: open, closed 34 s ago, not closed 36 s ago, never polled', () => {
    const t = setup()
    void t.inbox.poll('p1', 's1')
    expect(t.inbox.ready('s1')).toBe(true)
    t.advance(25_000)
    t.advance(34_000)
    expect(t.inbox.ready('s1')).toBe(true)
    t.advance(2_000)
    expect(t.inbox.ready('s1')).toBe(false)
    expect(t.inbox.ready('never')).toBe(false)
  })

  it('a session never polled is missed at once, without waiting', async () => {
    const t = setup()
    const sent = track(t.inbox.deliver('never', 'hello'))
    await settle()
    expect(sent.value).toBe('missed')
    expect(t.pending()).toBe(0)
  })

  it('a second transcript while one waits is busy', async () => {
    const t = setup()
    polledOnce(t, 's1')
    const first = track(t.inbox.deliver('s1', 'one'))
    const second = track(t.inbox.deliver('s1', 'two'))
    await settle()
    expect(second.value).toBe('busy')
    const next = track(t.inbox.poll('p2', 's1'))
    await settle()
    expect(next.value).toEqual({ text: 'one' })
    expect(first.value).toBe('taken')
  })

  it('keeps at most 256 closed-poll times and drops those older than 35 s', () => {
    const t = setup()
    const closeSession = (i: number): void => {
      void t.inbox.poll(`p${i}`, `s${i}`)
      t.inbox.gone(`p${i}`)
    }
    for (let i = 0; i < 256; i++) closeSession(i)
    expect(t.inbox.ready('s0')).toBe(true)
    // s0 closes again and is the newest: the next one in takes the place of s1, the oldest.
    closeSession(0)
    closeSession(256)
    expect(t.inbox.ready('s0')).toBe(true)
    expect(t.inbox.ready('s1')).toBe(false)
    expect(t.inbox.ready('s2')).toBe(true)
    expect(t.inbox.ready('s256')).toBe(true)
    t.advance(36_000)
    expect(t.inbox.ready('s256')).toBe(false)
  })

  it('closeAll answers every poll {} and every waiting transcript missed, and leaves no timer', async () => {
    const t = setup()
    polledOnce(t, 's3')
    const a = track(t.inbox.poll('p1', 's1'))
    const b = track(t.inbox.poll('p2', 's2'))
    const sent = track(t.inbox.deliver('s3', 'hello'))
    t.inbox.closeAll()
    await settle()
    expect(a.value).toEqual({})
    expect(b.value).toEqual({})
    expect(sent.value).toBe('missed')
    expect(t.pending()).toBe(0)
    // The core that held them is gone, and the mod waits 60 s after a failed poll: none is ready.
    expect(t.inbox.ready('s1')).toBe(false)
    expect(t.inbox.ready('s3')).toBe(false)
    const next = track(t.inbox.poll('p3', 's3'))
    await settle()
    expect(next.value).toBeUndefined()
  })
})
