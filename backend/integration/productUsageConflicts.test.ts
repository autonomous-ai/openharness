import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'

// A fresh loopback replica set, created here; the app's own Prisma client is pointed at it before anything imports it.
// Production on 2026-10-28: about 190 usage reports a minute, every one adding to the same daily totals, and 1,000 of
// the CLI's 1,269 rejected reports that morning were write conflicts on them.
let replica: MongoMemoryReplSet
let db: PrismaClient
let usage: typeof import('../src/lib/productUsage.js')

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`product_usage_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  process.env.DATABASE_URL = uri
  vi.resetModules()
  db = (await import('../src/lib/prisma.js')).prisma
  usage = await import('../src/lib/productUsage.js')
}, 120000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

const now = new Date('2026-10-28T06:00:00Z')
const context = { surface: 'cli', release: '0.4.92', platform: 'macos', channel: 'production' } as const
const total = async (metric: string): Promise<number | undefined> =>
  (await db.productUsageTotal.findUnique({ where: { dayUtc_metric: { dayUtc: new Date('2026-10-28'), metric } } }))?.value

it('a fleet reporting at once is counted whole, with no report refused', async () => {
  const reports = Array.from({ length: 64 }, (_, i) => ({ schemaVersion: 1 as const, revision: 0, id: randomUUID(), day: '2026-10-28',
    context, counters: { health_cli_collector_days: 1, turns_started: 2, [`turns_ended`]: i % 2 } }))
  const answers = await Promise.allSettled(reports.map((report, i) => usage.ingestProductUsage(`6a00000000000000000${String(i).padStart(5, '0')}`, report, now)))
  expect(answers.filter(a => a.status === 'rejected').map(a => (a as PromiseRejectedResult).reason?.code)).toEqual([])
  expect(answers.map(a => (a as PromiseFulfilledResult<unknown>).value)).toEqual(reports.map(() => ({ accepted: true })))
  expect(await total('health_cli_collector_days')).toBe(64)
  expect(await total('turns_started')).toBe(128)
  expect(await total('turns_ended')).toBe(32)
  expect(await total('breakdown:release:cli:0.4.92:turns_started')).toBe(128)
  expect(await db.productUsageReceipt.count()).toBe(64)
}, 60000)

it('a report sent again after its answer was lost counts once', async () => {
  const report = { schemaVersion: 1 as const, revision: 0, id: randomUUID(), day: '2026-10-28', context, counters: { launch_unobserved: 3 } }
  const answers = await Promise.all([1, 2, 3].map(() => usage.ingestProductUsage('6a0000000000000000000b01', report, now)))
  expect(answers).toEqual([{ accepted: true }, { accepted: true }, { accepted: true }])
  expect(await usage.ingestProductUsage('6a0000000000000000000b01', report, now)).toEqual({ accepted: true })
  expect(await total('launch_unobserved')).toBe(3)
}, 60000)

it('four backend processes reporting at once still count every report', async () => {
  // Each import after a reset is another process's batch writer over the same database.
  const processes = [usage]
  for (let i = 1; i < 4; i++) { vi.resetModules(); processes.push(await import('../src/lib/productUsage.js')) }
  const sent = processes.flatMap((each, p) => Array.from({ length: 48 }, (_, i) => each.ingestProductUsage(
    `6a000000000000000000${String(p * 100 + i).padStart(4, '0')}`,
    { schemaVersion: 1, revision: 0, id: randomUUID(), day: '2026-10-28', context, counters: { queue_capped: 1 } }, now)))
  const answers = await Promise.allSettled(sent)
  expect(answers.filter(a => a.status === 'rejected').map(a => (a as PromiseRejectedResult).reason?.code)).toEqual([])
  expect(await total('queue_capped')).toBe(192)
}, 60000)
