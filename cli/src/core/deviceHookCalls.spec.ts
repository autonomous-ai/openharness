import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createDeviceHookCalls, parseApproval, parseInboxPoll,
  type ApprovalDecision, type ApprovalRequest, type DeviceHookPort, type InboxAnswer, type InboxPoll,
} from './deviceHookCalls.js'

const approval = { sessionId: 's1', tool: 'Bash', summary: 'npm test', cwd: '/work/app' }

/** A devices port whose answers the test gives, one pending call per request. */
function fakeDevices() {
  const approvals: Array<{ request: ApprovalRequest; resolve(d: ApprovalDecision): void; reject(e: Error): void }> = []
  const polls: Array<{ poll: InboxPoll; resolve(a: InboxAnswer): void; reject(e: Error): void }> = []
  const port: DeviceHookPort = {
    approval: vi.fn((request: ApprovalRequest) =>
      new Promise<ApprovalDecision>((resolve, reject) => { approvals.push({ request, resolve, reject }) })),
    approvalGone: vi.fn(),
    inboxPoll: vi.fn((poll: InboxPoll) =>
      new Promise<InboxAnswer>((resolve, reject) => { polls.push({ poll, resolve, reject }) })),
    inboxGone: vi.fn(),
  }
  return { port, approvals, polls }
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

describe('parseApproval', () => {
  it('parses an approval', () => {
    expect(parseApproval({ ...approval, tool_input: { content: 'secret' } })).toEqual(approval)
    expect(parseApproval({ sessionId: 's1', tool: 'Bash', summary: '' })).toEqual({ sessionId: 's1', tool: 'Bash', summary: '' })
  })

  it('takes terminalOnly true or false, and keeps it', () => {
    expect(parseApproval({ ...approval, terminalOnly: true })).toStrictEqual({ ...approval, terminalOnly: true })
    expect(parseApproval({ ...approval, terminalOnly: false })).toStrictEqual({ ...approval, terminalOnly: false })
  })

  it('takes a 200-byte summary of multi-byte characters', () => {
    const summary = 'é'.repeat(100)
    expect(parseApproval({ ...approval, summary })).toEqual({ ...approval, summary })
  })

  it.each([
    ['a missing sessionId', { sessionId: undefined }],
    ['an empty sessionId', { sessionId: '' }],
    ['a sessionId of 129 characters', { sessionId: 'x'.repeat(129) }],
    ['a missing tool', { tool: undefined }],
    ['an empty tool', { tool: '' }],
    ['a tool of 65 characters', { tool: 'x'.repeat(65) }],
    ['a missing summary', { summary: undefined }],
    ['a summary of 201 bytes', { summary: `${'é'.repeat(100)}x` }],
    ['a cwd of 1025 characters', { cwd: 'x'.repeat(1025) }],
    ['a control character in sessionId', { sessionId: 's\u00001' }],
    ['a control character in tool', { tool: 'Ba\tsh' }],
    ['a control character in summary', { summary: 'npm\ntest' }],
    ['a control character in cwd', { cwd: '/work\u007f/app' }],
    ['a non-string sessionId', { sessionId: 1 }],
    ['a non-string tool', { tool: null }],
    ['a non-string summary', { summary: { text: 'npm test' } }],
    ['a non-string cwd', { cwd: 5 }],
    ['a terminalOnly that is a string', { terminalOnly: 'true' }],
    ['a terminalOnly that is a number', { terminalOnly: 1 }],
    ['a terminalOnly that is null', { terminalOnly: null }],
  ])('rejects %s', (_name, patch) => {
    expect(parseApproval({ ...approval, ...patch })).toBeNull()
  })

  it('rejects a body that is not an object', () => {
    for (const body of [null, 'x', 7, ['s1']]) expect(parseApproval(body)).toBeNull()
  })
})

describe('parseInboxPoll', () => {
  it('parses a poll, and keeps only its session', () => {
    expect(parseInboxPoll({ sessionId: 's1', text: 'x' })).toEqual({ sessionId: 's1' })
  })
})

describe('createDeviceHookCalls: approvals', () => {
  it('answers invalid to a bad body, and calls nothing', async () => {
    const { calls, port } = setup()
    expect(await calls.onApproval({ ...approval, tool: '' }, live())).toBe('invalid')
    expect(port.approval).not.toHaveBeenCalled()
  })

  it('answers none at once and calls nothing when not ready', async () => {
    const { port } = fakeDevices()
    const devices = vi.fn(() => port)
    const notReady = createDeviceHookCalls({ ready: () => false, devices, newId: () => 'id' })
    expect(await notReady.onApproval(approval, live())).toBe('none')
    expect(devices).not.toHaveBeenCalled()
    const noPort = createDeviceHookCalls({ ready: () => true, devices: () => undefined, newId: () => 'id' })
    expect(await noPort.onApproval(approval, live())).toBe('none')
    expect(port.approval).not.toHaveBeenCalled()
    expect(notReady.open()).toEqual({ approvals: 0, polls: 0 })
  })

  it('forwards with a new id and answers the devices\' decision', async () => {
    const { calls, port, approvals } = setup()
    const first = calls.onApproval(approval, live())
    const second = calls.onApproval({ sessionId: 's2', tool: 'Write', summary: 'src/a.ts' }, live())
    expect(port.approval).toHaveBeenNthCalledWith(1, { id: 'id-1', ...approval })
    expect(port.approval).toHaveBeenNthCalledWith(2, { id: 'id-2', sessionId: 's2', tool: 'Write', summary: 'src/a.ts' })
    approvals[0].resolve('allow')
    approvals[1].resolve('deny')
    expect(await first).toBe('allow')
    expect(await second).toBe('deny')
  })

  it('forwards terminalOnly typed, and answers invalid to one that is not a boolean', async () => {
    const { calls, port, approvals } = setup()
    const answer = calls.onApproval({ ...approval, terminalOnly: true }, live())
    expect(port.approval).toHaveBeenCalledWith({ id: 'id-1', ...approval, terminalOnly: true })
    approvals[0].resolve('none')
    expect(await answer).toBe('none')
    expect(await calls.onApproval({ ...approval, terminalOnly: 'yes' }, live())).toBe('invalid')
    expect(port.approval).toHaveBeenCalledTimes(1)
  })

  it('a call that rejects is none', async () => {
    const { calls, approvals } = setup()
    const answer = calls.onApproval(approval, live())
    approvals[0].reject(new Error('devices gone'))
    expect(await answer).toBe('none')
    expect(calls.open()).toEqual({ approvals: 0, polls: 0 })
  })

  it('the 5th open approval of a session and the 17th in all are none at once; a closed one frees its place', async () => {
    const { calls, port, approvals } = setup()
    const first = calls.onApproval(approval, live())
    for (let i = 1; i < 4; i += 1) void calls.onApproval(approval, live())
    expect(await calls.onApproval(approval, live())).toBe('none')
    expect(port.approval).toHaveBeenCalledTimes(4)

    approvals[0].resolve('allow')
    expect(await first).toBe('allow')
    void calls.onApproval(approval, live())
    expect(port.approval).toHaveBeenCalledTimes(5)

    for (const sessionId of ['s2', 's3', 's4']) {
      for (let i = 0; i < 4; i += 1) void calls.onApproval({ ...approval, sessionId }, live())
    }
    expect(calls.open().approvals).toBe(16)
    expect(await calls.onApproval({ ...approval, sessionId: 's5' }, live())).toBe('none')
    expect(port.approval).toHaveBeenCalledTimes(17)
  })

  it('the client going first tells approvalGone once, and its late answer is dropped', async () => {
    const { calls, port, approvals } = setup()
    const client = new AbortController()
    const answer = calls.onApproval(approval, client.signal)
    client.abort()
    expect(await answer).toBe('none')
    expect(port.approvalGone).toHaveBeenCalledTimes(1)
    expect(port.approvalGone).toHaveBeenCalledWith('id-1')
    expect(calls.open()).toEqual({ approvals: 0, polls: 0 })

    approvals[0].resolve('allow')
    await flush()
    expect(port.approvalGone).toHaveBeenCalledTimes(1)
    expect(calls.open()).toEqual({ approvals: 0, polls: 0 })
  })

  it('a client that goes after the answer tells nothing', async () => {
    const { calls, port, approvals } = setup()
    const client = new AbortController()
    const answer = calls.onApproval(approval, client.signal)
    approvals[0].resolve('deny')
    expect(await answer).toBe('deny')
    client.abort()
    expect(port.approvalGone).not.toHaveBeenCalled()
  })

  it('a client already gone is none, and nothing is forwarded', async () => {
    const { calls, port } = setup()
    const client = new AbortController()
    client.abort()
    expect(await calls.onApproval(approval, client.signal)).toBe('none')
    expect(port.approval).not.toHaveBeenCalled()
    expect(port.approvalGone).not.toHaveBeenCalled()
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

  it('off at once when not ready', async () => {
    const { port } = fakeDevices()
    const devices = vi.fn(() => port)
    const notReady = createDeviceHookCalls({ ready: () => false, devices, newId: () => 'id' })
    expect(await notReady.onInbox({ sessionId: 's1' }, live())).toBe('off')
    expect(devices).not.toHaveBeenCalled()
    const noPort = createDeviceHookCalls({ ready: () => true, devices: () => undefined, newId: () => 'id' })
    expect(await noPort.onInbox({ sessionId: 's1' }, live())).toBe('off')
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
    expect(calls.open()).toEqual({ approvals: 0, polls: 0 })
  })

  it('a text over 2000 characters or not a string is {}', async () => {
    const { calls, polls } = setup()
    const texts: unknown[] = ['x'.repeat(2001), '', 42, null, 'x'.repeat(2000)]
    const answers = texts.map((_text, i) => calls.onInbox({ sessionId: `s${i}` }, live()))
    texts.forEach((text, i) => polls[i].resolve({ text } as InboxAnswer))
    expect(await Promise.all(answers)).toEqual([{}, {}, {}, {}, { text: 'x'.repeat(2000) }])
  })
})

describe('createDeviceHookCalls: counts', () => {
  afterEach(() => { vi.useRealTimers() })

  // Counts only, as the paneless events' line (core/observedHook.ts): a forged or flooding hook is seen, and what it said is not.
  it('logs refused calls and calls over the bounds once a minute, with no id or content; no dial is not counted', async () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const { port } = fakeDevices()
    let ready = false
    let n = 0
    const calls = createDeviceHookCalls({ ready: () => ready, devices: () => port, newId: () => `id-${++n}`, log })
    expect(await calls.onApproval(approval, live())).toBe('none')
    expect(await calls.onInbox({ sessionId: 's1' }, live())).toBe('off')
    vi.advanceTimersByTime(60_000)
    expect(log).not.toHaveBeenCalled()

    ready = true
    expect(await calls.onApproval({ ...approval, sessionId: 'secret-session', tool: '' }, live())).toBe('invalid')
    expect(await calls.onInbox({ sessionId: 'secret\nsession' }, live())).toBe('invalid')
    for (let i = 0; i < 4; i += 1) void calls.onApproval(approval, live())
    expect(await calls.onApproval(approval, live())).toBe('none')
    for (let i = 0; i < 64; i += 1) void calls.onInbox({ sessionId: `poll-${i}` }, live())
    expect(await calls.onInbox({ sessionId: 'poll-64' }, live())).toBe('off')
    expect(log).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(log.mock.calls).toEqual([['[devices] dial hook calls in the last minute: 2 refused, 2 over the bound']])
    vi.advanceTimersByTime(120_000)
    expect(log).toHaveBeenCalledTimes(1)

    expect(await calls.onInbox(null, live())).toBe('invalid')
    vi.advanceTimersByTime(60_000)
    expect(log.mock.calls[1]).toEqual(['[devices] dial hook calls in the last minute: 1 refused, 0 over the bound'])
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|s1|poll-|id-|Bash|npm/)
  })
})

describe('createDeviceHookCalls: state', () => {
  it('keeps nothing once every request has ended', async () => {
    const { calls, approvals, polls } = setup()
    const client = new AbortController()
    const answered = calls.onApproval(approval, live())
    const failed = calls.onApproval({ ...approval, sessionId: 's2' }, live())
    const left = calls.onApproval({ ...approval, sessionId: 's3' }, client.signal)
    const replaced = calls.onInbox({ sessionId: 's1' }, live())
    const held = calls.onInbox({ sessionId: 's1' }, live())
    const other = calls.onInbox({ sessionId: 's2' }, client.signal)
    expect(calls.open()).toEqual({ approvals: 3, polls: 2 })

    approvals[0].resolve('allow')
    approvals[1].reject(new Error('devices gone'))
    client.abort()
    polls[1].resolve({})
    await Promise.all([answered, failed, left, replaced, held, other])
    expect(calls.open()).toEqual({ approvals: 0, polls: 0 })
  })
})
