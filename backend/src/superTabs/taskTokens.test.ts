import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import { MAX_TASK_ROWS, recordTaskTokens, taskTokens, taskTokensKey, TOKEN_WRITES_PER_HOUR } from './taskTokens.js'
import { SuperTabError } from './model.js'

type Row = { id: string; tabId: string; projectId: string; agentId: string; repository: string; number: number; kind: string
  tokens: unknown; rounds: number; startedAt: Date; endedAt: Date; createdAt: Date }
/** The collection as Mongo keeps it: a second insert of one id is refused as a duplicate key, as Prisma names it, and a read
 *  answers dates and large whole numbers as Extended JSON. */
function database() {
  const rows = new Map<string, Row>()
  const asked: unknown[] = []
  const db = { superTabTaskTokens: {
    create: async ({ data }: { data: Row }) => {
      if (rows.has(data.id)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
      rows.set(data.id, data)
      return data
    },
    update: async ({ where, data }: { where: { id: string }; data: Partial<Row> }) => {
      const row = rows.get(where.id)
      if (!row) throw Object.assign(new Error('Record to update not found'), { code: 'P2025' })
      rows.set(where.id, { ...row, ...data })
      return rows.get(where.id)
    },
    aggregateRaw: async ({ pipeline }: { pipeline: Array<Record<string, unknown>> }) => {
      asked.push(pipeline)
      const match = pipeline[0]!.$match as { tabId: string; repository: string; number: { $in: number[] } }
      return [...rows.values()].filter(row => row.tabId === match.tabId && row.repository === match.repository && match.number.$in.includes(row.number))
        .slice(0, (pipeline[1] as { $limit: number }).$limit)
        .map(row => ({ projectId: row.projectId, agentId: row.agentId, number: row.number, kind: row.kind, tokens: row.tokens, rounds: row.rounds,
          startedAt: { $date: row.startedAt.toISOString() }, endedAt: { $date: row.endedAt.toISOString() } }))
    },
  } } as unknown as PrismaClient
  return { db, rows, asked }
}
const NOW = 1_800_000_000_000
const SONNET = { model: 'claude-sonnet-5-5', input: 1200, output: 3400, cacheRead: 560_000, cacheWrite: 78_000 }
const record = (db: PrismaClient, over: Partial<Parameters<typeof recordTaskTokens>[1]> = {}) =>
  recordTaskTokens(db, { tabId: 'tab', projectId: 'web', agentId: 'pip', repository: 'Acme/App', number: 14, kind: 'build', tokens: [SONNET], rounds: 0,
    startedAt: NOW - 42 * 60_000, endedAt: NOW - 60_000, now: NOW, ...over })
const refusal = async (body: () => Promise<unknown>) => {
  try { await body(); return null } catch (error) { if (error instanceof SuperTabError) return error; throw error }
}

describe('what an agent\'s conversation used on a task', () => {
  it('keeps ids and counts only, under its Swarm, the repository in lower case, the number, its agent and the kind of work', async () => {
    const { db, rows } = database()
    expect(await record(db)).toEqual({ recorded: true })
    expect([...rows.values()]).toEqual([{ id: 'tab|acme/app|14|pip|build', tabId: 'tab', projectId: 'web', agentId: 'pip', repository: 'acme/app', number: 14, kind: 'build',
      tokens: [SONNET], rounds: 0, startedAt: new Date(NOW - 42 * 60_000), endedAt: new Date(NOW - 60_000), createdAt: new Date(NOW) }])
    expect(taskTokensKey('tab', 'Acme/App', 20, 'juno', 'read')).toBe('tab|acme/app|20|juno|read')
  })

  it('takes the totals so far: the same write again changes nothing, a later one replaces the numbers, and the expiry still counts from the first', async () => {
    const { db, rows } = database()
    await record(db)
    const first = { ...rows.get('tab|acme/app|14|pip|build')! }
    expect(await record(db, { repository: 'acme/app', now: NOW + 5_000 })).toEqual({ recorded: true })
    expect(rows.get('tab|acme/app|14|pip|build')).toEqual(first)
    const more = [{ ...SONNET, output: 9000 }, { model: 'gpt-5.5', input: 10, output: 20, cacheRead: 30, cacheWrite: 0 }]
    await record(db, { tokens: more, rounds: 2, endedAt: NOW, now: NOW + 60_000 })
    expect(rows.get('tab|acme/app|14|pip|build')).toEqual({ ...first, tokens: more, rounds: 2, endedAt: new Date(NOW) })
    expect(rows.size).toBe(1)
    // Another agent, another kind of work, another number and another Swarm each keep a row of their own.
    await record(db, { agentId: 'oak' })
    await record(db, { kind: 'fix' })
    await record(db, { number: 15 })
    await record(db, { tabId: 'other-tab' })
    expect(rows.size).toBe(5)
  })

  it('refuses an agent past its writes for the hour, and no other agent', async () => {
    const { db, rows } = database()
    for (let i = 0; i < TOKEN_WRITES_PER_HOUR; i++) await record(db, { agentId: 'busy', number: (i % 3) + 1, now: NOW + 1 })
    expect(await refusal(() => record(db, { agentId: 'busy', number: 9001, now: NOW + 2 }))).toMatchObject({ code: 'RATE_LIMITED', status: 429 })
    expect(rows.has('tab|acme/app|9001|busy|build')).toBe(false)
    expect(await record(db, { agentId: 'calm', number: 9002, now: NOW + 2 })).toEqual({ recorded: true })
  })

  it('fails as the database failed when it is no duplicate key', async () => {
    const { db } = database()
    const broken = { superTabTaskTokens: { ...db.superTabTaskTokens, create: async () => { throw new Error('the database is away') } } } as unknown as PrismaClient
    await expect(record(broken)).rejects.toThrow('the database is away')
  })

  it('reads the rows of the numbers asked, in one read by the Swarm, the repository and the numbers', async () => {
    const { db, asked } = database()
    await record(db)
    await record(db, { number: 20, kind: 'fix', rounds: 1, tokens: [{ ...SONNET, cacheRead: 5_000_000_000 }] })
    await record(db, { number: 20, kind: 'read', agentId: 'juno', projectId: 'docs', rounds: 1 })
    await record(db, { number: 21 })
    await record(db, { tabId: 'other-tab' })
    await record(db, { repository: 'acme/other' })
    const rows = await taskTokens(db, 'tab', 'ACME/App', [14, 20])
    expect(rows).toEqual([
      { projectId: 'web', agentId: 'pip', number: 14, kind: 'build', tokens: [SONNET], rounds: 0, startedAt: NOW - 42 * 60_000, endedAt: NOW - 60_000 },
      { projectId: 'web', agentId: 'pip', number: 20, kind: 'fix', tokens: [{ ...SONNET, cacheRead: 5_000_000_000 }], rounds: 1, startedAt: NOW - 42 * 60_000, endedAt: NOW - 60_000 },
      { projectId: 'docs', agentId: 'juno', number: 20, kind: 'read', tokens: [SONNET], rounds: 1, startedAt: NOW - 42 * 60_000, endedAt: NOW - 60_000 },
    ])
    expect(asked).toEqual([[{ $match: { tabId: 'tab', repository: 'acme/app', number: { $in: [14, 20] } } }, { $limit: MAX_TASK_ROWS },
      { $project: { _id: 0, projectId: 1, agentId: 1, number: 1, kind: 1, tokens: 1, rounds: 1, startedAt: 1, endedAt: 1 } }]])
  })

  it('reads counts and numbers as Mongo answers them: a whole number too large for 32 bits comes wrapped', async () => {
    const wrapped = { superTabTaskTokens: { aggregateRaw: async () => [{ projectId: 'web', agentId: 'pip', number: { $numberInt: '14' }, kind: 'build', rounds: { $numberLong: '3' },
      tokens: [{ model: 'gpt-5.5', input: { $numberLong: '5000000000' }, output: 7, cacheRead: { $numberDouble: '12' }, cacheWrite: 0 }],
      startedAt: { $date: { $numberLong: String(NOW - 1000) } }, endedAt: { $date: new Date(NOW).toISOString() } }] } } as unknown as PrismaClient
    expect(await taskTokens(wrapped, 'tab', 'acme/app', [14])).toEqual([{ projectId: 'web', agentId: 'pip', number: 14, kind: 'build', rounds: 3,
      tokens: [{ model: 'gpt-5.5', input: 5_000_000_000, output: 7, cacheRead: 12, cacheWrite: 0 }], startedAt: NOW - 1000, endedAt: NOW }])
  })

  it('asks nothing for no numbers', async () => {
    const { db, asked } = database()
    expect(await taskTokens(db, 'tab', 'acme/app', [])).toEqual([])
    expect(asked).toEqual([])
  })
})
