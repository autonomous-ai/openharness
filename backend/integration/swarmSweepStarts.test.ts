import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { RETENTION_MS } from '../src/superTabs/parts/types.js'
import { sweepSwarms } from '../src/superTabs/sweeps.js'

// The hourly sweep removes finished starts 7 days on (sweeps.ts expireStarts). Until 2026-10-29 it also removed every start
// that had not finished: Prisma sent `finishedAt: { lt }` as $expr, where a null finish time is less than any date. A fresh
// loopback replica set; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
const NOW = Date.parse('2026-10-29T08:00:00Z')
const DAY = 86_400_000
const maker: AuthUser = { sub: randomUUID().replaceAll('-', '').slice(0, 24), email: 'starter@example.com', autonomousEnv: 'prod', role: 'user' }
let tabId: string

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_sweep_starts_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  await db.user.create({ data: { id: maker.sub, externalId: `fixture-${maker.sub}`, email: maker.email, autonomousEnv: 'prod' } })
  tabId = (await new SuperTabStore(db, () => NOW).create(maker, randomUUID(), 'Starts')).id
  const start = (key: string, finishedAt: Date | null) => ({ id: `${tabId}:${key}`, tabId, key, version: 1, changedAt: new Date(NOW - 30 * DAY), ordinal: 1,
    data: { id: key }, machineId: 'm', conversationId: 'c', agentId: null, deleted: false, finishedAt })
  await db.swarmStart.createMany({ data: [
    start('expired', new Date(NOW - RETENTION_MS - DAY)),
    start('recent', new Date(NOW - DAY)),
    // Still starting, as parts/write.ts stores it: no finish time yet. Old enough that only its finish time keeps it.
    ...Array.from({ length: 3 }, (_, i) => start(`running-${i}`, null)),
  ] })
  // One stored before the finish time was extracted lacks the field.
  await db.$runCommandRaw({ insert: 'SwarmStart', documents: [{ _id: `${tabId}:legacy`, tabId, key: 'legacy', version: 1,
    changedAt: { $date: new Date(NOW - 30 * DAY).toISOString() }, ordinal: 1, data: { id: 'legacy' }, machineId: 'm', conversationId: 'c', deleted: false }] })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

it('removes only starts that finished more than 7 days ago, never one still starting', async () => {
  const result = await sweepSwarms(db, NOW)
  expect(result.startsExpired).toBe(1)
  const rows = await db.swarmStart.findMany({ where: { tabId }, select: { key: true, deleted: true }, orderBy: { key: 'asc' } })
  expect(rows.filter(r => r.deleted).map(r => r.key)).toEqual(['expired'])
  expect(rows.filter(r => !r.deleted).map(r => r.key)).toEqual(['legacy', 'recent', 'running-0', 'running-1', 'running-2'])
})
