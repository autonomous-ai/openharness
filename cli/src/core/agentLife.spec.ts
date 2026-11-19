import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import { storedGridFixture } from '../testing/gridCredentials.js'
import { createAgentLife, FOLLOWER_FAILURES_MAX, followOptions, PURGED_SESSIONS_MAX, TOLD_PRUNE_AT } from './agentLife.js'
import { FOLLOW_HAVING_MAX, VIEWERS_FOLLOW, type AgentLife, type HeldAgentLife } from './api.js'

const agent = (agentId: string, over: Partial<RegisteredSession> = {}) => ({ agentId, sessionId: `s-${agentId}`, engine: 'claude', ...over }) as RegisteredSession

function setup(live: RegisteredSession[] = [], hears: Record<string, HeldAgentLife[]> = {}) {
  const notify = vi.fn((_service: string, _frame: unknown, _opts?: { untilDelivered?: boolean }) => true)
  const log = vi.fn()
  const hub = createAgentLife({ live: () => live, notify, hears, log })
  /** A follower in this process, and what it heard. */
  const follower = (options?: Parameters<typeof hub.follow>[1]) => {
    const heard: AgentLife[] = []
    const unfollow = hub.follow((event) => { heard.push(event) }, options)
    return { heard, unfollow }
  }
  return { hub, notify, log, follower }
}

/** What a service in its own process was told, in order. */
const toldTo = (notify: ReturnType<typeof setup>['notify'], service: string) =>
  notify.mock.calls.filter(([name]) => name === service).map(([, frame, opts]) => ({ ...(frame as Record<string, unknown>), ...(opts ? { opts } : {}) }))

describe('what happens to agents, for the services that follow them', () => {
  afterEach(() => vi.restoreAllMocks())

  it('bounds frame epochs to live bindings and gives a reclaimed binding a new epoch', () => {
    const live = Array.from({ length: TOLD_PRUNE_AT }, (_, n) => agent(`a${n}`))
    const { hub, log } = setup(live)
    hub.followed('viewer', { frames: true })
    const original = hub.frameEpoch('a0')
    expect(original).toEqual(expect.any(String))
    hub.running(agent('overflow'))
    expect(hub.frameEpoch('overflow')).toBeUndefined()
    expect(log).toHaveBeenCalledWith('[frames] FRAME_PART_LIMIT')
    live.shift()
    hub.running(agent('replacement'))
    expect(hub.frameEpoch('a0')).toBeUndefined()
    expect(hub.frameEpoch('replacement')).toEqual(expect.any(String))
    hub.ended('replacement')
    hub.running(agent('replacement'))
    expect(hub.frameEpoch('replacement')).not.toBe(original)
  })

  it('shares an accepted person input source with inline followers and both declared process consumers', () => {
    const { hub, follower, notify } = setup([], { gateway: ['input'], agentCleanup: ['input'], search: ['purged'] })
    const inline = follower({ running: false })
    const row = agent('joined', { startedBy: 'agent' })
    hub.input(row, { connId: 'phone', kind: 'phone' })
    hub.input(agent('own'), { connId: 'desktop', kind: null })
    hub.input(agent('unattributed'))
    const events = [
      { kind: 'input', agentId: 'joined', source: { connection: 'phone', clientKind: 'phone' }, startedByAgent: true },
      { kind: 'input', agentId: 'own', source: { connection: 'desktop', clientKind: null }, startedByAgent: false },
      { kind: 'input', agentId: 'unattributed', startedByAgent: false },
    ]
    expect(inline.heard).toEqual(events)
    for (const name of ['gateway', 'agentCleanup']) expect(toldTo(notify, name)).toEqual(events.map(event => ({
      type: 'service_event', payload: { kind: 'agent', event }, opts: { untilDelivered: true, replaceKey: `input:${event.agentId}` },
    })))
    expect(toldTo(notify, 'search')).toEqual([])
  })

  it.each(['inline', 'process'] as const)('keeps credentials out of %s catch-up and running notifications, including retained rows', (mode) => {
    const override = storedGridFixture({ networkId: 'fixture', networkName: 'Fixture', baseUrl: 'https://fixture.invalid/v1', apiKey: 'synthetic-lifecycle-canary' })
    const plain = agent('plain')
    const keyed = agent('keyed', { gridLaunch: override })
    const { hub, notify } = setup([plain, keyed])
    const received: unknown[] = []
    const connect = (each: boolean) => {
      if (mode === 'inline') return hub.follow(event => { received.push(event) }, { each })
      received.push(hub.followed('viewers', { each }))
      return () => hub.disconnected('viewers')
    }
    const disconnect = connect(false)
    const initial = JSON.stringify(received)
    expect(initial).not.toContain('gridLaunch')
    expect(initial).not.toContain(override.credential.binding)
    plain.gridLaunch = override
    expect(JSON.stringify(received)).not.toContain('gridLaunch')
    hub.running(agent('new', { gridLaunch: override }))
    hub.running(agent('new', { gridLaunch: override }))
    disconnect()
    const end = connect(true)
    hub.running(keyed)
    hub.running(keyed)
    end()
    const all = [...received, ...notify.mock.calls]
    expect(JSON.stringify(all)).not.toContain('gridLaunch')
    expect(JSON.stringify(all)).not.toContain(override.credential.binding)
    expect(keyed.gridLaunch).toBe(override)
    expect(plain.gridLaunch).toBe(override)
    if (mode === 'process') expect(notify).toHaveBeenCalledTimes(3)
    else expect(received).toHaveLength(7)
  })

  it('does not read credential fields for unobserved, filtered or already-known scans', () => {
    const session = agent('known')
    const read = vi.fn(() => undefined)
    Object.defineProperty(session, 'gridLaunch', { get: read, enumerable: true })
    const { hub } = setup([session])
    hub.running(session)
    hub.follow(() => {}, { having: ['dsh'] })
    hub.follow(() => {}, { running: false })
    hub.followed('filtered', { having: ['dsh'] })
    hub.followed('quiet', { running: false })
    hub.running(session)
    expect(read).not.toHaveBeenCalled()
    hub.follow(() => {})
    hub.followed('once', {})
    read.mockClear()
    hub.running(session)
    expect(read).not.toHaveBeenCalled()
  })

  describe('a follower in the core\'s process', () => {
    it('is told every live agent it follows at once, then each look at a new one once a run, and its end', () => {
      const { hub, follower } = setup([agent('a1')])
      const { heard } = follower()
      expect(heard).toEqual([{ kind: 'running', session: agent('a1') }])
      // Every scan looks again: once a run is enough for this follower, so an idle daemon's scans cost it nothing.
      hub.running(agent('a1'))
      hub.running(agent('a2'))
      hub.running(agent('a2'))
      hub.ended('a2')
      // An end it was never told the agent ran for is not its to hear, and an end is said once.
      hub.ended('a2')
      hub.ended('never')
      // A run after the end is a new run.
      hub.running(agent('a2'))
      expect(heard.map((event) => event.kind === 'running' ? `running ${event.session.agentId}` : `${event.kind} ${'agentId' in event ? event.agentId : ''}`))
        .toEqual(['running a1', 'running a2', 'ended a2', 'running a2'])
    })

    it('asking for each look hears every one, and `having` only the agents whose row has those fields set', () => {
      const { hub, follower } = setup([agent('h1', { dsh: 'acme/blender' }), agent('plain'), agent('empty', { dsh: '' })])
      const { heard } = follower(VIEWERS_FOLLOW)
      hub.running(agent('h1', { dsh: 'acme/blender' }))
      hub.running(agent('plain'))
      hub.ended('plain')
      hub.ended('h1')
      expect(heard).toEqual([
        { kind: 'running', session: { ...agent('h1', { dsh: 'acme/blender' }), frameEpoch: expect.any(String) } },
        { kind: 'running', session: { ...agent('h1', { dsh: 'acme/blender' }), frameEpoch: expect.any(String) } },
        { kind: 'ended', agentId: 'h1' },
      ])
    })

    it('one that follows no runs hears only a stop, a purge and a pane taken, as every follower does', () => {
      const { hub, follower } = setup([agent('a1')])
      const quiet = follower({ running: false })
      const runs = follower()
      hub.running(agent('a1'))
      hub.ended('a1')
      hub.stopped('a1')
      hub.purged('a1', ['s1', 's0'])
      hub.taken('a1', agent('a2'))
      hub.taken('a1', agent('g1', { guest: 'kim@acme.io' }))
      const held: AgentLife[] = [
        { kind: 'stopped', agentId: 'a1' },
        { kind: 'purged', agentId: 'a1', sessionIds: ['s1', 's0'] },
        { kind: 'taken', from: 'a1', to: 'a2' },
        { kind: 'taken', from: 'a1', to: 'g1', guest: true },
      ]
      expect(quiet.heard).toEqual(held)
      expect(runs.heard).toEqual([{ kind: 'running', session: agent('a1') }, { kind: 'ended', agentId: 'a1' }, ...held])
    })

    it('names at most PURGED_SESSIONS_MAX conversations of a purge', () => {
      const { hub, follower } = setup()
      const { heard } = follower({ running: false })
      hub.purged('a1', Array.from({ length: PURGED_SESSIONS_MAX + 5 }, (_, i) => `s${i}`))
      expect((heard[0] as { sessionIds: string[] }).sessionIds).toHaveLength(PURGED_SESSIONS_MAX)
    })

    it('a follower that throws is said in the log, and the others and the core go on', () => {
      const { hub, log } = setup([agent('a1')])
      const after: AgentLife[] = []
      hub.follow(() => { throw new Error('boom') })
      hub.follow(() => { throw 'not an error' })
      hub.follow((event) => { after.push(event) })
      expect(() => hub.stopped('a1')).not.toThrow()
      expect(log.mock.calls).toEqual([
        ['[agents] a follower failed on running: Error'],
        ['[agents] a follower failed on running: string'],
        ['[agents] a follower failed on stopped: Error'],
        ['[agents] a follower failed on stopped: string'],
      ])
      expect(after.map((event) => event.kind)).toEqual(['running', 'stopped'])
    })

    it('a follower that keeps failing hears nothing more, said once, as a service that keeps failing is switched off', () => {
      const { hub, log } = setup([agent('a1')])
      const listener = vi.fn(() => { throw new Error('boom') })
      hub.follow(listener, VIEWERS_FOLLOW)
      for (let i = 0; i < FOLLOWER_FAILURES_MAX + 3; i++) hub.running(agent('a1', { dsh: 'acme/blender' }))
      expect(listener).toHaveBeenCalledTimes(FOLLOWER_FAILURES_MAX)
      expect(log).toHaveBeenLastCalledWith(`[agents] a follower failed ${FOLLOWER_FAILURES_MAX} times: it hears nothing more · Error`)
      expect(log).toHaveBeenCalledTimes(FOLLOWER_FAILURES_MAX + 1)
      hub.stopped('a1')
      expect(listener).toHaveBeenCalledTimes(FOLLOWER_FAILURES_MAX)
      // Dropped in the middle of its catch-up: the rest of it is not told either.
      const many = setup(Array.from({ length: FOLLOWER_FAILURES_MAX + 2 }, (_, i) => agent(`m${i}`)))
      const failing = vi.fn(() => { throw new Error('boom') })
      many.hub.follow(failing)
      expect(failing).toHaveBeenCalledTimes(FOLLOWER_FAILURES_MAX)
    })

    it('says a failing follower in the core\'s log when it is given none', () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const hub = createAgentLife({ live: () => [], notify: () => true, hears: {} })
      hub.follow(() => { throw new Error('boom') })
      hub.stopped('a1')
      expect(warn).toHaveBeenCalledWith('[agents] a follower failed on stopped: Error')
    })

    it('hears nothing once it stops following', () => {
      const { hub, follower } = setup()
      const { heard, unfollow } = follower()
      unfollow()
      hub.running(agent('a1'))
      hub.stopped('a1')
      expect(heard).toEqual([])
    })

    // An end that never came (a row gone some way that skipped its forget) costs a follower nothing for good.
    it('keeps the agents it was told run bounded: past TOLD_PRUNE_AT, only the live ones', () => {
      const live = [agent('kept')]
      const { hub, follower } = setup(live)
      const { heard } = follower()
      for (let i = 0; i < TOLD_PRUNE_AT; i++) hub.running(agent(`gone-${i}`))
      // Pruned to the live ones: one whose end never came is told again at its next look, a live one is not.
      hub.running(agent('kept'))
      hub.running(agent('gone-0'))
      const told = heard.filter((event) => event.kind === 'running').map((event) => (event as { session: RegisteredSession }).session.agentId)
      expect(told.filter((id) => id === 'kept')).toHaveLength(1)
      expect(told.filter((id) => id === 'gone-0')).toHaveLength(2)
    })
  })

  describe('a service in its own process', () => {
    it('asks to follow as it connects: answered its catch-up, then told each change on its link', () => {
      const { hub, notify } = setup([agent('h1', { dsh: 'acme/blender' }), agent('plain')])
      expect(hub.followed('viewers', { ...VIEWERS_FOLLOW })).toEqual({ agents: [{ ...agent('h1', { dsh: 'acme/blender' }), frameEpoch: expect.any(String) }] })
      hub.running(agent('h1', { dsh: 'acme/blender' }))
      hub.running(agent('plain'))
      hub.ended('h1')
      expect(toldTo(notify, 'viewers')).toEqual([
        { type: 'service_event', payload: { kind: 'agent', event: { kind: 'running', session: { ...agent('h1', { dsh: 'acme/blender' }), frameEpoch: expect.any(String) } } } },
        { type: 'service_event', payload: { kind: 'agent', event: { kind: 'ended', agentId: 'h1' } } },
      ])
    })

    it('one that follows no runs is answered no catch-up', () => {
      const { hub } = setup([agent('a1')])
      expect(hub.followed('search', { running: false })).toEqual({ agents: [] })
    })

    it('what it followed goes with its connection: its next one asks again, and the last one asked is the one told', () => {
      const { hub, notify } = setup([agent('a1')])
      hub.followed('agentBrowser', {})
      hub.followed('agentBrowser', {})
      hub.running(agent('a2'))
      expect(toldTo(notify, 'agentBrowser')).toHaveLength(1)
      hub.disconnected('agentBrowser')
      hub.running(agent('a3'))
      hub.ended('a2')
      expect(toldTo(notify, 'agentBrowser')).toHaveLength(1)
    })

    it('refuses options it does not understand: a filter misread would tell it every agent at every look', () => {
      const { hub } = setup([agent('a1')])
      expect(hub.followed('viewers', { each: 'yes' })).toEqual({ error: 'INVALID_REQUEST' })
      hub.running(agent('a2'))
    })

    // Held from the core's start until the service hears it, for the services whose process says they hear that kind
    // (harnessd/services.ts `hears`), whether or not they follow agents as they run.
    it('a stop, a purge and a pane taken are held for each service that hears that kind, and for no other', () => {
      const { hub, notify } = setup([], { search: ['purged'], agentCleanup: ['stopped'], agentBrowser: ['purged', 'taken'] })
      hub.stopped('a1')
      hub.purged('a1', ['s1'])
      hub.taken('a1', agent('a2'))
      const event = (kind: AgentLife) => ({ type: 'service_event', payload: { kind: 'agent', event: kind }, opts: { untilDelivered: true } })
      expect(toldTo(notify, 'agentCleanup')).toEqual([event({ kind: 'stopped', agentId: 'a1' })])
      expect(toldTo(notify, 'search')).toEqual([event({ kind: 'purged', agentId: 'a1', sessionIds: ['s1'] })])
      expect(toldTo(notify, 'agentBrowser')).toEqual([event({ kind: 'purged', agentId: 'a1', sessionIds: ['s1'] }), event({ kind: 'taken', from: 'a1', to: 'a2' })])
      expect(notify).toHaveBeenCalledTimes(4)
    })
  })

  describe('a follower\'s options, as a process sends them', () => {
    it('keeps only what it understood, and nothing that changes no answer', () => {
      expect(followOptions({})).toEqual({})
      expect(followOptions({ each: true, having: ['dsh'], running: true })).toEqual({ each: true, having: ['dsh'] })
      expect(followOptions({ each: false, having: [], running: false })).toEqual({ running: false })
      expect(followOptions({ having: Array.from({ length: FOLLOW_HAVING_MAX }, (_, i) => `f${i}`) })).toMatchObject({ having: expect.any(Array) })
    })

    it.each([
      ['each that is not true or false', { each: 1 }],
      ['running that is not true or false', { running: 'no' }],
      ['having that is not a list', { having: 'dsh' }],
      ['having past its most', { having: Array.from({ length: FOLLOW_HAVING_MAX + 1 }, (_, i) => `f${i}`) }],
      ['a field that is not a name', { having: [7] }],
      ['an empty field', { having: [''] }],
      ['a field past its longest', { having: ['x'.repeat(65)] }],
    ])('refuses %s', (_what, raw) => {
      expect(followOptions(raw)).toBeNull()
    })
  })
})
