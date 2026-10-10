// The router: what a client may send and how it is bounded, who may ask, how many decisions at once, and the
// answer a client acts on. The decision itself is lib/routeDecide.spec.ts's; here Jev is a fake behind a fake
// router, and the client the default router builds is a fake too: no network is ever reached.
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ROUTER_REQUESTS as DECLARED, type Asker } from '../core/api.js'
import { createJevDecide, JevUnavailable, type JevChoiceAnswer } from '../lib/jev/jevClient.js'
import { fakeCore } from '../testing/fakeCore.js'
import { defaultRouter, ROUTER_REQUESTS, routeInput, startRouter, type Router } from './router.js'

/** Jev's client as the default router builds it: what it was asked, and no answer, never a request sent. */
const client = vi.hoisted(() => ({ asked: [] as unknown[] }))
vi.mock('../lib/jev/jevClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/jev/jevClient.js')>()
  return { ...actual, createJevDecide: vi.fn(() => async (state: unknown) => { client.asked.push(state); return {} }) }
})

const OWNER: Asker = { local: true, owner: true, connection: 'window-1' }
const DEVICE: Asker = { local: false, owner: false, connection: 'device-1' }

/** A router with no Jev unless [over] gives one, logging into [lines]. */
function router(over: Partial<Router> = {}) {
  const lines: string[] = []
  const made: Router = { log: (line) => lines.push(line), ...over }
  return { router: made, lines }
}

/** A choice of [choice] at [p], the rest on the other [options]. */
function said(choice: string, p: number, options: string[]): JevChoiceAnswer {
  return { choice, probabilities: Object.fromEntries(options.map((id) => [id, id === choice ? p : (1 - p) / (options.length - 1)])) }
}

const DESK = [{ id: 'a1', name: 'billing retries', asks: ['why was the card charged twice'] }, { id: 'a2', name: 'Prometheus alerts' }]

afterEach(() => {
  vi.restoreAllMocks()
  vi.mocked(createJevDecide).mockClear()
  client.asked.length = 0
})

describe('what a client sends', () => {
  it('is its task, trimmed, with the sessions, projects and agents it can see', () => {
    expect(routeInput({
      text: '  the alert fired again \n',
      sessions: DESK,
      projects: [{ id: '/code/infra', name: 'infra' }],
      agents: [{ id: 'claude', name: 'Claude Code' }],
      last: { id: 'a2', agoMs: 30_000 },
    })).toEqual({
      text: 'the alert fired again',
      sessions: [{ id: 'a1', name: 'billing retries', asks: ['why was the card charged twice'] }, { id: 'a2', name: 'Prometheus alerts', asks: [] }],
      projects: [{ id: '/code/infra', name: 'infra' }],
      agents: [{ id: 'claude', name: 'Claude Code' }],
      last: { id: 'a2', agoMs: 30_000 },
    })
  })

  it('is nothing without a task, or with one longer than 16,000 characters', () => {
    for (const text of [undefined, '', '   \n', 42, ['go']]) expect(routeInput({ text }), String(text)).toBeNull()
    expect(routeInput({ text: 'x'.repeat(16_001) })).toBeNull()
    expect(routeInput({ text: `  ${'x'.repeat(16_000)}  ` })).toMatchObject({ text: 'x'.repeat(16_000) })
  })

  it('is no sessions, projects or agents where it sent something that is not a list', () => {
    expect(routeInput({ text: 'go', sessions: 'a1', projects: { id: 'p' }, agents: null })).toEqual({ text: 'go', sessions: [], projects: [], agents: [] })
  })

  it('drops the sessions it cannot read, and bounds what it keeps of each', () => {
    const sessions = routeInput({
      text: 'go',
      sessions: [
        null, 'a1', { id: 1, name: 'n' }, { id: 'a' }, { id: 'a', name: 7 },
        { id: 'x'.repeat(4201), name: 'too long an id' }, { id: 'long-name', name: 'n'.repeat(301) },
        { id: 'x'.repeat(4200), name: 'n'.repeat(300) },
        { id: 'asks', name: 'asks', asks: ['first', 2, null, 'second', `${'y'.repeat(600)}`, 'fourth'] },
        { id: 'not-a-list', name: 'asks', asks: 'first' },
        { id: 'about', name: 'about', about: `  ${'z'.repeat(600)}` },
        { id: 'blank-about', name: 'about', about: '  \n ' },
        { id: 'odd-about', name: 'about', about: 12 },
      ],
    })!.sessions
    expect(sessions).toEqual([
      { id: 'x'.repeat(4200), name: 'n'.repeat(300), asks: [] },
      { id: 'asks', name: 'asks', asks: ['first', 'second', 'y'.repeat(500)] },
      { id: 'not-a-list', name: 'asks', asks: [] },
      { id: 'about', name: 'about', asks: [], about: `  ${'z'.repeat(498)}` },
      { id: 'blank-about', name: 'about', asks: [] },
      { id: 'odd-about', name: 'about', asks: [] },
    ])
  })

  it('reads the first 200 sessions, projects and agents, and drops the options it cannot read', () => {
    const rows = Array.from({ length: 205 }, (_, i) => ({ id: `r${i}`, name: `row ${i}` }))
    const input = routeInput({ text: 'go', sessions: rows, projects: rows, agents: rows })!
    expect(input.sessions).toHaveLength(200)
    expect(input.projects).toHaveLength(200)
    expect(input.agents.at(-1)).toEqual({ id: 'r199', name: 'row 199' })
    const options = [
      null, 'p', { id: 3, name: 'n' }, { id: 'p' }, { id: 'p', name: false },
      { id: 'x'.repeat(4201), name: 'n' }, { id: 'p', name: 'n'.repeat(301) },
      { id: 'x'.repeat(4200), name: 'n'.repeat(300), extra: true },
    ]
    expect(routeInput({ text: 'go', projects: options, agents: options })).toMatchObject({
      projects: [{ id: 'x'.repeat(4200), name: 'n'.repeat(300) }],
      agents: [{ id: 'x'.repeat(4200), name: 'n'.repeat(300) }],
    })
    expect(routeInput({ text: 'go', projects: options })!.projects[0]).not.toHaveProperty('extra')
  })

  it('says how long ago a stopped session was last active, when that is a time', () => {
    const sent = (stoppedAgoMs: unknown) => routeInput({ text: 'go', sessions: [{ id: 'a1', name: 'lamp v1', stoppedAgoMs }] })?.sessions[0]
    expect(sent(3_600_000)).toEqual({ id: 'a1', name: 'lamp v1', asks: [], stoppedAgoMs: 3_600_000 })
    for (const odd of [undefined, -1, Number.NaN, Number.POSITIVE_INFINITY, '3600000']) expect(sent(odd), String(odd)).toEqual({ id: 'a1', name: 'lamp v1', asks: [] })
  })

  it('says where the last task went only with a session id and a finite time', () => {
    const last = (value: unknown) => routeInput({ text: 'go', last: value })!
    expect(last({ id: 'a1', agoMs: 0 }).last).toEqual({ id: 'a1', agoMs: 0 })
    for (const value of [undefined, null, 'a1', { id: 'a1' }, { agoMs: 5 }, { id: 3, agoMs: 5 }, { id: 'a1', agoMs: '5' },
      { id: 'a1', agoMs: Number.NaN }, { id: 'a1', agoMs: Number.POSITIVE_INFINITY }]) {
      expect(last(value), JSON.stringify(value)).not.toHaveProperty('last')
    }
  })
})

describe('the router', () => {
  it('declares the requests the core routes to it', () => {
    expect(ROUTER_REQUESTS).toBe(DECLARED)
    expect([...ROUTER_REQUESTS]).toEqual(['route_decide'])
    expect(Object.keys(startRouter(fakeCore(), router().router)).sort()).toEqual([...ROUTER_REQUESTS].sort())
  })

  it('decides for the owner alone, and only a task it can read', async () => {
    const jev = vi.fn(async () => ({}))
    const { router: made, lines } = router({ jev })
    const handlers = startRouter(fakeCore(), made)
    expect(await handlers.route_decide!({ text: 'go', sessions: DESK }, DEVICE)).toEqual({ error: 'OWNER_REQUIRED' })
    for (const payload of [{}, { text: '  ' }, { text: 7 }, { text: 'x'.repeat(16_001) }]) {
      expect(await handlers.route_decide!(payload, OWNER)).toEqual({ error: 'INVALID_REQUEST' })
    }
    expect(jev).not.toHaveBeenCalled()
    expect(lines).toEqual([])
  })

  it('answers a session Jev is sure of, and logs why', async () => {
    const jev = vi.fn(async () => ({ target: said('s0', 0.8, ['s0', 's1', 'new']) }))
    const { router: made, lines } = router({ jev })
    expect(await startRouter(fakeCore(), made).route_decide!({ text: 'refund it', sessions: DESK }, OWNER))
      .toEqual({ decided: 'session', id: 'a1', via: 'jev' })
    expect(lines).toEqual(['session — 2 sessions · jev: "billing retries" 0.80, then "Prometheus alerts" 0.10'])
    // Jev was asked the task as the client sent it, trimmed.
    expect(jev).toHaveBeenCalledWith({ message: 'refund it' }, expect.objectContaining({ target: expect.any(Object) }), undefined)
  })

  it('answers new work with the project and agent Jev chose, handing back the client\'s own ids', async () => {
    const jev = vi.fn(async () => ({
      target: said('new', 0.9, ['s0', 's1', 'new']),
      project: said('p1', 0.8, ['p0', 'p1']),
      agent: said('a0', 0.7, ['a0', 'a1']),
    }))
    const { router: made, lines } = router({ jev })
    const answer = await startRouter(fakeCore(), made).route_decide!({
      text: 'rename my photos by date',
      sessions: DESK,
      projects: [{ id: '/code/billing', name: 'billing' }, { id: '/Users/me/Pictures', name: 'Pictures' }],
      agents: [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }],
    }, OWNER)
    expect(answer).toEqual({ decided: 'new', via: 'jev', reason: 'Jev: new work', project: '/Users/me/Pictures', agent: 'claude' })
    expect(lines).toEqual(['new (Jev: new work) — 2 sessions · jev: "new" 0.90, then "billing retries" 0.05'])
  })

  it('answers new work with no project or agent when Jev was not sure, for the client to place', async () => {
    const jev = vi.fn(async () => ({ target: { choice: 's1', probabilities: { s0: 0.3, s1: 0.5, new: 0.2 } } }))
    const { router: made, lines } = router({ jev })
    expect(await startRouter(fakeCore(), made).route_decide!({ text: 'go', sessions: DESK }, OWNER))
      .toEqual({ decided: 'new', via: 'unsure', reason: 'Jev was not sure' })
    expect(lines).toEqual(['new (Jev was not sure) — 2 sessions · jev: "Prometheus alerts" 0.50, then "billing retries" 0.30'])
    // And decides the same without a log.
    expect(await startRouter(fakeCore(), { jev }).route_decide!({ text: 'go', sessions: DESK }, OWNER))
      .toEqual({ decided: 'new', via: 'unsure', reason: 'Jev was not sure' })
  })

  it('decides nothing, and says why, when Jev cannot be asked', async () => {
    const jev = vi.fn(async () => { throw new JevUnavailable('NO_KEY', 'no OpenRouter key on this computer') })
    const { router: made, lines } = router({ jev })
    expect(await startRouter(fakeCore(), made).route_decide!({ text: 'go', sessions: DESK }, OWNER))
      .toEqual({ error: 'JEV_UNAVAILABLE', detail: 'no OpenRouter key on this computer' })
    expect(lines).toEqual([
      'jev could not answer: no OpenRouter key on this computer',
      'nothing decided (no OpenRouter key on this computer) — 2 sessions · jev: failed',
    ])
    // A router with no Jev at all, with a log and without.
    const { router: none, lines: noneLines } = router()
    expect(await startRouter(fakeCore(), none).route_decide!({ text: 'go', sessions: DESK }, OWNER))
      .toEqual({ error: 'JEV_UNAVAILABLE', detail: 'Jev is not set up' })
    expect(noneLines).toEqual(['nothing decided (Jev is not set up) — 2 sessions · jev: not set up'])
    expect(await startRouter(fakeCore(), {}).route_decide!({ text: 'go' }, OWNER)).toEqual({ error: 'JEV_UNAVAILABLE', detail: 'Jev is not set up' })
  })

  it('takes two decisions at once from a connection and eight in all, and answers BUSY beyond', async () => {
    // Jev holds each decision until the test lets it go, by the task it was asked about.
    const waiting = new Map<string, () => void>()
    const jev = vi.fn((state: unknown) => new Promise<Record<string, JevChoiceAnswer>>((resolve) => {
      waiting.set((state as { message: string }).message, () => resolve({}))
    }))
    const handlers = startRouter(fakeCore(), router({ jev }).router)
    const ask = (task: string, connection?: string) =>
      handlers.route_decide!({ text: task, sessions: DESK }, { local: true, owner: true, ...(connection ? { connection } : {}) }) as Promise<Record<string, unknown>>
    const mine = [ask('one-1', 'one'), ask('one-2', 'one')]
    expect(await ask('one-3', 'one')).toEqual({ error: 'BUSY' })
    // A request with no connection (the core's own, or a core from before connections) is its own.
    const others = [ask('two-1', 'two'), ask('two-2', 'two'), ask('none-1'), ask('none-2'), ask('none-3'), ask('three-1', 'three')]
    expect(await ask('four-1', 'four')).toEqual({ error: 'BUSY' })
    await vi.waitFor(() => expect(waiting.size).toBe(8))
    expect(waiting.has('one-3')).toBe(false)
    expect(waiting.has('four-1')).toBe(false)
    // A decision that ends gives its slot back, to its connection and to the count.
    waiting.get('one-1')!()
    expect(await mine[0]).toMatchObject({ decided: 'new' })
    const again = ask('one-4', 'one')
    await vi.waitFor(() => expect(waiting.has('one-4')).toBe(true))
    expect(await ask('one-5', 'one')).toEqual({ error: 'BUSY' })
    for (const [task, resolve] of waiting) if (task !== 'one-1') resolve()
    expect(await Promise.all([mine[1], again, ...others])).toEqual(Array.from({ length: 8 }, () => expect.objectContaining({ decided: 'new' })))
    expect(jev).toHaveBeenCalledTimes(9)
  })

  it('stops asking Jev when the connection that asked closes, and gives its slot back then', async () => {
    const jev = vi.fn((_state: unknown, _questions: unknown, signal?: AbortSignal) => new Promise<Record<string, JevChoiceAnswer>>((_, reject) => {
      signal?.addEventListener('abort', () => reject(new JevUnavailable('UNAVAILABLE', 'the asker went away')))
    }))
    const handlers = startRouter(fakeCore(), router({ jev }).router)
    const closing = new AbortController()
    const asked = [0, 1].map(() => handlers.route_decide!({ text: 'go', sessions: DESK }, OWNER, closing.signal))
    expect(await handlers.route_decide!({ text: 'go', sessions: DESK }, OWNER)).toEqual({ error: 'BUSY' })
    closing.abort()
    expect(await Promise.all(asked)).toEqual([0, 1].map(() => ({ error: 'JEV_UNAVAILABLE', detail: 'the asker went away' })))
    expect(jev.mock.calls.map((call) => call[2])).toEqual([closing.signal, closing.signal])
  })

  it('gives a slot back when its decision fails', async () => {
    const jev = vi.fn(async () => ({}))
    const handlers = startRouter(fakeCore(), { jev, log: () => { throw new Error('the log could not be written') } })
    // Three on one connection, past its two: each fails for itself, never BUSY.
    for (let i = 0; i < 3; i++) {
      await expect(handlers.route_decide!({ text: 'go', sessions: DESK }, OWNER)).rejects.toThrow('the log could not be written')
    }
    expect(jev).toHaveBeenCalledTimes(3)
  })
})

describe('the router this computer runs', () => {
  it('asks Jev through the person\'s key, and logs as [route]', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const made = defaultRouter()
    // No key or fetch of its own: the client finds the person's key when it is asked, and not before.
    expect(createJevDecide).toHaveBeenCalledWith({ onCost: expect.any(Function) })
    expect(made.jev).toEqual(expect.any(Function))
    expect(Object.keys(made).sort()).toEqual(['jev', 'log'])
    made.log!('session — 2 sessions')
    // What each answer cost the person's key, as OpenRouter reported it.
    vi.mocked(createJevDecide).mock.calls[0]![0]!.onCost!(0.000167, 3986)
    expect(log.mock.calls).toEqual([['[route] session — 2 sessions'], ['[route] jev cost $0.000167 for 3986 tokens']])
    expect(client.asked).toEqual([])
  })

  it('is what the router runs on when given none', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const handlers = startRouter(fakeCore())
    expect(createJevDecide).toHaveBeenCalledOnce()
    expect(await handlers.route_decide!({ text: 'go', sessions: DESK }, OWNER)).toEqual({ decided: 'new', via: 'unsure', reason: 'Jev was not sure' })
    expect(client.asked).toEqual([{ message: 'go' }])
    expect(log.mock.calls).toEqual([['[route] new (Jev was not sure) — 2 sessions · jev: no answer']])
  })
})
