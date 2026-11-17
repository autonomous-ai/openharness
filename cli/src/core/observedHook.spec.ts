import { afterEach, describe, expect, it, vi } from 'vitest'
import { createObservedHook, parseObservedHook } from './observedHook.js'

const full = {
  engine: 'claude', sessionId: 's1', event: 'turn-stop', cwd: '/work/app', callerPid: 4242,
  transcriptPath: '/home/u/.claude/projects/p/s1.jsonl', hostHints: { TERM_PROGRAM: 'ghostty' },
}

describe('parseObservedHook', () => {
  it('parses a full event', () => {
    expect(parseObservedHook(full)).toEqual(full)
  })

  it('parses an event without the optional fields', () => {
    expect(parseObservedHook({ engine: 'codex', sessionId: 's', event: 'session-start', callerPid: 1, hostHints: {} }))
      .toEqual({ engine: 'codex', sessionId: 's', event: 'session-start', callerPid: 1, hostHints: {} })
  })

  it('takes 10 hint keys', () => {
    const hostHints = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`K${i}`, 'v'.repeat(64)]))
    expect(parseObservedHook({ ...full, hostHints })).toEqual({ ...full, hostHints })
  })

  it.each([
    ['an unknown engine', { engine: 'vim' }],
    ['a missing sessionId', { sessionId: undefined }],
    ['an empty sessionId', { sessionId: '' }],
    ['an unknown event', { event: 'tool-start' }],
    ['callerPid 0', { callerPid: 0 }],
    ['callerPid 1.5', { callerPid: 1.5 }],
    ['a string callerPid', { callerPid: '7' }],
    ['a sessionId of 129 chars', { sessionId: 'x'.repeat(129) }],
    ['a cwd of 1025 chars', { cwd: 'x'.repeat(1025) }],
    ['a transcriptPath of 1025 chars', { transcriptPath: 'x'.repeat(1025) }],
    ['a control character in cwd', { cwd: '/work\n/app' }],
    ['11 hint keys', { hostHints: Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`K${i}`, 'v'])) }],
    ['a 65-char hint value', { hostHints: { TERM_PROGRAM: 'x'.repeat(65) } }],
    ['a non-string hint value', { hostHints: { TERM_PROGRAM: 3 } }],
    ['hostHints that is an array', { hostHints: ['a'] }],
    ['hostHints missing', { hostHints: undefined }],
  ])('rejects %s', (_name, patch) => {
    expect(parseObservedHook({ ...full, ...patch })).toBeNull()
  })

  it('rejects a body that is not an object', () => {
    expect(parseObservedHook(null)).toBeNull()
    expect(parseObservedHook('x')).toBeNull()
    expect(parseObservedHook([])).toBeNull()
  })
})

// A permission prompt that waits, from the plugin's hook client (deviceClaude/asked.ts): it sends no process and no
// environment, and where the session runs stays its own hooks' to say.
describe('parseObservedHook: asked', () => {
  const asked = { engine: 'claude', sessionId: 's1', event: 'asked', tool: 'Bash', summary: 'npm test', cwd: '/work/app' }

  it('parses the client\'s body as it posts it', () => {
    expect(parseObservedHook(asked)).toStrictEqual(asked)
  })

  it('parses one with no tool, summary or cwd', () => {
    expect(parseObservedHook({ engine: 'claude', sessionId: 's1', event: 'asked' })).toStrictEqual({ engine: 'claude', sessionId: 's1', event: 'asked' })
  })

  it('takes a 64-character tool and a 200-byte summary of multi-byte characters', () => {
    const body = { ...asked, tool: 't'.repeat(64), summary: 'é'.repeat(100) }
    expect(parseObservedHook(body)).toStrictEqual(body)
  })

  it('keeps no process, hints or transcript an asked event carries, and no tool or summary another event carries', () => {
    expect(parseObservedHook({ ...asked, callerPid: 7, hostHints: { ORCA_TERMINAL_HANDLE: 'term_x' }, transcriptPath: '/t/s1.jsonl' }))
      .toStrictEqual(asked)
    expect(parseObservedHook({ ...full, tool: 'Bash', summary: 'npm test' })).toStrictEqual(full)
  })

  it.each([
    ['a tool of 65 characters', { tool: 't'.repeat(65) }],
    ['a summary of 201 bytes', { summary: `${'é'.repeat(100)}x` }],
    ['a summary of 201 characters', { summary: 'x'.repeat(201) }],
    ['a control character in tool', { tool: 'Ba\tsh' }],
    ['a control character in summary', { summary: 'npm\ntest' }],
    ['a non-string tool', { tool: 7 }],
    ['a non-string summary', { summary: { text: 'npm test' } }],
    ['a control character in cwd', { cwd: '/work\u007f/app' }],
    ['an empty sessionId', { sessionId: '' }],
  ])('rejects %s', (_name, patch) => {
    expect(parseObservedHook({ ...asked, ...patch })).toBeNull()
  })

  it('forwards it, under the session\'s own rate', () => {
    const forward = vi.fn(() => true)
    expect(createObservedHook({ forward, now: () => 7 }).onObserved(asked)).toBe('ok')
    expect(forward).toHaveBeenCalledWith(asked)
  })
})

// The hook says a typed prompt's turn came from another session (hook/notify.mjs); the core lets that one boolean
// through, on turn-start only, and nothing else of the prompt.
describe('parseObservedHook: relayed', () => {
  const turnStart = { ...full, event: 'turn-start' }

  it('takes relayed true and false on turn-start, and hands it on', () => {
    for (const relayed of [true, false]) {
      const body = { ...turnStart, relayed }
      expect(parseObservedHook(body)).toStrictEqual(body)
      const forward = vi.fn(() => true)
      expect(createObservedHook({ forward, now: () => 7 }).onObserved(body)).toBe('ok')
      expect(forward).toHaveBeenCalledWith(body)
    }
  })

  it('a turn-start without relayed has no such key', () => {
    expect(parseObservedHook(turnStart)).toStrictEqual(turnStart)
  })

  it.each([['true'], [1], [0], [null], [{}], [[]]])('rejects a relayed that is not a boolean: %j', (relayed) => {
    expect(parseObservedHook({ ...turnStart, relayed })).toBeNull()
  })

  const others = [
    ...['session-start', 'needs-input', 'turn-stop', 'turn-error', 'session-end'].map((event) => ({ ...full, event })),
    { engine: 'claude', sessionId: 's1', event: 'asked' },
  ]
  it.each(others.flatMap((body) => [true, false].map((relayed) => [body.event, relayed, body] as const)))(
    'rejects relayed on any other event: %s, relayed %s', (_event, relayed, body) => {
      expect(parseObservedHook(body)).not.toBeNull()
      expect(parseObservedHook({ ...body, relayed })).toBeNull()
    })
})

// The hook says the session's own name for itself (hook/notify.mjs); the core lets that one bounded string through, on
// session-start and turn-start only, and keeps none of it.
describe('parseObservedHook: title', () => {
  afterEach(() => { vi.useRealTimers() })

  const named = (event: string, title: unknown) => ({ ...full, event, title })

  it.each(['session-start', 'turn-start'])('takes a title on %s and hands it on', (event) => {
    const body = named(event, 'Tho')
    expect(parseObservedHook(body)).toStrictEqual(body)
    const forward = vi.fn(() => true)
    expect(createObservedHook({ forward, now: () => 7 }).onObserved(body)).toBe('ok')
    expect(forward).toHaveBeenCalledWith(body)
  })

  it('takes 64 UTF-16 units, letters outside ASCII and JSON\'s own characters', () => {
    for (const title of ['x'.repeat(64), '😀'.repeat(32), 'Thơ "gà" \\ 数学']) {
      const body = named('turn-start', title)
      expect(parseObservedHook(body)).toStrictEqual(body)
    }
  })

  it('takes a title beside relayed', () => {
    const body = { ...named('turn-start', 'Tho'), relayed: true }
    expect(parseObservedHook(body)).toStrictEqual(body)
  })

  it('an event without a title has no such key', () => {
    const body = { ...full, event: 'session-start' }
    expect(parseObservedHook(body)).toStrictEqual(body)
  })

  const bad: ReadonlyArray<readonly [string, unknown]> = [
    ['of 65 characters', 'x'.repeat(65)],
    ['of 66 UTF-16 units', '😀'.repeat(33)],
    ['that is empty', ''],
    ['with a bell', 'Th\u0007o'],
    ['with a newline', 'Th\no'],
    ['with a delete', 'Th\u007fo'],
    ['that is a number', 7],
    ['that is null', null],
    ['that is true', true],
    ['that is an object', { text: 'Tho' }],
    ['that is an array', ['Tho']],
  ]
  it.each(['session-start', 'turn-start'].flatMap((event) => bad.map(([name, title]) => [name, event, title] as const)))(
    'rejects a title %s on %s', (_name, event, title) => {
      expect(parseObservedHook(named(event, title))).toBeNull()
    })

  const others = [
    ...['needs-input', 'turn-stop', 'turn-error', 'session-end'].map((event) => ({ ...full, event })),
    { engine: 'claude', sessionId: 's1', event: 'asked' },
  ]
  it.each(others.map((body) => [body.event, body] as const))('rejects a title on %s', (_event, body) => {
    expect(parseObservedHook(body)).toStrictEqual(body)
    expect(parseObservedHook({ ...body, title: 'Tho' })).toBeNull()
  })

  it('counts a refused title and logs none of it', () => {
    vi.useFakeTimers()
    const log = vi.fn()
    const hook = createObservedHook({ forward: () => true, now: () => 0, log })
    expect(hook.onObserved(named('turn-start', 'secret-title'))).toBe('ok')
    expect(hook.onObserved(named('turn-stop', 'secret-title'))).toBe('invalid')
    expect(hook.onObserved(named('turn-start', 'secret\u0007title'))).toBe('invalid')
    vi.advanceTimersByTime(60_000)
    expect(log.mock.calls).toEqual([['[devices] paneless hook events in the last minute: 2 refused, 0 dropped']])
  })
})

describe('createObservedHook', () => {
  afterEach(() => { vi.useRealTimers() })

  it('logs refused and dropped counts once a minute', () => {
    vi.useFakeTimers()
    const log = vi.fn()
    let devices = true
    const hook = createObservedHook({ forward: () => devices, now: () => 0, log })
    hook.onObserved({ nope: 1 })
    hook.onObserved({ ...full, sessionId: 'secret-session', cwd: '/secret/path' })
    // The 21st within a second is over the rate.
    for (let i = 0; i < 21; i += 1) hook.onObserved(full)
    devices = false
    hook.onObserved({ ...full, sessionId: 's2' })
    expect(log).not.toHaveBeenCalled()
    vi.advanceTimersByTime(60_000)
    expect(log.mock.calls).toEqual([['[devices] paneless hook events in the last minute: 1 refused, 2 dropped']])
    vi.advanceTimersByTime(120_000)
    expect(log).toHaveBeenCalledTimes(1)
    hook.onObserved({ nope: 1 })
    vi.advanceTimersByTime(60_000)
    expect(log.mock.calls[1]).toEqual(['[devices] paneless hook events in the last minute: 1 refused, 0 dropped'])
    expect(JSON.stringify(log.mock.calls)).not.toMatch(/secret|s1|s2/)
  })

  it('forwards a valid event and answers ok', () => {
    const forward = vi.fn(() => true)
    expect(createObservedHook({ forward, now: () => 7 }).onObserved(full)).toBe('ok')
    expect(forward).toHaveBeenCalledWith(full)
  })

  it('answers invalid and forwards nothing for a bad body', () => {
    const forward = vi.fn(() => true)
    expect(createObservedHook({ forward, now: () => 1 }).onObserved({ nope: 1 })).toBe('invalid')
    expect(forward).not.toHaveBeenCalled()
  })

  it("drops the 21st event within a second for one session, keeps another session's", () => {
    let clock = 1000
    const forward = vi.fn(() => true)
    const hook = createObservedHook({ forward, now: () => clock })
    const results = Array.from({ length: 21 }, () => hook.onObserved(full))
    expect(results.slice(0, 20).every((r) => r === 'ok')).toBe(true)
    expect(results[20]).toBe('dropped')
    expect(hook.onObserved({ ...full, sessionId: 's2' })).toBe('ok')
    expect(forward).toHaveBeenCalledTimes(21)
    clock += 1000
    expect(hook.onObserved(full)).toBe('ok')
  })

  it('refills the bucket gradually', () => {
    let clock = 0
    const hook = createObservedHook({ forward: () => true, now: () => clock })
    for (let i = 0; i < 20; i += 1) hook.onObserved(full)
    expect(hook.onObserved(full)).toBe('dropped')
    clock += 50
    expect(hook.onObserved(full)).toBe('ok')
    expect(hook.onObserved(full)).toBe('dropped')
  })

  it('keeps serving a session whose clock stepped back', () => {
    let clock = 10_000
    const hook = createObservedHook({ forward: () => true, now: () => clock })
    for (let i = 0; i < 20; i += 1) hook.onObserved(full)
    clock = 0
    expect(hook.onObserved(full)).toBe('dropped')
    clock += 1000
    expect(hook.onObserved(full)).toBe('ok')
  })

  it("forward false (devices down) is 'dropped', not an error", () => {
    expect(createObservedHook({ forward: () => false, now: () => 1 }).onObserved(full)).toBe('dropped')
  })

  it('keeps nothing: a second instance after forward has no memory of the first except the bucket', () => {
    const seen: unknown[] = []
    const first = createObservedHook({ forward: (e) => { seen.push(e); return true }, now: () => 1 })
    first.onObserved(full)
    const forward = vi.fn(() => true)
    const second = createObservedHook({ forward, now: () => 1 })
    expect(second.onObserved(full)).toBe('ok')
    expect(forward).toHaveBeenCalledTimes(1)
    expect(Object.keys(first)).toEqual(['onObserved'])
  })

  it('forgets the counters of sessions idle for a second so the table stays bounded', () => {
    let clock = 0
    const hook = createObservedHook({ forward: () => true, now: () => clock })
    for (let i = 0; i < 300; i += 1) hook.onObserved({ ...full, sessionId: `s${i}` })
    clock += 2000
    expect(hook.onObserved({ ...full, sessionId: 'fresh' })).toBe('ok')
  })

  it('refuses a new session when 1024 are active at once, and still serves the known ones', () => {
    const hook = createObservedHook({ forward: () => true, now: () => 0 })
    for (let i = 0; i < 1024; i += 1) hook.onObserved({ ...full, sessionId: `s${i}` })
    expect(hook.onObserved({ ...full, sessionId: 'one-more' })).toBe('dropped')
    expect(hook.onObserved({ ...full, sessionId: 's5' })).toBe('ok')
  })
})
