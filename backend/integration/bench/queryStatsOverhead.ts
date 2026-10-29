import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { PrismaClient } from '@prisma/client'
import { POOL_DEFAULTS, withPoolDefaults } from '../../src/lib/databaseUrl.js'
import { createQueryStats, runWork, startQueryStats, withQueryStats } from '../../src/lib/queryStats.js'
import { localDatabase } from './mongo.js'
import { percentile } from './metrics.js'

/**
 * What the query hook (src/lib/queryStats.ts) costs, for the DB roadmap Phase 1 PR. Each round runs the same load in two
 * fresh processes against one loopback replica set: `plain`, the client as it was, and `hook`, the client with the hook,
 * its per-minute stats running, and every iteration named as a request (which turns on Node's async context tracking for
 * the whole process, as the server does). Processes alternate, so drift on a busy machine hits both alike.
 *
 *   npx tsx integration/bench/queryStatsOverhead.ts [--rounds 5] [--iterations 600] [--concurrency 8]
 *
 * Never reads DATABASE_URL or any existing database.
 */

type Result = { mode: string; queries: number; cpuUsPerQuery: number; wallMs: number; perSecond: number; listP50Ms: number; listP95Ms: number }

const arg = (name: string, fallback: number) => {
  const at = process.argv.indexOf(`--${name}`)
  return at >= 0 ? Number(process.argv[at + 1]) : fallback
}

const PEOPLE = 40
const email = (i: number) => `bench-${i}@example.invalid`

async function child(mode: 'plain' | 'hook', uri: string, iterations: number, concurrency: number): Promise<void> {
  const base = new PrismaClient({ datasources: { db: { url: withPoolDefaults(uri, POOL_DEFAULTS) } } })
  const db = mode === 'hook' ? withQueryStats(base) : base
  const stop = mode === 'hook' ? startQueryStats({ reportMs: 3_600_000, log: () => {}, warn: () => {} }) : () => {}
  const named = <T>(fn: () => Promise<T>) => mode === 'hook' ? runWork('http GET /bench', fn) : fn()
  const listMs: number[] = []
  // One iteration is a request's worth of reads: one person by a unique key, a page of 20 whole documents, a count.
  const iteration = (i: number) => named(async () => {
    await db.user.findUnique({ where: { email: email(i % PEOPLE) } })
    const started = performance.now()
    await db.user.findMany({ where: { autonomousEnv: 'prod' }, take: 20 })
    listMs.push(performance.now() - started)
    await db.user.count({ where: { role: 'user' } })
  })
  const load = async (n: number) => {
    let next = 0
    await Promise.all(Array.from({ length: concurrency }, async () => { while (next < n) await iteration(next++) }))
  }
  await load(200)
  listMs.length = 0
  const cpu = process.cpuUsage(), wall = performance.now()
  await load(iterations)
  const used = process.cpuUsage(cpu), wallMs = performance.now() - wall
  stop()
  await base.$disconnect()
  const queries = iterations * 3
  const result: Result = { mode, queries, cpuUsPerQuery: (used.user + used.system) / queries, wallMs, perSecond: queries / (wallMs / 1000),
    listP50Ms: percentile(listMs, 50)!, listP95Ms: percentile(listMs, 95)! }
  console.log(JSON.stringify(result))
}

/** The bookkeeping alone, in this process: what one record costs without any database. */
function recordCost(): number {
  const stats = createQueryStats({ log: () => {}, warn: () => {} })
  const rows = Array.from({ length: 20 }, (_, i) => ({ id: `id-${i}`, email: email(i), name: 'x'.repeat(2000), role: 'user' }))
  const args = { where: { autonomousEnv: 'prod', OR: [{ role: 'user' }, { email: { in: ['a', 'b'] } }] }, take: 20 }
  const n = 200_000
  const started = performance.now()
  for (let i = 0; i < n; i++) stats.record('User', 'findMany', args, 1, rows)
  return (performance.now() - started) * 1000 / n
}

async function main(): Promise<void> {
  const rounds = arg('rounds', 5), iterations = arg('iterations', 600), concurrency = arg('concurrency', 8)
  const local = await localDatabase()
  try {
    // Documents about the size of a Swarm row, so a page is ~40 KB and the sampled serialization has real work to do.
    await local.db.user.createMany({ data: Array.from({ length: PEOPLE }, (_, i) => ({ email: email(i), externalId: `bench-${i}`, autonomousEnv: 'prod',
      name: 'x'.repeat(2000) })) })
    const results: Result[] = []
    for (let round = 0; round < rounds; round++) {
      for (const mode of round % 2 ? ['hook', 'plain'] : ['plain', 'hook']) {
        const { stdout } = await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/tsx'),
          [process.argv[1]!, '--child', mode, '--uri', local.uri, '--iterations', String(iterations), '--concurrency', String(concurrency)],
          { env: { ...process.env, DATABASE_URL: 'mongodb://127.0.0.1:1/never-used' }, maxBuffer: 1 << 20 })
        results.push(JSON.parse(stdout.trim().split('\n').at(-1)!) as Result)
      }
    }
    const median = (mode: string, key: keyof Result) => percentile(results.filter(r => r.mode === mode).map(r => r[key] as number), 50)!
    const keys = ['cpuUsPerQuery', 'perSecond', 'listP50Ms', 'listP95Ms'] as const
    const table = keys.map(key => {
      const plain = median('plain', key), hook = median('hook', key)
      return `| ${key} | ${plain.toFixed(1)} | ${hook.toFixed(1)} | ${((hook / plain - 1) * 100).toFixed(1)}% |`
    })
    console.log([`Rounds: ${rounds}, ${iterations} iterations × 3 queries, concurrency ${concurrency}, medians.`, '',
      '| Metric | Plain | Hook | Change |', '|---|---|---|---|', ...table, '',
      `Bookkeeping alone (shape, totals, every 8th result serialized; 20 rows of 2 KB): ${recordCost().toFixed(2)} µs a query.`,
      '', 'Rounds:', ...results.map(r => JSON.stringify(r))].join('\n'))
  } finally {
    await local.stop()
  }
}

if (process.argv.includes('--child')) {
  const at = process.argv.indexOf('--child')
  await child(process.argv[at + 1] as 'plain' | 'hook', process.argv[process.argv.indexOf('--uri') + 1]!, arg('iterations', 600), arg('concurrency', 8))
} else {
  await main()
}
