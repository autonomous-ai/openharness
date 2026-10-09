import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import type { LiveFrame, LivePage, LivePull } from '../../engines/worker/liveProtocol.js'
import { createLiveSessions, type LiveSessions } from './liveSessions.js'
import { EngineLiveError } from './liveTransport.js'

const running: LiveSessions[] = []
const deferred = <T>() => { let resolve!: (value: T) => void; let reject!: (error: unknown) => void
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j }); return { promise, resolve, reject } }
const reply = (ask: LivePull, over: Partial<LivePage> = {}): LivePage => ({ frames: [], prepared: true,
  cursor: { serial: (ask.cursor?.serial ?? 0) + 1, origin: 10, offset: 10,
    turn: { identity: `${ask.token}:turn`, turnOpen: true, continued: false }, closed: false,
    prepareEnd: null, completeUntil: null, stamp: null },
  content: false, more: false, records: 0, turnFrom: 0, profileFrom: 0, end: 10, lastStarted: null, ...over })
const frame: LiveFrame = { raw: 'record', profile: true, observe: true, events: [], replay: false,
  turn: { identity: 'turn', turnOpen: true, continued: false } }

function setup(consoleLog = false) {
  const rows = new Map<string, RegisteredSession>()
  const session = (id = 's', path: string | null = '/private/transcript') => {
    const value = { agentId: id, sessionId: id, engine: 'claude', transcriptPath: path,
      boundAt: 1, cwd: '/private', model: null, cliVersion: null } as RegisteredSession
    rows.set(id, value); return value
  }
  const transport = { pull: vi.fn(async (ask: LivePull) => reply(ask)), forget: vi.fn(async () => {}),
    close: vi.fn(), connected: vi.fn(), disconnected: vi.fn() }
  const deps = { handles: (engine: string) => engine === 'claude', transport, bySession: (id: string) => rows.get(id),
    frame: vi.fn(), reattach: vi.fn(async () => {}), watch: vi.fn(), unwatch: vi.fn(),
    ...(consoleLog ? {} : { log: vi.fn() }) }
  const live = createLiveSessions(deps); running.push(live)
  const prepare = (s: RegisteredSession) => live.prepare(s, { live: false, end: 10 }, vi.fn())
  const attach = async (s: RegisteredSession) => { const p = await prepare(s); expect(live.install(p)).toBe(true); await live.follow(s); return p }
  return { live, deps, transport, rows, session, prepare, attach }
}

afterEach(async () => { await Promise.all(running.splice(0).map(live => live.stop())); vi.useRealTimers(); vi.restoreAllMocks() })

describe('live session lifecycle', () => {
  it('ignores absent tails and paths and shares a watched path until its final session leaves', async () => {
    vi.useFakeTimers()
    const p = setup(), a = p.session('a'), b = p.session('b')
    await p.live.follow(a)
    await p.live.pollSession('missing'); p.live.setTail('missing', 3)
    expect(await p.live.hold('missing', '/none')).toBeNull()
    await p.attach(p.session('empty', null))
    expect(p.deps.watch).not.toHaveBeenCalled()
    await p.attach(a); await p.attach(b); await p.attach(p.session('c'))
    p.live.changed('/unrelated')
    expect(await p.live.hold('a', '/wrong')).toBeNull()
    await p.live.follow(a)
    const hold = await p.live.hold('a', a.transcriptPath!)
    a.transcriptPath = '/private/new'
    const replacement = await p.prepare(a)
    expect(p.live.install(replacement)).toBe(true)
    await p.live.follow(a)
    hold!.release()
    expect(p.deps.unwatch).not.toHaveBeenCalled()
    await p.live.removeSession('b')
    expect(p.deps.unwatch).not.toHaveBeenCalled()
    await p.live.removeSession('c')
    expect(p.deps.unwatch).toHaveBeenCalledWith('/private/transcript')
    a.transcriptPath = '/private/third'
    const third = await p.prepare(a)
    expect(p.live.install(third)).toBe(true)
    await p.live.follow(a)
    expect(p.deps.unwatch).toHaveBeenCalledWith('/private/new')
    await p.live.removeSession('a'); await p.live.removeSession('a')
    expect(p.deps.unwatch).toHaveBeenCalledWith('/private/third')
  })

  it('hydrates multiple bounded pages and rejects a candidate after the binding changes', async () => {
    const p = setup(), s = p.session(), observe = vi.fn()
    p.transport.pull.mockImplementationOnce(async ask => reply(ask, { prepared: undefined, frames: [frame], content: true, records: 2 }))
    const prepared = await p.live.prepare(s, { live: false }, observe)
    expect(prepared.records).toBe(2); expect(prepared.content).toBe(true)
    expect(observe).toHaveBeenCalledExactlyOnceWith(frame)
    s.boundAt = (s.boundAt ?? 0) + 1
    expect(p.live.install(prepared)).toBe(false)
    p.live.discard(prepared)
    const pending = deferred<LivePage>()
    p.transport.pull.mockReturnValueOnce(pending.promise)
    const stale = p.prepare(s)
    await vi.waitFor(() => expect(p.transport.pull).toHaveBeenCalledTimes(3))
    s.boundAt = (s.boundAt ?? 0) + 1
    pending.resolve(reply(p.transport.pull.mock.calls.at(-1)![0]))
    await expect(stale).rejects.toMatchObject({ code: 'ENGINE_STALE_REPLY' })
  })

  it('reports repeated failures once, retries a failed poll and contains an observer failure per frame', async () => {
    vi.useFakeTimers()
    const p = setup(), s = p.session()
    await p.attach(s)
    p.transport.pull.mockRejectedValueOnce(new Error('offline')).mockRejectedValueOnce(new Error('offline'))
    await p.live.pollAll()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(p.deps.log).toHaveBeenCalledTimes(1)
    p.transport.pull.mockImplementationOnce(async ask => reply(ask, { frames: [frame, frame] }))
    p.deps.frame.mockImplementationOnce(() => { throw new Error('observer') })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(p.deps.frame).toHaveBeenCalledTimes(2)
    expect(p.deps.log).toHaveBeenCalledTimes(2)
    p.rows.delete(s.sessionId)
    const calls = p.transport.pull.mock.calls.length
    await p.live.pollAll()
    expect(p.transport.pull).toHaveBeenCalledTimes(calls)
  })

  it('reports non-Error failures through the default logger and retries failed activation', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = setup(true), s = p.session()
    const prepared = await p.prepare(s); p.live.install(prepared)
    p.transport.pull.mockRejectedValueOnce('offline')
    await p.live.follow(s)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('offline'))
    await vi.advanceTimersByTimeAsync(1_000)
    expect(p.transport.pull).toHaveBeenCalledTimes(3)
  })

  it('says a rewrite once through the default logger, and the re-attach names the stream whose read found it', async () => {
    vi.useFakeTimers()
    const say = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const p = setup(true), s = p.session()
    const original = await p.attach(s)
    p.transport.pull.mockRejectedValue(new EngineLiveError('ENGINE_TRANSCRIPT_CHANGED'))
    await expect(p.live.pollSession(s.sessionId)).rejects.toMatchObject({ code: 'ENGINE_TRANSCRIPT_CHANGED' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(say.mock.calls.filter(([line]) => String(line).includes('transcript rewritten in place'))).toHaveLength(1)
    expect(p.deps.reattach).toHaveBeenCalledWith(s)
    p.transport.pull.mockImplementation(async ask => reply(ask))
    const replacement = await p.prepare(s)
    expect(replacement.state.ask).toMatchObject({ rewritten: true, rewrittenFrom: original.state.ask.token })
  })

  it('coalesces concurrent drains and remembers file changes arriving during a read', async () => {
    vi.useFakeTimers()
    const p = setup(), s = p.session(); await p.attach(s)
    const pending = deferred<LivePage>()
    p.transport.pull.mockReturnValueOnce(pending.promise)
    const first = p.live.pollSession(s.sessionId)
    await vi.advanceTimersByTimeAsync(0)
    const second = p.live.pollSession(s.sessionId)
    p.live.changed(s.transcriptPath!)
    pending.resolve(reply(p.transport.pull.mock.calls.at(-1)![0]))
    await Promise.all([first, second])
    const calls = p.transport.pull.mock.calls.length
    await vi.advanceTimersByTimeAsync(40)
    expect(p.transport.pull).toHaveBeenCalledTimes(calls + 1)
  })

  it('waits out a failed in-flight read before holding, expires holds and ignores late releases after setTail', async () => {
    vi.useFakeTimers()
    const p = setup(), s = p.session(); await p.attach(s)
    const pending = deferred<LivePage>()
    p.transport.pull.mockReturnValueOnce(pending.promise)
    const read = p.live.pollSession(s.sessionId)
    const failure = expect(read).rejects.toThrow('offline')
    await vi.advanceTimersByTimeAsync(0)
    const waiting = p.live.hold(s.sessionId, s.transcriptPath!, 50)
    pending.reject(new Error('offline')); await failure
    const first = (await waiting)!, second = (await p.live.hold(s.sessionId, s.transcriptPath!, 100))!
    expect(first.offset).toBe(10)
    const drain = p.live.pollSession(s.sessionId)
    await vi.advanceTimersByTimeAsync(50)
    expect(first.expired).toBe(true); expect(second.expired).toBe(false)
    p.live.setTail(s.sessionId, 4)
    const moved = (await p.live.hold(s.sessionId, s.transcriptPath!))!
    expect(moved.offset).toBe(4)
    first.release(10); second.release(10); moved.release(10); await drain
    const candidate = await p.prepare(s)
    p.live.setTail(s.sessionId, 5)
    expect(p.live.install(candidate)).toBe(false); p.live.discard(candidate)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(p.deps.reattach).toHaveBeenCalledOnce()
    const accepted = await p.prepare(s)
    expect(p.live.install(accepted)).toBe(true)
    await p.live.pollSession(s.sessionId)
  })

  it('releases a blocked drain when detached and keeps no watch for a removed session', async () => {
    const p = setup(), s = p.session(); await p.attach(s)
    await p.live.hold(s.sessionId, s.transcriptPath!)
    const drain = p.live.pollSession(s.sessionId)
    await p.live.removeSession(s.sessionId)
    await drain
    expect(p.deps.unwatch).toHaveBeenCalledWith(s.transcriptPath)
  })

  it('finishes a hold awaiting a page when the session is removed during that page', async () => {
    const p = setup(), s = p.session(); await p.attach(s)
    const pending = deferred<LivePage>()
    p.transport.pull.mockReturnValueOnce(pending.promise)
    const read = p.live.pollSession(s.sessionId)
    await vi.waitFor(() => expect(p.transport.pull).toHaveBeenCalledTimes(3))
    const hold = p.live.hold(s.sessionId, s.transcriptPath!)
    await p.live.removeSession(s.sessionId)
    pending.resolve(reply(p.transport.pull.mock.calls.at(-1)![0]))
    await read
    expect((await hold)!.offset).toBe(0)
  })

  it('retries reattachment after failure, deduplicates timers and abandons retries for an obsolete binding', async () => {
    vi.useFakeTimers()
    const p = setup(), s = p.session()
    p.deps.reattach.mockRejectedValueOnce(new Error('offline'))
    p.live.retry(s); p.live.retry(s)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(p.deps.reattach).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(p.deps.reattach).toHaveBeenCalledTimes(2)
    p.live.retry(s); p.rows.delete(s.sessionId)
    await vi.advanceTimersByTimeAsync(1_000)
    expect(p.deps.reattach).toHaveBeenCalledTimes(2)
    await p.live.stop(); p.live.retry(s)
  })

  it('does not resurrect a removed binding when a pending read detects a rewrite', async () => {
    const p = setup(), s = p.session(); await p.attach(s)
    const pending = deferred<LivePage>()
    p.transport.pull.mockReturnValueOnce(pending.promise)
    const read = p.live.pollSession(s.sessionId)
    const failure = expect(read).rejects.toMatchObject({ code: 'ENGINE_TRANSCRIPT_CHANGED' })
    await vi.waitFor(() => expect(p.transport.pull).toHaveBeenCalledTimes(3))
    p.rows.delete(s.sessionId)
    pending.reject(new EngineLiveError('ENGINE_TRANSCRIPT_CHANGED')); await failure
    p.live.setTail(s.sessionId, 3)
    expect(p.deps.reattach).not.toHaveBeenCalled()
  })

  it('bounds its fair queue and rejects queued work on shutdown', async () => {
    const p = setup(), s = p.session(), pending = deferred<LivePage>()
    p.transport.pull.mockReturnValueOnce(pending.promise)
    const requests = Array.from({ length: 256 }, () => p.prepare(s))
    const outcomes = Promise.allSettled(requests)
    await expect(p.prepare(s)).rejects.toMatchObject({ code: 'ENGINE_BUSY' })
    await p.live.stop()
    pending.resolve(reply(p.transport.pull.mock.calls[0][0]))
    expect((await outcomes).every(result => result.status === 'rejected')).toBe(true)
    expect(p.transport.pull).toHaveBeenCalledOnce()
  })
})
