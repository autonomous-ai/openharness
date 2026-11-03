import { describe, expect, it } from 'vitest'
import { closeAssignment, recordAttempts, writeRouteEffects } from './routeDecisions.js'

type Row = Record<string, unknown> & { id: string; tabId: string; conversationId: string; outcome?: string | null }

// Exercise the persistence effects against rows, including Mongo's distinction between null and an unset field.
function memoryTx(rows: Row[]) {
  const matches = (row: Row, where: Record<string, unknown>): boolean => Object.entries(where).every(([key, want]) => {
    if (key === 'AND') return (want as Record<string, unknown>[]).every(part => matches(row, part))
    if (key === 'OR') return (want as Record<string, unknown>[]).some(part => matches(row, part))
    const actual = row[key]
    if (want && typeof want === 'object') {
      const filter = want as Record<string, unknown>
      if ('isSet' in filter) return (key in row) === filter.isSet
      if ('equals' in filter) return actual === filter.equals
      if ('not' in filter) return actual !== filter.not
      if ('in' in filter) return (filter.in as unknown[]).includes(actual)
    }
    return want === null ? actual == null : actual === want
  })
  const tx = { superTabRouteDecision: {
    findMany: async ({ where }: { where: Record<string, unknown> }) => rows.filter(row => matches(row, where))
      .map(row => ({ ...row, final: row.final ?? null, assignmentId: row.assignmentId ?? null })),
    updateMany: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const found = rows.filter(row => matches(row, where))
      found.forEach(row => Object.assign(row, data))
      return { count: found.length }
    },
    update: async ({ where, data }: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
      const row = rows.find(row => matches(row, where))!
      Object.assign(row, data)
      return row
    },
    create: async ({ data }: { data: Row }) => { rows.push({ ...data }); return data },
    deleteMany: async () => ({ count: 0 }),
  } }
  return tx as unknown as Parameters<typeof writeRouteEffects>[0]
}

describe('route decision persistence', () => {
  it('reroutes unused proposals while queued starts and assignments retain quota until their work ends', async () => {
    const now = Date.now()
    const final = { kind: 'new' as const, startId: 'start-1', machineId: 'machine', engine: 'claude', model: 'opus', effort: 'high' }
    const rows: Row[] = [
      { id: 'proposal', tabId: 'tab', conversationId: 'group', final: null, assignmentId: null, outcome: null },
      { id: 'unset-proposal', tabId: 'tab', conversationId: 'group' },
      { id: 'queued', tabId: 'tab', conversationId: 'group', final, assignmentId: null, outcome: null },
      { id: 'assigned', tabId: 'tab', conversationId: 'group', final: { kind: 'member', agentId: 'agent', machineId: 'machine' }, assignmentId: 'assignment-1', outcome: null },
      { id: 'assigned-without-final', tabId: 'tab', conversationId: 'group', final: null, assignmentId: 'assignment-2', outcome: null },
      { id: 'finished', tabId: 'tab', conversationId: 'group', final, assignmentId: 'assignment-3', outcome: 'done' },
      { id: 'other-group', tabId: 'tab', conversationId: 'other', final: null, assignmentId: null, outcome: null },
    ]
    const tx = memoryTx(rows)
    await writeRouteEffects(tx, 'tab', [{ op: 'create', id: 'next', conversationId: 'group', record: {} as never }], now)
    const outcome = (id: string) => rows.find(row => row.id === id)?.outcome ?? null
    expect(outcome('proposal')).toBe('superseded')
    expect(outcome('unset-proposal')).toBe('superseded')
    expect(outcome('queued')).toBeNull()
    expect(outcome('assigned')).toBeNull()
    expect(outcome('assigned-without-final')).toBeNull()
    expect(outcome('finished')).toBe('done')
    expect(outcome('other-group')).toBeNull()
    expect(rows.some(row => row.id === 'next')).toBe(true)

    // A queued start later becomes an assignment; both it and the already assigned work close on completion.
    await writeRouteEffects(tx, 'tab', [{ op: 'final', id: 'queued', final, assignmentId: 'assignment-queued' }], now + 1)
    await closeAssignment(tx, 'tab', 'assignment-queued', 'done', now + 2)
    await closeAssignment(tx, 'tab', 'assignment-1', 'done', now + 2)
    expect(outcome('queued')).toBe('done')
    expect(outcome('assigned')).toBe('done')
    expect(outcome('next')).toBeNull()
  })
})

describe('attempt records on route decisions', () => {
  const config = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
  const task = (id: string, status = 'working') => ({ id, agentId: 'w', status, configuration: config,
    execution: { machineId: 'm1', harnessId: 'h1', machineOwnerId: 'owner' }, result: null })
  const swarm = (conversations: Array<{ id: string; assignment: ReturnType<typeof task> | null }>, input: number) => ({
    agents: [{ id: 'w', machineId: 'm1', harnessId: 'h1', configuration: config }], conversations,
    machines: [{ machineId: 'm1', observation: { receivedAt: 1, quotas: [{ engine: 'claude', known: true, windows: [{ name: '5-hour', usedPercent: 1, resetsAt: null }] }],
      runningHarnessIds: ['h1'], stoppedHarnessIds: [], harnessTokens: { h1: { 'claude-opus-5-5': { input, output: 0, cacheRead: 0, cacheWrite: 0 } } } } }],
  }) as never
  const tokens = (input: number) => ({ 'claude-opus-5-5': { input, output: 0, cacheRead: 0, cacheWrite: 0 } })

  it('starts the run of a new attempt, ends it as lost, reopens it on resume, and ends it again with the real outcome left to its command', async () => {
    const rows: Row[] = [{ id: 'd1', tabId: 'tab', conversationId: 'g1', assignmentId: 'a1', outcome: null, createdAt: new Date(5) }]
    const tx = memoryTx(rows)
    await recordAttempts(tx, 'tab', swarm([{ id: 'g1', assignment: null }], 0), swarm([{ id: 'g1', assignment: task('a1') }], 100), 1000)
    expect(rows[0]!.run).toEqual({ machineId: 'm1', harnessId: 'h1', engine: 'claude', model: 'opus', effort: 'high', billing: 'subscription',
      startedAt: 1000, start: tokens(100) })
    await recordAttempts(tx, 'tab', swarm([{ id: 'g1', assignment: task('a1') }], 0), swarm([{ id: 'g1', assignment: task('a1', 'lost') }], 400), 2000)
    expect(rows[0]).toMatchObject({ outcome: 'lost', outcomeAt: new Date(2000), run: { endedAt: 2000, end: tokens(400), start: tokens(100) } })
    await recordAttempts(tx, 'tab', swarm([{ id: 'g1', assignment: task('a1', 'lost') }], 0), swarm([{ id: 'g1', assignment: task('a1') }], 400), 3000)
    expect(rows[0]).toMatchObject({ outcome: null, outcomeAt: null })
    await recordAttempts(tx, 'tab', swarm([{ id: 'g1', assignment: task('a1') }], 0), swarm([{ id: 'g1', assignment: task('a1', 'done') }], 900), 4000)
    expect(rows[0]).toMatchObject({ outcome: null, run: { endedAt: 4000, end: tokens(900) } })
  })

  it('supersedes an open attempt whose group went while it was active, and never reopens or overwrites a closed outcome', async () => {
    const rows: Row[] = [{ id: 'd1', tabId: 'tab', conversationId: 'g1', assignmentId: 'a1', outcome: null, createdAt: new Date(5) },
      { id: 'd2', tabId: 'tab', conversationId: 'g2', assignmentId: 'a2', outcome: 'cancelled', createdAt: new Date(5) }]
    const tx = memoryTx(rows)
    await recordAttempts(tx, 'tab', swarm([{ id: 'g1', assignment: task('a1') }, { id: 'g2', assignment: task('a2') }], 0), swarm([], 50), 2000)
    expect(rows.map(r => r.outcome)).toEqual(['superseded', 'cancelled'])
    // Recorded before runs existed: it ends with what it ran on, its start unknown and taken as when it was routed.
    expect(rows[0]!.run).toMatchObject({ engine: 'claude', startedAt: 5, start: null, endedAt: 2000, end: tokens(50) })
  })
})
