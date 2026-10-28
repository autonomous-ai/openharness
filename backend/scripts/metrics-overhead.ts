/**
 * What the metrics cost: per request (the onResponse histogram) and per query (the Prisma timing
 * extension, against a throwaway local replica set). Plain and measured alternate so drift in the
 * machine hits both alike; the median of each is reported.
 *
 *   npx tsx scripts/metrics-overhead.ts
 */
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import Fastify from 'fastify'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import { createMetrics, registerRequestMetrics, withQueryTiming } from '../src/lib/metrics.js'

const ROUNDS = 7
const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

async function microsPerCall(times: number, call: () => Promise<unknown>): Promise<number> {
  const started = performance.now()
  for (let i = 0; i < times; i++) await call()
  return ((performance.now() - started) * 1000) / times
}

async function requestApp(measured: boolean) {
  const app = Fastify()
  if (measured) registerRequestMetrics(app, createMetrics())
  app.get('/api/super-tabs/:tabId/changes', async () => ({ ok: true }))
  await app.ready()
  return app
}

async function requests() {
  const plain = await requestApp(false)
  const measured = await requestApp(true)
  const get = (app: typeof plain) => () => app.inject({ method: 'GET', url: '/api/super-tabs/c51479bd73b59e58176ad9e4/changes?since=1' })
  await microsPerCall(5_000, get(plain))
  await microsPerCall(5_000, get(measured))
  const [a, b]: number[][] = [[], []]
  for (let round = 0; round < ROUNDS; round++) {
    a.push(await microsPerCall(20_000, get(plain)))
    b.push(await microsPerCall(20_000, get(measured)))
  }
  await plain.close()
  await measured.close()
  return { plain: median(a), measured: median(b) }
}

async function queries() {
  const replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`metrics_overhead_${randomUUID().replaceAll('-', '_')}`)
  try {
    await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], { env: { ...process.env, DATABASE_URL: uri }, timeout: 60000 })
    const base = new PrismaClient({ datasources: { db: { url: uri } } })
    const timed = withQueryTiming(base, createMetrics())
    const id = randomUUID().replaceAll('-', '').slice(0, 24)
    await base.user.create({ data: { id, externalId: `bench-${id}`, email: `${id}@example.com`, autonomousEnv: 'prod' } })
    const find = (db: PrismaClient) => () => db.user.findUnique({ where: { id } })
    await microsPerCall(500, find(base))
    await microsPerCall(500, find(timed))
    // Database latency varies more than the extension costs, so alternate call by call and compare the
    // medians of single calls rather than of batches.
    const [a, b]: number[][] = [[], []]
    for (let i = 0; i < 10_000; i++) {
      a.push(await microsPerCall(1, find(base)))
      b.push(await microsPerCall(1, find(timed)))
    }
    await base.$disconnect()
    return { plain: median(a), measured: median(b) }
  } finally {
    await replica.stop()
  }
}

const line = (what: string, { plain, measured }: { plain: number; measured: number }) =>
  `${what}: ${plain.toFixed(1)} µs plain, ${measured.toFixed(1)} µs measured, +${(measured - plain).toFixed(1)} µs (${(((measured - plain) / plain) * 100).toFixed(1)}%)`

const r = await requests()
process.stdout.write(`${line('request (Fastify inject, one route)', r)}\n`)
const q = await queries()
process.stdout.write(`${line('query (findUnique, local replica set)', q)}\n`)
