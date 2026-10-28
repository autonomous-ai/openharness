import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import { createMetrics, withQueryTiming } from '../src/lib/metrics.js'

// A fresh loopback replica set, created here. This suite never reads DATABASE_URL or an existing database.
let replica: MongoMemoryReplSet
let base: PrismaClient
let uri: string

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  uri = replica.getUri(`query_timing_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  base = new PrismaClient({ datasources: { db: { url: uri } } })
})
afterAll(async () => {
  await base?.$disconnect()
  await replica?.stop()
})

async function queryCounts(metrics: ReturnType<typeof createMetrics>) {
  return (await metrics.registry.metrics()).split('\n').filter(line => line.startsWith('prisma_query_duration_seconds_count'))
}

describe('Prisma query timing against a real database', () => {
  it('times model queries, raw commands and queries inside an interactive transaction', async () => {
    const metrics = createMetrics()
    const db = withQueryTiming(base, metrics)
    const id = randomUUID().replaceAll('-', '').slice(0, 24)
    await db.user.create({ data: { id, externalId: `fixture-${id}`, email: `${id}@example.com`, autonomousEnv: 'prod' } })
    await db.$transaction(async (tx) => {
      await tx.user.findUnique({ where: { id } })
      await tx.user.findUnique({ where: { id } })
    })
    await db.$runCommandRaw({ ping: 1 })

    expect((await queryCounts(metrics)).sort()).toEqual([
      'prisma_query_duration_seconds_count{model="User",operation="create"} 1',
      'prisma_query_duration_seconds_count{model="User",operation="findUnique"} 2',
      'prisma_query_duration_seconds_count{model="raw",operation="$runCommandRaw"} 1',
    ])
    // The timed client is the same database: what it wrote, the plain client reads.
    expect(await base.user.findUnique({ where: { id }, select: { email: true } })).toEqual({ email: `${id}@example.com` })
  })

  it('times the shared backend client, so every route\'s queries are measured', async () => {
    process.env.DATABASE_URL = uri
    vi.resetModules()
    const { prisma } = await import('../src/lib/prisma.js')
    const { metrics } = await import('../src/lib/metrics.js')
    await prisma.user.count()
    expect(await queryCounts(metrics)).toEqual(['prisma_query_duration_seconds_count{model="User",operation="count"} 1'])
    await prisma.$disconnect()
  })
})
