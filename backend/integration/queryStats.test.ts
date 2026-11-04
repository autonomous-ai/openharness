import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import { createQueryStats, runWork, startQueryStats, withQueryStats, type QueryStats } from '../src/lib/queryStats.js'

// The query hook on a real client (DB roadmap Phase 1). A fresh loopback replica set; never DATABASE_URL.
let replica: MongoMemoryReplSet
let base: PrismaClient
let db: PrismaClient
let stats: QueryStats
let infos: Record<string, unknown>[] = []
let warns: Record<string, unknown>[] = []

type Row = { op: string; shape: string; route: string; n: number; ms: number; docs: number; bytes: number; errors: number }
const flushed = (): Row[] => { stats.flush(); return infos.at(-1)!.top as Row[] }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`query_stats_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  base = new PrismaClient({ datasources: { db: { url: uri } } })
  db = withQueryStats(base, () => stats)
})
afterAll(async () => {
  await base?.$disconnect()
  await replica?.stop()
})
beforeEach(() => {
  infos = []; warns = []
  stats = createQueryStats({ pod: 'test', sampleEvery: 1, log: (_m, c) => infos.push(c), warn: (_m, c) => warns.push(c) })
})

const person = () => {
  const id = randomUUID()
  return { email: `person-${id}@example.com`, externalId: `fixture-${id}`, autonomousEnv: 'prod' }
}

it('records a query under its model.action, filter shape and route, with its count, time, documents and bytes', async () => {
  const someone = person()
  await db.user.create({ data: someone })
  const found = await runWork('http GET /api/users/:id', async () => await db.user.findMany({ where: { email: someone.email } }))
  expect(found).toHaveLength(1)
  const row = flushed().find(r => r.op === 'User.findMany')!
  expect(row).toMatchObject({ shape: '{"email":"?"}', route: 'http GET /api/users/:id', n: 1, docs: 1, errors: 0 })
  expect(row.bytes).toBe(JSON.stringify(found).length)
  expect(row.ms).toBeGreaterThanOrEqual(0)
  const create = infos.at(-1)!.top as Row[]
  expect(create.find(r => r.op === 'User.create')).toMatchObject({ shape: '', route: 'background', n: 1, docs: 1 })
  expect(JSON.stringify(infos)).not.toContain(someone.email)
})

it('logs a slow query with its filter keys and no values', async () => {
  const someone = person()
  await db.user.create({ data: someone })
  stats = createQueryStats({ pod: 'test', slowMs: 150, log: (_m, c) => infos.push(c), warn: (_m, c) => warns.push(c) })
  // Server-side JavaScript that sleeps makes the query itself slow: the hook times the database, not a fake clock.
  await runWork('web-ws swarm_changes', async () => await db.user.findRaw({ filter: { email: someone.email, $where: 'sleep(200) || true' } }))
  await db.user.findMany({ where: { email: someone.email } })
  expect(warns).toHaveLength(1)
  expect(warns[0]).toMatchObject({ op: 'User.findRaw', shape: '{"$where":"?","email":"?"}', route: 'web-ws swarm_changes', docs: 1, error: false })
  expect(warns[0]!.ms as number).toBeGreaterThanOrEqual(150)
  expect(JSON.stringify(warns)).not.toContain(someone.email)
  expect(JSON.stringify(warns)).not.toContain('sleep')
  stats.flush()
  expect(infos.at(-1)).toMatchObject({ slowQueries: 1 })
})

it('counts a failed query as an error and still throws it to the caller', async () => {
  const someone = person()
  await db.user.create({ data: someone })
  await expect(db.user.create({ data: { ...someone, externalId: `other-${randomUUID()}` } })).rejects.toThrow()
  const rows = flushed().filter(r => r.op === 'User.create')
  expect(rows).toEqual([expect.objectContaining({ n: 2, errors: 1 })])
})

it('records raw commands by their collection and command', async () => {
  const someone = person()
  await db.user.create({ data: someone })
  await runWork('job sweepSwarms', async () => await db.$runCommandRaw({ find: 'users', filter: { email: someone.email } }))
  const row = flushed().find(r => r.op === 'users.$runCommandRaw find')!
  expect(row).toMatchObject({ shape: '{"email":"?"}', route: 'job sweepSwarms', n: 1, docs: 1 })
})

it('times queries and records nothing when no stats are running', async () => {
  const quiet = withQueryStats(base, () => undefined)
  await expect(quiet.user.count()).resolves.toBeGreaterThanOrEqual(0)
})

it('keeps each route apart when queries from two routes run in the same tick', async () => {
  const [a, b] = [person(), person()]
  await db.user.create({ data: a }); await db.user.create({ data: b })
  // Prisma batches findUnique calls of one tick into one engine request; each must still count for its own route.
  await Promise.all([
    runWork('http GET /api/a', async () => await db.user.findUnique({ where: { email: a.email } })),
    runWork('http GET /api/b', async () => await db.user.findUnique({ where: { email: b.email } })),
  ])
  const rows = flushed().filter(r => r.op === 'User.findUnique')
  expect(rows.map(r => [r.route, r.n, r.docs]).sort()).toEqual([['http GET /api/a', 1, 1], ['http GET /api/b', 1, 1]])
})

it('never fails a query because its stats failed, and says so once', async () => {
  const someone = person()
  await db.user.create({ data: someone })
  const broken: QueryStats = { record() { throw new Error('stats bug') }, flush() {} }
  const problems: string[] = []
  const guarded = withQueryStats(base, () => broken, (message, context) => problems.push(`${message} ${String(context.error)}`))
  await expect(guarded.user.findUnique({ where: { email: someone.email } })).resolves.toMatchObject({ email: someone.email })
  await expect(guarded.user.create({ data: someone })).rejects.toThrow(/Unique constraint/)
  expect(problems).toEqual(['query stats failed stats bug'])
})

it('logs every interval once started, flushes the last window on stop, and records nothing after it', async () => {
  // The default getter: what server.ts and worker.ts get from startQueryStats.
  const hooked = withQueryStats(base)
  const lines: Record<string, unknown>[] = []
  const stop = startQueryStats({ reportMs: 50, log: (_m, c) => lines.push(c), warn: () => {} })
  await runWork('job sweepSwarms', async () => await hooked.user.count())
  while (!lines.some(l => (l.top as Row[]).some(r => r.op === 'User.count' && r.route === 'job sweepSwarms'))) await new Promise(resolve => setTimeout(resolve, 10))
  await hooked.user.count({ where: { role: 'admin' } })
  stop()
  const last = lines.at(-1)!.top as Row[]
  expect(last.find(r => r.op === 'User.count')).toMatchObject({ shape: '{"role":"?"}', route: 'background', n: 1 })
  const after = lines.length
  await hooked.user.count()
  await new Promise(resolve => setTimeout(resolve, 120))
  expect(lines).toHaveLength(after)
})
