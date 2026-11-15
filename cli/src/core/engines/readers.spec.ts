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
    expect(p.forEngine('terminal')).toBeUndefined()
    expect(inline).toHaveBeenCalledExactlyOnceWith('claude')
    // The other engines read in this process only while the master runs no worker of theirs that reads them.
    expect(p.forEngine('pi')).toBe(inlineReader)
    expect(inline).toHaveBeenLastCalledWith('pi')
    expect(createEngineReaders({ isolated: new Set(), call }).forEngine('pi')).toBeUndefined()
    expect(createEngineReaders({ isolated: new Set(), call, inline: () => undefined }).forEngine('claude')).toBeDefined()
    expect(createEngineReaders({ isolated: new Set(), call }).forEngine('claude')).toBeDefined()
    p.connected('search'); p.disconnected('search')
    expect(p.answer('search')).toBeNull()
    for (const name of [...Object.values(READER_SERVICES), 'engine-others']) expect(p.answer(name)).toEqual({ error: 'READER_HAS_NO_CORE_CAPABILITIES' })
    expect(new EngineReadError('ENGINE_UNAVAILABLE').retryable).toBe(true)
    expect(new EngineReadError('ENGINE_INVALID_REQUEST').retryable).toBe(false)
    expect(new EngineReadError('ENGINE_REPLY_TOO_LARGE').retryable).toBe(false)
  })
})

describe('the other engines\' readers, in their one worker', () => {
  const pi: TranscriptSession = { sessionId: 'pi-conversation', transcriptPath: '/private/pi.jsonl', touchedAt: 100 }
  const store: TranscriptSession = { sessionId: 'ses_1', transcriptPath: null, touchedAt: 100, store: '/stores/opencode.db' }
  function others() {
    const replies: ReturnType<typeof deferred<Record<string, unknown>>>[] = []
    const call = vi.fn((..._args: unknown[]) => { const reply = deferred<Record<string, unknown>>(); replies.push(reply); return reply.promise })
    const inline = vi.fn(() => { throw new Error('isolated reads never fall back') })
    const port = createEngineReaders({ isolated: new Set([...Object.values(READER_SERVICES), 'engine-others']), call, inline })
    return { ...port, call, inline, replies }
  }

  it('sends the engine and the store the core named, and nothing else of the session', async () => {
    const p = others()
    const answer = p.forEngine('pi')!.historyPage({ ...pi, codexHome: '/not/sent' } as TranscriptSession, { limit: 2 }, pages)
    expect(p.call).toHaveBeenCalledWith('engine-others', READER_HISTORY, { version: READER_VERSION,
      session: { engine: 'pi', sessionId: 'pi-conversation', transcriptPath: '/private/pi.jsonl', touchedAt: 100, store: null },
      ask: { limit: 2, before: undefined } }, READER_WAIT_MS)
    p.connected('engine-others')
    p.replies[0].resolve({ version: READER_VERSION, answer: { ...page, truncated: true } })
    expect(await answer).toEqual({ ...page, truncated: true })
    expect(p.forEngine('pi')).toBe(p.forEngine('pi'))
    const last = p.forEngine('opencode')!.lastTurnText(store)
    expect(p.call).toHaveBeenLastCalledWith('engine-others', READER_LAST_TURN, { version: READER_VERSION,
      session: { engine: 'opencode', sessionId: 'ses_1', transcriptPath: null, touchedAt: 100, store: '/stores/opencode.db' } }, READER_WAIT_MS)
    p.replies[1].resolve({ version: READER_VERSION, answer: turn })
    expect(await last).toEqual(turn)
    // A conversation with neither a transcript nor a store has no last turn, and wakes no worker.
    expect(await p.forEngine('pi')!.lastTurnText({ ...pi, transcriptPath: null })).toBeNull()
    expect(p.call).toHaveBeenCalledTimes(2)
    expect(p.inline).not.toHaveBeenCalled()
  })

  it('waits for Amp\'s history as long as its export may take, and accepts a finished sub-agent in a replay', async () => {
    const p = others(); p.connected('engine-others')
    const answer = p.forEngine('amp')!.historyPage({ ...pi, sessionId: 'T-0123456789abcdef' }, {}, pages)
    expect(p.call).toHaveBeenLastCalledWith('engine-others', READER_HISTORY, expect.anything(), 25_000)
    const finished = { type: 'subagent_finished', payload: { id: 'tool-1', status: 'completed' } }
    p.replies[0].resolve({ version: READER_VERSION, answer: { ...page, events: [finished] } })
    expect(await answer).toEqual({ ...page, events: [finished] })
    const last = p.forEngine('amp')!.lastTurnText(pi)
    expect(p.call).toHaveBeenLastCalledWith('engine-others', READER_LAST_TURN, expect.anything(), READER_WAIT_MS)
    p.replies[1].resolve({ version: READER_VERSION, answer: null })
    expect(await last).toBeNull()
  })

  it('bounds reads per engine, so one busy engine holds back no other', async () => {
    const p = others()
    const busy = Array.from({ length: READER_IN_FLIGHT }, () => p.forEngine('pi')!.historyPage(pi, {}, pages))
    const settled = Promise.allSettled(busy)
    await expect(p.forEngine('pi')!.historyPage(pi, {}, pages)).rejects.toMatchObject({ code: 'ENGINE_BUSY' })
    const cursor = p.forEngine('cursor')!.historyPage(pi, {}, pages)
    p.connected('engine-others')
    p.replies[READER_IN_FLIGHT].resolve({ version: READER_VERSION, answer: page })
    expect(await cursor).toEqual(page)
    for (const reply of p.replies.slice(0, READER_IN_FLIGHT)) reply.resolve({ error: 'SERVICE_UNAVAILABLE' })
    expect((await settled).every(r => r.status === 'rejected')).toBe(true)
  })

  it.each<[Record<string, unknown>, string]>([
    [{ version: 1, answer: { ...page, truncated: false } }, 'ENGINE_INVALID_REPLY'],
    [{ version: 1, answer: { ...page, events: [{ type: 'subagent_finished', payload: { id: 1, status: 'completed' } }] } }, 'ENGINE_INVALID_REPLY'],
    [{ version: 1, answer: { ...page, events: [{ type: 'turn_started', payload: { userMessage: 'live only' } }] } }, 'ENGINE_INVALID_REPLY'],
    [{ error: 'SERVICE_UNAVAILABLE' }, 'ENGINE_UNAVAILABLE'],
  ])('refuses %j from their worker', async (reply, code) => {
    const p = others(); p.connected('engine-others')
    const answer = p.forEngine('muse')!.historyPage(pi, {}, pages)
    p.replies[0].resolve(reply)
    await expect(answer).rejects.toMatchObject({ code })
  })

  it('rejects an answer from a worker that restarted under the read', async () => {
    const p = others(); p.connected('engine-others')
    const answer = p.forEngine('grok')!.historyPage(pi, {}, pages)
    p.disconnected('engine-others'); p.connected('engine-others')
    p.replies[0].resolve({ version: READER_VERSION, answer: page })
    await expect(answer).rejects.toMatchObject({ code: 'ENGINE_STALE_REPLY' })
  })
})
