import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PromptScopes, TeamsEvent } from '../core/api.js'
import { channelTeamId } from '../teams/service.js'
import { runServiceProcess, type CoreConnection, type ServiceProcessOptions } from './process.js'
import { KEPT_UNDOS, runTeamsService } from './teamsProcess.js'

// The real default reaches a real socket and this process's own channel: never in a test.
vi.mock('./process.js', () => ({ runServiceProcess: vi.fn(() => ({ stop: vi.fn() })) }))

const TEAM = channelTeamId('tab-1')
const OTHER = channelTeamId('tab-2')
const Q = 'c'.repeat(32)
const T0 = 1_000_000

/** An event of `core-1`, as the core numbers and stamps it. */
const ev = (seq: number, change: Record<string, unknown>, at = T0): TeamsEvent =>
  ({ agentId: 'agent-1', ...change, seq, core: 'core-1', at }) as TeamsEvent
const flush = () => new Promise((done) => setTimeout(done, 0))

describe('the teams\' prompt scopes in their own process', () => {
  afterEach(() => vi.clearAllMocks())

  const setup = (over: Partial<Parameters<typeof runTeamsService>[0]> = {}) => {
    let options: ServiceProcessOptions | null = null
    const service = { stop: vi.fn() }
    const lines: string[] = []
    const handle = runTeamsService({
      dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't',
      run: (given) => { options = given; return service },
      log: (line) => lines.push(line),
      ...over,
    })
    return { options: options!, service, handle, lines }
  }
  /** A core that answers `hello` with `answer`, and records every acknowledgement. */
  const connection = (answer: Record<string, unknown> | (() => Promise<Record<string, unknown>>) = { core: 'core-1', reset: true, base: 0, events: [] }) => {
    const query = vi.fn((name: string, _payload?: Record<string, unknown>) => name === 'hello'
      ? (typeof answer === 'function' ? answer() : Promise.resolve(answer))
      : Promise.resolve({ kept: true }))
    const acks = () => query.mock.calls.filter(([name]) => name === 'ack').map(([, payload]) => payload)
    const hellos = () => query.mock.calls.filter(([name]) => name === 'hello').map(([, payload]) => payload)
    return { core: { query } satisfies CoreConnection, query, acks, hellos }
  }
  /** Connected, and caught up with `events`. */
  const synced = async (options: ServiceProcessOptions, events: TeamsEvent[] = []) => {
    const core = connection({ core: 'core-1', reset: true, base: 0, events })
    options.onConnected!(core.core)
    await flush()
    return core
  }

  it('reaches the core as `teams`, through the socket and token it was given, and answers the apps nothing', () => {
    const { options } = setup()
    expect(options).toMatchObject({ name: 'teams', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    expect(options.requests).toEqual({})
  })

  it('first asks for what it lacks, applies it, then says where each agent stands', async () => {
    const { options } = setup()
    const core = await synced(options, [
      ev(1, { kind: 'prepare', text: 'hello team', tabId: 'tab-1' }),
      ev(2, { kind: 'started', text: 'hello team', source: 'hook', engine: 'claude' }),
    ])
    expect(core.hellos()).toEqual([{ core: null, applied: 0 }])
    expect(core.acks()).toEqual([{ core: 'core-1', applied: 2, scopes: { 'agent-1': TEAM } }])
  })

  it('applies what comes next in order, once: skips what it has, and asks again for what went missing', async () => {
    const { options } = setup()
    const core = await synced(options, [ev(1, { kind: 'prepare', text: 'hello team', tabId: 'tab-1' })])
    // Already applied, from another core, not a numbered event, or not an event at all: nothing to do.
    options.onEvent!({ kind: 'event', event: ev(1, { kind: 'prepare', text: 'hello team', tabId: 'tab-1' }) })
    options.onEvent!({ kind: 'event', event: { ...ev(2, { kind: 'forget' }), core: 'core-0' } })
    options.onEvent!({ kind: 'event', event: { ...ev(2, { kind: 'forget' }), seq: 'two' } })
    options.onEvent!({ kind: 'event' })
    options.onEvent!({ kind: 'touch', sessionId: 's1' })
    options.onEvent!({ kind: 'event', event: ev(2, { kind: 'started', text: 'hello team', source: 'hook' }) })
    await flush()
    expect(core.acks().at(-1)).toEqual({ core: 'core-1', applied: 2, scopes: { 'agent-1': TEAM } })
    // The fourth before the third: ask the core again, from where it is.
    options.onEvent!({ kind: 'event', event: ev(4, { kind: 'forget' }) })
    await flush()
    expect(core.hellos().at(-1)).toEqual({ core: 'core-1', applied: 2 })
  })

  it('applies nothing before its first question is answered: the answer brings it all', async () => {
    const { options } = setup()
    let answer: (value: Record<string, unknown>) => void = () => {}
    const core = connection(() => new Promise((done) => { answer = done }))
    options.onConnected!(core.core)
    options.onEvent!({ kind: 'event', event: ev(1, { kind: 'prepare', text: 'early', tabId: 'tab-1' }) })
    answer({ core: 'core-1', reset: true, base: 0, events: [ev(1, { kind: 'prepare', text: 'early', tabId: 'tab-1' }), ev(2, { kind: 'started', text: 'early', source: 'hook' })] })
    await flush()
    expect(core.acks()).toEqual([{ core: 'core-1', applied: 2, scopes: { 'agent-1': TEAM } }])
  })

  it('ignores an answer it cannot use: an older connection\'s, or one that says nothing', async () => {
    const { options } = setup()
    let older: (value: Record<string, unknown>) => void = () => {}
    options.onConnected!(connection(() => new Promise((done) => { older = done })).core)
    const current = connection({ core: 'core-1' })
    options.onConnected!(current.core)
    older({ core: 'core-1', reset: true, base: 0, events: [] })
    for (const answer of [{ core: 'core-1', base: 0 }, { core: 'core-1', events: [] }, { base: 0, events: [] }]) {
      options.onConnected!(connection(answer).core)
    }
    options.onConnected!(connection(async () => { throw new Error('the core went away') }).core)
    await flush()
    // Never caught up: what comes is not applied.
    options.onEvent!({ kind: 'event', event: ev(1, { kind: 'forget' }) })
    expect(current.acks()).toEqual([])
  })

  it('applies a replay only from where it stands: out of place and foreign events are not its', async () => {
    const { options } = setup()
    const core = await synced(options, [
      null as unknown as TeamsEvent,
      ev(1, { kind: 'prepare', text: 'one', tabId: 'tab-1' }),
      { ...ev(2, { kind: 'started', text: 'one', source: 'hook' }), core: 'core-0' },
      ev(3, { kind: 'started', text: 'one', source: 'hook' }),
    ])
    expect(core.acks()).toEqual([{ core: 'core-1', applied: 1, scopes: { 'agent-1': null } }])
  })

  it('takes back a write that failed, so the prompt it would have scoped finds no team', async () => {
    const { options } = setup()
    const core = await synced(options, [
      ev(1, { kind: 'prepare', text: 'never written', tabId: 'tab-1' }),
      ev(2, { kind: 'unprepare', of: 1 }),
      // An undo for a write it never saw, or saw taken back already, does nothing.
      ev(3, { kind: 'unprepare', of: 1 }),
      ev(4, { kind: 'unprepare', of: 99 }),
      ev(5, { kind: 'started', text: 'never written', source: 'hook' }),
    ])
    expect(core.acks()).toEqual([{ core: 'core-1', applied: 5, scopes: { 'agent-1': null } }])
  })

  it('keeps a bounded number of undos', async () => {
    const { options } = setup()
    const writes = Array.from({ length: KEPT_UNDOS + 1 }, (_, n) => ev(n + 1, { kind: 'prepare', text: `m${n}`, tabId: 'tab-1', agentId: `agent-${n}` }))
    const core = await synced(options, [...writes, ev(KEPT_UNDOS + 2, { kind: 'unprepare', of: 1, agentId: 'agent-0' })])
    expect(core.acks()[0]).toMatchObject({ applied: KEPT_UNDOS + 2 })
  })

  it('applies each event at the time it happened, so a replay ages as the original would have', async () => {
    const minute = 60_000
    const { options } = setup()
    const core = await synced(options, [
      ev(1, { kind: 'prepare', text: 'quick', tabId: 'tab-1', agentId: 'quick' }, T0),
      ev(2, { kind: 'started', text: 'quick', source: 'hook', agentId: 'quick' }, T0 + minute),
      ev(3, { kind: 'prepare', text: 'slow', tabId: 'tab-2', agentId: 'slow' }, T0),
      ev(4, { kind: 'started', text: 'slow', source: 'hook', agentId: 'slow' }, T0 + 6 * minute),
    ])
    // Past five minutes, a message is no longer matched to the prompt that starts.
    expect(core.acks()).toEqual([{ core: 'core-1', applied: 4, scopes: { quick: TEAM, slow: null } }])
  })

  it('reads keys typed into a scoped terminal, and answers to a team\'s question', async () => {
    const { options } = setup()
    const question = `team:${OTHER}:${Q}:question`
    const core = await synced(options, [
      ev(1, { kind: 'raw', bytes: Buffer.from('typed\r').toString('base64'), tabId: 'tab-1', pasted: false }),
      ev(2, { kind: 'started', text: 'typed', source: 'hook' }),
      ev(3, { kind: 'prepare', text: 'a question', deliveryId: question, agentId: 'asked' }),
      ev(4, { kind: 'started', text: 'a question', source: 'transcript', agentId: 'asked' }),
    ])
    expect(core.acks().at(-1)).toMatchObject({ scopes: { 'agent-1': TEAM, asked: OTHER } })
    options.onEvent!({ kind: 'event', event: ev(5, { kind: 'replied', teamId: OTHER, questionId: Q, agentId: 'asked' }) })
    options.onEvent!({ kind: 'event', event: ev(6, { kind: 'forget' }) })
    await flush()
    expect(core.acks().at(-1)).toEqual({ core: 'core-1', applied: 6, scopes: { asked: null, 'agent-1': null } })
  })

  it('starts over when the core says so, and goes on from where the core says', async () => {
    const { options } = setup()
    const first = await synced(options, [ev(1, { kind: 'prepare', text: 'hello', tabId: 'tab-1' })])
    expect(first.acks()).toHaveLength(1)
    // The same core, reconnected: nothing lost, nothing over.
    const again = connection({ core: 'core-1', reset: false, base: 1, events: [ev(2, { kind: 'started', text: 'hello', source: 'hook' })] })
    options.onConnected!(again.core)
    await flush()
    expect(again.hellos()).toEqual([{ core: 'core-1', applied: 1 }])
    expect(again.acks()).toEqual([{ core: 'core-1', applied: 2, scopes: { 'agent-1': TEAM } }])
    // A new core: the old scopes go.
    const fresh = connection({ core: 'core-2', reset: true, base: 0, events: [{ ...ev(1, { kind: 'started', text: 'hello', source: 'hook' }), core: 'core-2' }] })
    options.onConnected!(fresh.core)
    await flush()
    expect(fresh.hellos()).toEqual([{ core: 'core-1', applied: 2 }])
    expect(fresh.acks()).toEqual([{ core: 'core-2', applied: 1, scopes: { 'agent-1': null } }])
  })

  it('goes on past an event it cannot apply, and one of a kind it does not know', async () => {
    const { options, lines } = setup()
    const core = await synced(options, [
      ev(1, { kind: 'prepare', tabId: 'tab-1' }),
      ev(2, { kind: 'newer-kind' }),
      ev(3, { kind: 'forget' }),
    ])
    expect(lines).toEqual([expect.stringMatching(/^\[teams\] event 1 could not be applied · /)])
    expect(core.acks()).toEqual([{ core: 'core-1', applied: 3, scopes: { 'agent-1': null } }])
    const thrown = setup({ scopes: () => ({ ...fakeScopes(), forget: () => { throw 'gone' } }) })
    await synced(thrown.options, [ev(1, { kind: 'forget' })])
    expect(thrown.lines).toEqual(['[teams] event 1 could not be applied · gone'])
  })

  it('says how far it got once per burst, and shrugs off a core that went away', async () => {
    const { options } = setup()
    const core = await synced(options)
    for (let seq = 1; seq <= 3; seq++) options.onEvent!({ kind: 'event', event: ev(seq, { kind: 'raw', bytes: 'YQ==', tabId: 'tab-1', pasted: false }) })
    await flush()
    expect(core.acks()).toHaveLength(2)
    expect(core.acks()[1]).toEqual({ core: 'core-1', applied: 3, scopes: { 'agent-1': null } })
    core.query.mockImplementation(async () => { throw new Error('the core went away') })
    options.onEvent!({ kind: 'event', event: ev(4, { kind: 'forget' }) })
    await flush()
  })

  it('stops its connection when stopped', () => {
    const { handle, service } = setup()
    handle.stop()
    expect(service.stop).toHaveBeenCalledOnce()
  })

  it('runs as a real service process by default, logging on the console', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    runTeamsService({ dataDir: '/data', socketPath: '/data/daemon-1.sock', machineId: 'm', token: 't' })
    const options = vi.mocked(runServiceProcess).mock.calls.at(-1)![0]
    expect(options).toMatchObject({ name: 'teams', socketPath: '/data/daemon-1.sock' })
    await synced(options, [ev(1, { kind: 'started', source: 'hook' })])
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('[teams] event 1 could not be applied'))
    warn.mockRestore()
  })
})

function fakeScopes(): PromptScopes {
  return { prepare: () => () => {}, started: () => {}, raw: () => {}, forget: () => {}, replied: () => {}, current: () => null }
}
