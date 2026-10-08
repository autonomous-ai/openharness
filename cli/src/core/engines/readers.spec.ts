import { describe, expect, it, vi } from 'vitest'
import { createEngineReaders } from './readers.js'
import type { EngineTranscript, TranscriptSession } from '../../engines/facets/transcript.js'
import { EngineReadError, READER_ERRORS, READER_HISTORY, READER_IN_FLIGHT, READER_LAST_TURN, READER_SERVICES, READER_VERSION, READER_WAIT_MS } from '../../engines/worker/protocol.js'

const session: TranscriptSession = { sessionId: 'conversation', transcriptPath: '/private/read.jsonl', touchedAt: 100, codexHome: '/private/codex' }
const page = { events: [], timestamp: '2026-10-07T00:00:00.000Z' }
const turn = { userMessage: 'hello', assistantText: 'world' }
const pages = {} as Parameters<EngineTranscript['historyPage']>[2]
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }

function setup() {
  const replies: ReturnType<typeof deferred<Record<string, unknown>>>[] = []
  const call = vi.fn(() => { const reply = deferred<Record<string, unknown>>(); replies.push(reply); return reply.promise })
  const inline = vi.fn(() => { throw new Error('isolated reads never fall back') })
  const port = createEngineReaders({ isolated: new Set(Object.values(READER_SERVICES)), call, inline })
  return { ...port, call, inline, replies, history: () => port.forEngine('claude')!.historyPage(session, { limit: 2, before: 'cursor' }, pages) }
}

describe('the core reader port', () => {
  it('wakes on a cold call, passes only the immutable read snapshot, and accepts a versioned answer', async () => {
    const p = setup()
    const answer = p.history()
    expect(p.call).toHaveBeenCalledWith('engine-claude', READER_HISTORY,
      { version: READER_VERSION, session, ask: { limit: 2, before: 'cursor' } }, READER_WAIT_MS)
    expect(p.call.mock.calls[0]).not.toContain(pages)
    p.connected('engine-claude')
    p.replies[0].resolve({ version: READER_VERSION, answer: page })
    expect(await answer).toEqual(page)
    const warm = p.forEngine('claude')!.historyPage(session, { limit: 0 }, pages)
    p.replies[1].resolve({ version: READER_VERSION, answer: page })
    expect(await warm).toEqual(page)
    expect(p.call).toHaveBeenLastCalledWith('engine-claude', READER_HISTORY, expect.objectContaining({ ask: { limit: undefined, before: undefined } }), READER_WAIT_MS)
    expect(p.inline).not.toHaveBeenCalled()
  })

  it('routes last-turn reads per engine and does not wake a worker for an unbound transcript', async () => {
    const p = setup()
    expect(await p.forEngine('codex')!.lastTurnText({ ...session, transcriptPath: null })).toBeNull()
    expect(p.call).not.toHaveBeenCalled()
    p.connected('engine-codex')
    const answer = p.forEngine('codex')!.lastTurnText(session)
    expect(p.call).toHaveBeenCalledWith('engine-codex', READER_LAST_TURN, { version: READER_VERSION, session }, READER_WAIT_MS)
    p.replies[0].resolve({ version: READER_VERSION, answer: turn })
    expect(await answer).toEqual(turn)
  })

  it('bounds concurrent reads per engine, rejects excess without queueing, and releases slots on failure', async () => {
    const p = setup()
    const requests = Array.from({ length: READER_IN_FLIGHT }, () => p.history())
    const settled = Promise.allSettled(requests)
    await expect(p.history()).rejects.toMatchObject({ code: 'ENGINE_BUSY' })
    const codex = p.forEngine('codex')!.lastTurnText(session)
    p.connected('engine-codex')
    p.replies[READER_IN_FLIGHT].resolve({ version: READER_VERSION, answer: null })
    expect(await codex).toBeNull()
    for (const reply of p.replies.slice(0, READER_IN_FLIGHT)) reply.resolve({ error: 'SERVICE_UNAVAILABLE' })
    expect((await settled).every(r => r.status === 'rejected')).toBe(true)
    const next = p.history()
    p.connected('engine-claude')
    p.replies.at(-1)!.resolve({ version: READER_VERSION, answer: page })
    expect(await next).toEqual(page)
  })

  it.each(['disconnect', 'replacement', 'reconnect'] as const)('rejects an old connection after %s without replaying the read', async (kind) => {
    const p = setup()
    p.connected('engine-claude')
    const answer = p.history()
    if (kind !== 'replacement') p.disconnected('engine-claude')
    if (kind !== 'disconnect') p.connected('engine-claude')
    p.replies[0].resolve({ version: READER_VERSION, answer: page })
    await expect(answer).rejects.toMatchObject({ code: 'ENGINE_STALE_REPLY' })
    expect(p.call).toHaveBeenCalledOnce()
  })

  it.each<[Record<string, unknown>, string]>([
    [{ error: 'SERVICE_UNAVAILABLE' }, 'ENGINE_UNAVAILABLE'],
    [{ error: 'SERVICE_FAILED' }, 'ENGINE_UNAVAILABLE'],
    [{ version: 2, answer: page }, 'ENGINE_INVALID_REPLY'],
    [{ version: 1, error: 'surprise' }, 'ENGINE_INVALID_REPLY'],
    [{ version: 1, answer: { ...page, events: [{ type: 'turn_ended', payload: {} }] } }, 'ENGINE_INVALID_REPLY'],
    ...READER_ERRORS.map((error): [Record<string, unknown>, string] => [{ version: 1, error }, error]),
  ])('contains a failed or malformed reply %j', async (reply, code) => {
    const p = setup(); p.connected('engine-claude')
    const answer = p.history()
    p.replies[0].resolve(reply as Record<string, unknown>)
    await expect(answer).rejects.toMatchObject({ code })
    expect(p.inline).not.toHaveBeenCalled()
  })

  it('contains unexpected transport exceptions and malformed last-turn replies', async () => {
    const port = createEngineReaders({ isolated: new Set(['engine-claude']), call: async () => { throw new Error('socket') } })
    await expect(port.forEngine('claude')!.lastTurnText(session)).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
    const p = setup(); p.connected('engine-codex')
    const answer = p.forEngine('codex')!.lastTurnText(session)
    p.replies[0].resolve({ version: 1, answer: {} })
    await expect(answer).rejects.toMatchObject({ code: 'ENGINE_INVALID_REPLY' })
  })

  it('uses explicit inline compatibility only when the master does not host this reader', () => {
    const inlineReader = {} as EngineTranscript
    const call = vi.fn(async () => ({}))
    const inline = vi.fn(() => inlineReader)
    const p = createEngineReaders({ isolated: new Set(['engine-codex']), call, inline })
    expect(p.forEngine('claude')).toBe(inlineReader)
    expect(p.forEngine('codex')).not.toBe(inlineReader)
    expect(p.forEngine('constructor')).toBeUndefined()
    expect(p.forEngine('pi')).toBeUndefined()
    expect(inline).toHaveBeenCalledExactlyOnceWith('claude')
    expect(createEngineReaders({ isolated: new Set(), call, inline: () => undefined }).forEngine('claude')).toBeDefined()
    expect(createEngineReaders({ isolated: new Set(), call }).forEngine('claude')).toBeDefined()
    p.connected('search'); p.disconnected('search')
    expect(p.answer('search')).toBeNull()
    for (const name of Object.values(READER_SERVICES)) expect(p.answer(name)).toEqual({ error: 'READER_HAS_NO_CORE_CAPABILITIES' })
    expect(new EngineReadError('ENGINE_UNAVAILABLE').retryable).toBe(true)
    expect(new EngineReadError('ENGINE_INVALID_REQUEST').retryable).toBe(false)
    expect(new EngineReadError('ENGINE_REPLY_TOO_LARGE').retryable).toBe(false)
  })
})
