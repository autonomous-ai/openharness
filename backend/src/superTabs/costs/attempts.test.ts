import { describe, expect, it } from 'vitest'
import type { Assignment, Conversation, SuperTabState } from '../model.js'
import { attemptChanges, attemptTokens, endRun, startRun, type RouteRun } from './attempts.js'

const opus = (input: number, output = 0) => ({ input, output, cacheRead: 0, cacheWrite: 0 })
const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const assignment = (over: Partial<Assignment> = {}): Assignment => ({ id: 'a1', agentId: 'w', status: 'working', configuration: config,
  execution: { machineId: 'm1', harnessId: 'h1', machineOwnerId: 'owner' }, result: null, ...over })
const group = (task: Assignment | null, id = 'g1') => ({ id, assignment: task }) as Conversation
function swarm(over: { quotas?: unknown[]; tokens?: Record<string, Record<string, ReturnType<typeof opus>>>; localModels?: unknown[]; gridModel?: string;
  conversations?: Conversation[]; agentConfig?: typeof config } = {}): SuperTabState {
  return { agents: [{ id: 'w', machineId: 'm1', harnessId: 'h1', configuration: over.agentConfig ?? config, ...(over.gridModel ? { gridModel: over.gridModel } : {}) }],
    conversations: over.conversations ?? [],
    machines: [{ machineId: 'm1', observation: { receivedAt: 1, quotas: over.quotas ?? [], runningHarnessIds: ['h1'], stoppedHarnessIds: [],
      ...(over.tokens ? { harnessTokens: over.tokens } : {}) } },
    { machineId: 'm2', observation: { receivedAt: 1, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [], ...(over.localModels ? { localModels: over.localModels } : {}) } }],
  } as unknown as SuperTabState
}

describe('which attempts started, ended or resumed in a write', () => {
  it('finds a new assignment, one that ended (lost apart), one replaced or removed while active, and a lost one resumed', () => {
    const before = [group(assignment({ id: 'done' }), 'g1'), group(assignment({ id: 'lost' }), 'g2'), group(assignment({ id: 'gone' }), 'g3'),
      group(assignment({ id: 'resumed', status: 'lost' }), 'g4'), group(assignment({ id: 'old', status: 'done' }), 'g5'), group(assignment({ id: 'still' }), 'g6')]
    const after = swarm({ conversations: [group(assignment({ id: 'done', status: 'done' }), 'g1'), group(assignment({ id: 'lost', status: 'lost' }), 'g2'),
      group(assignment({ id: 'resumed', status: 'working' }), 'g4'), group(assignment({ id: 'new' }), 'g5'), group(assignment({ id: 'still', status: 'review' }), 'g6')] })
    const changes = attemptChanges(before, after)
    expect(changes.started.map(a => a.id)).toEqual(['new'])
    expect(changes.ended.map(e => [e.assignment.id, e.outcome])).toEqual([['done', null], ['lost', 'lost'], ['gone', 'superseded']])
    expect(changes.resumed.map(a => a.id)).toEqual(['resumed'])
  })

  it('sees nothing when no attempt changed', () => {
    const before = [group(assignment()), group(null, 'g2')]
    expect(attemptChanges(before, swarm({ conversations: before }))).toEqual({ started: [], ended: [], resumed: [] })
  })
})

describe('what an attempt ran on and how it was paid', () => {
  it('starts from the session totals its machine last reported, with the agent’s model and effort', () => {
    const run = startRun(swarm({ tokens: { h1: { 'claude-opus-5-5': opus(500) } }, quotas: [{ engine: 'claude', known: true, windows: [{ name: '5-hour', usedPercent: 3, resetsAt: null }] }] }),
      assignment(), 1000)
    expect(run).toEqual({ machineId: 'm1', harnessId: 'h1', engine: 'claude', model: 'opus', effort: 'high', billing: 'subscription',
      startedAt: 1000, start: { 'claude-opus-5-5': opus(500) } })
  })

  it('pays per token on an engine whose machine reads no plan windows (an API key), and says unknown when it cannot tell', () => {
    expect(startRun(swarm({ quotas: [{ engine: 'claude', known: true, windows: [] }] }), assignment(), 1).billing).toBe('api')
    expect(startRun(swarm({ quotas: [{ engine: 'claude', known: false, windows: [] }] }), assignment(), 1).billing).toBe('unknown')
    expect(startRun(swarm(), assignment(), 1)).toMatchObject({ billing: 'unknown', start: null })
  })

  it('names a grid model and pays for it as its servers do: own hardware, a shared API, or unknown when they disagree', () => {
    const served = (kind: string) => ({ grid: 'swarm-1', model: 'kimi-k3', kind })
    expect(startRun(swarm({ gridModel: 'kimi-k3', localModels: [served('api')] }), assignment(), 1)).toMatchObject({ grid: 'kimi-k3', billing: 'api' })
    expect(startRun(swarm({ gridModel: 'kimi-k3', localModels: [served('local')] }), assignment(), 1)).toMatchObject({ grid: 'kimi-k3', billing: 'own-hardware' })
    expect(startRun(swarm({ gridModel: 'kimi-k3', localModels: [served('local'), served('api')] }), assignment(), 1).billing).toBe('unknown')
    expect(startRun(swarm({ gridModel: 'kimi-k3' }), assignment(), 1).billing).toBe('unknown')
  })

  it('ends with the session totals then, the model and effort the agent ran at last, and keeps how it started', () => {
    const start = startRun(swarm({ tokens: { h1: { 'claude-opus-5-5': opus(500) } } }), assignment(), 1000)
    const ended = endRun(start, swarm({ tokens: { h1: { 'claude-opus-5-5': opus(900, 40) } }, agentConfig: { ...config, effort: 'max' } }),
      assignment(), 'w', 5000)
    expect(ended).toEqual({ ...start, effort: 'max', endedAt: 5000, end: { 'claude-opus-5-5': opus(900, 40) } })
  })

  it('ends with the totals its machine reported before this write when this write’s report no longer lists the session', () => {
    const start = startRun(swarm({ tokens: { h1: { m: opus(500) } } }), assignment(), 1000)
    const ended = endRun(start, swarm(), assignment(), 'w', 5000, swarm({ tokens: { h1: { m: opus(800) } } }))
    expect(ended).toMatchObject({ endedAt: 5000, end: { m: opus(800) } })
    expect(endRun(start, swarm({ tokens: { h1: { m: opus(900) } } }), assignment(), 'w', 5000, swarm({ tokens: { h1: { m: opus(800) } } })).end).toEqual({ m: opus(900) })
  })

  it('ends with the reading its session sent as it finished, and with none (unknown) when it finished without one', () => {
    const start = startRun(swarm({ tokens: { h1: { m: opus(500) } } }), assignment(), 1000)
    const stale = swarm({ tokens: { h1: { m: opus(600) } } })
    expect(endRun(start, stale, assignment(), 'w', 5000, stale, { m: opus(2000) }).end).toEqual({ m: opus(2000) })
    expect(endRun(start, stale, assignment(), 'w', 5000, stale, null).end).toBeNull()
  })

  it('starts from nothing when the attempt ends on another session than it began (a replaced terminal)', () => {
    const start = startRun(swarm({ tokens: { h1: { m: opus(500) } } }), assignment(), 1000)
    const moved = swarm({ tokens: { h2: { m: opus(30) } } })
    ;(moved.agents[0] as { harnessId: string }).harnessId = 'h2'
    const ended = endRun(start, moved, assignment({ execution: { machineId: 'm1', harnessId: 'h2', machineOwnerId: 'owner' } }), 'w', 5000)
    expect(ended).toMatchObject({ harnessId: 'h2', start: {}, end: { m: opus(30) } })
  })
})

describe('an attempt’s tokens', () => {
  const run = (start: RouteRun['start'], end: RouteRun['end'], over: Partial<RouteRun> = {}): RouteRun => ({ machineId: 'm1', harnessId: 'h1', engine: 'claude',
    model: 'opus', effort: 'high', billing: 'subscription', startedAt: 1, start, endedAt: 2, end, ...over })

  it('is what the session added during it, by model, taking a counter that went back as restarted', () => {
    expect(attemptTokens(run({ a: opus(100, 10), b: opus(5) }, { a: opus(150, 30), b: opus(5), c: opus(7, 1) }), false))
      .toEqual({ a: opus(50, 20), c: opus(7, 1) })
    expect(attemptTokens(run({ a: opus(100) }, { a: opus(40) }), false)).toEqual({ a: opus(40) })
  })

  it('counts from zero only for an agent started for it, and is unknown with no reading at either end', () => {
    expect(attemptTokens(run(null, { a: opus(9) }), true)).toEqual({ a: opus(9) })
    expect(attemptTokens(run(null, { a: opus(9) }), false)).toBeNull()
    expect(attemptTokens(run({ a: opus(9) }, null), true)).toBeNull()
    expect(attemptTokens(run({ a: opus(9) }, undefined), true)).toBeNull()
  })
})
