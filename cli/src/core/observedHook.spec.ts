import { describe, expect, it, vi } from 'vitest'
import { createObservedHook, parseObservedHook } from './observedHook.js'

const full = {
  engine: 'claude', sessionId: 's1', event: 'turn-stop', cwd: '/work/app', callerPid: 4242,
  transcriptPath: '/home/u/.claude/projects/p/s1.jsonl', hostHints: { TERM_PROGRAM: 'ghostty' },
}

describe('parseObservedHook', () => {
  it('parses a full event', () => {
    expect(parseObservedHook(full, 99)).toEqual({ ...full, at: 99 })
  })

  it('parses an event without the optional fields', () => {
    expect(parseObservedHook({ engine: 'codex', sessionId: 's', event: 'session-start', callerPid: 1, hostHints: {} }, 5))
      .toEqual({ engine: 'codex', sessionId: 's', event: 'session-start', callerPid: 1, hostHints: {}, at: 5 })
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
    ['9 hint keys', { hostHints: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`K${i}`, 'v'])) }],
    ['a 65-char hint value', { hostHints: { TERM_PROGRAM: 'x'.repeat(65) } }],
    ['a non-string hint value', { hostHints: { TERM_PROGRAM: 3 } }],
    ['hostHints that is an array', { hostHints: ['a'] }],
    ['hostHints missing', { hostHints: undefined }],
  ])('rejects %s', (_name, patch) => {
    expect(parseObservedHook({ ...full, ...patch }, 1)).toBeNull()
  })

  it('rejects a body that is not an object', () => {
    expect(parseObservedHook(null, 1)).toBeNull()
    expect(parseObservedHook('x', 1)).toBeNull()
    expect(parseObservedHook([], 1)).toBeNull()
  })
})

describe('createObservedHook', () => {
  it('forwards a valid event and answers ok', () => {
    const forward = vi.fn(() => true)
    expect(createObservedHook({ forward, now: () => 7 }).onObserved(full)).toBe('ok')
    expect(forward).toHaveBeenCalledWith({ ...full, at: 7 })
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
