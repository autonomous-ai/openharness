import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { createSessionHookWait, SESSION_HOOK_WAIT_BOUNDS, sessionKey, type WaitingHook, type WaitingRoute } from './sessionHookWait.js'

const SESSION = 'a1b2c3d4e5f6'
const S = 'a1b2c3d4'
const KEY = sessionKey('claude', SESSION)
const OTHER = 'f6e5d4c3b2a1'
const O = 'f6e5d4c3'
const OTHER_KEY = sessionKey('codex', OTHER)

type TestHook = WaitingHook & { run: Mock<() => Promise<void>> }
function hook(route: WaitingRoute = 'turn-stop', run: () => Promise<void> = async () => {},
  { sessionId = SESSION, bytes = 100 } = {}): TestHook {
  return { route, sessionId, bytes, run: vi.fn(run) }
}
/** A run the test ends by hand. */
function gate() {
  let open!: () => void, fail!: (error: unknown) => void
  const promise = new Promise<void>((resolve, reject) => { open = resolve; fail = reject })
  return { promise, open, fail }
}
/** A drain starts by `setImmediate` after the settling call: one turn of the loop lets it start, and its runs that are
 *  already resolved finish, before the test goes on. */
const turn = () => new Promise<void>(resolve => setImmediate(resolve))

const waitsLine = (s: string, route: string) => `[hooks] ${s} ${route} waits for its session's admission`
const ranLine = (s: string, n: number) => `[hooks] ${s} waiting hooks ran · ${n}`
const unheldLine = (s: string, route: string, reason: string) => `[hooks] ${s} ${route} runs unheld · ${reason}`
const failedLine = (s: string, route: string, kind: string) => `[hooks] ${s} ${route} waiting hook failed · ${kind}`

let lines: string[]
beforeEach(() => {
  // setImmediate stays real: the module starts a drain with it, and the test waits a turn for it.
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  lines = []
  const say = (...parts: unknown[]) => { lines.push(parts.join(' ')) }
  vi.spyOn(console, 'log').mockImplementation(say)
  vi.spyOn(console, 'warn').mockImplementation(say)
})
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

describe('a session\'s hooks waiting behind its admission', () => {
  it('runs a hook at once when nothing of its session is being admitted', async () => {
    const waits = createSessionHookWait()
    expect(waits.hold(KEY, hook())).toBe(false)
    // An admission that ended with no job (an ignore, a 400, 409 or 429) is settled at once.
    const ignored = waits.admission(KEY, 'd1')
    ignored.requestDone()
    expect(waits.hold(KEY, hook('tool-start'))).toBe(false)
    await turn()
    expect(lines).toEqual([])
    waits.close()
  })

  it('holds a hook behind an admission that arrived before it, and runs it once that admission settles', async () => {
    const waits = createSessionHookWait()
    const ticket = waits.admission(KEY, 'delivery-0123456789')
    const ended = ticket.queued()
    const stop = hook()
    expect(waits.hold(KEY, stop)).toBe(true)
    // Its request left the handler (answered `200 pending`), but its job is still queued.
    ticket.requestDone()
    await turn()
    expect(stop.run).not.toHaveBeenCalled()
    ended()
    await turn()
    expect(stop.run).toHaveBeenCalledOnce()
    expect(lines).toEqual([waitsLine(S, 'turn-stop'), ranLine(S, 1)])
    // Settled and run: the next hook of the session does not wait.
    expect(waits.hold(KEY, hook())).toBe(false)
    waits.close()
  })

  it('settles only when every request of the delivery is done and its latest job ended; the same id is the same admission', async () => {
    const waits = createSessionHookWait()
    const first = waits.admission(KEY, 'd1')
    const firstEnded = first.queued()
    const stop = hook()
    expect(waits.hold(KEY, stop)).toBe(true)
    // Sent again after the hook: the same admission, in its first place, so it still holds the hook.
    const second = waits.admission(KEY, 'd1')
    first.requestDone()
    await turn()
    expect(stop.run).not.toHaveBeenCalled()
    // The second request queued the delivery's latest job (pendingAdmission replaced the first): it decides.
    const secondEnded = second.queued()
    second.requestDone()
    firstEnded()
    await turn()
    expect(stop.run).not.toHaveBeenCalled()
    secondEnded()
    await turn()
    expect(stop.run).toHaveBeenCalledOnce()

    // The same id once settled is a new admission; the old tickets' late calls change nothing of it.
    const third = waits.admission(KEY, 'd1')
    const thirdEnded = third.queued()
    third.requestDone()
    const late = hook('session-end')
    expect(waits.hold(KEY, late)).toBe(true)
    firstEnded(); secondEnded(); first.requestDone(); second.requestDone(); first.queued()()
    await turn()
    expect(late.run).not.toHaveBeenCalled()
    thirdEnded()
    // Ending twice is ending once.
    thirdEnded()
    await turn()
    expect(late.run).toHaveBeenCalledOnce()
    expect(stop.run).toHaveBeenCalledOnce()
    waits.close()
  })

  it('never holds a hook behind an admission that arrived after it', async () => {
    const waits = createSessionHookWait()
    const d1 = waits.admission(KEY, 'd1')
    const first = hook('wait')
    expect(waits.hold(KEY, first)).toBe(true)
    const d2 = waits.admission(KEY, 'd2')
    const second = hook('turn-stop')
    expect(waits.hold(KEY, second)).toBe(true)
    d1.requestDone()
    await turn()
    expect(first.run).toHaveBeenCalledOnce()
    expect(second.run).not.toHaveBeenCalled()
    d2.requestDone()
    await turn()
    expect(second.run).toHaveBeenCalledOnce()
    // A later admission settling first frees nothing ahead of an earlier one.
    const d3 = waits.admission(KEY, 'd3')
    const third = hook('subagent')
    waits.hold(KEY, third)
    const d4 = waits.admission(KEY, 'd4')
    const fourth = hook('turn-start')
    waits.hold(KEY, fourth)
    d4.requestDone()
    await turn()
    expect(third.run).not.toHaveBeenCalled()
    expect(fourth.run).not.toHaveBeenCalled()
    d3.requestDone()
    await turn()
    expect(third.run.mock.invocationCallOrder[0]).toBeLessThan(fourth.run.mock.invocationCallOrder[0]!)
    waits.close()
  })

  it('runs a session\'s waiting hooks one after another in arrival order', async () => {
    const waits = createSessionHookWait()
    const d1 = waits.admission(KEY, 'd1')
    const calls: string[] = []
    const gates = [gate(), gate(), gate()]
    const routes = ['wait', 'subagent', 'turn-stop'] as const
    const hooks = routes.map((route, index) => hook(route, () => { calls.push(route); return gates[index]!.promise }))
    for (const each of hooks.slice(0, 2)) expect(waits.hold(KEY, each)).toBe(true)
    // The third waits behind a second admission too, which settles while the first hook runs.
    const d2 = waits.admission(KEY, 'd2')
    expect(waits.hold(KEY, hooks[2]!)).toBe(true)
    d1.requestDone()
    await turn()
    expect(calls).toEqual(['wait'])
    d2.requestDone()
    await turn()
    expect(calls).toEqual(['wait'])
    gates[0]!.open()
    await turn()
    expect(calls).toEqual(['wait', 'subagent'])
    gates[1]!.open()
    await turn()
    expect(calls).toEqual(['wait', 'subagent', 'turn-stop'])
    // While the last one runs, its session's admissions all settle and a new one comes and goes: a hook with nothing
    // ahead runs at once, and one behind the new admission runs after the running one, never beside it.
    const d3 = waits.admission(KEY, 'd3')
    d3.requestDone()
    expect(waits.hold(KEY, hook('tool-start'))).toBe(false)
    const d4 = waits.admission(KEY, 'd4')
    expect(waits.hold(KEY, hook('session-end', async () => { calls.push('session-end') }))).toBe(true)
    d4.requestDone()
    await turn()
    expect(calls).toEqual(['wait', 'subagent', 'turn-stop'])
    gates[2]!.open()
    await turn()
    expect(calls).toEqual(['wait', 'subagent', 'turn-stop', 'session-end'])
    expect(lines.filter(line => line.includes('waiting hooks ran'))).toEqual([ranLine(S, 4)])
    waits.close()
  })

  it('starts a run on a later turn, never inside the call that settled the admission', async () => {
    const waits = createSessionHookWait()
    const ticket = waits.admission(KEY, 'd1')
    const ended = ticket.queued()
    ticket.requestDone()
    const stop = hook()
    waits.hold(KEY, stop)
    ended()
    expect(stop.run).not.toHaveBeenCalled()
    await turn()
    expect(stop.run).toHaveBeenCalledOnce()
    waits.close()
  })

  it('does not hold a hook over the session, core or byte bound, and says why', async () => {
    const perSession = createSessionHookWait({ perSession: 1 })
    perSession.admission(KEY, 'd1')
    expect(perSession.hold(KEY, hook())).toBe(true)
    expect(perSession.hold(KEY, hook('tool-start'))).toBe(false)
    perSession.admission(OTHER_KEY, 'd1')
    expect(perSession.hold(OTHER_KEY, hook('wait', undefined, { sessionId: OTHER }))).toBe(true)
    perSession.close()

    const core = createSessionHookWait({ total: 1 })
    const first = core.admission(KEY, 'd1')
    expect(core.hold(KEY, hook())).toBe(true)
    core.admission(OTHER_KEY, 'd1')
    expect(core.hold(OTHER_KEY, hook('subagent', undefined, { sessionId: OTHER }))).toBe(false)
    // A hook that ran gives its place back.
    first.requestDone()
    await turn()
    expect(core.hold(OTHER_KEY, hook('subagent', undefined, { sessionId: OTHER }))).toBe(true)
    core.close()

    const bytes = createSessionHookWait({ totalBytes: 10 })
    bytes.admission(KEY, 'd1')
    expect(bytes.hold(KEY, hook('tool-start', undefined, { bytes: 11 }))).toBe(false)
    expect(bytes.hold(KEY, hook('tool-start', undefined, { bytes: 6 }))).toBe(true)
    expect(bytes.hold(KEY, hook('turn-start', undefined, { bytes: 5 }))).toBe(false)
    expect(bytes.hold(KEY, hook('turn-start', undefined, { bytes: 4 }))).toBe(true)
    bytes.close()

    expect(lines.filter(line => line.includes('runs unheld'))).toEqual([
      unheldLine(S, 'tool-start', 'session_full'),
      unheldLine(O, 'subagent', 'core_full'),
      unheldLine(S, 'tool-start', 'core_full'),
      unheldLine(S, 'turn-start', 'core_full'),
    ])
    expect(SESSION_HOOK_WAIT_BOUNDS).toEqual({ perSession: 32, total: 256, totalBytes: 4 * 1024 * 1024, maxWaitMs: 120_000 })
  })

  it('runs a hook past its time at once, and says so', async () => {
    const waits = createSessionHookWait({ maxWaitMs: 1_000 })
    const ticket = waits.admission(KEY, 'd1')
    const stop = hook()
    const next = hook('session-end')
    waits.hold(KEY, stop)
    await vi.advanceTimersByTimeAsync(500)
    waits.hold(KEY, next)
    await vi.advanceTimersByTimeAsync(499)
    expect(stop.run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(stop.run).toHaveBeenCalledOnce()
    expect(next.run).not.toHaveBeenCalled()
    expect(lines).toEqual([waitsLine(S, 'turn-stop'), unheldLine(S, 'turn-stop', 'timed_out')])
    // The one still waiting runs when the admission settles; the one that left runs nothing more.
    ticket.requestDone()
    await turn()
    expect(stop.run).toHaveBeenCalledOnce()
    expect(next.run).toHaveBeenCalledOnce()
    expect(lines.at(-1)).toBe(ranLine(S, 1))
    waits.close()

    // 120 s unless a test says otherwise.
    const defaults = createSessionHookWait()
    defaults.admission(KEY, 'd1')
    const slow = hook('wait')
    defaults.hold(KEY, slow)
    await vi.advanceTimersByTimeAsync(119_999)
    expect(slow.run).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(slow.run).toHaveBeenCalledOnce()
    expect(lines.at(-1)).toBe(unheldLine(S, 'wait', 'timed_out'))
    defaults.close()
  })

  it('says a failed run by its kind and runs the next', async () => {
    const waits = createSessionHookWait({ maxWaitMs: 1_000 })
    const ticket = waits.admission(KEY, 'd1')
    const failing = hook('tool-start', async () => { throw new TypeError('the prompt and /Users/someone/notes.txt') })
    const next = hook()
    waits.hold(KEY, failing)
    waits.hold(KEY, next)
    ticket.requestDone()
    await turn()
    expect(next.run).toHaveBeenCalledOnce()
    expect(lines).toEqual([waitsLine(S, 'tool-start'), failedLine(S, 'tool-start', 'TypeError'), ranLine(S, 2)])

    // A hook past its time that fails is said the same way, and so is a run that throws before it returns a promise.
    waits.admission(KEY, 'd2')
    const late = hook('subagent', () => Promise.reject(new RangeError('a tool input')))
    const throws: TestHook = { ...hook('wait'), run: vi.fn((): Promise<void> => { throw 'a body' }) }
    waits.hold(KEY, late)
    await vi.advanceTimersByTimeAsync(500)
    waits.hold(KEY, throws)
    await vi.advanceTimersByTimeAsync(500)
    await turn()
    await vi.advanceTimersByTimeAsync(500)
    await turn()
    expect(lines.slice(3)).toEqual([
      waitsLine(S, 'subagent'),
      unheldLine(S, 'subagent', 'timed_out'), failedLine(S, 'subagent', 'RangeError'),
      unheldLine(S, 'wait', 'timed_out'), failedLine(S, 'wait', 'string'),
    ])
    expect(lines.join('\n')).not.toMatch(/prompt|notes|tool input|body/)
    waits.close()
  })

  it('says a session\'s wait once per admission', async () => {
    const waits = createSessionHookWait()
    const d1 = waits.admission(KEY, 'd1')
    waits.hold(KEY, hook('turn-stop'))
    waits.hold(KEY, hook('wait'))
    const d2 = waits.admission(KEY, 'd2')
    waits.hold(KEY, hook('subagent'))
    waits.hold(KEY, hook('tool-start'))
    expect(lines).toEqual([waitsLine(S, 'turn-stop'), waitsLine(S, 'subagent')])
    d1.requestDone(); d2.requestDone()
    await turn()
    expect(lines.slice(2)).toEqual([ranLine(S, 4)])
    waits.close()
  })

  it('keeps engines apart', async () => {
    expect(sessionKey('claude', 'x')).not.toBe(sessionKey('codex', 'x'))
    expect(sessionKey('a', 'b:c')).not.toBe(sessionKey('a:b', 'c'))
    expect(sessionKey('a', 'b')).toBe(sessionKey('a', 'b'))
    const waits = createSessionHookWait()
    const claude = waits.admission(sessionKey('claude', SESSION), 'd1')
    const codexHook = hook()
    expect(waits.hold(sessionKey('codex', SESSION), codexHook)).toBe(false)
    const claudeHook = hook()
    expect(waits.hold(sessionKey('claude', SESSION), claudeHook)).toBe(true)
    // One session's settling runs nothing of another's.
    const codex = waits.admission(sessionKey('codex', SESSION), 'd1')
    const codexWaiting = hook('wait')
    expect(waits.hold(sessionKey('codex', SESSION), codexWaiting)).toBe(true)
    claude.requestDone()
    await turn()
    expect(claudeHook.run).toHaveBeenCalledOnce()
    expect(codexWaiting.run).not.toHaveBeenCalled()
    codex.requestDone()
    await turn()
    expect(codexWaiting.run).toHaveBeenCalledOnce()
    expect(codexHook.run).not.toHaveBeenCalled()
    waits.close()
  })

  it('drops everything on close and runs nothing', async () => {
    const waits = createSessionHookWait()
    const ticket = waits.admission(KEY, 'd1')
    const ended = ticket.queued()
    const stop = hook()
    waits.hold(KEY, stop)
    // Settled just before the close: its drain was scheduled, and finds nothing to run.
    const other = waits.admission(OTHER_KEY, 'd1')
    const otherHook = hook('wait', undefined, { sessionId: OTHER })
    waits.hold(OTHER_KEY, otherHook)
    other.requestDone()
    expect(vi.getTimerCount()).toBe(2)
    waits.close()
    expect(vi.getTimerCount()).toBe(0)
    await turn()
    ticket.queued()(); ended(); ticket.requestDone()
    await turn()
    await vi.advanceTimersByTimeAsync(SESSION_HOOK_WAIT_BOUNDS.maxWaitMs)
    expect(stop.run).not.toHaveBeenCalled()
    expect(otherHook.run).not.toHaveBeenCalled()
    expect(waits.hold(KEY, hook())).toBe(false)
    const after = waits.admission(KEY, 'd2')
    after.queued()()
    after.requestDone()
    expect(waits.hold(KEY, hook())).toBe(false)
    expect(lines.filter(line => !line.includes('waits for'))).toEqual([])
  })

  it('stops a drain at the close: a hook still waiting behind a running one never runs', async () => {
    const waits = createSessionHookWait()
    const ticket = waits.admission(KEY, 'd1')
    const running = gate()
    const first = hook('tool-start', () => running.promise)
    const second = hook()
    waits.hold(KEY, first)
    waits.hold(KEY, second)
    ticket.requestDone()
    await turn()
    expect(first.run).toHaveBeenCalledOnce()
    waits.close()
    running.open()
    await turn()
    expect(second.run).not.toHaveBeenCalled()
  })
})
