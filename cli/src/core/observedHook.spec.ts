// A paneless session's hook event (core/observedHook.ts): checked, bounded and rate-limited in the core, then
// handed to the devices, which keep it. The core keeps nothing of it but how many it took this second.
import { describe, expect, it, vi } from 'vitest'
import { createObservedHook, parseObservedHook, type ObservedHookEvent } from './observedHook.js'

const FULL = {
  engine: 'claude',
  sessionId: '0b7c1f9e-2a51-4d38-9a51-2f3e8f0c4d11',
  event: 'turn-stop',
  cwd: '/Users/someone/work/demo',
  callerPid: 4242,
  transcriptPath: '/Users/someone/.claude/projects/demo/0b7c1f9e.jsonl',
  hostHints: { TERM_PROGRAM: 'ghostty', ORCA_APP_VERSION: '1.4.256' },
}

describe('parseObservedHook', () => {
  it('parses a full event', () => {
    expect(parseObservedHook(FULL, 1_700_000_000_000)).toEqual({ ...FULL, at: 1_700_000_000_000 })
  })

  it('parses each event name, with no cwd, transcript or hints', () => {
    for (const event of ['session-start', 'turn-start', 'needs-input', 'turn-stop', 'turn-error', 'session-end']) {
      expect(parseObservedHook({ engine: 'codex', sessionId: 's1', event, callerPid: 7, cwd: null }, 5))
        .toEqual({ engine: 'codex', sessionId: 's1', event, callerPid: 7, hostHints: {}, at: 5 })
    }
  })

  it.each([
    ['an unknown engine', { ...FULL, engine: 'gemini' }],
    ['a missing sessionId', { ...FULL, sessionId: undefined }],
    ['an empty sessionId', { ...FULL, sessionId: '' }],
    ['callerPid 0', { ...FULL, callerPid: 0 }],
    ['callerPid 1.5', { ...FULL, callerPid: 1.5 }],
    ['a missing callerPid', { ...FULL, callerPid: undefined }],
    ['a sessionId of 129 chars', { ...FULL, sessionId: 's'.repeat(129) }],
    ['a cwd of 1025 chars', { ...FULL, cwd: `/${'c'.repeat(1024)}` }],
    ['a transcriptPath of 1025 chars', { ...FULL, transcriptPath: `/${'t'.repeat(1024)}` }],
    ['an unknown event', { ...FULL, event: 'compact' }],
    ['an unknown field', { ...FULL, env: { HOME: '/' } }],
    ['hints that are not an object', { ...FULL, hostHints: ['TERM_PROGRAM'] }],
    ['a hint key that is not a variable name', { ...FULL, hostHints: { 'TERM PROGRAM': 'x' } }],
    ['a hint value that is not a string', { ...FULL, hostHints: { TERM_PROGRAM: 1 } }],
  ])('rejects %s', (_name, body) => {
    expect(parseObservedHook(body, 1)).toBeNull()
  })

  it('rejects 9 hint keys and a 65-char hint value', () => {
    const nine = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`HINT_${i}`, 'x']))
    expect(parseObservedHook({ ...FULL, hostHints: nine }, 1)).toBeNull()
    expect(parseObservedHook({ ...FULL, hostHints: { TERM_PROGRAM: 'x'.repeat(65) } }, 1)).toBeNull()
    // The bounds themselves pass.
    const eight = Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`HINT_${i}`, 'x'.repeat(64)]))
    expect(parseObservedHook({ ...FULL, sessionId: 's'.repeat(128), cwd: `/${'c'.repeat(1023)}`, hostHints: eight }, 1)).not.toBeNull()
  })

  it('rejects a control character in cwd', () => {
    expect(parseObservedHook({ ...FULL, cwd: '/work/demo\n[hooks] forged' }, 1)).toBeNull()
    expect(parseObservedHook({ ...FULL, hostHints: { TERM_PROGRAM: 'ghostty\u0007' } }, 1)).toBeNull()
  })

  it.each([[null], [[]], ['turn-stop'], [42]])('rejects a body that is not an object: %j', (body) => {
    expect(parseObservedHook(body, 1)).toBeNull()
  })
})

describe('createObservedHook', () => {
  const event = (sessionId: string) => ({ ...FULL, sessionId })

  it('forwards a valid event, stamped with when the core heard it, and refuses an invalid one', () => {
    const forward = vi.fn(() => true)
    const hook = createObservedHook({ forward, now: () => 99 })
    expect(hook.onObserved(FULL)).toBe('ok')
    expect(forward).toHaveBeenCalledWith({ ...FULL, at: 99 })
    expect(hook.onObserved({ ...FULL, engine: 'nope' })).toBe('invalid')
    expect(forward).toHaveBeenCalledOnce()
  })

  it('drops the 21st event within a second for one session, keeps another session\'s', () => {
    let now = 10_000
    const forward = vi.fn(() => true)
    const hook = createObservedHook({ forward, now: () => now })
    for (let i = 0; i < 20; i++) expect(hook.onObserved(event('flood'))).toBe('ok')
    now += 999
    expect(hook.onObserved(event('flood'))).toBe('dropped')
    expect(hook.onObserved(event('calm'))).toBe('ok')
    // The same session id under another engine is another session.
    expect(hook.onObserved({ ...event('flood'), engine: 'codex' })).toBe('ok')
    expect(forward).toHaveBeenCalledTimes(22)
    // A second later the flooding session is heard again.
    now += 1
    expect(hook.onObserved(event('flood'))).toBe('ok')
  })

  it('forward false (devices down) is \'dropped\', not an error', () => {
    const hook = createObservedHook({ forward: () => false, now: () => 1 })
    expect(hook.onObserved(FULL)).toBe('dropped')
  })

  it('keeps nothing: a second instance after forward has no memory of the first except the bucket', () => {
    let now = 0
    const forwarded: ObservedHookEvent[] = []
    const hook = createObservedHook({ forward: (e) => { forwarded.push(e); return true }, now: () => now })
    expect(hook.onObserved(event('s1'))).toBe('ok')
    // What it handed on is the devices' now: changing it changes nothing in the core.
    forwarded[0].hostHints.TERM_PROGRAM = 'changed'
    expect(hook.onObserved(event('s1'))).toBe('ok')
    expect(forwarded[1].hostHints.TERM_PROGRAM).toBe('ghostty')
    // A fresh instance starts with a full bucket: only the count was kept.
    const fresh = createObservedHook({ forward: () => true, now: () => now })
    for (let i = 0; i < 20; i++) expect(fresh.onObserved(event('s1'))).toBe('ok')
    expect(fresh.onObserved(event('s1'))).toBe('dropped')
  })

  it('bounds the buckets: a flood of new session ids is dropped, and the buckets are freed a second later', () => {
    let now = 0
    const forward = vi.fn(() => true)
    const hook = createObservedHook({ forward, now: () => now })
    for (let i = 0; i < 1024; i++) expect(hook.onObserved(event(`s${i}`))).toBe('ok')
    expect(hook.onObserved(event('one-too-many'))).toBe('dropped')
    // A session already counted this second is still heard.
    expect(hook.onObserved(event('s3'))).toBe('ok')
    now += 1000
    expect(hook.onObserved(event('one-too-many'))).toBe('ok')
  })
})
