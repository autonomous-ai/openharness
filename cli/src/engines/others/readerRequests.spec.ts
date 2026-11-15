import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Asker } from '../../core/api.js'
import type { EngineTranscript } from '../facets/transcript.js'
import { READER_HISTORY, READER_IN_FLIGHT, READER_LAST_TURN, READER_REPLY_BYTES, READER_WAIT_MS } from '../worker/protocol.js'
import { runOtherEngines } from './process.js'
import { OTHER_READS_IN_FLIGHT, otherReaderRequests } from './readerRequests.js'

vi.mock('../../services/process.js', async (real) => ({ ...await real<object>(), runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))
const asker: Asker = { owner: true, local: true }
const session = { engine: 'pi', sessionId: 'conversation', transcriptPath: '/private/read.jsonl', touchedAt: 1 }
const page = { events: [], timestamp: '2026-10-07T00:00:00Z' }
const answer = { userMessage: 'hello', assistantText: 'world' }
const payload = { version: 1, session, ask: { limit: 3, before: 'cursor' } }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
const failed = (error: string, retryable = true) => ({ version: 1, error, retryable })

function setup() {
  const reader = { historyPage: vi.fn(async (): Promise<typeof page> => page), lastTurnText: vi.fn(async (): Promise<typeof answer | null> => answer) }
  const transcriptFor = vi.fn((_engine: string): EngineTranscript => reader as unknown as EngineTranscript)
  const recycle = vi.fn()
  const log = vi.fn()
  const requests = otherReaderRequests({ transcriptFor, recycle, log })
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

  it('recycles the worker for a read that outlasts its deadline, Amp\'s history its own export\'s, never the core', async () => {
    vi.useFakeTimers()
    const t = setup(); const work = deferred<typeof page>()
    t.reader.historyPage.mockImplementation(() => work.promise)
    const read = t.read()
    await vi.advanceTimersByTimeAsync(READER_WAIT_MS - 1)
    expect(t.recycle).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await read).toEqual(failed('ENGINE_UNAVAILABLE'))
    expect(t.recycle).toHaveBeenCalledOnce()
    const amp = t.read({ ...payload, session: { ...session, engine: 'amp', sessionId: 'T-0123456789abcdef' } })
    await vi.advanceTimersByTimeAsync(24_999)
    expect(t.recycle).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(await amp).toEqual(failed('ENGINE_UNAVAILABLE'))
    expect(t.recycle).toHaveBeenCalledTimes(2)
    const last = t.requests[READER_LAST_TURN]({ version: 1, session: { ...session, engine: 'amp' } }, asker)
    t.reader.lastTurnText.mockImplementation(() => new Promise(() => {}))
    await vi.advanceTimersByTimeAsync(READER_WAIT_MS)
    await last
    work.resolve(page)
  })

  it('says a reader that throws, and answers it unavailable', async () => {
    const t = setup()
    t.reader.historyPage.mockRejectedValueOnce(new Error('no SQLite reader'))
    expect(await t.read()).toEqual(failed('ENGINE_UNAVAILABLE'))
    expect(t.log).toHaveBeenLastCalledWith('[engine pi] history unreadable · no SQLite reader')
    t.reader.lastTurnText.mockRejectedValueOnce('locked')
    expect(await t.requests[READER_LAST_TURN]({ version: 1, session }, asker)).toEqual(failed('ENGINE_UNAVAILABLE'))
    expect(t.log).toHaveBeenLastCalledWith('[engine pi] last turn unreadable · locked')
    expect(await t.read()).toEqual({ version: 1, answer: page })
  })

  it('refuses an oversized serialized reply before it reaches the core', async () => {
    const t = setup()
    t.reader.lastTurnText.mockResolvedValue({ ...answer, assistantText: '😺'.repeat(READER_REPLY_BYTES / 4) })
    expect(await t.requests[READER_LAST_TURN]({ version: 1, session }, asker)).toEqual(failed('ENGINE_REPLY_TOO_LARGE', false))
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
    expect(run).toHaveBeenLastCalledWith({ name: 'engine-others', socketPath: opts.socketPath, machineId: opts.machineId, token: opts.token, requests })
    expect(runOtherEngines(opts).stop).toBeTypeOf('function')
  })
})
