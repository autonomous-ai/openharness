import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts } from '../core/api.js'
import type { AgentCloseResult } from '../lib/closeAgentService.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { RETENTION_LAPSE_MS, retainContributions, retentionFile } from '../superTabs/retention.js'
import { ASK_AGAIN_MS, CASCADE_RETRY_MS, CASCADE_TRIES, createAgentCleanup, IDLE_CLOSE_MS, JOINED_MAX, joinedPath, LOOK_EVERY_MS, startAgentCleanup, type AgentCleanupDeps } from './agentCleanup.js'

const NOW = Date.parse('2026-10-12T12:00:00Z')
const MIN = 60_000

const row = (agentId: string, over: Partial<RegisteredSession> = {}) =>
  ({ agentId, sessionId: `s-${agentId}`, defaultName: agentId, registeredAt: NOW - 2 * IDLE_CLOSE_MS, ...over }) as RegisteredSession
/** A harness another agent started: `lead` here, unless said. */
const kid = (agentId: string, over: Partial<RegisteredSession> = {}) => row(agentId, { startedBy: 'agent', parentAgentId: 'lead', ...over })

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'agent-cleanup-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); vi.restoreAllMocks() })

/** The cleanup on a fake core: [sessions] are the live agents, [quietFor] how long ago each last moved. */
function setup(sessions: RegisteredSession[], quietFor: Record<string, number | null> = {}, over: AgentCleanupDeps & { refuse?: Record<string, AgentCloseResult> } = {}) {
  let clock = NOW
  const closeStarted = vi.fn(async (agentId: string, _mode: 'idle' | 'now'): Promise<AgentCloseResult> => {
    const refused = over.refuse?.[agentId]
    if (refused) return refused
    sessions.splice(sessions.findIndex((s) => s.agentId === agentId), 1)
    return { closed: true }
  })
  const lastActivity = vi.fn(async (agentId: string) => {
    const quiet = quietFor[agentId]
    return quiet === null ? null : clock - (quiet ?? 0)
  })
  const core = fakeCore({
    dataDir: dir,
    agents: {
      live: vi.fn(() => [...sessions]),
      resolve: vi.fn((id: string) => sessions.find((s) => s.agentId === id || s.sessionId === id)),
      closeStarted, lastActivity,
    },
  })
  const log = vi.fn()
  let tick: (() => void) | null = null
  const waited: number[] = []
  const cleanup = createAgentCleanup(core, { now: () => clock, log, every: (_ms, run) => { tick = run; return () => { tick = null } },
    wait: async (ms) => { waited.push(ms) }, ...over })
  return { cleanup, core, closeStarted, lastActivity, log, waited, advance: (ms: number) => { clock += ms }, tick: () => tick }
}

/** Lets the closes a notice started finish. */
const settle = () => new Promise((done) => setTimeout(done, 0))

it('keeps idle Super Tab members through host restarts and starter closure, until their contribution is removed', async () => {
  const sessions = [kid('member'), kid('ordinary')]
  const t = setup(sessions, { member: 2 * IDLE_CLOSE_MS, ordinary: 2 * IDLE_CLOSE_MS })
  retainContributions(dir, 'machine-1', [{ tabId: 'tab', agent: { harnessId: 'member', machineId: 'machine-1' } }])
  await t.cleanup.look()
  t.advance(IDLE_CLOSE_MS)
  await t.cleanup.look()
  expect(t.closeStarted.mock.calls).toEqual([['ordinary', 'idle']])
  await t.cleanup.closeStartedBy('lead')
  expect(sessions.map(s => s.agentId)).toEqual(['member'])
  t.cleanup.port.stop()
  const restarted = setup(sessions, { member: 2 * IDLE_CLOSE_MS })
  await restarted.cleanup.look()
  restarted.advance(IDLE_CLOSE_MS)
  await restarted.cleanup.look()
  expect(restarted.closeStarted).not.toHaveBeenCalled()
  retainContributions(dir, 'machine-1', [])
  await restarted.cleanup.look()
  expect(restarted.closeStarted.mock.calls).toEqual([['member', 'idle']])
  restarted.cleanup.port.stop()
})

// The owner, 2026-10-23: the Lead of an active project is never stopped in any case, nor when no roster has confirmed it
// for a week (a machine signed out), which lapses every other member to cleanup.
it('never closes a Swarm Lead, idle or orphaned, even once its roster has lapsed', async () => {
  const sessions = [kid('pm'), kid('member')]
  const t = setup(sessions, { pm: 2 * IDLE_CLOSE_MS, member: 2 * IDLE_CLOSE_MS })
  retainContributions(dir, 'machine-1', [{ tabId: 'tab', lead: true, agent: { harnessId: 'pm', machineId: 'machine-1' } },
    { tabId: 'tab', agent: { harnessId: 'member', machineId: 'machine-1' } }])
  const lapsed = new Date(Date.now() - RETENTION_LAPSE_MS - MIN)
  utimesSync(retentionFile(dir), lapsed, lapsed)
  await t.cleanup.look()
  t.advance(IDLE_CLOSE_MS)
  await t.cleanup.look()
  await t.cleanup.closeStartedBy('lead')
  expect(t.closeStarted.mock.calls).toEqual([['member', 'idle']])
  expect(sessions.map(s => s.agentId)).toEqual(['pm'])
  t.cleanup.port.stop()
})

it('rechecks retention after waiting on activity or another orphan close', async () => {
  const t = setup([kid('member')], { member: 2 * IDLE_CLOSE_MS })
  await t.cleanup.look()
  t.advance(IDLE_CLOSE_MS)
  t.lastActivity.mockImplementationOnce(async () => {
    retainContributions(dir, 'machine', [{ tabId: 'tab', agent: { harnessId: 'member', machineId: 'machine' } }])
    return NOW - IDLE_CLOSE_MS
  })
  await t.cleanup.look()
  expect(t.closeStarted).not.toHaveBeenCalled()
  expect(t.log).not.toHaveBeenCalled()
  retainContributions(dir, 'machine', [])
  const cascade = setup([kid('first'), kid('member')])
  cascade.closeStarted.mockImplementationOnce(async () => {
    retainContributions(dir, 'machine', [{ tabId: 'tab', agent: { harnessId: 'member', machineId: 'machine' } }])
    return { closed: true }
  })
  await cascade.cleanup.closeStartedBy('lead')
  expect(cascade.closeStarted.mock.calls).toEqual([['first', 'now']])
  t.cleanup.port.stop()
  cascade.cleanup.port.stop()
})

describe('closing the harnesses a closed harness started', () => {
  it('closes them now, working or not, with one line each, and only those another agent started there', async () => {
    // Lead itself is gone: it was closed.
    const sessions = [kid('a'), kid('b'), kid('other', { parentAgentId: 'someone' }), row('mine', { parentAgentId: 'lead' })]
    const { cleanup, closeStarted, log } = setup(sessions)
    cleanup.port.closed('lead')
    await settle()
    expect(closeStarted.mock.calls).toEqual([['a', 'now'], ['b', 'now']])
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[agent-cleanup] closed a (a): the harness that started it was closed. Its conversation is kept.',
      '[agent-cleanup] closed b (b): the harness that started it was closed. Its conversation is kept.',
    ])
    expect(sessions.map((s) => s.agentId)).toEqual(['other', 'mine'])
  })

  it('closes nothing once its starter is back, and once for two notices of one stop', async () => {
    // Its starter resumed while the notice was held for a process that was down: its harnesses are its again.
    const back = setup([row('lead'), kid('a')])
    back.cleanup.port.closed('lead')
    await settle()
    expect(back.closeStarted).not.toHaveBeenCalled()
    // Two stops of one harness tell this twice.
    const twice = setup([kid('a')])
    twice.cleanup.port.closed('lead')
    twice.cleanup.port.closed('lead')
    await settle()
    expect(twice.closeStarted.mock.calls).toEqual([['a', 'now']])
  })

  it('leaves one the person typed into: it is theirs now', async () => {
    const { cleanup, closeStarted } = setup([kid('joined'), kid('left')])
    cleanup.port.typed('s-joined')
    cleanup.port.closed('lead')
    await settle()
    expect(closeStarted.mock.calls).toEqual([['left', 'now']])
  })

  it('tries one that would not close again, a moment later, and says it once the tries are spent', async () => {
    const refuse: Record<string, AgentCloseResult> = { stuck: { error: 'CLOSE_FAILED', detail: 'Could not save its screen.' }, odd: { error: 'AGENT_CHANGED' },
      blip: { error: 'IDENTITY_UNAVAILABLE' } }
    const { cleanup, closeStarted, log, waited } = setup([kid('stuck', { defaultName: undefined, title: 'Fix the login test' }), kid('odd', { defaultName: undefined }), kid('blip')], {},
      { refuse, wait: async (ms) => { waited.push(ms); delete refuse.blip } })
    cleanup.port.closed('lead')
    await settle()
    // Its identity between two writes for a moment: closed on the second try.
    expect(closeStarted.mock.calls.filter(([id]) => id === 'blip')).toHaveLength(2)
    expect(closeStarted.mock.calls.filter(([id]) => id === 'stuck')).toHaveLength(CASCADE_TRIES)
    expect(waited).toEqual(Array(CASCADE_TRIES - 1).fill(CASCADE_RETRY_MS))
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '[agent-cleanup] closed blip (blip): the harness that started it was closed. Its conversation is kept.',
      '[agent-cleanup] could not close Fix the login test (stuck) (the harness that started it was closed): Could not save its screen.',
      '[agent-cleanup] could not close a harness (odd) (the harness that started it was closed): AGENT_CHANGED',
    ])
    // Stopped meanwhile: not tried again.
    const halted = setup([kid('stuck')], {}, { refuse: { stuck: { error: 'CLOSE_FAILED' } } })
    halted.cleanup.port.stop()
    await halted.cleanup.closeStartedBy('lead')
    expect(halted.closeStarted).toHaveBeenCalledTimes(1)
    const failing = setup([], {}, { refresh: async () => { throw new Error('the core is gone') } })
    failing.cleanup.port.closed('lead-agent-id')
    await settle()
    expect(failing.log).toHaveBeenCalledWith('[agent-cleanup] could not close what lead-age started: the core is gone')
    // The real wait: a timer that holds nothing open.
    vi.useFakeTimers()
    const timed = setup([kid('stuck')], {}, { refuse: { stuck: { error: 'CLOSE_FAILED' } }, wait: undefined })
    const tries = timed.cleanup.closeStartedBy('lead')
    await vi.advanceTimersByTimeAsync((CASCADE_TRIES - 1) * CASCADE_RETRY_MS)
    await tries
    expect(timed.closeStarted).toHaveBeenCalledTimes(CASCADE_TRIES)
  })
})

describe('closing a harness another agent started once it has sat idle', () => {
  it(`closes one idle ${IDLE_CLOSE_MS / MIN} minutes after its last answer, once its screen is idle, with one line`, async () => {
    const sessions = [kid('done'), kid('fresh'), row('mine'), kid('unknown')]
    const { cleanup, closeStarted, lastActivity, log, advance } = setup(sessions, { done: IDLE_CLOSE_MS, fresh: IDLE_CLOSE_MS - MIN, mine: 10 * IDLE_CLOSE_MS, unknown: null })
    // Just started, it has seen every harness just now: nothing is closed, nor asked about, for half an hour.
    await cleanup.look()
    expect(closeStarted).not.toHaveBeenCalled()
    expect(lastActivity).not.toHaveBeenCalled()
    advance(IDLE_CLOSE_MS)
    await cleanup.look()
    // The person's own harness is never asked about, and one whose last move is not known is left alone.
    expect(closeStarted.mock.calls).toEqual([['done', 'idle']])
    expect(log.mock.calls).toEqual([['[agent-cleanup] closed done (done): another agent started it, and it has sat idle 30 minutes. Its conversation is kept.']])
  })

  it('counts a harness starting again (resumed, restored) as moving: the person resumed it to read it', async () => {
    // A resume writes nothing a conversation's time is read from: the one resumed was closed again within a minute.
    const resumed = kid('kid', { processIdentity: { pid: 1, startMarker: 'a', executable: 'claude' } })
    const sessions = [resumed]
    const { cleanup, closeStarted, advance } = setup(sessions, { kid: 3 * IDLE_CLOSE_MS })
    await cleanup.look()
    advance(IDLE_CLOSE_MS - MIN)
    sessions[0] = { ...resumed, processIdentity: { pid: 2, startMarker: 'b', executable: 'claude' } }
    advance(MIN)
    await cleanup.look()
    expect(closeStarted).not.toHaveBeenCalled()
    advance(IDLE_CLOSE_MS)
    await cleanup.look()
    expect(closeStarted.mock.calls).toEqual([['kid', 'idle']])
  })

  it('never closes one the person typed or pasted into, even across a restart', async () => {
    const sessions = [kid('joined')]
    const first = setup(sessions, { joined: 10 * IDLE_CLOSE_MS })
    first.cleanup.port.typed('joined')
    first.cleanup.port.typed('joined')
    await first.cleanup.look()
    first.advance(IDLE_CLOSE_MS)
    await first.cleanup.look()
    expect(first.closeStarted).not.toHaveBeenCalled()
    expect(JSON.parse(readFileSync(joinedPath(dir), 'utf8'))).toEqual({ version: 1, joined: { joined: NOW } })
    const restarted = setup(sessions, { joined: 10 * IDLE_CLOSE_MS })
    await restarted.cleanup.look()
    restarted.advance(IDLE_CLOSE_MS)
    await restarted.cleanup.look()
    expect(restarted.closeStarted).not.toHaveBeenCalled()
  })

  it('keeps nothing for the person\'s own harness, and an id the core named that it does not list', async () => {
    const { cleanup } = setup([row('mine')])
    cleanup.port.typed('mine')
    expect(() => readFileSync(joinedPath(dir), 'utf8')).toThrow()
    cleanup.port.typed('started-elsewhere')
    expect(JSON.parse(readFileSync(joinedPath(dir), 'utf8')).joined).toEqual({ 'started-elsewhere': NOW })
  })

  it('asks one that would not close again only after a while, quietly, and forgets it once it is gone', async () => {
    const sessions = [kid('busy')]
    const refuse: Record<string, AgentCloseResult> = { busy: { error: 'SESSION_NOT_IDLE', activity: 'working' } }
    // (A refusal for its state is quiet; one for anything else is said once: see below.)
    const { cleanup, closeStarted, log, advance } = setup(sessions, { busy: IDLE_CLOSE_MS }, { refuse })
    await cleanup.look()
    advance(IDLE_CLOSE_MS)
    await cleanup.look()
    advance(ASK_AGAIN_MS - MIN)
    await cleanup.look()
    expect(closeStarted).toHaveBeenCalledTimes(1)
    advance(MIN)
    delete refuse.busy
    await cleanup.look()
    expect(closeStarted).toHaveBeenCalledTimes(2)
    expect(log.mock.calls.map(([line]) => line)).toEqual([expect.stringMatching(/^\[agent-cleanup\] closed busy \(busy\): .* idle 3\d minutes/)])
    // Refused, then gone: nothing is kept for it, and back it is a new run, seen from then.
    const gone = setup([kid('x')], { x: IDLE_CLOSE_MS }, { refuse: { x: { error: 'SESSION_NOT_IDLE' } } })
    await gone.cleanup.look()
    gone.advance(IDLE_CLOSE_MS)
    await gone.cleanup.look()
    ;(gone.core.agents.live as ReturnType<typeof vi.fn>).mockReturnValue([])
    await gone.cleanup.look()
    ;(gone.core.agents.live as ReturnType<typeof vi.fn>).mockReturnValue([kid('x')])
    await gone.cleanup.look()
    expect(gone.closeStarted).toHaveBeenCalledTimes(1)
    gone.advance(IDLE_CLOSE_MS)
    await gone.cleanup.look()
    expect(gone.closeStarted).toHaveBeenCalledTimes(2)
  })

  it('says once a close that failed for more than its state, and again only once it has come back', async () => {
    const sessions = [kid('broken')]
    const { cleanup, closeStarted, log, advance, core } = setup(sessions, { broken: IDLE_CLOSE_MS }, { refuse: { broken: { error: 'CLOSE_FAILED', detail: 'Could not save its screen.' } } })
    await cleanup.look()
    advance(IDLE_CLOSE_MS)
    await cleanup.look()
    advance(ASK_AGAIN_MS)
    await cleanup.look()
    expect(closeStarted).toHaveBeenCalledTimes(2)
    expect(log.mock.calls.map(([line]) => line)).toEqual([expect.stringMatching(/^\[agent-cleanup\] could not close broken \(broken\) \(another agent started it, .*\): Could not save its screen\.$/)])
    ;(core.agents.live as ReturnType<typeof vi.fn>).mockReturnValueOnce([])
    await cleanup.look()
    await cleanup.look()
    advance(IDLE_CLOSE_MS)
    await cleanup.look()
    expect(log).toHaveBeenCalledTimes(2)
  })

  it('looks once at a time, and not at all once stopped', async () => {
    let release!: () => void
    const held = new Promise<void>((done) => { release = done })
    const sessions = [kid('a'), kid('b')]
    const { cleanup, closeStarted, lastActivity, tick, advance } = setup(sessions, { a: IDLE_CLOSE_MS, b: IDLE_CLOSE_MS })
    await cleanup.look()
    advance(IDLE_CLOSE_MS)
    lastActivity.mockImplementationOnce(async () => { await held; return NOW })
    const first = cleanup.look()
    await cleanup.look()
    expect(lastActivity).toHaveBeenCalledTimes(1)
    // Stopped halfway: the rest is left.
    cleanup.port.stop()
    expect(tick()).toBeNull()
    release()
    await first
    expect(closeStarted.mock.calls).toEqual([['a', 'idle']])
    await cleanup.look()
    expect(closeStarted).toHaveBeenCalledTimes(1)
  })

  it('looks every minute, and says a look that failed', async () => {
    const { tick, log } = setup([], {}, { refresh: async () => { throw 'no core' } })
    tick()!()
    await settle()
    expect(log).toHaveBeenCalledWith('[agent-cleanup] a look failed: no core')
    vi.useFakeTimers()
    const core = fakeCore({ dataDir: dir, agents: { live: vi.fn(() => []) } })
    const timed = createAgentCleanup(core, { log: vi.fn() })
    await vi.advanceTimersByTimeAsync(LOOK_EVERY_MS)
    expect(core.agents.live).toHaveBeenCalledTimes(1)
    timed.port.stop()
    await vi.advanceTimersByTimeAsync(5 * LOOK_EVERY_MS)
    expect(core.agents.live).toHaveBeenCalledTimes(1)
  })
})

describe('what the cleanup keeps and how it runs', () => {
  it('remembers the newest thousand the person joined, and reads a damaged file as none', async () => {
    const full = Object.fromEntries([['old', 1], ['bad', 'x'], ...Array.from({ length: JOINED_MAX - 1 }, (_, i) => [`k${i}`, 2 + i])])
    writeFileSync(joinedPath(dir), JSON.stringify({ version: 1, joined: full }))
    const { cleanup, closeStarted } = setup([kid('old', { parentAgentId: 'p' }), kid('bad', { parentAgentId: 'p' })])
    cleanup.port.closed('p')
    await settle()
    expect(closeStarted.mock.calls).toEqual([['bad', 'now']])
    cleanup.port.typed('newest')
    const kept = JSON.parse(readFileSync(joinedPath(dir), 'utf8')).joined
    expect(Object.keys(kept)).toHaveLength(JOINED_MAX)
    expect(kept.old).toBeUndefined()
    expect(kept.newest).toBe(NOW)
    for (const damaged of ['{ not json', '{}']) {
      writeFileSync(joinedPath(dir), damaged)
      const fresh = setup([kid('k0', { parentAgentId: 'p' })])
      fresh.cleanup.port.closed('p')
      await settle()
      expect(fresh.closeStarted).toHaveBeenCalledWith('k0', 'now')
    }
  })

  it('says it could not keep a join, and goes on', () => {
    const blocked = join(dir, 'blocked')
    writeFileSync(blocked, '')
    const core = fakeCore({ dataDir: join(blocked, 'data') })
    const log = vi.fn()
    createAgentCleanup(core, { log, every: () => () => {} }).port.typed('kid')
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/^\[agent-cleanup\] could not keep which harnesses the person joined: /))
  })

  it('closes nothing, and knows no time, on a core that offers neither', async () => {
    const sessions = [kid('a')]
    const core = fakeCore({ dataDir: dir, agents: { live: vi.fn(() => sessions) } })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    let clock = NOW
    const cleanup = createAgentCleanup(core, { every: () => () => {}, wait: async () => {}, now: () => clock })
    await cleanup.look()
    clock += IDLE_CLOSE_MS
    await cleanup.look()
    expect(core.agents.live).toHaveBeenCalledTimes(2)
    await cleanup.closeStartedBy('lead')
    expect(log).toHaveBeenCalledWith('[agent-cleanup] could not close a (a) (the harness that started it was closed): UNSUPPORTED')
  })

  it('starts as the agent cleanup\'s port', () => {
    vi.useFakeTimers()
    const ports = emptyPorts()
    startAgentCleanup(fakeCore({ dataDir: dir }), ports)
    expect(ports.agentCleanup).toMatchObject({ closed: expect.any(Function), typed: expect.any(Function), stop: expect.any(Function) })
    ports.agentCleanup!.stop()
  })
})
