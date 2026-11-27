import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDeviceHookCalls, parseInboxPoll, type DeviceHookPort, type InboxAnswer, type InboxPoll } from './deviceHookCalls.js'

/** A devices port whose answers the test gives, one pending call per request. */
function fakeDevices() {
  const polls: Array<{ poll: InboxPoll; resolve(a: InboxAnswer): void; reject(e: Error): void }> = []
  const port: DeviceHookPort = {
    inboxPoll: vi.fn((poll: InboxPoll) =>
      new Promise<InboxAnswer>((resolve, reject) => { polls.push({ poll, resolve, reject }) })),
    inboxGone: vi.fn(),
  }
  return { port, polls }
}

function setup() {
  const devices = fakeDevices()
  let n = 0
  const calls = createDeviceHookCalls({ ready: () => true, devices: () => devices.port, newId: () => `id-${++n}` })
  return { ...devices, calls }
}

const live = () => new AbortController().signal
/** Lets every settled promise run its callbacks, with no timer. */
const flush = () => new Promise((resolve) => setImmediate(resolve))

/** The promise's answer once it settles; `undefined` while it waits. */
function track<T>(answer: Promise<T>) {
  const state: { value?: T } = {}
  void answer.then((value) => { state.value = value })
  return state
}

describe('parseInboxPoll', () => {
  it('parses a poll, and keeps only its session', () => {
    expect(parseInboxPoll({ sessionId: 's1', text: 'x' })).toEqual({ sessionId: 's1' })
  })
})

// The dial only shows a waiting prompt (docs/specs/2026-11-13-device-claude-orca.md): the core holds no approval for it.
describe('createDeviceHookCalls: no approvals', () => {
  it('has the inbox alone, and holds no approval', () => {
    const { calls } = setup()
    expect(Object.keys(calls).sort()).toEqual(['onInbox', 'open', 'watching'])
    expect(calls.open()).toStrictEqual({ polls: 0 })
  })
})

describe('createDeviceHookCalls: inbox', () => {
  it('rejects a missing or 129-character sessionId', async () => {
    const { calls, port } = setup()
    for (const body of [{}, { sessionId: '' }, { sessionId: 'x'.repeat(129) }, { sessionId: 's\n1' }, null, ['s1']]) {
      expect(await calls.onInbox(body, live())).toBe('invalid')
    }
    expect(port.inboxPoll).not.toHaveBeenCalled()
  })

  it('a newer poll answers the older off and tells inboxGone for it', async () => {
    const { calls, port, polls } = setup()
    const olderClient = new AbortController()
    const older = calls.onInbox({ sessionId: 's1' }, olderClient.signal)
    const newer = calls.onInbox({ sessionId: 's1' }, live())
    expect(await older).toBe('off')
    expect(port.inboxGone).toHaveBeenCalledTimes(1)
    expect(port.inboxGone).toHaveBeenCalledWith('id-1')
    expect(port.inboxPoll).toHaveBeenNthCalledWith(2, { pollId: 'id-2', sessionId: 's1' })
    expect(calls.open().polls).toBe(1)

    olderClient.abort()
    polls[0].resolve({ text: 'late' })
    await flush()
    expect(port.inboxGone).toHaveBeenCalledTimes(1)
    expect(calls.open().polls).toBe(1)

    polls[1].resolve({ text: 'hello' })
    expect(await newer).toEqual({ text: 'hello' })
    expect(calls.open().polls).toBe(0)
  })

  it('the 65th open poll is off', async () => {
    const { calls, port } = setup()
    for (let i = 0; i < 64; i += 1) void calls.onInbox({ sessionId: `s${i}` }, live())
    expect(await calls.onInbox({ sessionId: 's64' }, live())).toBe('off')
    expect(port.inboxPoll).toHaveBeenCalledTimes(64)
    // A newer poll for a session already open takes the older's place, so it is held even at the bound.
    void calls.onInbox({ sessionId: 's0' }, live())
    expect(port.inboxPoll).toHaveBeenCalledTimes(65)
    expect(calls.open().polls).toBe(64)
  })

  it('the client going first tells inboxGone', async () => {
    const { calls, port, polls } = setup()
    const client = new AbortController()
    const answer = calls.onInbox({ sessionId: 's1' }, client.signal)
    client.abort()
    expect(await answer).toBe('off')
    expect(port.inboxGone).toHaveBeenCalledTimes(1)
    expect(port.inboxGone).toHaveBeenCalledWith('id-1')
    expect(calls.open().polls).toBe(0)

    polls[0].resolve({ text: 'late' })
    await flush()
    expect(port.inboxGone).toHaveBeenCalledTimes(1)
  })

  it('a client already gone is off, and nothing is forwarded', async () => {
    const { calls, port } = setup()
    const client = new AbortController()
    client.abort()
    expect(await calls.onInbox({ sessionId: 's1' }, client.signal)).toBe('off')
    expect(port.inboxPoll).not.toHaveBeenCalled()
  })

  it('answers the text, or {} when the hold ran out', async () => {
    const { calls, polls } = setup()
    const spoken = calls.onInbox({ sessionId: 's1' }, live())
    const quiet = calls.onInbox({ sessionId: 's2' }, live())
    polls[0].resolve({ text: 'run the tests' })
    polls[1].resolve({})
    expect(await spoken).toEqual({ text: 'run the tests' })
    expect(await quiet).toEqual({})
  })

  it('an off answer and a call that rejects are off', async () => {
    const { calls, polls } = setup()
    const off = calls.onInbox({ sessionId: 's1' }, live())
    const failed = calls.onInbox({ sessionId: 's2' }, live())
    polls[0].resolve({ text: 'ignored', off: true })
    polls[1].reject(new Error('devices gone'))
    expect(await off).toBe('off')
    expect(await failed).toBe('off')
    expect(calls.open()).toEqual({ polls: 0 })
  })

  it('a text over 20,000 characters or not a string is {}', async () => {
    const { calls, polls } = setup()
    const texts: unknown[] = ['x'.repeat(20_001), '', 42, null, 'x'.repeat(20_000), 'x'.repeat(10_000)]
    const answers = texts.map((_text, i) => calls.onInbox({ sessionId: `s${i}` }, live()))
    texts.forEach((text, i) => polls[i].resolve({ text } as InboxAnswer))
    expect(await Promise.all(answers)).toEqual([{}, {}, {}, {}, { text: 'x'.repeat(20_000) }, { text: 'x'.repeat(10_000) }])
  })
})

// Answered 503 at once with no dial, the mod asked again only a minute later, so words said right after a dial was
// plugged in waited 5 s for a poll that did not come (Diego, CLI 0.6.90).
describe('createDeviceHookCalls: no dial watching', () => {
  afterEach(() => { vi.useRealTimers() })

  /** Calls whose dial starts watching at `watch`, as the devices tell the core (core/main.ts `dialWatching`). */
  function unwatched() {
    const devices = fakeDevices()
    let ready = false
    let n = 0
    const calls = createDeviceHookCalls({ ready: () => ready, devices: () => devices.port, newId: () => `id-${++n}` })
    return { ...devices, calls, watch: () => { ready = true; calls.watching() } }
  }

  it('holds the poll 25 s and answers {}, never asking for the devices', async () => {
    vi.useFakeTimers()
    const { port } = fakeDevices()
    const devices = vi.fn(() => port)
    const calls = createDeviceHookCalls({ ready: () => false, devices, newId: () => 'id' })
    const poll = track(calls.onInbox({ sessionId: 's1' }, live()))
    await vi.advanceTimersByTimeAsync(24_999)
    expect(poll.value).toBeUndefined()
    expect(calls.open()).toEqual({ polls: 1 })
    await vi.advanceTimersByTimeAsync(1)
    expect(poll.value).toEqual({})
    expect(calls.open()).toEqual({ polls: 0 })
    expect(devices).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('holds the poll as well when a dial watches and the devices are not there', async () => {
    vi.useFakeTimers()
    const calls = createDeviceHookCalls({ ready: () => true, devices: () => undefined, newId: () => 'id' })
    const poll = track(calls.onInbox({ sessionId: 's1' }, live()))
    await vi.advanceTimersByTimeAsync(24_999)
    expect(poll.value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(poll.value).toEqual({})
  })

  it('a dial that starts watching ends every held poll at once with {}, and the next poll reaches the devices', async () => {
    vi.useFakeTimers()
    const { calls, port, watch } = unwatched()
    const s1 = track(calls.onInbox({ sessionId: 's1' }, live()))
    const s2 = track(calls.onInbox({ sessionId: 's2' }, live()))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(port.inboxPoll).not.toHaveBeenCalled()
    watch()
    await vi.advanceTimersByTimeAsync(0)
    expect(s1.value).toEqual({})
    expect(s2.value).toEqual({})
    expect(calls.open()).toEqual({ polls: 0 })
    expect(vi.getTimerCount()).toBe(0)
    void calls.onInbox({ sessionId: 's1' }, live())
    expect(port.inboxPoll).toHaveBeenCalledWith({ pollId: 'id-1', sessionId: 's1' })
  })

  // The mod takes {} sooner than 1 s for no hold, and asks again only a minute later (harness-device's HELD_MS).
  it('a poll under 1.5 s old when the dial starts watching ends once it is 1.5 s old', async () => {
    vi.useFakeTimers()
    const { calls, watch } = unwatched()
    const poll = track(calls.onInbox({ sessionId: 's1' }, live()))
    await vi.advanceTimersByTimeAsync(500)
    watch()
    await vi.advanceTimersByTimeAsync(999)
    expect(poll.value).toBeUndefined()
    await vi.advanceTimersByTimeAsync(1)
    expect(poll.value).toEqual({})
    expect(vi.getTimerCount()).toBe(0)
  })

  it('a client that goes ends its hold and its timer, before the dial watches or after, and tells the devices nothing', async () => {
    vi.useFakeTimers()
    const { calls, port, watch } = unwatched()
    const before = new AbortController()
    const first = calls.onInbox({ sessionId: 's1' }, before.signal)
    before.abort()
    expect(await first).toBe('off')
    expect(vi.getTimerCount()).toBe(0)
    const after = new AbortController()
    const second = calls.onInbox({ sessionId: 's1' }, after.signal)
    watch()
    after.abort()
    expect(await second).toBe('off')
    expect(vi.getTimerCount()).toBe(0)
    expect(calls.open()).toEqual({ polls: 0 })
    expect(port.inboxGone).not.toHaveBeenCalled()
  })

  it('a newer poll for the session takes a held one\'s place: the older is off, and one timer is left', async () => {
    vi.useFakeTimers()
    const { calls } = unwatched()
    const older = calls.onInbox({ sessionId: 's1' }, live())
    const newer = track(calls.onInbox({ sessionId: 's1' }, live()))
    expect(await older).toBe('off')
    expect(calls.open()).toEqual({ polls: 1 })
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(25_000)
    expect(newer.value).toEqual({})
  })

  it('holds 64 polls at most, one timer each: the 65th is off', async () => {
    vi.useFakeTimers()
    const { calls } = unwatched()
    for (let i = 0; i < 64; i += 1) void calls.onInbox({ sessionId: `s${i}` }, live())
    expect(vi.getTimerCount()).toBe(64)
    expect(await calls.onInbox({ sessionId: 's64' }, live())).toBe('off')
    expect(calls.open()).toEqual({ polls: 64 })
  })
})

describe('createDeviceHookCalls: counts', () => {
  afterEach(() => { vi.useRealTimers() })

  const REFUSED = '[devices] a dial hook call was refused; more are counted once a minute'
  const OVER = '[devices] a dial hook call was over the bound; more are counted once a minute'

  // Counts only, as the paneless events' lines (core/observedHook.ts): a forged or flooding hook is seen, and what it said is not.
  it('says the first refused call and the first over the bound at once, the minute\'s count only if more came; a poll held with no dial is not counted', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const { port } = fakeDevices()
    let ready = false
    let n = 0
    const calls = createDeviceHookCalls({ ready: () => ready, devices: () => port, newId: () => `id-${++n}`, log })
    void calls.onInbox({ sessionId: 's1' }, live())
    vi.advanceTimersByTime(60_000)
    expect(log).not.toHaveBeenCalled()

    ready = true
    expect(await calls.onInbox({ sessionId: 'secret\nsession' }, live())).toBe('invalid')
    expect(log.mock.calls).toEqual([[REFUSED]])
    expect(await calls.onInbox({ sessionId: 'secret-session'.repeat(10) }, live())).toBe('invalid')
    for (let i = 0; i < 64; i += 1) void calls.onInbox({ sessionId: `poll-${i}` }, live())
    expect(await calls.onInbox({ sessionId: 'poll-64' }, live())).toBe('off')
    expect(log.mock.calls).toEqual([[REFUSED], [OVER]])
    vi.advanceTimersByTime(60_000)
    expect(log.mock.calls[2]).toEqual(['[devices] dial hook calls in the last minute: 1 refused, 0 over the bound'])
    vi.advanceTimersByTime(120_000)
    expect(log).toHaveBeenCalledTimes(3)

    // A later minute says its first loss at once again, and one loss alone leaves no minute line.
    expect(await calls.onInbox(null, live())).toBe('invalid')
    expect(log.mock.calls[3]).toEqual([REFUSED])
    vi.advanceTimersByTime(60_000)
    expect(log).toHaveBeenCalledTimes(4)
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|s1|poll-|id-/)
  })
})

describe('createDeviceHookCalls: state', () => {
  it('keeps nothing once every request has ended', async () => {
    const { calls, polls } = setup()
    const client = new AbortController()
    const replaced = calls.onInbox({ sessionId: 's1' }, live())
    const held = calls.onInbox({ sessionId: 's1' }, live())
    const other = calls.onInbox({ sessionId: 's2' }, client.signal)
    const failed = calls.onInbox({ sessionId: 's3' }, live())
    expect(calls.open()).toEqual({ polls: 3 })

    client.abort()
    polls[1].resolve({})
    polls[3].reject(new Error('devices gone'))
    await Promise.all([replaced, held, other, failed])
    expect(calls.open()).toEqual({ polls: 0 })
  })
})
