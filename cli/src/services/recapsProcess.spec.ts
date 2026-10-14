import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CoreApi, TurnLifecycle } from '../core/api.js'
import type { LiveEvent } from '../lib/normalize.js'
import type { CoreConnection, ServiceProcessOptions } from './process.js'
import { createRecaps } from './recaps.js'
import { recapsCoreApi, runRecapsService } from './recapsProcess.js'
import { nativeRecapId, nativeRecapDigest, NATIVE_RECAP_VERSION } from '../lib/nativeRecapWire.js'
import { deriveTurnSummary } from '../lib/deviceRecap.js'

// The real default reaches a real socket and this process's own channel: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const dirs: string[] = []
const temp = () => { const dir = mkdtempSync(join(tmpdir(), 'recaps-process-')); dirs.push(dir); return dir }
const watching = { device: true, active: true }
const s1 = { sessionId: 's1', agentId: 'a1', subagent: false }
const started = { type: 'turn_started', payload: { userMessage: 'what is the fix?' } } as LiveEvent
const ended = { type: 'turn_ended', payload: {} } as LiveEvent
const lifecycle = (event: TurnLifecycle) => ({ kind: 'lifecycle', event, watchers: watching })

/** A connection to the core that records what it is told and answers `lastTurn` with `turn`. */
function connection(turn: unknown = { assistantText: 'The fix is in.', userMessage: 'what is the fix?' }) {
  const notice = vi.fn()
  const query = vi.fn(async (_name: string, _payload?: Record<string, unknown>) => ({ turn }) as Record<string, unknown>)
  const said = (kind: string) => notice.mock.calls.filter(([k]) => k === kind).map(([, payload]) => payload)
  return { core: { query, notice } satisfies CoreConnection, notice, query, said }
}

describe('the recaps in their own process', () => {
  afterEach(() => {
    vi.clearAllMocks()
    vi.restoreAllMocks()
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  const setup = (over: Partial<Parameters<typeof runRecapsService>[0]> = {}) => {
    let options: ServiceProcessOptions | null = null
    let api: CoreApi | null = null
    const service = { stop: vi.fn() }
    const handle = runRecapsService({
      dataDir: temp(), socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return service },
      create: (core, opts) => { api = core; return createRecaps(core, { recapForce: false, recapWithoutDevice: () => true, ...opts }) },
      ...over,
    })
    return { options: options!, api: api!, service, handle }
  }

  it('reaches the core as `recaps`, through the socket and token it was given, and answers the apps nothing', () => {
    const { options, handle, service } = setup()
    expect(options).toMatchObject({ name: 'recaps', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(Object.keys(options.requests)).toEqual(['liveCards', 'nativeCompletion'])
    expect(handle).toBe(service)
  })

  it('cuts a turn\'s recap, sends its cards and recap as notices, and says what it now holds of the session', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { options } = setup()
    const core = connection()
    options.onConnected!(core.core)
    options.onEvent!(lifecycle({ kind: 'events', session: s1, events: [started], replay: false }))
    expect(core.said('recaps').at(-1)).toMatchObject({ sessionId: 's1', recaps: { asks: ['what is the fix?'], busy: true } })
    options.onEvent!(lifecycle({ kind: 'events', session: s1, events: [ended], replay: false }))
    await vi.waitFor(() => expect(core.said('summary')).toHaveLength(1))
    expect(core.query).toHaveBeenCalledWith('lastTurn', { sessionId: 's1' })
    expect(core.said('summary')[0]).toMatchObject({ frame: { type: 'turn_summary', agentId: 'a1', dbSessionId: 's1' } })
    expect(core.said('card').map(({ frame }) => frame.payload.kind)).toEqual(['turn_started', 'processing', 'done', 'summary'])
    expect(core.said('recaps').at(-1)).toMatchObject({ sessionId: 's1', recaps: { busy: false, history: [expect.any(String)] } })
    // A change is said once: a beat that changes nothing says nothing more.
    const before = core.said('recaps').length
    options.onEvent!(lifecycle({ kind: 'beat', session: s1, working: false }))
    expect(core.said('recaps')).toHaveLength(before)
  })

  it('derives an old native answer without reading or changing the successor, even across reconnect', async () => {
    const { options } = setup()
    const core = connection({ assistantText: 'The successor answer must stay separate.' })
    options.onConnected!(core.core)
    options.onEvent!(lifecycle({ kind: 'events', session: s1, events: [started], replay: false }))
    const before = structuredClone(core.notice.mock.calls)
    const owner = { agentId: 'a1', sessionId: 's1', processKey: ['boot', 'cursor', '42', 'birth'].join('\0') }
    const completion = { id: nativeRecapId(owner, 'A'), owner, generationId: 'A', responseText: 'The original answer is retained.' }
    const result = await options.requests.nativeCompletion({ completion }, { local: true, owner: true })
    expect(result).toEqual({ result: { state: 'ready', id: completion.id, sourceDigest: nativeRecapDigest(completion), version: NATIVE_RECAP_VERSION,
      summary: deriveTurnSummary(completion.responseText) } })
    expect(core.query).not.toHaveBeenCalled()
    expect(core.notice.mock.calls).toEqual(before)
    options.onDisconnected!()
    const next = connection()
    options.onConnected!(next.core)
    expect(next.said('recaps')).toMatchObject([{ sessionId: 's1', recaps: { busy: true, history: [], fullTexts: [], asks: ['what is the fix?'] } }])
    expect(next.said('summary')).toEqual([])
    expect(next.said('card')).toEqual([])
    expect(await options.requests.nativeCompletion({ completion }, { local: true, owner: true })).toEqual(result)
    expect(await options.requests.nativeCompletion({}, { local: true, owner: true })).toEqual({ result: { state: 'held', reason: 'Waiting for the original native answer.' } })
  })

  it('tells a core that connects everything it holds, and a new connection everything again', () => {
    const { options } = setup()
    options.onEvent!(lifecycle({ kind: 'events', session: s1, events: [started], replay: false }))
    const first = connection()
    options.onConnected!(first.core)
    expect(first.said('recaps')).toMatchObject([{ sessionId: 's1', recaps: { busy: true } }])
    options.onDisconnected!()
    // While no core listens, nothing is said, and the change waits for the next connection.
    options.onEvent!(lifecycle({ kind: 'cancelled', session: s1 }))
    expect(first.said('recaps')).toHaveLength(1)
    const second = connection()
    options.onConnected!(second.core)
    expect(second.said('recaps')).toMatchObject([{ sessionId: 's1', recaps: { busy: false } }])
  })

  it('cuts no recap when the core is not there to read the turn, or reads none', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { api } = setup()
    expect(await api.transcripts.lastTurn('s1')).toBeNull()
    const { options, api: connected } = setup()
    options.onConnected!(connection('not a turn').core)
    expect(await connected.transcripts.lastTurn('s1')).toBeNull()
  })

  it('answers the core\'s one question: the cards of every turn still at work', async () => {
    const { options } = setup()
    options.onEvent!(lifecycle({ kind: 'events', session: s1, events: [started], replay: false }))
    options.onEvent!(lifecycle({ kind: 'beat', session: s1, working: true }))
    expect(await options.requests.liveCards({}, { local: true, owner: true })).toMatchObject({ cards: [{ dbSessionId: 's1', payload: { kind: 'processing' } }] })
  })

  it('takes only what reads as a lifecycle event', () => {
    const { options } = setup()
    const core = connection()
    options.onConnected!(core.core)
    for (const payload of [{ kind: 'lifecycle' }, { kind: 'lifecycle', event: { kind: 'stopped', sessionId: 's1' } }, { kind: 'other', event: { kind: 'rejoined', working: [] }, watchers: watching }, { kind: 'lifecycle', event: 'x', watchers: watching }, { kind: 'lifecycle', event: {}, watchers: watching }]) {
      options.onEvent!(payload as Record<string, unknown>)
    }
    expect(core.notice).not.toHaveBeenCalled()
  })

  it('drops a card or a recap said while no core is connected', () => {
    const { api } = setup()
    expect(() => api.clients.turnCard({ type: 'commander_event', agentId: 'a', dbSessionId: 's', payload: {} })).not.toThrow()
    expect(() => api.clients.turnSummary({ type: 'turn_summary' })).not.toThrow()
  })

  it('runs on a core API that reaches the core only through these three ways, and holds no credential', async () => {
    const ways = { turnCard: vi.fn(), turnSummary: vi.fn(), lastTurn: vi.fn(async () => null) }
    const api = recapsCoreApi('/data', ways)
    expect(api.dataDir).toBe('/data')
    expect(api.transcripts.lastTurn).toBe(ways.lastTurn)
    expect(api.clients.turnCard).toBe(ways.turnCard)
    expect(api.clients.turnSummary).toBe(ways.turnSummary)
    await expect(api.account.accessToken()).rejects.toThrow('recaps holds no credential')
  })

  it('runs on the real service process unless told otherwise', async () => {
    const { runServiceProcess } = await import('./process.js')
    runRecapsService({ dataDir: temp(), socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(runServiceProcess).toHaveBeenCalledWith(expect.objectContaining({ name: 'recaps' }))
  })
})
