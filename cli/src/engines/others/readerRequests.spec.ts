import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Asker } from '../../core/api.js'
import type { EngineTranscript } from '../facets/transcript.js'
import { createHash } from 'node:crypto'
import { READER_HISTORY, READER_IN_FLIGHT, READER_LAST_TURN, READER_PART, READER_PARTED_BYTES } from '../worker/protocol.js'
import { otherEngineRequests, runOtherEngines } from './otherEnginesProcess.js'
import { STREAM_OPEN, STREAMS_WAIT, STREAM_VERSION } from '../worker/otherStreamProtocol.js'
import { OTHER_READ_STUCK_MS, OTHER_READS_IN_FLIGHT, otherReaderRequests, type OtherReaderDeps } from './readerRequests.js'

vi.mock('../../services/process.js', async (real) => ({ ...await real<object>(), runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))
const asker: Asker = { owner: true, local: true }
const session = { engine: 'pi', sessionId: 'conversation', transcriptPath: '/private/read.jsonl', touchedAt: 1 }
const page = { events: [], timestamp: '2026-10-07T00:00:00Z' }
const answer = { userMessage: 'hello', assistantText: 'world' }
const payload = { version: 1, session, ask: { limit: 3, before: 'cursor' } }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
const failed = (error: string, retryable = true) => ({ version: 1, error, retryable })

function setup(limits?: OtherReaderDeps['limits']) {
  const reader = { historyPage: vi.fn(async (): Promise<typeof page> => page), lastTurnText: vi.fn(async (): Promise<typeof answer | null> => answer) }
  const transcriptFor = vi.fn((_engine: string): EngineTranscript => reader as unknown as EngineTranscript)
  const recycle = vi.fn()
  const log = vi.fn()
  const requests = otherReaderRequests({ transcriptFor, recycle, log, limits })
  return { requests, reader, transcriptFor, recycle, log,
    read: (data: Record<string, unknown> = payload, who = asker, signal?: AbortSignal) => requests[READER_HISTORY](data, who, signal) }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('the other engines\' readers in their worker', () => {
  it('reads for the engine each request names, with only the snapshot fields it is allowed', async () => {
    const t = setup()
    expect(await t.read({ ...payload, session: { ...session, agentId: 'not-copied', processIdentity: {}, store: '/stores/pi.db' } })).toEqual({ version: 1, answer: page })
    expect(t.transcriptFor).toHaveBeenLastCalledWith('pi')
    expect(t.reader.historyPage).toHaveBeenLastCalledWith({ sessionId: 'conversation', transcriptPath: '/private/read.jsonl', touchedAt: 1, store: '/stores/pi.db' },
      { limit: 3, before: 'cursor' }, expect.objectContaining({ page: expect.any(Function) }))
    expect(await t.requests[READER_LAST_TURN]({ version: 1, session: { ...session, engine: 'opencode', transcriptPath: null, store: '/stores/opencode.db' } }, asker))
      .toEqual({ version: 1, answer })
    expect(t.transcriptFor).toHaveBeenLastCalledWith('opencode')
    expect(t.reader.lastTurnText).toHaveBeenLastCalledWith({ sessionId: 'conversation', transcriptPath: null, touchedAt: 1, store: '/stores/opencode.db' })
    // No ask is a whole read; a store not named is none.
    expect(await t.read({ version: 1, session: { ...session, engine: 'muse' } })).toEqual({ version: 1, answer: page })
    expect(t.reader.historyPage).toHaveBeenLastCalledWith({ ...session, engine: undefined, store: null }, {}, expect.anything())
    expect(t.recycle).not.toHaveBeenCalled()
  })

  it('refuses a public caller, another version, an engine not theirs and any malformed field before reading', async () => {
    const t = setup()
    for (const who of [{ ...asker, owner: false }, { ...asker, local: false }, { ...asker, connection: 'client' }]) {
      expect(await t.read(payload, who)).toEqual(failed('ENGINE_INVALID_REQUEST', false))
    }
    const badSessions = [undefined, null, [], {}, { ...session, engine: 'claude' }, { ...session, engine: 'codex' }, { ...session, engine: 'constructor' },
      { ...session, engine: undefined }, { ...session, sessionId: 1 }, { ...session, sessionId: 'x'.repeat(201) },
      ...['relative', '/a\0b', 1, 'x'.repeat(32769)].map(transcriptPath => ({ ...session, transcriptPath })),
      ...[undefined, Infinity, 8.64e15 + 1].map(touchedAt => ({ ...session, touchedAt })),
      ...['relative', 7].map(store => ({ ...session, store }))]
    for (const bad of badSessions) expect(await t.read({ ...payload, session: bad })).toEqual(failed('ENGINE_INVALID_REQUEST', false))
    for (const ask of [null, [], { limit: '1' }, { limit: 0 }, { limit: 1.5 }, { limit: 501 }, { before: 3 }, { before: 'x'.repeat(2001) }]) {
      expect(await t.read({ ...payload, ask })).toEqual(failed('ENGINE_INVALID_REQUEST', false))
    }
    expect(await t.read({ ...payload, version: 2 })).toEqual(failed('ENGINE_INVALID_REQUEST', false))
    expect(t.transcriptFor).not.toHaveBeenCalled()
  })

  it('bounds reads per engine and in all, answers busy at once, and drops answers for a departed connection', async () => {
    const t = setup()
    const work = deferred<typeof page>()
    t.reader.historyPage.mockImplementation(() => work.promise)
    const gone = new AbortController()
    gone.abort()
    expect(await t.read(payload, asker, gone.signal)).toEqual(failed('ENGINE_UNAVAILABLE'))
    const closed = new AbortController()
    const pi = Array.from({ length: READER_IN_FLIGHT }, () => t.read(payload, asker, closed.signal))
    expect(await t.read()).toEqual(failed('ENGINE_BUSY'))
    // Another engine still reads while Pi is full, until the worker's own bound.
    const engines = ['opencode', 'cursor', 'kilo']
    const others = engines.flatMap(engine => Array.from({ length: READER_IN_FLIGHT }, () => t.read({ ...payload, session: { ...session, engine } }, asker, closed.signal)))
    expect(READER_IN_FLIGHT * (1 + engines.length)).toBe(OTHER_READS_IN_FLIGHT)
    expect(await t.read({ ...payload, session: { ...session, engine: 'grok' } })).toEqual(failed('ENGINE_BUSY'))
    closed.abort(); work.resolve(page)
    for (const result of await Promise.all([...pi, ...others])) expect(result).toEqual(failed('ENGINE_UNAVAILABLE'))
    expect(await t.read()).toEqual({ version: 1, answer: page })
  })

  it('answers a read past its deadline unavailable and keeps its place until it ends, recycling only one that is stuck', async () => {
    vi.useFakeTimers()
    const t = setup(); const work = deferred<typeof page>()
    t.reader.historyPage.mockImplementation(() => work.promise)
    const reads = Array.from({ length: READER_IN_FLIGHT }, () => t.read())
    await vi.advanceTimersByTimeAsync(15_000 - 1)
    expect(t.log).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    for (const read of await Promise.all(reads)) expect(read).toEqual(failed('ENGINE_UNAVAILABLE'))
    expect(t.log).toHaveBeenLastCalledWith('[engine pi] history not read within 15 s · answered unavailable')
    // Still reading: Pi's places are taken, and no other engine's read is cut short for it.
    expect(await t.read()).toEqual(failed('ENGINE_BUSY'))
    const kilo = t.read({ ...payload, session: { ...session, engine: 'kilo' } })
    expect(t.recycle).not.toHaveBeenCalled()
    work.resolve(page)
    expect(await kilo).toEqual({ version: 1, answer: page })
    await vi.advanceTimersByTimeAsync(0)
    // What the late reads found is not kept: the core was already answered.
    const t2 = setup({ inline: 8, part: 4, parted: 400 }); const slow = deferred<typeof page>()
    t2.reader.historyPage.mockImplementation(() => slow.promise)
    const late = t2.read()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await late).toEqual(failed('ENGINE_UNAVAILABLE'))
    slow.resolve(page)
    await vi.advanceTimersByTimeAsync(0)
    t2.reader.historyPage.mockImplementation(async () => page)
    const fresh = await t2.read()
    expect(await t2.requests[READER_PART]({ version: 1, part: fresh.part, offset: 4 }, asker)).toMatchObject({ offset: 4 })
    t.reader.historyPage.mockImplementation(async () => page)
    expect(await t.read()).toEqual({ version: 1, answer: page })
    await vi.advanceTimersByTimeAsync(OTHER_READ_STUCK_MS)
    expect(t.recycle).not.toHaveBeenCalled()
    // Amp's history waits for its export; a read still running a minute past its deadline is stuck.
    t.reader.historyPage.mockImplementation(() => new Promise(() => {}))
    const amp = t.read({ ...payload, session: { ...session, engine: 'amp', sessionId: 'T-0123456789abcdef' } })
    await vi.advanceTimersByTimeAsync(24_999)
    expect(t.log).not.toHaveBeenLastCalledWith('[engine amp] history not read within 25 s · answered unavailable')
    await vi.advanceTimersByTimeAsync(1)
    expect(await amp).toEqual(failed('ENGINE_UNAVAILABLE'))
    expect(t.log).toHaveBeenLastCalledWith('[engine amp] history not read within 25 s · answered unavailable')
    await vi.advanceTimersByTimeAsync(OTHER_READ_STUCK_MS - 1)
    expect(t.recycle).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(t.log).toHaveBeenLastCalledWith('[engine amp] history still read 85 s after it began · recycling this worker')
    expect(t.recycle).toHaveBeenCalledOnce()
    t.reader.lastTurnText.mockImplementation(() => new Promise(() => {}))
    const last = t.requests[READER_LAST_TURN]({ version: 1, session: { ...session, engine: 'amp' } }, asker)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await last).toEqual(failed('ENGINE_UNAVAILABLE'))
    expect(t.log).toHaveBeenLastCalledWith('[engine amp] last turn not read within 15 s · answered unavailable')
  })

  it('says a reader that throws, and answers it unavailable', async () => {
    const t = setup()
    t.reader.historyPage.mockRejectedValueOnce(new Error('PRIVATE_TRANSCRIPT_TOKEN:/home/person/session'))
    expect(await t.read()).toEqual(failed('ENGINE_UNAVAILABLE'))
    expect(t.log).toHaveBeenLastCalledWith('[engine pi] HISTORY_READ_FAILED · Error')
    t.reader.lastTurnText.mockRejectedValueOnce('PRIVATE_TRANSCRIPT_TOKEN:/home/person/session')
    expect(await t.requests[READER_LAST_TURN]({ version: 1, session }, asker)).toEqual(failed('ENGINE_UNAVAILABLE'))
    expect(t.log).toHaveBeenLastCalledWith('[engine pi] LAST_TURN_READ_FAILED · string')
    expect(await t.read()).toEqual({ version: 1, answer: page })
  })

  it('sends a reply past one frame in parts, each once, keeping a few, and refuses one past the parts\' bound', async () => {
    const t = setup({ inline: 64, part: 50, parted: 400 })
    const big = { events: [{ type: 'text_delta', payload: { content: 'x'.repeat(100) } }], timestamp: page.timestamp }
    t.reader.historyPage.mockResolvedValue(big as never)
    const whole = Buffer.from(JSON.stringify({ version: 1, answer: big }))
    const hash = createHash('sha256').update(whole).digest('hex')
    const first = await t.read()
    expect(first).toEqual({ version: 1, part: expect.any(String), offset: 0, bytes: whole.length, hash, data: whole.subarray(0, 50).toString('base64') })
    const next = (offset: number, part = first.part) => t.requests[READER_PART]({ version: 1, part, offset }, asker)
    let taken = Buffer.from(first.data as string, 'base64')
    while (taken.length < whole.length) {
      const reply = await next(taken.length)
      expect(reply).toMatchObject({ version: 1, part: first.part, offset: taken.length, bytes: whole.length, hash })
      taken = Buffer.concat([taken, Buffer.from(reply.data as string, 'base64')])
    }
    expect(taken.equals(whole)).toBe(true)
    // Its last part let it go.
    expect(await next(0)).toEqual(failed('ENGINE_STALE_REPLY'))
    for (const bad of [{ part: 7, offset: 0 }, { part: first.part, offset: -1 }, { part: first.part, offset: 1.5 }, { part: first.part }]) {
      expect(await t.requests[READER_PART]({ version: 1, ...bad }, asker)).toEqual(failed('ENGINE_INVALID_REQUEST', false))
    }
    expect(await t.requests[READER_PART]({ version: 2, part: first.part, offset: 0 }, asker)).toEqual(failed('ENGINE_INVALID_REQUEST', false))
    expect(await t.requests[READER_PART]({ version: 1, part: first.part, offset: 0 }, { ...asker, connection: 'client' })).toEqual(failed('ENGINE_INVALID_REQUEST', false))
    // A few kept at once: a fifth lets the oldest go.
    const kept = [] as Array<Record<string, unknown>>
    for (let i = 0; i < 5; i++) kept.push(await t.read())
    expect(await next(50, kept[0].part)).toEqual(failed('ENGINE_STALE_REPLY'))
    expect(await next(50, kept[4].part)).toMatchObject({ part: kept[4].part, offset: 50 })
    expect(await next(whole.length, kept[4].part)).toEqual(failed('ENGINE_STALE_REPLY'))
    t.reader.historyPage.mockResolvedValue({ ...big, events: [{ type: 'text_delta', payload: { content: 'x'.repeat(400) } }] } as never)
    expect(await t.read()).toEqual(failed('ENGINE_REPLY_TOO_LARGE', false))
    expect(READER_PARTED_BYTES).toBe(64 * 1024 * 1024)
  })

  it('clears a waiting inline call and finishes stopping before restarting the tailer', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'other-inline-'))
    const file = join(dir, 'pi.jsonl')
    writeFileSync(file, '')
    const closed = deferred<void>()
    const watcher = { on: vi.fn(), start: vi.fn(), addSession: vi.fn(async () => {}), removeSession: vi.fn(async () => {}),
      pollSession: vi.fn(async () => {}), stop: vi.fn(() => closed.promise) }
    const service = otherEngineRequests(watcher as never)
    const open = (token: string) => service.call(STREAM_OPEN, { version: STREAM_VERSION, token, live: false, abandon: false, held: false,
      session: { agentId: 'a', sessionId: 's', engine: 'pi', transcriptPath: file, store: null } }, 1_000)
    try {
      expect(await open('first')).toHaveProperty('answer')
      const waiting = service.call(STREAMS_WAIT, { version: STREAM_VERSION, acks: {} }, 30_000)
      await Promise.resolve(); await Promise.resolve()
      service.clear()
      expect(await waiting).toMatchObject({ answer: { pages: [], lost: [] } })
      const next = open('next')
      await Promise.resolve(); await Promise.resolve()
      expect(watcher.addSession).toHaveBeenCalledOnce()
      closed.resolve()
      expect(await next).toHaveProperty('answer')
      expect(watcher.start).toHaveBeenCalledTimes(2)
    } finally { closed.resolve(); service.clear(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('reads with the engines\' own code by default, and runs as its own authenticated service', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'other-readers-'))
    try {
      const file = join(dir, 'pi.jsonl')
      writeFileSync(file, '')
      const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const requests = otherReaderRequests()
      expect(await requests[READER_LAST_TURN]({ version: 1, session: { ...session, transcriptPath: null } }, asker)).toEqual({ version: 1, answer: null })
      expect(await requests[READER_HISTORY]({ version: 1, session: { ...session, transcriptPath: file } }, asker))
        .toMatchObject({ version: 1, answer: { events: [{ type: 'done', payload: { result: 'success' } }] } })
      expect(await requests[READER_HISTORY]({ version: 1, session: { ...session, engine: 'opencode', transcriptPath: null, store: join(dir, 'missing.db') } }, asker))
        .toMatchObject({ version: 1 })
      expect(exit).not.toHaveBeenCalled()
      warn.mockRestore()
    } finally { rmSync(dir, { recursive: true, force: true }) }
    const opts = { dataDir: '/private/data', socketPath: '/private/socket', machineId: 'machine', token: 'token' }
    const requests = setup().requests
    const run = vi.fn(() => ({ stop: vi.fn() }))
    expect(runOtherEngines({ ...opts, requests, run }).stop).toBeTypeOf('function')
    expect(run).toHaveBeenLastCalledWith({ name: 'engine-others', socketPath: opts.socketPath, machineId: opts.machineId, token: opts.token, requests,
      onConnected: expect.any(Function), onDisconnected: expect.any(Function) })
    expect(runOtherEngines(opts).stop).toBeTypeOf('function')
  })
})
