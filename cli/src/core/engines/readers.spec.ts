import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { createEngineReaders } from './readers.js'
import type { TranscriptReader, TranscriptSession } from '../../engines/facets/transcript.js'
import { EngineReadError, READER_ERRORS, READER_HISTORY, READER_IN_FLIGHT, READER_LAST_TURN, READER_PART, READER_PART_BYTES, READER_PARTED_BYTES, READER_SERVICES, READER_VERSION, READER_WAIT_MS } from '../../engines/worker/protocol.js'

const session: TranscriptSession = { sessionId: 'conversation', transcriptPath: '/private/read.jsonl', touchedAt: 100, codexHome: '/private/codex' }
const page = { events: [], timestamp: '2026-10-07T00:00:00.000Z' }
const turn = { userMessage: 'hello', assistantText: 'world' }
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r }); return { promise, resolve } }

function setup() {
  const replies: ReturnType<typeof deferred<Record<string, unknown>>>[] = []
  const call = vi.fn(() => { const reply = deferred<Record<string, unknown>>(); replies.push(reply); return reply.promise })
  const inline = vi.fn(() => { throw new Error('isolated reads never fall back') })
  const port = createEngineReaders({ isolated: new Set(Object.values(READER_SERVICES)), call, inline })
  return { ...port, call, inline, replies, history: () => port.forEngine('claude')!.historyPage(session, { limit: 2, before: 'cursor' }) }
}

describe('the core reader port', () => {
  it('wakes on a cold call, passes only the immutable read snapshot, and accepts a versioned answer', async () => {
    const p = setup()
    const answer = p.history()
    expect(p.call).toHaveBeenCalledWith('engine-claude', READER_HISTORY,
      { version: READER_VERSION, session, ask: { limit: 2, before: 'cursor' } }, READER_WAIT_MS)
    p.connected('engine-claude')
    p.replies[0].resolve({ version: READER_VERSION, answer: page })
    expect(await answer).toEqual(page)
    const warm = p.forEngine('claude')!.historyPage(session, { limit: 0 })
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
    [{ version: 1, answer: { ...page, events: {} } }, 'ENGINE_INVALID_REPLY'],
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
    const inlineReader = {} as TranscriptReader
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
    const log = vi.fn()
    const port = createEngineReaders({ isolated: new Set([...Object.values(READER_SERVICES), 'engine-others']), call, inline, log })
    return { ...port, call, inline, log, replies }
  }
  /** A reply as their worker sends one past a frame: its parts, each `size` bytes of it. */
  const inParts = (reply: Record<string, unknown>, size: number) => {
    const bytes = Buffer.from(JSON.stringify(reply)), hash = createHash('sha256').update(bytes).digest('hex')
    const parts = [] as Array<Record<string, unknown>>
    for (let offset = 0; offset < bytes.length; offset += size) {
      parts.push({ version: 1, part: 'reply-1', offset, bytes: bytes.length, hash, data: bytes.subarray(offset, offset + size).toString('base64') })
    }
    return parts
  }
  /** Answers each call in turn, as it comes. */
  const answering = (p: ReturnType<typeof others>, answers: Array<Record<string, unknown>>) => {
    p.call.mockImplementation(async () => answers.shift() ?? { version: 1, error: 'ENGINE_STALE_REPLY' })
  }

  it('sends the engine and the store the core named, and nothing else of the session', async () => {
    const p = others()
    const answer = p.forEngine('pi')!.historyPage({ ...pi, codexHome: '/not/sent' } as TranscriptSession, { limit: 2 })
    expect(p.call).toHaveBeenCalledWith('engine-others', READER_HISTORY, { version: READER_VERSION,
      session: { engine: 'pi', sessionId: 'pi-conversation', transcriptPath: '/private/pi.jsonl', touchedAt: 100, store: null },
      ask: { limit: 2, before: undefined } }, 15_000)
    p.connected('engine-others')
    p.replies[0].resolve({ version: READER_VERSION, answer: { ...page, truncated: true } })
    expect(await answer).toEqual({ ...page, truncated: true })
    expect(p.forEngine('pi')).toBe(p.forEngine('pi'))
    const last = p.forEngine('opencode')!.lastTurnText(store)
    expect(p.call).toHaveBeenLastCalledWith('engine-others', READER_LAST_TURN, { version: READER_VERSION,
      session: { engine: 'opencode', sessionId: 'ses_1', transcriptPath: null, touchedAt: 100, store: '/stores/opencode.db' } }, 15_000)
    p.replies[1].resolve({ version: READER_VERSION, answer: turn })
    expect(await last).toEqual(turn)
    // A conversation with neither a transcript nor a store has no last turn, and wakes no worker.
    expect(await p.forEngine('pi')!.lastTurnText({ ...pi, transcriptPath: null })).toBeNull()
    expect(p.call).toHaveBeenCalledTimes(2)
    expect(p.inline).not.toHaveBeenCalled()
    expect(p.log).not.toHaveBeenCalled()
  })

  it('waits for Amp\'s history as long as its export may take, and accepts a finished sub-agent in a replay', async () => {
    const p = others(); p.connected('engine-others')
    const answer = p.forEngine('amp')!.historyPage({ ...pi, sessionId: 'T-0123456789abcdef' }, {})
    expect(p.call).toHaveBeenLastCalledWith('engine-others', READER_HISTORY, expect.anything(), 25_000)
    const finished = { type: 'subagent_finished', payload: { id: 'tool-1', status: 'completed' } }
    p.replies[0].resolve({ version: READER_VERSION, answer: { ...page, events: [finished] } })
    expect(await answer).toEqual({ ...page, events: [finished] })
    const last = p.forEngine('amp')!.lastTurnText(pi)
    expect(p.call).toHaveBeenLastCalledWith('engine-others', READER_LAST_TURN, expect.anything(), 15_000)
    p.replies[1].resolve({ version: READER_VERSION, answer: null })
    expect(await last).toBeNull()
  })

  it('bounds reads per engine, so one busy engine holds back no other', async () => {
    const p = others()
    const busy = Array.from({ length: READER_IN_FLIGHT }, () => p.forEngine('pi')!.historyPage(pi, {}))
    const settled = Promise.allSettled(busy)
    await expect(p.forEngine('pi')!.historyPage(pi, {})).rejects.toMatchObject({ code: 'ENGINE_BUSY' })
    const cursor = p.forEngine('cursor')!.historyPage(pi, {})
    p.connected('engine-others')
    p.replies[READER_IN_FLIGHT].resolve({ version: READER_VERSION, answer: page })
    expect(await cursor).toEqual(page)
    for (const reply of p.replies.slice(0, READER_IN_FLIGHT)) reply.resolve({ error: 'SERVICE_UNAVAILABLE' })
    expect((await settled).every(r => r.status === 'rejected')).toBe(true)
  })

  it('leaves out the events it cannot check, keeps the rest of the page, and says how many', async () => {
    const p = others(); p.connected('engine-others')
    const kept = { type: 'text_delta', payload: { content: 'kept' } }
    const answer = p.forEngine('muse')!.historyPage(pi, {})
    p.replies[0].resolve({ version: 1, answer: { ...page, events: [{ type: 'subagent_finished', payload: { id: 1, status: 'completed' } }, kept,
      { type: 'turn_started', payload: { userMessage: 'live only' } }] } })
    expect(await answer).toEqual({ ...page, events: [kept] })
    expect(p.log).toHaveBeenCalledExactlyOnceWith('[engine muse] history · left out 2 event(s) its reader sent that the core could not check')
    // Said in the core's own log when no other is given.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const port = createEngineReaders({ isolated: new Set(['engine-others']), call: async () => ({ version: 1, answer: { ...page, events: [{ type: 'turn_ended', payload: {} }] } }) })
    const read = port.forEngine('grok')!.historyPage(pi, {})
    port.connected('engine-others')
    expect(await read).toEqual(page)
    expect(warn).toHaveBeenCalledWith('[engine grok] history · left out 1 event(s) its reader sent that the core could not check')
    warn.mockRestore()
  })

  it.each<[Record<string, unknown>, string]>([
    [{ version: 1, answer: { ...page, truncated: false } }, 'ENGINE_INVALID_REPLY'],
    [{ error: 'SERVICE_UNAVAILABLE' }, 'ENGINE_UNAVAILABLE'],
  ])('refuses %j from their worker', async (reply, code) => {
    const p = others(); p.connected('engine-others')
    const answer = p.forEngine('muse')!.historyPage(pi, {})
    p.replies[0].resolve(reply)
    await expect(answer).rejects.toMatchObject({ code })
  })

  it('rejects an answer from a worker that restarted under the read', async () => {
    const p = others(); p.connected('engine-others')
    const answer = p.forEngine('grok')!.historyPage(pi, {})
    p.disconnected('engine-others'); p.connected('engine-others')
    p.replies[0].resolve({ version: READER_VERSION, answer: page })
    await expect(answer).rejects.toMatchObject({ code: 'ENGINE_STALE_REPLY' })
  })

  it('takes a reply past one frame in parts, each by its offset, and checks the whole', async () => {
    const p = others(); p.connected('engine-others')
    const big = { ...page, events: Array.from({ length: 40 }, (_, i) => ({ type: 'text_delta', payload: { content: `line ${i}` } })) }
    const parts = inParts({ version: 1, answer: big }, 300)
    answering(p, [...parts])
    expect(await p.forEngine('grok')!.historyPage(pi, {})).toEqual(big)
    expect(p.call).toHaveBeenCalledTimes(parts.length)
    parts.slice(1).forEach((part, i) => expect(p.call.mock.calls[i + 1]).toEqual(['engine-others', READER_PART,
      { version: 1, part: 'reply-1', offset: part.offset }, expect.any(Number)]))
    const lastTurn = inParts({ version: 1, answer: turn }, 10)
    answering(p, [...lastTurn])
    expect(await p.forEngine('cursor')!.lastTurnText(pi)).toEqual(turn)
  })

  it.each<[string, (parts: Array<Record<string, unknown>>) => Array<Record<string, unknown>>, string]>([
    ['no id', ([first, ...rest]) => [{ ...first, part: 7 }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['an empty id', ([first, ...rest]) => [{ ...first, part: '' }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['a long id', ([first, ...rest]) => [{ ...first, part: 'x'.repeat(201) }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['no size', ([first, ...rest]) => [{ ...first, bytes: '1' }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['a size not whole', ([first, ...rest]) => [{ ...first, bytes: 1.5 }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['a size of none', ([first, ...rest]) => [{ ...first, bytes: 0 }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['a size past the core\'s bound', ([first, ...rest]) => [{ ...first, bytes: READER_PARTED_BYTES + 1 }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['no hash', ([first, ...rest]) => [{ ...first, hash: 'abc' }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['a part of another reply', ([first, second, ...rest]) => [first, { ...second, part: 'reply-2' }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['a part of another size', ([first, second, ...rest]) => [first, { ...second, bytes: Number(second.bytes) + 1 }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['a part of another hash', ([first, second, ...rest]) => [first, { ...second, hash: 'f'.repeat(64) }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['a part out of order', ([first, second, ...rest]) => [first, { ...second, offset: 1 }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['a part with no data', ([first, second, ...rest]) => [first, { ...second, data: 7 }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['a part past a part\'s bound', ([first, ...rest]) => [{ ...first, data: 'A'.repeat(Math.ceil(READER_PART_BYTES / 3) * 4 + 4) }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['an empty part', ([first, ...rest]) => [{ ...first, data: '' }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['a part past the reply', ([first, ...rest]) => [{ ...first, bytes: 3 }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['a part that is not base64', ([first, ...rest]) => [{ ...first, data: `${first.data}!` }, ...rest], 'ENGINE_INVALID_REPLY'],
    ['a whole that is not its hash', (parts) => parts.map(part => ({ ...part, hash: 'e'.repeat(64) })), 'ENGINE_INVALID_REPLY'],
    ['a part its worker no longer has', ([first]) => [first, { version: 1, error: 'ENGINE_STALE_REPLY' }], 'ENGINE_STALE_REPLY'],
    ['a worker gone between parts', ([first]) => [first, { error: 'SERVICE_UNAVAILABLE' }], 'ENGINE_UNAVAILABLE'],
  ])('refuses a reply in parts with %s', async (_, change, code) => {
    const p = others(); p.connected('engine-others')
    answering(p, change(inParts({ version: 1, answer: { ...page, events: [{ type: 'text_delta', payload: { content: 'x'.repeat(100) } }] } }, 40)))
    await expect(p.forEngine('pi')!.historyPage(pi, {})).rejects.toMatchObject({ code })
  })

  it('refuses a whole that is not JSON, and parts that outlast the read\'s wait or a worker restart', async () => {
    const p = others(); p.connected('engine-others')
    const text = Buffer.from('not json'), hash = createHash('sha256').update(text).digest('hex')
    answering(p, [{ version: 1, part: 'reply-1', offset: 0, bytes: text.length, hash, data: text.toString('base64') }])
    await expect(p.forEngine('pi')!.historyPage(pi, {})).rejects.toMatchObject({ code: 'ENGINE_INVALID_REPLY' })
    const [first, ...rest] = inParts({ version: 1, answer: page }, 20)
    let now = 0
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    answering(p, [first, ...rest])
    p.call.mockImplementationOnce(async () => { now = 0; return first }).mockImplementationOnce(async () => { now = 15_001; return rest[0] })
    const late = p.forEngine('pi')!.historyPage(pi, {})
    await expect(late).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
    now = 0
    p.call.mockReset()
    p.call.mockImplementationOnce(async () => first).mockImplementationOnce(async () => { p.disconnected('engine-others'); p.connected('engine-others'); return rest[0] })
    await expect(p.forEngine('pi')!.historyPage(pi, {})).rejects.toMatchObject({ code: 'ENGINE_STALE_REPLY' })
    clock.mockRestore()
  })
})
