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

/** The worker, scripted: each request type answered by the test's own function; a wait held until the test answers it. */
function setup(over: Partial<OtherStreamsDeps> = {}) {
  const sessions = new Map<string, RegisteredSession>([['s1', row()]])
  const waits: Array<(answer: Record<string, unknown>) => void> = []
  const answers = {
    open: vi.fn(async (_payload: Record<string, unknown>): Promise<Record<string, unknown>> => ok(opened())),
    op: vi.fn(async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => ok({ frames: [], turn: turn(`t:${payload.op}`, payload.op === 'open') })),
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
    expect(log).toHaveBeenCalledWith(expect.stringContaining('frame failed · taker broke'))
    run.sessions.set('s1', row('s1', 'grok'))
    run.waits[0]?.(ok({ pages: [], lost: [] }))
    await vi.waitFor(() => expect(run.waits.length).toBeGreaterThan(0))
    const token = run.answers.open.mock.calls[0][0].token as string
    run.waits.at(-1)!(ok({ pages: [{ token, frames: [frame(2, { rewritten: true })] }], lost: [] }))
    await new Promise((resolve) => setTimeout(resolve, 5))
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
    expect(run.streams.has('s1')).toBe(false)
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
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(run.deps.reattach).toHaveBeenCalledOnce()
    // Gone or another engine's by the time it is tried: not attached again.
    run.answers.open.mockResolvedValueOnce({ error: 'SERVICE_UNAVAILABLE' })
    await run.streams.open(row(), OPEN)
    run.sessions.set('s1', row('s1', 'grok'))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(run.deps.reattach).toHaveBeenCalledOnce()
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
    run.answers.op.mockResolvedValueOnce(ok({ closed: false, frames: [], turn: turn('t:2', true) }))
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
    answer(ok({ frames: [frame(1, { turn: turn('t:1', true) })], turn: turn('t:2', false) }))
    await vi.waitFor(() => expect(run.deps.frame).toHaveBeenCalledOnce())
    expect(run.streams.get('s1')!.turnOpen).toBe(false)
    run.streams.get('s1')!.closeTurn('abandoned')
    await vi.waitFor(() => expect(ops(run)).toEqual(['cancel', 'close']))
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
    run.call.mockRejectedValueOnce(new Error('cut'))
    expect(await run.streams.openTurn('s1')).toEqual([])
    run.answers.op.mockResolvedValueOnce({ version: STREAM_VERSION, error: 'ENGINE_STREAM_GONE' })
    await run.streams.drain('s1')
    expect(run.streams.has('s1')).toBe(false)
    expect(run.deps.reattach).toHaveBeenCalledOnce()
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
    run.answers.op.mockImplementation(async () => ok({ frames: [frame(1)], quietFor: 10 * 60_000 }))
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
    run.answers.open.mockResolvedValueOnce(ok(opened({ frames: [frame(1)], turn: turn('t:9', false) })))
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
      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(run.deps.frame).not.toHaveBeenCalled()
      run.streams.stop()
    }
  })

  it('stops: forgets every stream with the worker, retries nothing, and asks nothing more', async () => {
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
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(run.deps.reattach).not.toHaveBeenCalled()
  })
})
