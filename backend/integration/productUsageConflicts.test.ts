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

// Relay connects: counted in memory, written once a minute. Each import after a reset is another process.
const connectDay = new Date('2026-10-27')
const connectTotal = async (metric: string): Promise<number | undefined> =>
  (await db.productUsageTotal.findUnique({ where: { dayUtc_metric: { dayUtc: connectDay, metric } } }))?.value

it('connects from four processes at once, and the people who turned sharing off, total exactly the connects that were counted', async () => {
  const processes = [usage]
  for (let i = 1; i < 4; i++) { vi.resetModules(); processes.push(await import('../src/lib/productUsage.js')) }
  await usage.setProductUsageChoice('6a0000000000000000000f01', false)
  const receiptsBefore = await db.productUsageReceipt.count()
  await Promise.all(processes.map((each, p) => Promise.all(Array.from({ length: 150 }, (_, i) =>
    each.recordRelayUsage(i % 5 === 0 ? '6a0000000000000000000f01' : `6a00000000000000000${p}0${i % 7}`,
      new Date('2026-10-27T10:00:00Z'), 'relay_tui_opens', i % 2 ? ['relay_machine_connections'] : [])))))
  expect(await connectTotal('relay_tui_opens')).toBeUndefined()
  await Promise.all(processes.map(each => each.flushRelayUsage()))
  // 150 per process, minus every fifth (the person who is off): 120; the odd ones also add a machine connection.
  expect(await connectTotal('relay_tui_opens')).toBe(4 * 120)
  expect(await connectTotal('relay_machine_connections')).toBe(4 * 60)
  expect(await db.productUsageReceipt.count()).toBe(receiptsBefore + 4)
  expect(await db.productUsageTotal.count({ where: { dayUtc: connectDay } })).toBe(2)
}, 60000)

it('a flush whose answer was lost and is sent again counts once', async () => {
  vi.resetModules()
  const each = await import('../src/lib/productUsage.js')
  const before = await connectTotal('relay_remote_sessions')
  await each.recordRelayUsage('6a0000000000000000000e01', new Date('2026-10-27T11:00:00Z'), 'relay_remote_sessions')
  const real = db.$transaction.bind(db) as (fn: unknown, options?: unknown) => Promise<unknown>
  const spy = vi.spyOn(db, '$transaction').mockImplementationOnce(async (fn: unknown, options?: unknown) => {
    await real(fn, options)
    throw new Error('connection reset')
  })
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  await each.flushRelayUsage()
  await each.flushRelayUsage()
  await each.flushRelayUsage()
  spy.mockRestore(); warn.mockRestore()
  expect(await connectTotal('relay_remote_sessions')).toBe((before ?? 0) + 1)
}, 60000)

it('sharing turned off through one server stops the next connect on another server at once; turned back on, it counts again after a few seconds', async () => {
  const servers = []
  for (let i = 0; i < 2; i++) { vi.resetModules(); servers.push(await import('../src/lib/productUsage.js')) }
  const [one, other] = servers
  const person = '6a0000000000000000000d01'
  const day = new Date('2026-10-27T12:00:00Z')
  const counted = async (): Promise<number> => {
    await Promise.all(servers.map(each => each.flushRelayUsage()))
    return (await connectTotal('relay_desktop_opens')) ?? 0
  }
  const before = await counted()
  await one.recordRelayUsage(person, day, 'relay_desktop_opens')
  expect(await counted()).toBe(before + 1)
  await other.setProductUsageChoice(person, false)
  await one.recordRelayUsage(person, day, 'relay_desktop_opens')
  expect(await counted()).toBe(before + 1)
  // The off answer is kept by the server that read it; a change made through the other server is seen after the TTL.
  await other.setProductUsageChoice(person, true)
  await one.recordRelayUsage(person, day, 'relay_desktop_opens')
  expect(await counted()).toBe(before + 1)
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 6_000)
  await one.recordRelayUsage(person, day, 'relay_desktop_opens')
  clock.mockRestore()
  expect(await counted()).toBe(before + 2)
}, 60000)
