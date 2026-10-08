import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Asker } from '../../core/api.js'
import type { EngineTranscript } from '../facets/transcript.js'
import { engineReaderRequests, runEngineReader } from './process.js'
import { runClaudeReader } from '../claude/claudeReaderProcess.js'
import { runCodexReader } from '../codex/codexReaderProcess.js'
import { READER_HISTORY, READER_IN_FLIGHT, READER_LAST_TURN, READER_REPLY_BYTES, READER_WAIT_MS } from './protocol.js'

vi.mock('../../services/process.js', async (real) => ({ ...await real<object>(), runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))
const asker: Asker = { owner: true, local: true }
const session = { sessionId: 'conversation', transcriptPath: '/private/read.jsonl', touchedAt: 1, codexHome: '/private/codex' }
const page = { events: [], timestamp: '2026-10-07T00:00:00Z' }
const answer = { userMessage: 'hello', assistantText: 'world' }
const payload = { version: 1, session, ask: { limit: 3, before: 'cursor' } }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }
const failed = (error: string, retryable = true) => ({ version: 1, error, retryable })

function setup() {
  const adapter = { historyPage: vi.fn(async () => page), lastTurnText: vi.fn(async () => answer) }
  const load = vi.fn(async () => adapter)
  const recycle = vi.fn()
  const requests = engineReaderRequests('claude', { load, recycle })
  return { requests, adapter, load, recycle, read: (data: Record<string, unknown> = payload, who = asker, signal?: AbortSignal) => requests[READER_HISTORY](data, who, signal) }
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('read-only engine worker', () => {
  it('loads on first read, shares one adapter and bounded pager, and only passes allowed snapshot fields', async () => {
    const t = setup()
    expect(t.load).not.toHaveBeenCalled()
    expect(await t.read({ ...payload, session: { ...session, agentId: 'do-not-copy', processIdentity: {} } })).toEqual({ version: 1, answer: page })
    expect(t.adapter.historyPage).toHaveBeenCalledWith(session, payload.ask, expect.objectContaining({}))
    expect(await t.requests[READER_LAST_TURN]({ version: 1, session }, asker)).toEqual({ version: 1, answer })
    expect(t.adapter.lastTurnText).toHaveBeenCalledWith(session)
    expect(t.load).toHaveBeenCalledOnce()
    expect(await t.read({ version: 1, session: { ...session, sessionId: '', transcriptPath: null, codexHome: undefined }, ask: {} })).toEqual({ version: 1, answer: page })
    expect(await t.read({ version: 1, session: { ...session, codexHome: null } })).toEqual({ version: 1, answer: page })
    expect(t.recycle).not.toHaveBeenCalled()
  })

  it('refuses public callers, unknown versions and invalid request fields before loading a reader', async () => {
    const t = setup()
    for (const who of [{ ...asker, owner: false }, { ...asker, local: false }, { ...asker, connection: 'client' }]) {
      expect(await t.read(payload, who)).toEqual(failed('ENGINE_INVALID_REQUEST', false))
    }
    const badSessions = [undefined, null, [], {}, { ...session, sessionId: 1 }, { ...session, sessionId: null }, { ...session, sessionId: 'x'.repeat(201) },
      ...['relative', '/a\0b', 1, 'x'.repeat(32769)].map(transcriptPath => ({ ...session, transcriptPath })),
      ...[undefined, Infinity, 8.64e15 + 1].map(touchedAt => ({ ...session, touchedAt })),
      { ...session, codexHome: 'relative' }]
    for (const bad of badSessions) expect(await t.read({ ...payload, session: bad })).toEqual(failed('ENGINE_INVALID_REQUEST', false))
    for (const ask of [null, [], { limit: '1' }, { limit: 0 }, { limit: 1.5 }, { limit: 501 }, { before: 3 }, { before: 'x'.repeat(2001) }]) {
      expect(await t.read({ ...payload, ask })).toEqual(failed('ENGINE_INVALID_REQUEST', false))
    }
    expect(await t.read({ ...payload, version: 2 })).toEqual(failed('ENGINE_INVALID_REQUEST', false))
    expect(t.load).not.toHaveBeenCalled()
  })

  it('bounds concurrent work, answers busy immediately, and drops answers for a departed connection', async () => {
    const t = setup()
    const work = deferred<typeof page>()
    t.adapter.historyPage.mockImplementation(() => work.promise)
    const controller = new AbortController()
    controller.abort()
    expect(await t.read(payload, asker, controller.signal)).toEqual(failed('ENGINE_UNAVAILABLE'))
    const closed = new AbortController()
    const reads = Array.from({ length: READER_IN_FLIGHT }, () => t.read(payload, asker, closed.signal))
    expect(await t.read()).toEqual(failed('ENGINE_BUSY'))
    closed.abort(); work.resolve(page)
    for (const result of await Promise.all(reads)) expect(result).toEqual(failed('ENGINE_UNAVAILABLE'))
    expect(await t.read()).toEqual({ version: 1, answer: page })
  })

  it('recycles a read that hangs asynchronously even while the process can still beat', async () => {
    vi.useFakeTimers()
    const t = setup(); const work = deferred<typeof page>()
    t.adapter.historyPage.mockImplementation(() => work.promise)
    const read = t.read()
    await vi.advanceTimersByTimeAsync(READER_WAIT_MS - 1)
    expect(t.recycle).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(await read).toEqual(failed('ENGINE_UNAVAILABLE'))
    expect(t.recycle).toHaveBeenCalledOnce()
    work.resolve(page)
  })

  it('uses process exit for the production deadline and cancels deadlines after errors', async () => {
    vi.useFakeTimers()
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never)
    const work = deferred<EngineTranscript>()
    const requests = engineReaderRequests('codex', { load: () => work.promise })
    const read = requests[READER_LAST_TURN]({ version: 1, session }, asker)
    await vi.advanceTimersByTimeAsync(READER_WAIT_MS)
    expect(await read).toEqual(failed('ENGINE_UNAVAILABLE'))
    expect(exit).toHaveBeenCalledWith(1)
    work.resolve({ historyPage: async () => page, lastTurnText: async () => answer })
    await vi.runAllTimersAsync()
    const t = setup()
    t.load.mockRejectedValueOnce(new Error('import failed'))
    await expect(t.read()).rejects.toThrow('import failed')
    expect(await t.read()).toEqual({ version: 1, answer: page })
    expect(t.load).toHaveBeenCalledTimes(2)
    t.adapter.historyPage.mockRejectedValueOnce(new Error('bad file'))
    await expect(t.read()).rejects.toThrow('bad file')
    await vi.advanceTimersByTimeAsync(READER_WAIT_MS)
    expect(t.recycle).not.toHaveBeenCalled()
  })

  it('rejects oversized serialized replies before sending them to core', async () => {
    const t = setup()
    t.adapter.lastTurnText.mockResolvedValue({ ...answer, assistantText: '😺'.repeat(READER_REPLY_BYTES / 4) })
    expect(await t.requests[READER_LAST_TURN]({ version: 1, session }, asker)).toEqual(failed('ENGINE_REPLY_TOO_LARGE', false))
  })

  it('uses real readers for both engines and gives each runner only its own authenticated link', async () => {
    for (const engine of ['claude', 'codex'] as const) {
      const requests = engineReaderRequests(engine)
      expect(await requests[READER_LAST_TURN]({ version: 1, session: { ...session, transcriptPath: null } }, asker)).toEqual({ version: 1, answer: null })
    }
    const opts = { dataDir: '/private/data', socketPath: '/private/socket', machineId: 'machine', token: 'token' }
    const requests = setup().requests
    const run = vi.fn(() => ({ stop: vi.fn() }))
    for (const [name, start] of [['claude', runClaudeReader], ['codex', runCodexReader]] as const) {
      const process = start({ ...opts, requests, run })
      expect(run).toHaveBeenLastCalledWith({ name: `engine-${name}`, socketPath: opts.socketPath, machineId: opts.machineId, token: opts.token, requests, onConnected: expect.any(Function), onDisconnected: expect.any(Function) })
      expect(process.stop).toBeTypeOf('function')
    }
    expect(runEngineReader('claude', opts).stop).toBeTypeOf('function')
  })
})
