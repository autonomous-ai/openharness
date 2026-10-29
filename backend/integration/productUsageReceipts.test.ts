import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'

// A fresh loopback replica set, created here; nothing reads an existing database. Receipts lived 36 days until 2026-10-29
// (about 4M of them in production) and live 4 now. Here the shorter life was released on 30 October and the clock reads
// 2 November, 03:00 UTC: every receipt below is seeded by this file.
let replica: MongoMemoryReplSet
let db: PrismaClient
let usage: typeof import('../src/lib/productUsage.js')
let sweep: typeof import('../src/lib/productUsageReceiptSweep.js')

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`product_usage_receipts_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  process.env.DATABASE_URL = uri
  vi.resetModules()
  db = (await import('../src/lib/prisma.js')).prisma
  usage = await import('../src/lib/productUsage.js')
  sweep = await import('../src/lib/productUsageReceiptSweep.js')
}, 120000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

const DAY = 86_400_000
const now = new Date('2026-11-02T03:00:00Z')
const at = (day: string, days: number) => new Date(Date.parse(day) + days * DAY)
/** Every UTC day from [first] to [last], both included. */
const days = (first: string, last: string) => Array.from({ length: (Date.parse(last) - Date.parse(first)) / DAY + 1 },
  (_, i) => at(first, i).toISOString().slice(0, 10))
const ids = (style: string, day: string) => [0, 1, 2].map(n => `${style}-${day}-${n}`)

// Three receipts a report day. Old servers wrote day + 36 up to the release (30 October included), new ones day + 4.
const OLD_DAYS = days('2026-09-28', '2026-10-30')
const NEW_DAYS = days('2026-10-30', '2026-11-02')
// The sweep removes the old receipts whose 4-day life is over (report days 3 to 29 October), apart from those Mongo's expiry
// removes within 5 days anyway (day + 36 up to 7 November). The 30th's new life ends on 3 November, after this clock.
const KEPT = [...days('2026-09-28', '2026-10-02'), '2026-10-30'].flatMap(day => ids('old', day))
  .concat(NEW_DAYS.flatMap(day => ids('new', day)), ['expired-old-2026-09-25'])
const TOTALS = [{ dayUtc: new Date('2026-10-20'), metric: 'turns_started', value: 41 }, { dayUtc: new Date('2026-11-01'), metric: 'turns_started', value: 7 }]

beforeEach(async () => {
  await db.productUsageReceipt.deleteMany()
  await db.productUsageTotal.deleteMany()
  await db.productUsageReceipt.createMany({ data: [
    ...OLD_DAYS.flatMap(day => ids('old', day).map(id => ({ id, expiresAt: at(day, 36) }))),
    ...NEW_DAYS.flatMap(day => ids('new', day).map(id => ({ id, expiresAt: at(day, 4) }))),
    // Expired already (1 November); Mongo's expiry removes it, not the cleanup.
    { id: 'expired-old-2026-09-25', expiresAt: at('2026-09-25', 36) },
  ] })
  await db.productUsageTotal.createMany({ data: TOTALS })
})

const pass = (at = now) => sweep.sweepOldReceipts(db, at, { chunk: 10, chunks: 4, pauseMs: 30 })
const left = async () => (await db.productUsageReceipt.findMany({ select: { id: true } })).map(r => r.id).sort()
const totals = async () => db.productUsageTotal.findMany({ select: { dayUtc: true, metric: true, value: true }, orderBy: { dayUtc: 'asc' } })

it('removes only old receipts outside the new life, a few chunks a pass with a pause, then nothing', async () => {
  const started = performance.now()
  expect(await pass()).toEqual({ removed: 40, waiting: false, done: false })
  expect(performance.now() - started).toBeGreaterThanOrEqual(3 * 30)
  expect(await pass()).toEqual({ removed: 40, waiting: false, done: false })
  expect(await pass()).toEqual({ removed: 1, waiting: false, done: false })
  expect(await left()).toEqual(KEPT.sort())
  // The 30 October's old receipts are still inside their new life (to 3 November): kept, and the sweep goes on.
  expect(await pass()).toEqual({ removed: 0, waiting: false, done: false })
  const later = new Date('2026-11-03T03:00:00Z')
  expect(await pass(later)).toEqual({ removed: 3, waiting: false, done: true })
  expect(await pass(later)).toEqual({ removed: 0, waiting: false, done: true })
  expect(await left()).toEqual(KEPT.filter(id => !id.startsWith('old-2026-10-30')).sort())
  expect(await totals()).toEqual(TOTALS)
})

it('sends commands to the receipts collection only', async () => {
  await db.$runCommandRaw({ profile: 2 })
  const since = new Date()
  expect(await pass()).toMatchObject({ removed: 40 })
  await db.$runCommandRaw({ profile: 0 })
  const answer = await db.$runCommandRaw({ find: 'system.profile', filter: { ts: { $gt: { $date: since.toISOString() } } },
    projection: { ns: 1 }, batchSize: 100_000, singleBatch: true }) as { cursor: { firstBatch: Array<{ ns: string }> } }
  const collections = new Set(answer.cursor.firstBatch.map(entry => entry.ns.split('.').slice(1).join('.')))
  expect([...collections].filter(name => name !== 'system.profile' && name !== '$cmd')).toEqual(['product_usage_receipts'])
})

it('waits while a server still writes 36-day receipts', async () => {
  await db.productUsageReceipt.create({ data: { id: 'old-2026-11-02-0', expiresAt: at('2026-11-02', 36) } })
  expect(await pass()).toEqual({ removed: 0, waiting: true, done: false })
  expect((await left()).length).toBe(113)
  // The next UTC day, every server writes 4-day receipts.
  expect(await pass(new Date('2026-11-03T00:01:00Z'))).toMatchObject({ removed: 40, waiting: false })
})

it('two workers at once (a rolling deploy) still remove each receipt once and nothing else', async () => {
  const passes = await Promise.all([pass(), pass(), pass()])
  expect(passes.every(p => !p.waiting)).toBe(true)
  while ((await pass()).removed) { /* the rest */ }
  expect(await left()).toEqual(KEPT.sort())
  expect(await totals()).toEqual(TOTALS)
})

it('the worker\'s sweep runs a pass a minute and stops by itself once nothing is left', async () => {
  const lines: string[] = []
  const log = { info: (message: string) => lines.push(message), warn: (message: string) => lines.push(message) }
  await db.productUsageReceipt.deleteMany({ where: { id: { startsWith: 'old-2026-10-30' } } })
  const stop = sweep.startReceiptSweep(db, { everyMs: 20, chunk: 50, chunks: 1, pauseMs: 0, now: () => now, log })
  try {
    await vi.waitFor(() => expect(lines.at(-1)).toMatch(/done/), { timeout: 5000 })
    const settled = lines.length
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(lines.length).toBe(settled)
  } finally { stop() }
  expect(lines.filter(line => line.includes('pass'))).toHaveLength(2)
  expect(await left()).toEqual(KEPT.filter(id => !id.startsWith('old-2026-10-30')).sort())
})

it('a failed pass is logged and the next minute\'s pass carries on', async () => {
  const lines: string[] = []
  const log = { info: (message: string) => lines.push(message), warn: (message: string) => lines.push(message) }
  await db.productUsageReceipt.deleteMany({ where: { id: { startsWith: 'old-2026-10-30' } } })
  let calls = 0
  // The database refuses the first command only, as a lost connection or a primary stepping down would.
  const flaky = new Proxy(db, { get: (target, key) => key === '$runCommandRaw'
    ? (command: never) => calls++ ? target.$runCommandRaw(command) : Promise.reject(new Error('connection closed'))
    : Reflect.get(target, key) })
  const stop = sweep.startReceiptSweep(flaky, { everyMs: 20, chunk: 100, chunks: 1, pauseMs: 0, now: () => now, log })
  try {
    await vi.waitFor(() => expect(lines.at(-1)).toMatch(/done/), { timeout: 5000 })
  } finally { stop() }
  expect(lines[0]).toMatch(/pass failed; retrying next minute/)
  expect(await left()).toEqual(KEPT.filter(id => !id.startsWith('old-2026-10-30')).sort())
})

it('counting stays exact: a report inside the window counts once across the sweep, an older one adds nothing', async () => {
  const context = { surface: 'cli', release: '0.4.92', platform: 'macos', channel: 'production' } as const
  const report = { schemaVersion: 1 as const, revision: 0, id: randomUUID(), day: '2026-11-01', context, counters: { turns_ended: 2 } }
  const turnsEnded = async () => (await db.productUsageTotal.findUnique({ where: { dayUtc_metric: { dayUtc: new Date('2026-11-01'), metric: 'turns_ended' } } }))?.value
  expect(await usage.ingestProductUsage('6a0000000000000000000c01', report, now)).toEqual({ accepted: true })
  expect(await db.productUsageReceipt.findUnique({ where: { id: report.id } })).toEqual({ id: report.id, expiresAt: new Date('2026-11-05') })
  while ((await pass()).removed) { /* every old receipt outside the new life */ }
  expect(await usage.ingestProductUsage('6a0000000000000000000c01', report, now)).toEqual({ accepted: true })
  expect(await turnsEnded()).toBe(2)

  const late = { ...report, id: randomUUID(), day: '2026-10-30' }
  expect(await usage.ingestProductUsage('6a0000000000000000000c01', late, now)).toEqual({ accepted: false, reason: 'EXPIRED' })
  expect(await db.productUsageReceipt.findUnique({ where: { id: late.id } })).toBeNull()
  expect(await db.productUsageTotal.findMany({ where: { dayUtc: new Date('2026-10-30') } })).toEqual([])
}, 60000)
