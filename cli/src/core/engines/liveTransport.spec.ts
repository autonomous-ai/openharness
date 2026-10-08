import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createLiveTransport } from './liveTransport.js'
import {
  LIVE_CAPABILITIES, LIVE_CLOSE, LIVE_FORGET, LIVE_PART, LIVE_PART_BYTES, LIVE_PREPARE, LIVE_READ,
  LIVE_RESULT_BYTES, LIVE_WAIT_MS, type LiveCursor, type LivePage, type LivePull,
} from '../../engines/worker/liveProtocol.js'

const cursor = (changes: Partial<LiveCursor> = {}): LiveCursor => ({ serial: 1, origin: 0, offset: 0,
  turn: { identity: 'binding:empty', turnOpen: false, continued: false }, closed: false,
  prepareEnd: null, completeUntil: null, stamp: null, ...changes })
const page = (changes: Partial<LivePage> = {}): LivePage => ({ frames: [], cursor: cursor(), prepared: true,
  content: false, more: false, records: 0, turnFrom: 0, profileFrom: 0, end: 0, lastStarted: null, ...changes })
const ask = (checkpoint: LiveCursor | null = null, engine = 'claude'): LivePull => ({ token: 'binding', cursor: checkpoint,
  fromStart: false, replay: false, session: { agentId: 'agent', sessionId: 'session', engine,
    transcriptPath: '/private/transcript.jsonl', cwd: '/private', model: null, cliVersion: null } } as LivePull)
const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r }); return { promise, resolve } }
type Reply = Record<string, unknown>

function setup(reply: (type: string, payload: Reply) => Promise<Reply> | Reply = () => ({ version: 1, answer: page() })) {
  const call = vi.fn(async (service: string, type: string, payload: Reply, _wait: number): Promise<Reply> =>
    type === LIVE_CAPABILITIES ? { version: 1, live: 1, engine: service.slice('engine-'.length) } : reply(type, payload))
  const port = createLiveTransport({ call })
  port.connected('engine-claude'); port.connected('engine-codex')
  return { port, call }
}

function fragmented(text: string, size = 29) {
  const bytes = Buffer.from(text), hash = createHash('sha256').update(bytes).digest('hex')
  return (offset = 0): Reply => ({ version: 1, part: 'fragment', offset, bytes: bytes.length, hash,
    data: bytes.subarray(offset, offset + size).toString('base64') })
}

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

describe('live worker transport', () => {
  it('negotiates a cold connection once, then uses the accepted cursor on the same connection', async () => {
    const p = setup((_method, payload) => ({ version: 1, answer: page({ cursor: cursor({ serial: payload.cursor ? 2 : 1 }) }) }))
    p.port.disconnected('engine-claude')
    const call = p.call.getMockImplementation()!
    p.call.mockImplementationOnce(async (...args) => { p.port.connected('engine-claude'); return call(...args) })
    const first = await p.port.pull(ask())
    expect(p.call.mock.calls.map(call => call[1])).toEqual([LIVE_CAPABILITIES, LIVE_PREPARE])
    expect(p.call.mock.calls[1].slice(0, 3)).toEqual(['engine-claude', LIVE_PREPARE, { ...ask(), version: 1 }])
    expect(p.call.mock.calls[1][3]).toBeGreaterThan(0)
    expect(p.call.mock.calls[1][3]).toBeLessThanOrEqual(LIVE_WAIT_MS)
    await p.port.pull(ask(first.cursor))
    expect(p.call.mock.calls.map(call => call[1])).toEqual([LIVE_CAPABILITIES, LIVE_PREPARE, LIVE_READ])
    p.port.connected('search'); p.port.disconnected('search')
  })

  it('bounds work independently for each engine and frees the slot after a failed read', async () => {
    const waiting = deferred<Reply>()
    const p = setup(() => waiting.promise)
    const first = p.port.pull(ask())
    const settled = expect(first).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
    await expect(p.port.pull(ask())).rejects.toMatchObject({ code: 'ENGINE_BUSY' })
    const second = p.port.pull(ask(null, 'codex'))
    const other = expect(second).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
    waiting.resolve({ error: 'SERVICE_UNAVAILABLE' })
    await Promise.all([settled, other])
    p.call.mockResolvedValue({ version: 1, answer: page() })
    expect(await p.port.pull(ask())).toEqual(page())
  })

  it.each(['disconnect', 'replacement', 'reconnect'] as const)('rejects a late reply after %s', async kind => {
    const waiting = deferred<Reply>(), p = setup()
    p.call.mockReturnValueOnce(waiting.promise)
    const request = p.port.pull(ask())
    if (kind !== 'replacement') p.port.disconnected('engine-claude')
    if (kind !== 'disconnect') p.port.connected('engine-claude')
    waiting.resolve({ version: 1, live: 1, engine: 'claude' })
    await expect(request).rejects.toMatchObject({ code: 'ENGINE_STALE_REPLY' })
    expect(p.call).toHaveBeenCalledOnce()
  })

  it.each([
    [{ error: 'SERVICE_FAILED' }, 'ENGINE_UNAVAILABLE'],
    [{ error: { message: 'oops' } }, 'ENGINE_UNAVAILABLE'],
    [{ error: 'ENGINE_TRANSCRIPT_CHANGED' }, 'ENGINE_TRANSCRIPT_CHANGED'],
    [{ version: 2 }, 'ENGINE_INVALID_REPLY'],
  ])('contains a failed worker reply %j', async (reply, code) => {
    const p = setup(() => reply)
    await expect(p.port.pull(ask())).rejects.toMatchObject({ code })
  })

  it.each([{ version: 1, live: 2, engine: 'claude' }, { version: 1, live: 1, engine: 'codex' }])('rejects incompatible capabilities %j', async reply => {
    const p = setup(); p.call.mockResolvedValue(reply)
    await expect(p.port.pull(ask())).rejects.toMatchObject({ code: 'ENGINE_INVALID_REPLY' })
    expect(p.call).toHaveBeenCalledOnce()
  })

  it('contains transport exceptions without loading an inline parser', async () => {
    const p = setup(); p.call.mockRejectedValue(new Error('socket closed'))
    await expect(p.port.pull(ask())).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
  })

  it.each([
    {}, page({ cursor: cursor({ serial: 3 }) }),
    page({ cursor: cursor({ turn: { identity: 'another:empty', turnOpen: false, continued: false } }) }),
    page({ frames: [{ raw: '', profile: true, observe: true, events: [], replay: false,
      turn: { identity: 'another:empty', turnOpen: false, continued: false } }] }),
  ])('refuses a malformed page or one from another binding', async answer => {
    const p = setup(() => ({ version: 1, answer }))
    await expect(p.port.pull(ask())).rejects.toMatchObject({ code: 'ENGINE_INVALID_REPLY' })
  })

  it.each([
    cursor({ serial: 2, offset: 4, origin: 5 }),
    cursor({ serial: 2, offset: 5, origin: 4 }),
    cursor({ serial: 1, offset: 5, origin: 5 }),
  ])('never moves an accepted cursor backward or changes its recovery window', async checkpoint => {
    const p = setup(() => ({ version: 1, answer: page({ cursor: checkpoint, end: 5 }) }))
    await expect(p.port.pull(ask(cursor({ offset: 5, origin: 5 })))).rejects.toMatchObject({ code: 'ENGINE_INVALID_REPLY' })
  })

  it('reassembles bounded fragments with an exact hash before accepting the page', async () => {
    const fragment = fragmented(JSON.stringify({ version: 1, answer: page() }))
    const p = setup((_method, payload) => fragment(payload.offset as number | undefined))
    expect(await p.port.pull(ask())).toEqual(page())
    expect(p.call.mock.calls.filter(call => call[1] === LIVE_PART).length).toBeGreaterThan(1)
    expect(p.call.mock.calls.slice(2).every(call => call[2].part === 'fragment')).toBe(true)
  })

  it.each([
    { part: 4 }, { part: '' }, { part: 'x'.repeat(201) }, { bytes: '1' }, { bytes: 0 },
    { bytes: 0.5 }, { bytes: LIVE_RESULT_BYTES + 1 }, { hash: 4 }, { hash: 'bad' },
    { offset: 1 }, { data: 1 }, { data: '' }, { data: '?A==' },
    { data: 'a'.repeat(Math.ceil(LIVE_PART_BYTES / 3) * 4 + 1) },
  ])('bounds and validates fragment metadata before accepting it', async changes => {
    const fragment = fragmented(JSON.stringify({ version: 1, answer: page() }))
    const p = setup(() => ({ ...fragment(), ...changes }))
    await expect(p.port.pull(ask())).rejects.toMatchObject({ code: 'ENGINE_INVALID_REPLY' })
  })

  it.each([{ part: 'replacement' }, { bytes: 1 }, { hash: '0'.repeat(64) }, { offset: 0 }])('rejects a changed fragment stream', async changes => {
    const fragment = fragmented(JSON.stringify({ version: 1, answer: page() }))
    const p = setup((method, payload) => ({ ...fragment(payload.offset as number | undefined), ...(method === LIVE_PART ? changes : {}) }))
    await expect(p.port.pull(ask())).rejects.toMatchObject({ code: 'ENGINE_INVALID_REPLY' })
  })

  it.each(['invalid json', 'null', '[]', '{"version":2}'])('rejects invalid assembled content %s', async content => {
    const fragment = fragmented(content)
    const p = setup((_method, payload) => fragment(payload.offset as number | undefined))
    await expect(p.port.pull(ask())).rejects.toMatchObject({ code: 'ENGINE_INVALID_REPLY' })
  })

  it('rejects a corrupt hash, oversized decoded chunk and noncanonical base64', async () => {
    for (const changes of [{ hash: '0'.repeat(64) }, { bytes: 1 }, { bytes: 1, data: 'Zh==' }]) {
      const fragment = fragmented('{}')
      const p = setup(() => ({ ...fragment(), ...changes }))
      await expect(p.port.pull(ask())).rejects.toMatchObject({ code: 'ENGINE_INVALID_REPLY' })
    }
  })

  it('shares one deadline across capability negotiation and every fragment', async () => {
    vi.useFakeTimers({ toFake: ['performance'] })
    const fragment = fragmented(JSON.stringify({ version: 1, answer: page() }))
    const p = setup((_method, payload) => { vi.advanceTimersByTime(6_000); return fragment(payload.offset as number | undefined) })
    await expect(p.port.pull(ask())).rejects.toMatchObject({ code: 'ENGINE_UNAVAILABLE' })
    expect(p.call.mock.calls.map(call => call[3])).toEqual([15_000, 15_000, 9_000, 3_000])
  })

  it('closes only a validated cursor, forgets supported engines, and ignores unrelated services', async () => {
    const p = setup((method) => method === LIVE_CLOSE
      ? { version: 1, answer: { closed: true, cursor: cursor({ closed: 'cancel', serial: 2 }) } }
      : { version: 1, forgotten: true })
    expect(await p.port.close(ask(cursor()), 'binding:empty', 'cancel')).toMatchObject({ closed: true, cursor: { serial: 2 } })
    expect(p.call.mock.calls.at(-1)?.slice(0, 3)).toEqual(['engine-claude', LIVE_CLOSE,
      { ...ask(cursor()), identity: 'binding:empty', reason: 'cancel', version: 1 }])
    await p.port.forget('claude', 'binding')
    expect(p.call.mock.calls.at(-1)?.[1]).toBe(LIVE_FORGET)
    const count = p.call.mock.calls.length
    await p.port.forget('unknown', 'binding')
    await expect(p.port.pull(ask(null, 'unknown'))).rejects.toMatchObject({ code: 'ENGINE_INVALID_REQUEST' })
    await expect(p.port.close(ask(null, 'unknown'), '', 'hook')).rejects.toMatchObject({ code: 'ENGINE_INVALID_REQUEST' })
    expect(p.call).toHaveBeenCalledTimes(count)
  })

  it.each([null, { closed: 'true', cursor: cursor() }, { closed: true, cursor: null }])('rejects invalid close replies %j', async answer => {
    const p = setup(() => ({ version: 1, answer }))
    await expect(p.port.close(ask(cursor()), 'binding:empty', 'hook')).rejects.toMatchObject({ code: 'ENGINE_INVALID_REPLY' })
  })
})
