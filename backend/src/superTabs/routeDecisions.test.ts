import { describe, expect, it } from 'vitest'
import { closeAssignment, writeRouteEffects } from './routeDecisions.js'

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
