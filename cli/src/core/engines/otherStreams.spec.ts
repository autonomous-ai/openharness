import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { STREAM_OP, STREAM_OPEN, STREAM_VERSION, STREAMS_WAIT, type StreamFrame, type StreamOpened } from '../../engines/worker/otherStreamProtocol.js'
import { READER_PART } from '../../engines/worker/protocol.js'
import { createOtherStreams, type OtherStreamsDeps } from './otherStreams.js'

const row = (sessionId = 's1', engine = 'pi'): RegisteredSession => ({ agentId: `a-${sessionId}`, sessionId, engine, transcriptPath: '/t/x.jsonl' }) as RegisteredSession
const turn = (identity = 't:1', turnOpen = true) => ({ identity, turnOpen })
const frame = (serial: number, over: Partial<StreamFrame> = {}): StreamFrame => ({ serial, events: [{ type: 'text_delta', payload: { content: `f${serial}` } }], turn: turn(), ...over })
const opened = (over: Partial<StreamOpened> = {}): StreamOpened => ({ turn: turn(), historyTurnOpen: false, lastStarted: null, lastEnded: null,
  initial: [], lines: 0, evidence: [], abandoned: false, frames: [], ...over })
const ok = (answer: unknown) => ({ version: STREAM_VERSION, answer })
const OPEN = { live: false, abandon: false, held: false, store: null }
function stopReservation() {
  let resolve!: () => void, reject!: (error: Error) => void
  const promise = new Promise<void>((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve: () => resolve(), reject: () => reject(new Error('Stop failed')) }
}

/** The worker, scripted: each request type answered by the test's own function; a wait held until the test answers it. */
function setup(over: Partial<OtherStreamsDeps> = {}) {
  const sessions = new Map<string, RegisteredSession>([['s1', row()]])
  const waits: Array<(answer: Record<string, unknown>) => void> = []
  const answers = {
    open: vi.fn(async (_payload: Record<string, unknown>): Promise<Record<string, unknown>> => ok(opened())),
    op: vi.fn(async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => ok({ frames: [], events: [], turn: turn(`t:${payload.op}`, payload.op === 'open') })),
    part: vi.fn(async (_payload: Record<string, unknown>): Promise<Record<string, unknown>> => ({})),
  }
  const call = vi.fn(async (type: string, payload: Record<string, unknown>) => {
    if (type === STREAM_OPEN) return answers.open(payload)
    if (type === STREAM_OP) return answers.op(payload)
    if (type === READER_PART) return answers.part(payload)
    expect(type).toBe(STREAMS_WAIT)
    return new Promise<Record<string, unknown>>((resolve) => { waits.push(resolve) })
  })
  const deps: OtherStreamsDeps = { call, bySession: (id) => sessions.get(id), frame: vi.fn(), reattach: vi.fn(), log: vi.fn(), retryMs: 10, ...over }
  return { streams: createOtherStreams(deps), deps, call, answers, waits, sessions }
}
const ops = (run: ReturnType<typeof setup>) => run.answers.op.mock.calls.map(([payload]) => payload.op)

describe('the other engines\' streams, as the core holds them', () => {
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('reports readiness only for a current installed reader without an unfinished open, close or Stop', async () => {
    let stopping: Promise<void> | undefined
    const run = setup({ stopping: () => stopping })
    expect(run.streams.ready('s1')).toBe(false)
    await run.streams.open(row(), OPEN)
    expect(run.streams.ready('s1')).toBe(true)
    let finishOpen!: (reply: Record<string, unknown>) => void
    run.answers.open.mockImplementationOnce(() => new Promise(resolve => { finishOpen = resolve }))
    const replacing = run.streams.open(row(), OPEN)
    expect(run.streams.has('s1')).toBe(true)
    expect(run.streams.ready('s1')).toBe(false)
    finishOpen(ok(opened())); await replacing
    expect(run.streams.ready('s1')).toBe(true)
    let finishClose!: (reply: Record<string, unknown>) => void
    run.answers.op.mockImplementationOnce(() => new Promise(resolve => { finishClose = resolve }))
    run.streams.get('s1')!.closeTurn('cancel')
    expect(run.streams.ready('s1')).toBe(false)
    finishClose(ok({ frames: [], events: [], turn: turn('closed', false) }))
    await vi.waitFor(() => expect(run.streams.ready('s1')).toBe(true))
    const stop = stopReservation(); stopping = stop.promise
    expect(run.streams.ready('s1')).toBe(false)
    stopping = undefined; stop.resolve()
    run.sessions.delete('s1'); expect(run.streams.ready('s1')).toBe(false)
    run.sessions.set('s1', row('s1', 'grok')); expect(run.streams.ready('s1')).toBe(false)
    run.sessions.set('s1', row()); expect(run.streams.ready('s1')).toBe(true)
    run.streams.forget('s1'); expect(run.streams.ready('s1')).toBe(false)
    run.streams.stop()
  })

  it('does not mistake retained or recovering worker state for a ready reader', async () => {
    const run = setup()
    await run.streams.open(row(), OPEN)
    run.streams.disconnected()
    expect(run.streams.has('s1')).toBe(true); expect(run.streams.ready('s1')).toBe(false)
    let finish!: (reply: Record<string, unknown>) => void
    run.answers.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    run.streams.connected()
    expect(run.streams.ready('s1')).toBe(false)
    finish(ok(opened()))
    await vi.waitFor(() => expect(run.streams.ready('s1')).toBe(true))
    run.streams.unavailable(row())
    expect(run.streams.ready('s1')).toBe(false)
    run.streams.stop(); expect(run.streams.ready('s1')).toBe(false)
  })

  it('does not report a held wait or a worker-lost stream as ready', async () => {
    const held = stopReservation()
    const run = setup({ log: line => { if (line.includes('delivery held')) held.resolve() } })
    await run.streams.open(row(), OPEN)
    expect(run.streams.ready('s1')).toBe(true)
    run.waits[0]({})
    await held.promise
    expect(run.streams.ready('s1')).toBe(false)
    await vi.waitFor(() => expect(run.waits).toHaveLength(2))
    const token = run.answers.open.mock.calls[0][0].token as string
    run.waits[1](ok({ pages: [], lost: [token] }))
    await vi.waitFor(() => expect(run.deps.reattach).toHaveBeenCalled())
    expect(run.streams.has('s1')).toBe(true); expect(run.streams.ready('s1')).toBe(false)
    run.streams.stop()
  })

  it('opens a stream, takes the frames it made as it opened, and waits for the rest with one request', async () => {
    const run = setup()
    run.answers.open.mockResolvedValueOnce(ok(opened({ frames: [frame(1), frame(2, { offset: 40 })], offset: 20 })))
    const reply = await run.streams.open(run.sessions.get('s1')!, { ...OPEN, live: true, store: '/db/x' })
    expect(reply?.frames).toHaveLength(2)
    expect(run.answers.open.mock.calls[0][0]).toMatchObject({ version: STREAM_VERSION, live: true,
      session: { agentId: 'a-s1', sessionId: 's1', engine: 'pi', transcriptPath: '/t/x.jsonl', store: '/db/x' } })
    expect(vi.mocked(run.deps.frame).mock.calls.map(([, f]) => f.serial)).toEqual([1, 2])
    expect(run.streams.has('s1')).toBe(true)
    const stream = run.streams.get('s1')!
    expect([stream.engine, stream.sessionId, stream.turnOpen, stream.offset]).toEqual(['pi', 's1', true, 40])
    await vi.waitFor(() => expect(run.waits).toHaveLength(1))
    expect(run.call.mock.calls.at(-1)![1]).toEqual({ version: STREAM_VERSION, acks: { [run.answers.open.mock.calls[0][0].token as string]: 2 } })
    // The next page: an old frame again is taken once, a new one in order, and the next wait acknowledges it.
    const token = run.answers.open.mock.calls[0][0].token as string
    run.waits[0](ok({ pages: [{ token, frames: [frame(2), frame(3, { turn: turn('t:2', false) })] }, { token: 'gone', frames: [frame(1)] },
      { token, frames: 'no' }], lost: ['unknown', 7] }))
    await vi.waitFor(() => expect(run.waits).toHaveLength(2))
    expect(vi.mocked(run.deps.frame).mock.calls.map(([, f]) => f.serial)).toEqual([1, 2, 3])
    expect(stream.turnOpen).toBe(false)
    run.streams.stop()
    run.waits[1](ok({ pages: [], lost: [] }))
  })

  it('says a frame for a session rebound to another engine, or gone, to no one, and contains one its taker throws on', async () => {
    const log = vi.fn()
    const run = setup({ log, frame: vi.fn(() => { throw new Error('taker broke') }) })
    run.answers.open.mockResolvedValueOnce(ok(opened({ frames: [frame(1)] })))
    await run.streams.open(row(), OPEN)
    expect(log).toHaveBeenCalledWith(expect.stringContaining('frame could not be applied'))
    run.sessions.set('s1', row('s1', 'grok'))
    run.waits[0]?.(ok({ pages: [], lost: [] }))
    await vi.waitFor(() => expect(run.waits).toHaveLength(2))
    const token = run.answers.open.mock.calls[0][0].token as string
    run.waits.at(-1)!(ok({ pages: [{ token, frames: [frame(2, { rewritten: true })] }], lost: [] }))
    await vi.waitFor(() => expect(run.waits).toHaveLength(3))
    expect(run.deps.frame).toHaveBeenCalledTimes(1)
    expect(run.deps.reattach).not.toHaveBeenCalled()
    run.streams.stop()
  })

  it('attaches a rewritten transcript again, and a stream the worker gave up on', async () => {
    const run = setup()
    await run.streams.open(row(), OPEN)
    const token = run.answers.open.mock.calls[0][0].token as string
    await vi.waitFor(() => expect(run.waits).toHaveLength(1))
    run.waits[0](ok({ pages: [{ token, frames: [frame(1, { events: [], rewritten: true })] }], lost: [] }))
    await vi.waitFor(() => expect(run.deps.reattach).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(run.waits).toHaveLength(2))
    run.waits[1](ok({ pages: [], lost: [token] }))
    await vi.waitFor(() => expect(run.deps.reattach).toHaveBeenCalledTimes(2))
    expect(run.streams.has('s1')).toBe(true)
    expect(run.deps.log).toHaveBeenCalledWith(expect.stringContaining('given up by the worker'))
  })

  it('waits out a wait the worker could not answer, then asks again', async () => {
    const run = setup()
    await run.streams.open(row(), OPEN)
    await vi.waitFor(() => expect(run.waits).toHaveLength(1))
    run.waits[0]({ error: 'SERVICE_UNAVAILABLE' })
    await vi.waitFor(() => expect(run.waits).toHaveLength(2))
    run.call.mockRejectedValueOnce(new Error('link gone'))
    run.waits[1]({ version: 9 })
    await vi.waitFor(() => expect(run.waits).toHaveLength(3))
    run.streams.stop()
    run.waits[2](ok({ pages: [], lost: [] }))
  })

  it('reattaches the session once more, later, when its open is not answered, and not once it opens or is forgotten', async () => {
    vi.useFakeTimers()
    const run = setup()
    run.answers.open.mockResolvedValueOnce({ error: 'SERVICE_UNAVAILABLE' })
    expect(await run.streams.open(row(), OPEN)).toBeNull()
    // The worker may hold what it opened: it is told to forget it.
    expect(ops(run)).toEqual(['forget'])
    await vi.waitFor(() => expect(run.deps.reattach).toHaveBeenCalledOnce())
    // An answer it cannot check, or an error that is not about its being there, is not tried again by itself.
    run.answers.open.mockResolvedValueOnce(ok({ turn: 'no' })).mockResolvedValueOnce({ version: STREAM_VERSION, error: 'ENGINE_INVALID_REQUEST' })
    expect(await run.streams.open(row(), OPEN)).toBeNull()
    expect(await run.streams.open(row(), OPEN)).toBeNull()
    run.call.mockRejectedValueOnce(new Error('cut'))
    expect(await run.streams.open(row(), OPEN)).toBeNull()
    run.streams.forget('s1')
    await vi.advanceTimersByTimeAsync(30)
    expect(run.deps.reattach).toHaveBeenCalledOnce()
    // Gone or another engine's by the time it is tried: not attached again.
    run.answers.open.mockResolvedValueOnce({ error: 'SERVICE_UNAVAILABLE' })
    await run.streams.open(row(), OPEN)
    run.sessions.set('s1', row('s1', 'grok'))
    await vi.advanceTimersByTimeAsync(30)
    expect(run.deps.reattach).toHaveBeenCalledOnce()
  })

  it('shows an initial reader failure, clears only that hold before a bounded retry, and clears its retry on stop', async () => {
    vi.useFakeTimers()
    const run = setup({ held: vi.fn() })
    run.answers.open.mockResolvedValue({ error: 'SERVICE_UNAVAILABLE' })
    expect(await run.streams.open(row(), OPEN)).toBeNull()
    expect(run.deps.held).toHaveBeenLastCalledWith(row(), true)
    await vi.advanceTimersByTimeAsync(10)
    expect(run.deps.held).toHaveBeenLastCalledWith(row(), false)
    expect(run.deps.reattach).toHaveBeenCalledOnce()
    for (let n = 1; n <= 5; n++) {
      await run.streams.open(row(), OPEN)
      await vi.advanceTimersByTimeAsync(10 * 2 ** n)
    }
    expect(run.deps.reattach).toHaveBeenCalledTimes(5)
    expect(run.deps.log).toHaveBeenCalledWith(expect.stringContaining('unavailable after 5 retries'))
    run.streams.stop()
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.deps.reattach).toHaveBeenCalledTimes(5)
  })

  it('replaces the stream a later open made, telling the worker to forget the old one, and opens nothing once stopped', async () => {
    const run = setup()
    await run.streams.open(row(), OPEN)
    const first = run.answers.open.mock.calls[0][0].token
    await run.streams.open(row(), OPEN)
    expect(run.answers.op.mock.calls.map(([payload]) => [payload.op, payload.token])).toEqual([['forget', first]])
    run.streams.stop()
    expect(await run.streams.open(row(), OPEN)).toBeNull()
  })

  it('closes for a Stop with what the worker\'s parser emits, and itself, said, when the worker does not answer', async () => {
    const run = setup()
    const events = [{ type: 'turn_ended', payload: {} }]
    expect(await run.streams.close('nobody', {})).toEqual([])
    await run.streams.open(row(), OPEN)
    run.answers.op.mockResolvedValueOnce(ok({ closed: true, events, frames: [frame(1)], turn: turn('t:2', false) }))
    expect(await run.streams.close('s1', { abort: true, error: true, stop: true })).toEqual(events)
    expect(run.answers.op.mock.calls[0][0]).toMatchObject({ op: 'abort', error: true, stop: true })
    // What it made before the close is taken first.
    expect(vi.mocked(run.deps.frame).mock.calls.map(([, f]) => f.serial)).toEqual([1])
    expect(run.streams.get('s1')!.turnOpen).toBe(false)
    // Not answered: closed here, an error as an abort; nothing when no turn is open.
    run.answers.op.mockResolvedValueOnce(ok({ frames: [], turn: turn('t:3', true) }))
    await run.streams.drain('s1')
    run.answers.op.mockResolvedValueOnce({ error: 'SERVICE_UNAVAILABLE' })
    expect(await run.streams.close('s1', { error: true })).toEqual([{ type: 'turn_ended', payload: { aborted: true } }])
    expect(run.deps.log).toHaveBeenCalledWith(expect.stringContaining('closed by the core itself'))
    run.answers.op.mockResolvedValueOnce({ error: 'SERVICE_UNAVAILABLE' })
    expect(await run.streams.close('s1', {})).toEqual([])
    run.answers.op.mockResolvedValueOnce(ok({ frames: [], turn: turn('t:4', true) }))
    await run.streams.drain('s1')
    run.answers.op.mockResolvedValueOnce({ error: 'SERVICE_UNAVAILABLE' })
    expect(await run.streams.close('s1', {})).toEqual([{ type: 'turn_ended', payload: {} }])
    run.streams.stop()
  })

  it('closes a history turn only while it is still that turn, here when the worker does not answer', async () => {
    const run = setup()
    expect(await run.streams.closeIf('nobody', 't:1')).toBe(false)
    await run.streams.open(row(), OPEN)
    expect(await run.streams.closeIf('s1', 'another')).toBe(false)
    run.answers.op.mockResolvedValueOnce(ok({ closed: false, events: [], frames: [], turn: turn('t:2', true) }))
    expect(await run.streams.closeIf('s1', 't:1')).toBe(false)
    run.answers.op.mockResolvedValueOnce(ok({ closed: true, events: [], frames: [], turn: turn('t:3', false) }))
    expect(await run.streams.closeIf('s1', 't:2')).toBe(true)
    run.answers.op.mockResolvedValueOnce(ok({ frames: [], turn: turn('t:4', true) }))
    await run.streams.drain('s1')
    run.answers.op.mockResolvedValueOnce({ error: 'SERVICE_UNAVAILABLE' })
    expect(await run.streams.closeIf('s1', 't:4')).toBe(true)
    expect(run.streams.get('s1')!.turnOpen).toBe(false)
    run.streams.stop()
  })

  it('marks a cancel closed at once and tells the worker, whose late answer does not open it again', async () => {
    const run = setup()
    await run.streams.open(row(), OPEN)
    let answer!: (value: Record<string, unknown>) => void
    run.answers.op.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    run.streams.get('s1')!.closeTurn('cancel')
    expect(run.streams.get('s1')!.turnOpen).toBe(false)
    expect(run.answers.op.mock.calls[0][0].op).toBe('cancel')
    answer(ok({ events: [], frames: [frame(1, { turn: turn('t:1', true) })], turn: turn('t:2', false) }))
    await vi.waitFor(() => expect(run.deps.frame).toHaveBeenCalledOnce())
    expect(run.streams.get('s1')!.turnOpen).toBe(false)
    run.streams.get('s1')!.closeTurn('abandoned')
    await vi.waitFor(() => expect(ops(run)).toEqual(['cancel', 'close']))
    run.streams.stop()
  })

  it('keeps a cancelled turn closed when its delayed answer still reports that turn open', async () => {
    const run = setup()
    await run.streams.open(row(), OPEN)
    run.answers.op.mockResolvedValueOnce(ok({ events: [], frames: [], turn: turn() }))
    run.streams.get('s1')!.closeTurn('cancel')
    await vi.waitFor(() => expect(run.answers.op).toHaveBeenCalledOnce())
    await Promise.resolve(); await Promise.resolve()
    expect(run.answers.op.mock.calls[0][0]).toMatchObject({ identity: 't:1' })
    expect(run.streams.get('s1')!.turnOpen).toBe(false)
    run.streams.stop()
  })

  it('does not replace a newer delivered turn with an older operation answer', async () => {
    const run = setup()
    await run.streams.open(row(), OPEN)
    let done!: (value: Record<string, unknown>) => void
    run.answers.op.mockImplementationOnce(() => new Promise(resolve => { done = resolve }))
    const draining = run.streams.drain('s1')
    const token = run.answers.open.mock.calls[0][0].token as string
    run.waits[0](ok({ pages: [{ token, frames: [frame(1, { turn: turn('new:1') })] }], lost: [] }))
    await vi.waitFor(() => expect(run.streams.get('s1')!.turn.identity).toBe('new:1'))
    done(ok({ frames: [], turn: turn('old:1', false) }))
    await draining
    expect(run.streams.get('s1')!.turn.identity).toBe('new:1')
    run.streams.stop()
  })

  it('reads an answer it cannot check as none, and a stream the worker no longer has as given up', async () => {
    const run = setup()
    await run.streams.open(row(), OPEN)
    for (const answer of [ok({ frames: [], stray: 1 }), ok({ frames: 'no' }), ok({ frames: [{ serial: 0 }] }), ok({ frames: [], turn: 'no' }),
      ok({ frames: [], events: [{ type: 'nonsense' }] }), ok({ frames: [], events: 'no' })]) {
      run.answers.op.mockResolvedValueOnce(answer)
      expect(await run.streams.openTurn('s1', 'hi')).toEqual([])
    }
    run.answers.op.mockResolvedValueOnce(ok({ frames: [], turn: turn(), events: 'invalid' }))
    await run.streams.drain('s1')
    run.call.mockRejectedValueOnce(new Error('cut'))
    expect(await run.streams.openTurn('s1')).toEqual([])
    run.answers.op.mockResolvedValueOnce({ version: STREAM_VERSION, error: 'ENGINE_STREAM_GONE' })
    await run.streams.drain('s1')
    expect(run.streams.has('s1')).toBe(true)
    await vi.waitFor(() => expect(run.deps.reattach).toHaveBeenCalledOnce())
    run.answers.op.mockResolvedValueOnce({ version: STREAM_VERSION, error: 'ENGINE_STREAM_GONE' })
    await run.streams.open(row(), OPEN)
    run.sessions.delete('s1')
    await run.streams.drain('s1')
    expect(run.deps.reattach).toHaveBeenCalledOnce()
  })

  it('asks the worker for each of a session\'s ops, and for nothing about a session it does not follow', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const run = setup()
    for (const id of ['nobody']) {
      await run.streams.drain(id); await run.streams.tail(id, '/t/y.jsonl', true)
      expect(await run.streams.openTurn(id)).toEqual([])
      run.streams.task(id, 'tool', {}); run.streams.release(id); run.streams.forget(id)
      expect(run.streams.paneRead(id, { ready: true, gatewayLost: false, running: false })).toBe(false)
      expect(run.streams.paneDue(id)).toBe(true)
    }
    expect(run.call).not.toHaveBeenCalled()
    // Nothing followed: no drain of everything either.
    await run.streams.drainAll()
    expect(run.call).not.toHaveBeenCalled()
    await run.streams.open(row(), OPEN)
    run.answers.op.mockImplementation(async (payload) => ok({ frames: [], turn: turn(), ...(payload.op === 'open' ? { events: [{ type: 'turn_started', payload: { userMessage: 'hi' } }] } : {}),
      ...(payload.op === 'pane' ? { quietFor: 30_000 } : {}) }))
    await run.streams.tail('s1', '/t/y.jsonl', true)
    expect(await run.streams.openTurn('s1', 'hi')).toEqual([{ type: 'turn_started', payload: { userMessage: 'hi' } }])
    run.streams.task('s1', 'tool-1', { prompt: 'x' })
    run.streams.release('s1')
    expect(run.streams.paneRead('s1', { ready: true, gatewayLost: false, running: false })).toBe(true)
    await vi.waitFor(() => expect(run.streams.paneDue('s1')).toBe(false))
    vi.setSystemTime(Date.now() + 30_000)
    expect(run.streams.paneDue('s1')).toBe(true)
    // A quiet the stream cannot have said is not taken; a frame makes the pane due again.
    run.answers.op.mockImplementation(async () => ok({ frames: [frame(1)], turn: turn(), quietFor: 10 * 60_000 }))
    run.streams.paneRead('s1', { ready: true, gatewayLost: false, running: false })
    await vi.waitFor(() => expect(run.deps.frame).toHaveBeenCalled())
    expect(run.streams.paneDue('s1')).toBe(true)
    await run.streams.drainAll()
    expect(run.answers.op.mock.calls.map(([payload]) => payload.op)).toEqual(['tail', 'open', 'task', 'release', 'pane', 'pane', 'drain'])
    expect(run.answers.op.mock.calls.at(-1)![0]).not.toHaveProperty('token')
    run.streams.forget('s1')
    expect(run.streams.has('s1')).toBe(false)
    run.streams.stop()
  })

  it('takes an answer the worker sent in parts, within the request\'s own wait', async () => {
    const run = setup()
    const whole = Buffer.from(JSON.stringify(ok(opened({ lines: 7 }))))
    const hash = createHash('sha256').update(whole).digest('hex')
    const half = Math.ceil(whole.length / 2)
    const part = (offset: number, end: number) => ({ version: 1, part: 'p1', offset, bytes: whole.length, hash, data: whole.subarray(offset, end).toString('base64') })
    run.answers.open.mockResolvedValueOnce(part(0, half))
    run.answers.part.mockResolvedValueOnce(part(half, whole.length))
    expect((await run.streams.open(row(), OPEN))?.lines).toBe(7)
    expect(run.answers.part.mock.calls[0][0]).toEqual({ version: 1, part: 'p1', offset: half })
    // Past its wait, the rest is not asked for.
    const now = performance.now()
    const clock = vi.spyOn(performance, 'now').mockReturnValueOnce(now).mockReturnValue(now + 60_000)
    run.answers.open.mockResolvedValueOnce(part(0, half))
    expect(await run.streams.open(row('s1'), OPEN)).toBeNull()
    clock.mockRestore()
    expect(run.answers.part).toHaveBeenCalledOnce()
    run.streams.stop()
  })

  it('holds its streams while their worker is gone, says so, and opens each again where it took it once it is back', async () => {
    const run = setup()
    run.answers.open.mockResolvedValueOnce(ok(opened({ offset: 12, turn: turn('t:1', true) })))
    await run.streams.open(row(), OPEN)
    run.sessions.set('s2', row('s2'))
    run.answers.open.mockResolvedValueOnce({ error: 'SERVICE_UNAVAILABLE' })
    await run.streams.open(row('s2'), OPEN)
    run.streams.disconnected()
    run.streams.disconnected()
    expect(run.deps.log).toHaveBeenCalledWith(expect.stringContaining('worker is gone · 1 conversation(s) held'))
    // Gone, it is asked nothing: a Stop's close is the core's own.
    run.call.mockClear()
    expect(await run.streams.close('s1', {})).toEqual([{ type: 'turn_ended', payload: {} }])
    run.streams.get('s1')!.closeTurn('cancel')
    run.streams.forget('nobody')
    await run.streams.drainAll()
    expect(run.call).not.toHaveBeenCalled()
    run.answers.open.mockResolvedValueOnce(ok(opened({ frames: [frame(1, { turn: turn('t:9', false) })], turn: turn('t:9', false) })))
    run.streams.connected()
    run.streams.connected()
    await vi.waitFor(() => expect(run.answers.open).toHaveBeenCalledTimes(3))
    expect(run.answers.open.mock.calls[2][0]).toMatchObject({ resume: { turnOpen: false, offset: 12 }, live: false, abandon: false, held: false })
    await vi.waitFor(() => expect(run.deps.frame).toHaveBeenCalledOnce())
    expect(run.streams.get('s1')!.turn.identity).toBe('t:9')
    // The session whose open was not answered is attached again.
    expect(run.deps.reattach).toHaveBeenCalledWith(row('s2'))
    expect(run.deps.log).toHaveBeenCalledWith(expect.stringContaining('worker is back · following 1 conversation(s) again'))
    run.streams.stop()
  })

  it('opens nothing again for a stream forgotten, rebound or not answered while its worker came back', async () => {
    for (const change of ['forgotten', 'rebound', 'unanswered', 'gone'] as const) {
      const run = setup()
      await run.streams.open(row(), OPEN)
      run.streams.disconnected()
      let answer!: (value: Record<string, unknown>) => void
      run.answers.open.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
      if (change === 'rebound') run.sessions.set('s1', row('s1', 'grok'))
      if (change === 'gone') run.sessions.delete('s1')
      run.streams.connected()
      if (change === 'forgotten') run.streams.forget('s1')
      if (change === 'rebound' || change === 'gone') { expect(run.answers.open).toHaveBeenCalledOnce(); continue }
      await vi.waitFor(() => expect(run.answers.open).toHaveBeenCalledTimes(2))
      answer(change === 'unanswered' ? { error: 'SERVICE_UNAVAILABLE' } : ok(opened()))
      await vi.waitFor(() => expect(ops(run)).toContain('forget'))
      expect(run.deps.frame).not.toHaveBeenCalled()
      run.streams.stop()
    }
  })

  it('reopens a store stream against the same store after its worker restarts', async () => {
    const run = setup()
    const session = row('s1', 'opencode'); session.transcriptPath = null
    run.sessions.set('s1', session)
    await run.streams.open(session, { ...OPEN, store: '/private-fixture/store.db' })
    run.streams.disconnected()
    run.streams.connected()
    await vi.waitFor(() => expect(run.answers.open).toHaveBeenCalledTimes(2))
    expect(run.answers.open.mock.calls[1][0]).toMatchObject({ session: { store: '/private-fixture/store.db' } })
    run.streams.stop()
  })

  it('ignores a turn operation answered by the worker connection that has gone', async () => {
    const run = setup()
    await run.streams.open(row(), OPEN)
    let answer!: (value: Record<string, unknown>) => void
    run.answers.op.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const draining = run.streams.drain('s1')
    run.streams.disconnected()
    run.answers.open.mockResolvedValueOnce(ok(opened({ turn: turn('restarted', false) })))
    run.streams.connected()
    await vi.waitFor(() => expect(run.streams.get('s1')!.turn.identity).toBe('restarted'))
    answer(ok({ frames: [frame(1)], turn: turn('old-worker', true) }))
    await draining
    expect(run.deps.frame).not.toHaveBeenCalled()
    expect(run.streams.get('s1')!.turn).toEqual(turn('restarted', false))
    run.streams.stop()
  })

  it('does not let an old Stop close a new turn after a worker restart', async () => {
    const run = setup()
    await run.streams.open(row(), OPEN)
    let answer!: (value: Record<string, unknown>) => void
    run.answers.op.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const closing = run.streams.close('s1', {})
    run.streams.disconnected()
    run.answers.open.mockResolvedValueOnce(ok(opened({ turn: turn('new-turn', true) })))
    run.streams.connected()
    await vi.waitFor(() => expect(run.streams.get('s1')!.turn.identity).toBe('new-turn'))
    answer({ error: 'SERVICE_UNAVAILABLE' })
    expect(await closing).toEqual([])
    expect(run.streams.get('s1')!.turnOpen).toBe(true)
    run.streams.stop()
  })

  it('does not restore an opening stream after a second disconnect', async () => {
    const run = setup()
    await run.streams.open(row(), OPEN)
    run.streams.disconnected()
    let answer!: (value: Record<string, unknown>) => void
    run.answers.open.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    run.streams.connected()
    run.streams.disconnected()
    answer(ok(opened({ frames: [frame(1)] })))
    // The abandoned open is forgotten; it must not restore the orphan from the disconnected worker.
    await vi.waitFor(() => expect(ops(run)).toContain('forget'))
    run.streams.connected()
    await vi.waitFor(() => expect(run.answers.open).toHaveBeenCalledTimes(3))
    expect(run.deps.frame).not.toHaveBeenCalled()
    run.streams.stop()
  })

  it.each(['forgotten', 'stopped', 'disconnected', 'rebound'])('discards an initial open that was %s while awaiting the worker', async (change) => {
    const run = setup()
    let answer!: (value: Record<string, unknown>) => void
    run.answers.open.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const pending = run.streams.open(row(), OPEN)
    if (change === 'forgotten') run.streams.forget('s1')
    if (change === 'stopped') run.streams.stop()
    if (change === 'disconnected') run.streams.disconnected()
    if (change === 'rebound') run.sessions.set('s1', { ...row(), transcriptPath: '/new/file' })
    answer(ok(opened({ frames: [frame(1)] })))
    expect(await pending).toBeNull()
    expect(run.streams.has('s1')).toBe(false)
    expect(run.deps.frame).not.toHaveBeenCalled()
    expect(ops(run)).toContain('forget')
    run.streams.stop()
  })

  it('keeps the newest of overlapping initial opens when the older answers last', async () => {
    const run = setup()
    let answer!: (value: Record<string, unknown>) => void
    run.answers.open.mockImplementationOnce(() => new Promise(resolve => { answer = resolve }))
    const old = run.streams.open(row(), OPEN)
    await run.streams.open(row(), OPEN)
    const current = run.streams.get('s1')
    answer(ok(opened({ frames: [frame(1)] })))
    expect(await old).toBeNull()
    expect(run.streams.get('s1')).toBe(current)
    expect(run.deps.frame).not.toHaveBeenCalled()
    run.streams.stop()
  })

  it('rejects a serial gap without acknowledging or applying the later frame', async () => {
    const run = setup()
    await run.streams.open(row(), OPEN)
    await vi.waitFor(() => expect(run.waits).toHaveLength(1))
    const token = run.answers.open.mock.calls[0][0].token
    run.waits[0](ok({ pages: [{ token, frames: [frame(2)] }], lost: [] }))
    await vi.waitFor(() => expect(run.deps.reattach).toHaveBeenCalledOnce())
    expect(run.deps.frame).not.toHaveBeenCalled()
    run.streams.stop()
  })

  it('closes locally when a close reply omits its required events or turn', async () => {
    for (const answer of [{ frames: [], closed: true }, { frames: [], events: [], closed: true }]) {
      const run = setup()
      await run.streams.open(row(), OPEN)
      run.answers.op.mockResolvedValueOnce(ok(answer))
      expect(await run.streams.close('s1', {})).toEqual([{ type: 'turn_ended', payload: {} }])
      expect(run.streams.get('s1')!.turnOpen).toBe(false)
      run.streams.stop()
    }
  })

  it('locates stores through the worker and distinguishes no store from an unavailable answer', async () => {
    const run = setup()
    run.call.mockResolvedValueOnce(ok({ store: '/profiles/work/state.db', home: '/profiles/work' }))
    expect(await run.streams.locateStore({ ...row('s1', 'hermes'), hermesHome: '/profiles/work' })).toEqual({ store: '/profiles/work/state.db', home: '/profiles/work' })
    expect(run.call.mock.calls[0][1]).toMatchObject({ session: { engine: 'hermes', sessionId: 's1', hermesHome: '/profiles/work' } })
    run.call.mockResolvedValueOnce(ok({ store: null }))
    expect(await run.streams.locateStore(row('s1', 'openclaw'))).toEqual({ store: null })
    for (const reply of [{ error: 'SERVICE_UNAVAILABLE' }, ok({ store: 'relative' }), ok({ store: '/db', home: 4 })]) {
      run.call.mockResolvedValueOnce(reply)
      await expect(run.streams.locateStore(row())).rejects.toThrow('ENGINE_UNAVAILABLE')
    }
  })

  it('holds a corrupt stream while another engine continues delivering', async () => {
    const run = setup({ held: vi.fn() })
    const second = row('s2', 'grok')
    run.sessions.set('s2', second)
    await run.streams.open(row(), OPEN)
    await run.streams.open(second, OPEN)
    const firstToken = run.answers.open.mock.calls[0][0].token
    const secondToken = run.answers.open.mock.calls[1][0].token
    run.waits[0](ok({ pages: [{ token: firstToken, frames: [{ serial: -1 }] }, { token: secondToken, frames: [frame(1)] }], lost: [] }))
    await vi.waitFor(() => expect(run.deps.frame).toHaveBeenCalledWith(second, frame(1)))
    expect(run.deps.held).toHaveBeenCalledWith(row(), true)
    expect(run.streams.get('s2')!.turnOpen).toBe(true)
    run.streams.stop()
  })

  it('rejects reply bytes independently of the link and bounds initial stream admission', async () => {
    const run = setup()
    run.answers.open.mockResolvedValueOnce(ok({ ...opened(), extra: Array(65).fill('界'.repeat(350_000)) }))
    expect(await run.streams.open(row(), OPEN)).toBeNull()
    expect(run.streams.has('s1')).toBe(false)
    for (let index = 0; index < 512; index++) {
      const session = row(`full-${index}`)
      run.sessions.set(session.sessionId, session)
      await run.streams.open(session, OPEN)
    }
    expect(await run.streams.open(row(), OPEN)).toBeNull()
    expect(run.deps.log).toHaveBeenCalledWith('[engine-others] live stream limit reached')
    run.streams.stop()
  })

  it('retains the acknowledged file stamp and exposes a rewrite during reader recovery', async () => {
    vi.useFakeTimers()
    const run = setup({ held: vi.fn() })
    const stamp = { device: 1, inode: 2, bytes: 5, digest: 'a'.repeat(64) }
    run.answers.open.mockResolvedValueOnce(ok(opened({ offset: 5, stamp })))
    await run.streams.open(row(), OPEN)
    run.streams.disconnected()
    expect(run.deps.held).toHaveBeenLastCalledWith(row(), true)
    run.answers.open.mockResolvedValueOnce({ version: STREAM_VERSION, error: 'ENGINE_TRANSCRIPT_CHANGED' })
    run.streams.connected()
    await vi.waitFor(() => expect(run.answers.open).toHaveBeenCalledTimes(2))
    expect(run.answers.open.mock.calls[1][0].resume).toMatchObject({ offset: 5, stamp })
    await vi.waitFor(() => expect(run.deps.held).toHaveBeenCalledWith(row(), true, true))
    expect(run.deps.log).toHaveBeenCalledWith(expect.stringContaining('missed live events cannot be recovered'))
    await vi.advanceTimersByTimeAsync(10)
    expect(run.deps.reattach).toHaveBeenCalledOnce()
    run.streams.stop()
  })

  it('cancels a wait backoff on shutdown and stops repeated corrupt waits after five tries', async () => {
    vi.useFakeTimers()
    const run = setup({ held: vi.fn() })
    await run.streams.open(row(), OPEN)
    for (let index = 0; index < 5; index++) {
      run.waits[index]({ version: 99 })
      await vi.advanceTimersByTimeAsync(10 * 2 ** index)
    }
    expect(run.waits).toHaveLength(5)
    expect(run.deps.held).toHaveBeenLastCalledWith(row(), true)
    run.streams.stop()
    const next = setup()
    await next.streams.open(row(), OPEN)
    next.waits[0]({})
    await vi.advanceTimersByTimeAsync(0)
    next.streams.stop()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['open', 'operation', 'reconnect'])('rejects a frame gap during %s', async phase => {
    const run = setup()
    if (phase !== 'open') await run.streams.open(row(), OPEN)
    if (phase === 'operation') {
      run.answers.op.mockResolvedValueOnce(ok({ frames: [frame(2)], turn: turn() }))
      await run.streams.drain('s1')
    } else {
      run.answers.open.mockResolvedValueOnce(ok(opened({ frames: [frame(2)] })))
      if (phase === 'reconnect') { run.streams.disconnected(); run.streams.connected() }
      else expect(await run.streams.open(row(), OPEN)).toBeNull()
    }
    await vi.waitFor(() => expect(run.deps.reattach).toHaveBeenCalledOnce())
    expect(run.deps.frame).not.toHaveBeenCalled()
    run.streams.stop()
  })

  it('contains failed best-effort notifications and logs without a supplied logger', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = setup({ log: undefined, retryMs: undefined })
    await run.streams.open(row(), OPEN)
    run.answers.op.mockRejectedValue(new Error('link cut'))
    expect(await run.streams.close('s1', {})).toEqual([{ type: 'turn_ended', payload: {} }])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('closed by the core itself'))
    await run.streams.drainAll()
    run.streams.forget('s1')
    await vi.waitFor(() => expect(ops(run)).toContain('forget'))
    run.streams.stop()
  })

  it('bounds unanswered session retries and does not revive a session removed during the outage', async () => {
    vi.useFakeTimers()
    const run = setup({ held: vi.fn() })
    for (let index = 0; index <= 512; index++) run.streams.unavailable(row(`retry-${index}`))
    expect(run.deps.log).toHaveBeenCalledWith('[engine-others] live retry limit reached')
    run.streams.stop()
    const next = setup()
    next.answers.open.mockResolvedValueOnce({ error: 'SERVICE_UNAVAILABLE' })
    await next.streams.open(row(), OPEN)
    next.streams.disconnected()
    next.sessions.clear()
    next.streams.connected()
    expect(next.deps.reattach).not.toHaveBeenCalled()
    next.streams.stop()
  })

  it('keeps missing and malformed pages isolated from the wait and disconnected session list', async () => {
    vi.useFakeTimers()
    const run = setup({ held: vi.fn() })
    const session = row(); session.transcriptPath = null
    run.sessions.set('s1', session)
    await run.streams.open(session, OPEN)
    const token = run.answers.open.mock.calls[0][0].token
    run.sessions.clear()
    run.waits[0]({})
    await vi.advanceTimersByTimeAsync(10)
    run.waits[1](ok({ pages: [null, { token: 'gone', frames: 'invalid' }, { token, frames: [frame(1)] }], lost: [] }))
    await vi.advanceTimersByTimeAsync(0)
    run.streams.disconnected()
    run.streams.connected()
    expect(run.deps.held).toHaveBeenCalledTimes(1)
    run.streams.stop()
  })

  it.each(['present', 'removed'])('retries only a still-%s initial open after its retry timer expired offline', async state => {
    vi.useFakeTimers()
    const run = setup({ held: vi.fn() })
    let finish!: (value: Record<string, unknown>) => void
    run.answers.open.mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    const opening = run.streams.open(row(), OPEN)
    if (state === 'removed') run.sessions.clear()
    run.streams.disconnected()
    await vi.advanceTimersByTimeAsync(100)
    run.streams.connected()
    expect(run.deps.reattach).toHaveBeenCalledTimes(state === 'present' ? 1 : 0)
    finish(ok(opened()))
    expect(await opening).toBeNull()
    run.streams.stop()
  })

  it('preserves Stop authority and shows history uncertainty after the worker discards buffered events', async () => {
    vi.useFakeTimers()
    const run = setup({ held: vi.fn() })
    await run.streams.open(row(), OPEN)
    const token = run.answers.open.mock.calls[0][0].token
    run.waits[0](ok({ pages: [], lost: [token] }))
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.held).toHaveBeenLastCalledWith(row(), true, 'lost')
    expect(run.streams.get('s1')!.turnOpen).toBe(true)
    expect(await run.streams.close('s1', {})).toEqual([{ type: 'turn_ended', payload: {} }])
    await vi.advanceTimersByTimeAsync(10)
    expect(run.deps.reattach).toHaveBeenCalledOnce()
    run.streams.stop()
  })

  it.each(['resolve', 'reject'] as const)('resumes one reader recovery after the existing Stop promise %s settles', async outcome => {
    vi.useFakeTimers()
    const reservation = stopReservation(), observed = vi.spyOn(reservation.promise, 'then')
    let stopping: Promise<void> | undefined
    const run = setup({ stopping: () => stopping, held: vi.fn() })
    await run.streams.open(row(), OPEN)
    const token = run.answers.open.mock.calls[0][0].token
    run.waits[0](ok({ pages: [], lost: [token] }))
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.held).toHaveBeenLastCalledWith(row(), true, 'lost')
    stopping = reservation.promise
    await vi.advanceTimersByTimeAsync(10)
    for (let i = 0; i < 20; i++) run.streams.unavailable(row())
    expect(observed).toHaveBeenCalledOnce()
    expect(run.deps.reattach).not.toHaveBeenCalled()
    expect(run.deps.held).toHaveBeenLastCalledWith(row(), true, 'lost')
    stopping = undefined
    reservation[outcome]()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.held).toHaveBeenLastCalledWith(row(), false)
    expect(run.deps.reattach).toHaveBeenCalledExactlyOnceWith(row())
    await vi.advanceTimersByTimeAsync(1_000)
    expect(run.deps.reattach).toHaveBeenCalledOnce()
    run.streams.stop()
  })

  it('defers optional page health and rewritten recovery, but delivers native frame evidence during Stop', async () => {
    vi.useFakeTimers()
    const reservation = stopReservation()
    let stopping: Promise<void> | undefined
    const run = setup({ stopping: () => stopping, held: vi.fn() })
    await run.streams.open(row(), OPEN)
    vi.mocked(run.deps.held!).mockClear()
    stopping = reservation.promise
    const token = run.answers.open.mock.calls[0][0].token
    const native = frame(1, { rewritten: true, hold: 'The native store changed.' })
    run.waits[0](ok({ pages: [{ token, frames: [native] }], lost: [] }))
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.frame).toHaveBeenCalledExactlyOnceWith(row(), native)
    expect(run.deps.held).not.toHaveBeenCalled()
    expect(run.deps.reattach).not.toHaveBeenCalled()
    stopping = undefined
    reservation.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.reattach).toHaveBeenCalledOnce()
    run.streams.stop()
  })

  it.each(['removed', 'process', 'route', 'conversation', 'evidence'] as const)('drops recovery when the captured binding is %s during Stop', async change => {
    vi.useFakeTimers()
    const reservation = stopReservation()
    let stopping: Promise<void> | undefined = reservation.promise
    const run = setup({ stopping: () => stopping, held: vi.fn() })
    expect(await run.streams.open(row(), OPEN)).toBeNull()
    expect(run.answers.open).not.toHaveBeenCalled()
    const latest = run.sessions.get('s1')!
    if (change === 'removed') run.sessions.delete('s1')
    else if (change === 'process') latest.processIdentity = { pid: 8, executable: 'pi', startMarker: 'replacement' }
    else if (change === 'route') latest.runtimes = [{ backend: 'tmux', paneId: '%new' }]
    else if (change === 'conversation') latest.sessionId = 'different'
    else latest.evidenceRevision = 8
    if (change === 'process' || change === 'route' || change === 'evidence') run.streams.unavailable(latest)
    stopping = undefined
    reservation.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.held).not.toHaveBeenCalled()
    expect(run.deps.reattach).not.toHaveBeenCalled()
    run.streams.stop()
  })

  it('reports a recovery callback failure without rejecting the completed Stop', async () => {
    vi.useFakeTimers()
    const reservation = stopReservation()
    let stopping: Promise<void> | undefined = reservation.promise
    const run = setup({ stopping: () => stopping, reattach: vi.fn(() => { throw new Error('attachment failed') }) })
    run.streams.unavailable(row())
    stopping = undefined
    reservation.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.log).toHaveBeenCalledWith('[engine-others] LIVE_RECOVERY_FAILED')
    run.streams.stop()
  })

  it('keeps recovery with a later Stop until that reservation actually settles', async () => {
    vi.useFakeTimers()
    const first = stopReservation(), second = stopReservation()
    let stopping: Promise<void> | undefined = first.promise
    const run = setup({ stopping: () => stopping, held: vi.fn() })
    run.streams.unavailable(row())
    stopping = second.promise
    first.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.held).not.toHaveBeenCalled()
    expect(run.deps.reattach).not.toHaveBeenCalled()
    stopping = undefined
    second.reject()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.reattach).toHaveBeenCalledExactlyOnceWith(row())
    run.streams.stop()
  })

  it.each(['forget', 'stop', 'disconnect'] as const)('revokes deferred recovery on %s', async action => {
    vi.useFakeTimers()
    const reservation = stopReservation()
    let stopping: Promise<void> | undefined = reservation.promise
    const run = setup({ stopping: () => stopping, held: vi.fn() })
    run.streams.unavailable(row())
    if (action === 'forget') run.streams.forget('s1')
    else if (action === 'stop') run.streams.stop()
    else run.streams.disconnected()
    stopping = undefined
    reservation.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.held).not.toHaveBeenCalled()
    expect(run.deps.reattach).not.toHaveBeenCalled()
    run.streams.stop()
  })

  it('keeps one cancelled reservation through repeated forget and open before Stop settles', async () => {
    vi.useFakeTimers()
    const reservation = stopReservation(), observed = vi.spyOn(reservation.promise, 'then')
    let stopping: Promise<void> | undefined = reservation.promise
    const run = setup({ stopping: () => stopping, held: vi.fn() })
    for (let index = 0; index < 20; index++) {
      expect(await run.streams.open(row(), OPEN)).toBeNull()
      run.streams.forget('s1')
    }
    expect(await run.streams.open(row(), OPEN)).toBeNull()
    expect(observed).toHaveBeenCalledOnce()
    stopping = undefined
    reservation.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.reattach).toHaveBeenCalledExactlyOnceWith(row())
    run.streams.stop()
    run.streams.unavailable(row())
    expect(observed).toHaveBeenCalledOnce()
  })

  it.each(['before', 'after'] as const)('resumes an orphan when its Stop settles %s reconnection', async when => {
    vi.useFakeTimers()
    const reservation = stopReservation()
    const observed = vi.spyOn(reservation.promise, 'then')
    let stopping: Promise<void> | undefined
    const run = setup({ stopping: () => stopping, held: vi.fn() })
    await run.streams.open(row(), OPEN)
    stopping = reservation.promise
    run.streams.disconnected()
    if (when === 'after') {
      run.streams.connected()
      run.streams.disconnected()
      run.streams.connected()
    }
    expect(observed).toHaveBeenCalledOnce()
    stopping = undefined
    reservation.resolve()
    await vi.advanceTimersByTimeAsync(0)
    if (when === 'before') {
      expect(run.deps.held).toHaveBeenLastCalledWith(row(), true)
      expect(run.deps.reattach).not.toHaveBeenCalled()
      run.streams.connected()
      await vi.advanceTimersByTimeAsync(0)
    }
    expect(run.deps.held).toHaveBeenLastCalledWith(row(), false)
    expect(run.deps.reattach).toHaveBeenCalledOnce()
    run.streams.stop()
  })

  it('bounds deferred recoveries and releases their slots when Stop settles', async () => {
    vi.useFakeTimers()
    const reservation = stopReservation()
    let stopping: Promise<void> | undefined = reservation.promise
    const run = setup({ stopping: () => stopping, held: vi.fn() })
    for (let index = 0; index <= 512; index++) run.streams.unavailable(row(`held-${index}`))
    expect(run.deps.log).toHaveBeenCalledWith('[engine-others] live recovery limit reached')
    expect(run.deps.held).not.toHaveBeenCalled()
    stopping = undefined
    reservation.resolve()
    await vi.advanceTimersByTimeAsync(0)
    const next = stopReservation()
    stopping = next.promise
    run.streams.unavailable(row())
    stopping = undefined
    next.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.reattach).toHaveBeenCalledExactlyOnceWith(row())
    run.streams.stop()
  })

  it('stops: forgets every stream with the worker, retries nothing, and asks nothing more', async () => {
    vi.useFakeTimers()
    const run = setup()
    await run.streams.open(row(), OPEN)
    run.sessions.set('s2', row('s2'))
    run.answers.open.mockResolvedValueOnce({ error: 'SERVICE_UNAVAILABLE' })
    await run.streams.open(row('s2'), OPEN)
    run.streams.stop()
    expect(run.streams.has('s1')).toBe(false)
    expect(ops(run)).toEqual(['forget', 'forget'])
    run.streams.connected()
    run.streams.disconnected()
    await vi.advanceTimersByTimeAsync(30)
    expect(run.deps.reattach).not.toHaveBeenCalled()
  })
})
