import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LiveEvent } from '../../lib/normalize.js'
import type { SessionRecaps } from '../../lib/recapReads.js'
import { projectDisplayName, type RegisteredSession } from '../../lib/registry.js'
import type { ActivityFrame } from '../../lib/turnActivity.js'
import type { RecapsPort } from '../api.js'
import { createRecaps, type RecapDeps } from './recaps.js'

function setup(over: Partial<RecapDeps> = {}) {
  const live = { agentId: 'a1', sessionId: 's1', engine: 'claude', cwd: '/work/app', transcriptPath: '/t/s1.jsonl' } as RegisteredSession
  const bare = { agentId: 'a2', sessionId: 's2', engine: 'claude', cwd: '/work/other' } as RegisteredSession
  const sessions = new Map([['s1', live], ['s2', bare]])
  const held = new Map<string, SessionRecaps>()
  const card = { type: 'commander_event' as const, agentId: 'a1', dbSessionId: 's1', payload: { kind: 'processing' } }
  const port = { lifecycle: vi.fn(), recaps: vi.fn((sessionId: string) => held.get(sessionId) ?? null), liveCards: vi.fn(async () => [card]) } satisfies RecapsPort
  let on: RecapsPort | null = port
  const deps: RecapDeps = {
    port: () => on,
    turnActivity: { snapshot: vi.fn(() => undefined) },
    clients: { hasActiveCommander: vi.fn(() => false) },
    deviceIsWatching: vi.fn(() => true),
    cableWatchingLocal: vi.fn(() => false),
    bySession: (sessionId) => sessions.get(sessionId),
    resolve: (id) => id === 'a1' ? live : undefined,
    stopped: (agentId) => agentId === 'gone' ? ({ agentId: 'gone', sessionId: 'old-s' } as RegisteredSession) : null,
    live: () => [live, bare, { agentId: 'a3', sessionId: '' } as RegisteredSession],
    sessionTurnOpen: vi.fn((sessionId: string) => sessionId === 's1'),
    orchestratorRoleOf: vi.fn(() => null),
    ...over,
  }
  const recaps = createRecaps(deps)
  return { deps, recaps, port, held, live, off: () => { on = null } }
}

const watching = { device: true, active: false }
const started = { type: 'turn_started', payload: { userMessage: 'hi' } } as LiveEvent
const ended = { type: 'turn_ended', payload: {} } as LiveEvent

describe('recaps, as the core keeps them', () => {
  afterEach(() => { vi.restoreAllMocks() })

  it('counts a specialist\'s turn, or a director\'s while specialists are out, as a sub-agent\'s', () => {
    const { deps, recaps } = setup()
    const role = vi.mocked(deps.orchestratorRoleOf)
    expect(recaps.isSubagentSession('nobody')).toBe(false)
    expect(recaps.isSubagentSession('s1')).toBe(false)
    role.mockReturnValueOnce({ role: 'worker' })
    expect(recaps.isSubagentSession('s1')).toBe(true)
    role.mockReturnValueOnce({ role: 'director', busy: true })
    expect(recaps.isSubagentSession('s1')).toBe(true)
    role.mockReturnValueOnce({ role: 'director', busy: false })
    expect(recaps.isSubagentSession('s1')).toBe(false)
    expect(role).toHaveBeenCalledWith('a1')
  })

  it('takes an agent whose role cannot be read for anyone\'s: the turn keeps its end (e2e/diskfull.e2e.ts)', () => {
    const { deps, recaps } = setup()
    vi.mocked(deps.orchestratorRoleOf).mockImplementationOnce(() => { throw new Error('ENOSPC: no space left on device, mkdir') })
    expect(recaps.isSubagentSession('s1')).toBe(false)
  })

  it('tells the recaps each batch, addressed as the core knows the session, and whether it is a sub-agent\'s only where a turn ends', () => {
    const { deps, recaps, port, live } = setup()
    recaps.mirror.ingest([started], 's1')
    vi.mocked(deps.orchestratorRoleOf).mockReturnValueOnce({ role: 'worker' })
    recaps.mirror.ingest([ended], 's1', { replay: true })
    recaps.mirror.ingest([started], 's2')
    recaps.mirror.ingest([started], 'unbound')
    const session = { sessionId: 's1', agentId: 'a1', name: projectDisplayName(live), transcriptPath: '/t/s1.jsonl' }
    expect(port.lifecycle.mock.calls).toEqual([
      [{ kind: 'events', session, events: [started], replay: false }, watching],
      [{ kind: 'events', session: { ...session, subagent: true }, events: [ended], replay: true }, watching],
      [{ kind: 'events', session: { sessionId: 's2', agentId: 'a2', name: projectDisplayName({ agentId: 'a2', sessionId: 's2', engine: 'claude', cwd: '/work/other' } as RegisteredSession) }, events: [started], replay: false }, watching],
      // A session the core no longer has is addressed by its own id, as the cards always were.
      [{ kind: 'events', session: { sessionId: 'unbound', agentId: 'unbound' }, events: [started], replay: false }, watching],
    ])
    expect(deps.orchestratorRoleOf).toHaveBeenCalledTimes(1)
  })

  it('says who watches: a device at all, and one rendering this machine (a plugged-in dial always is)', () => {
    const { deps, recaps, port } = setup()
    vi.mocked(deps.deviceIsWatching).mockReturnValue(false)
    recaps.mirror.noteEngineStopped('s1')
    vi.mocked(deps.cableWatchingLocal).mockReturnValueOnce(true)
    recaps.mirror.noteEngineStopped('s1')
    vi.mocked(deps.clients.hasActiveCommander).mockReturnValueOnce(true)
    recaps.mirror.noteEngineStopped('s1')
    expect(port.lifecycle.mock.calls.map(([, seen]) => seen)).toEqual([
      { device: false, active: false }, { device: false, active: true }, { device: false, active: true },
    ])
  })

  it('beats with whether the turn is verifiably working, and keeps beating while the recaps say its card is busy', () => {
    const { deps, recaps, port, held, off } = setup()
    vi.mocked(deps.turnActivity.snapshot).mockReturnValueOnce({ state: 'working' } as ActivityFrame)
    expect(recaps.mirror.heartbeat('s1')).toBe(false)
    held.set('s1', { latest: null, history: [], fullTexts: [], asks: [], busy: true })
    expect(recaps.mirror.heartbeat('s1')).toBe(true)
    expect(port.lifecycle.mock.calls.map(([event]) => event)).toMatchObject([
      { kind: 'beat', session: { sessionId: 's1' }, working: true },
      { kind: 'beat', session: { sessionId: 's1' }, working: false },
    ])
    // The recaps off: nothing is busy, and nothing is told.
    off()
    expect(recaps.mirror.heartbeat('s1')).toBe(false)
    expect(port.lifecycle).toHaveBeenCalledTimes(2)
  })

  it('tells a cancel, a forget, a purge, a rebound and a Stop hook, each in its own words', () => {
    const { deps, recaps, port } = setup()
    vi.mocked(deps.orchestratorRoleOf).mockReturnValueOnce({ role: 'worker' })
    recaps.mirror.cancel('s1')
    recaps.mirror.forget('s2')
    recaps.mirror.deleteHistory('s1')
    recaps.mirror.inheritSummary('s1', 's9')
    recaps.mirror.noteEngineStopped('s2')
    expect(port.lifecycle.mock.calls.map(([event]) => event)).toMatchObject([
      { kind: 'cancelled', session: { sessionId: 's1', subagent: true } },
      { kind: 'forgotten', session: { sessionId: 's2', subagent: false } },
      { kind: 'purged', sessionId: 's1' },
      { kind: 'rebound', from: 's1', to: 's9' },
      { kind: 'stopped', sessionId: 's2' },
    ])
  })

  it('tells the recaps a session attached with its last turn already over', () => {
    const { recaps, port } = setup()
    recaps.mirror.settled('s1')
    expect(port.lifecycle.mock.calls.map(([event]) => event)).toMatchObject([{ kind: 'settled', session: { sessionId: 's1' } }])
  })

  it('says, as a device joins, which turns are verifiably working, so their busy cards go with it', () => {
    const { deps, recaps, port } = setup()
    vi.mocked(deps.turnActivity.snapshot).mockImplementation((sessionId) => (sessionId === 's2' ? { state: 'working' } as ActivityFrame : undefined))
    recaps.mirror.replayAll()
    expect(port.lifecycle).toHaveBeenCalledWith({ kind: 'rejoined', working: ['s2'] }, watching)
  })

  it('tells the recaps a question asked and answered', () => {
    const { recaps, port } = setup()
    recaps.question('asked', 's1', 'r1')
    recaps.question('answered', 's1', 'r1')
    expect(port.lifecycle.mock.calls.map(([event]) => event)).toEqual([
      { kind: 'asked', sessionId: 's1', requestId: 'r1' },
      { kind: 'answered', sessionId: 's1', requestId: 'r1' },
    ])
  })

  it('asks the recaps for the cards of turns still at work, and has none while they are off', async () => {
    const { recaps, off } = setup()
    expect(await recaps.mirror.liveCards()).toEqual([expect.objectContaining({ type: 'commander_event', dbSessionId: 's1' })])
    off()
    expect(await recaps.mirror.liveCards()).toEqual([])
  })

  it('reads a fork\'s "busy" from the core\'s own turn, not from the recaps', () => {
    const { recaps, port } = setup()
    expect(recaps.mirror.isBusy('s1')).toBe(true)
    expect(recaps.mirror.isBusy('s2')).toBe(false)
    expect(port.recaps).not.toHaveBeenCalled()
  })

  it('reads a session\'s recaps from what the recaps hold, and none while they are off', () => {
    const { recaps, held, off } = setup()
    held.set('s1', { latest: 'old\n\nbody', history: ['r1\n\nb1', 'r0\n\nb0'], fullTexts: ['full one', 'full zero'], asks: ['why?', 'how?'], busy: false })
    expect(recaps.mirror.recent('s1', 1)).toEqual([{ kind: 'summary', text: 'b1', recap: 'r1', fullText: 'full one' }])
    expect(recaps.mirror.recentAsks('s1', 1)).toEqual(['why?'])
    expect(recaps.mirror.lastFullText('s1')).toBe('full one')
    expect(recaps.mirror.recent('nobody')).toEqual([])
    off()
    expect(recaps.mirror.recent('s1')).toEqual([])
    expect(recaps.mirror.recentAsks('s1')).toEqual([])
    expect(recaps.mirror.lastFullText('s1')).toBeUndefined()
  })

  it('looks recaps up under the engine session, asked for by agent, live or stopped', () => {
    const { recaps } = setup()
    const recent = vi.spyOn(recaps.mirror, 'recent').mockReturnValue([])
    const asks = vi.spyOn(recaps.mirror, 'recentAsks').mockReturnValue([])
    recaps.recent('a1', 3)
    recaps.recent('gone', 2)
    recaps.recent('s9', 1)
    recaps.recentAsks('a1', 5)
    recaps.recentAsks('gone')
    recaps.recentAsks('s9', 1)
    expect(recent.mock.calls).toEqual([['s1', 3], ['old-s', 2], ['s9', 1]])
    expect(asks.mock.calls).toEqual([['s1', 5], ['old-s', undefined], ['s9', 1]])
  })

  it('answers agent_recent with an agent\'s summaries and questions, two of each unless one to five are asked for', () => {
    const { recaps } = setup()
    const summary = { kind: 'summary', text: 'body', recap: 'recap' }
    const recent = vi.spyOn(recaps.mirror, 'recent').mockReturnValue([summary])
    const asks = vi.spyOn(recaps.mirror, 'recentAsks').mockReturnValue(['which build is this?'])
    expect(recaps.agentRecent({})).toStrictEqual({ error: 'MISSING_AGENT_ID' })
    const reply = recaps.agentRecent({ agentId: 'a1' })
    expect(reply).toStrictEqual({ agentId: 'a1', events: [summary], asks: ['which build is this?'] })
    expect(Object.keys(reply)).toEqual(['agentId', 'events', 'asks'])
    for (const n of [0, 'many', 9, -3, 3.5]) recaps.agentRecent({ agentId: 'a1', n })
    expect(recent.mock.calls.map(([, n]) => n)).toEqual([2, 2, 2, 5, 1, 3.5])
    expect(asks.mock.calls.map(([, n]) => n)).toEqual([2, 2, 2, 5, 1, 3.5])
    expect(recent).toHaveBeenCalledWith('s1', 2)
  })
})
