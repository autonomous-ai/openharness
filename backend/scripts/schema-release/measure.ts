/**
 * What a release's schema step does to Swarm reads, on a local Mongo only (a loopback replica set created here; it never reads
 * DATABASE_URL). Each scenario starts from a database shaped like production before the release: `--from` pushed and every
 * expiry index made by hand, as the worker always has, with `--groups` Swarm groups and `--starts` starts. While the step
 * runs, `--readers` loops read groups and starts in transactions, as a Swarm read does on a cache miss; Mongo lets a
 * transaction wait at most 5 ms for a lock. Reports each scenario's reads, failures and latency, and every index change with
 * the exclusive lock it took.
 *
 *   NODE_ENV=test HARNESS_CREDENTIAL_ENCRYPTION_KEY=<any 32-byte base64> DATABASE_URL=mongodb://127.0.0.1:1/unused \
 *     npx tsx scripts/schema-release/measure.ts --from OLD.prisma --to NEW.prisma [--groups 50000] [--starts 50000] [--readers 16] \
 *     [--retry] [--lock-wait-ms N] [--out REPORT.md]
 *
 * The environment only satisfies the backend's config check. `--retry`: reads retry transient failures as the store's
 * transaction() does. `--lock-wait-ms`: how long Mongo lets a transaction wait for a lock (its default is 5).
 *
 * Scenarios: the step as it was (db push of --to without the expiry indexes, then every expiry index built again), this
 * step's first release (--to with them declared), and the release after it with nothing changed.
 */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { parseArgs } from 'node:util'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import { ensureSchema } from '../../src/lib/db/migrate.js'
import { releaseSchema } from '../../src/lib/db/schemaRelease.js'

const { values } = parseArgs({ options: { from: { type: 'string' }, to: { type: 'string' }, groups: { type: 'string', default: '50000' },
  starts: { type: 'string', default: '50000' }, readers: { type: 'string', default: '16' }, swarms: { type: 'string', default: '200' },
  retry: { type: 'boolean', default: false }, 'lock-wait-ms': { type: 'string' }, out: { type: 'string' } } })
if (!values.from || !values.to) throw new Error('--from and --to name the schemas before and after the release')
const GROUPS = Number(values.groups), STARTS = Number(values.starts), READERS = Number(values.readers), SWARMS = Number(values.swarms)
const DAY = 86_400

/** The worker's hand-made indexes, as it made them before this change. */
const HAND_MADE: Array<[string, Record<string, unknown>]> = [
  ['product_usage_preferences', { key: { userId: 1 }, name: 'product_usage_preferences_userId_key', unique: true }],
  ['product_usage_totals', { key: { dayUtc: 1, metric: 1 }, name: 'product_usage_totals_dayUtc_metric_key', unique: true }],
  ['product_usage_receipts', { key: { expiresAt: 1 }, name: 'product_usage_expiry', expireAfterSeconds: 0 }],
  ['product_usage_totals', { key: { dayUtc: 1 }, name: 'product_usage_expiry', expireAfterSeconds: 396 * DAY }],
  ...['user_daily_presence', 'user_daily_client_presence', 'user_daily_remote_usage', 'user_daily_device_presence', 'machine_daily_presence',
    'agent_daily_presence', 'analytics_daily_buckets', 'analytics_daily_machines']
    .map(c => [c, { key: { dayUtc: 1 }, name: 'product_usage_expiry', expireAfterSeconds: 35 * DAY }] as [string, Record<string, unknown>]),
  ['product_usage_activity', { key: { expiresAt: 1 }, name: 'product_usage_expiry', expireAfterSeconds: 0 }],
  ['product_usage_activity', { key: { subject: 1, dayUtc: 1 }, name: 'product_usage_activity_subject_dayUtc_key', unique: true }],
  ['harness_sessions', { key: { expiresAt: 1 }, name: 'harness_session_expiry', expireAfterSeconds: 30 * DAY }],
  ['SuperTabTerminalRequest', { key: { createdAt: 1 }, name: 'terminal_request_expiry', expireAfterSeconds: 120 }],
  ['SuperTabMention', { key: { createdAt: 1 }, name: 'mention_expiry', expireAfterSeconds: 30 * DAY }],
  ...['SwarmHead', 'SwarmGroup', 'SwarmStart', 'SwarmProgress'].map(c => [c, { key: { purgeAt: 1 }, name: 'part_purge', expireAfterSeconds: 0 }] as [string, Record<string, unknown>]),
  ...['SwarmWorkspace', 'SwarmWorkspaceMember', 'SwarmWorkspaceRemoval']
    .map(c => [c, { key: { purgeAt: 1 }, name: 'workspace_purge', expireAfterSeconds: 0 }] as [string, Record<string, unknown>]),
  ['SwarmWorkspaceInvitation', { key: { expiresAt: 1 }, name: 'workspace_invitation_expiry', expireAfterSeconds: 0 }],
]

async function buildHandMade(db: PrismaClient): Promise<void> {
  for (const [collection, index] of HAND_MADE) await db.$runCommandRaw({ createIndexes: collection, indexes: [index as never] })
}

/** The step before this change: push, then build every hand-made index again (the push has just dropped them). */
async function oldStep(db: PrismaClient, schema: string, databaseUrl: string): Promise<void> {
  await ensureSchema({ schema, databaseUrl })
  await buildHandMade(db)
}

const payload = 'x'.repeat(1200)
async function seed(db: PrismaClient): Promise<void> {
  const at = new Date('2026-10-28T08:00:00Z')
  for (let i = 0; i < GROUPS; i += 5000) {
    const rows = Array.from({ length: Math.min(5000, GROUPS - i) }, (_, j) => {
      const n = i + j, tabId = `tab-${n % SWARMS}`
      return { _id: `${tabId}:g${n}`, tabId, key: `g${n}`, version: 1, changedAt: { $date: at.toISOString() }, deleted: false, ordinal: n, projectId: `p${n % 7}`,
        kind: null, archived: false, dormant: n % 3 === 0, agentIds: [`a${n % 50}`], messageSeq: n % 100, reportSeq: 0, workFinished: n % 2 === 0,
        lastActivityAt: { $date: new Date(at.getTime() - n * 1000).toISOString() }, hostMachineIds: [], data: { title: `Group ${n}`, brief: payload } }
    })
    await db.$runCommandRaw({ insert: 'SwarmGroup', documents: rows as never })
  }
  for (let i = 0; i < STARTS; i += 5000) {
    const rows = Array.from({ length: Math.min(5000, STARTS - i) }, (_, j) => {
      const n = i + j, tabId = `tab-${n % SWARMS}`
      return { _id: `${tabId}:s${n}`, tabId, key: `s${n}`, version: 1, changedAt: { $date: at.toISOString() }, deleted: false, ordinal: n,
        machineId: `m${n % 20}`, agentId: `a${n % 50}`, data: { request: payload } }
    })
    await db.$runCommandRaw({ insert: 'SwarmStart', documents: rows as never })
  }
}

interface Reads { ok: number; failed: Record<string, number>; latencies: number[] }
/** Swarm reads on a cache miss: one transaction reads a Swarm's groups and starts. */
function startReaders(db: PrismaClient): { stop(): Promise<Reads> } {
  const reads: Reads = { ok: 0, failed: {}, latencies: [] }
  let running = true
  const loops = Array.from({ length: READERS }, async (_, reader) => {
    for (let n = 0; running; n++) {
      const tabId = `tab-${(reader * 31 + n) % SWARMS}`, began = performance.now()
      try {
        // With --retry, as the store's transaction() does: a transient failure is tried again, up to 8 times, after a jittered backoff.
        for (let attempt = 1; ; attempt++) {
          try {
            await db.$transaction(async tx => {
              await tx.swarmGroup.findMany({ where: { tabId, dormant: false }, select: { id: true, version: true }, take: 200 })
              await tx.swarmStart.findMany({ where: { tabId }, select: { id: true, version: true }, take: 200 })
            })
            break
          } catch (error) {
            if (!values.retry || attempt >= 8 || !String((error as Error).message).includes('TransientTransactionError')) throw error
            await new Promise(resolve => setTimeout(resolve, Math.random() * Math.min(1000, 50 * 2 ** (attempt - 1))))
          }
        }
        reads.ok++
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error)
        const kind = /LockTimeout|Unable to acquire/i.test(text) ? 'lock timeout' : text.split('\n').find(line => line.trim())?.slice(0, 120) ?? 'unknown'
        reads.failed[kind] = (reads.failed[kind] ?? 0) + 1
      }
      reads.latencies.push(performance.now() - began)
    }
  })
  return { async stop() { running = false; await Promise.all(loops); return reads } }
}

const percentile = (sorted: number[], p: number) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] : 0

const INDEX_CHANGES = { $or: [{ 'command.createIndexes': { $exists: true } }, { 'command.dropIndexes': { $exists: true } }, { 'command.collMod': { $exists: true } }] }
type Profiled = { command?: Record<string, unknown>; millis?: number; errCode?: number; locks?: Record<string, { acquireCount?: Record<string, number>; timeAcquiringMicros?: Record<string, number> }> }
async function indexChanges(db: PrismaClient): Promise<string[]> {
  const answer = await db.$runCommandRaw({ find: 'system.profile', filter: INDEX_CHANGES, batchSize: 10_000, singleBatch: true }) as { cursor: { firstBatch: Profiled[] } }
  return answer.cursor.firstBatch.filter(entry => entry.errCode === undefined).map(entry => {
    const command = entry.command!, name = Object.keys(command)[0]
    const index = name === 'createIndexes' ? (command.indexes as Array<{ name: string }>).map(i => i.name).join(',') : name === 'dropIndexes' ? command.index : (command.index as { name?: string })?.name
    const exclusive = entry.locks?.Collection?.acquireCount?.W ? `, exclusive lock, waited ${((entry.locks.Collection.timeAcquiringMicros?.W ?? 0) / 1000).toFixed(1)} ms for it` : ''
    return `${name} ${command[name]} ${index}: ${entry.millis} ms${exclusive}`
  })
}

async function scenario(replica: MongoMemoryReplSet, label: string, from: string, step: (db: PrismaClient, databaseUrl: string) => Promise<void>,
  before?: (db: PrismaClient, databaseUrl: string) => Promise<void>) {
  const databaseUrl = replica.getUri(`schema_release_measure_${randomUUID().replaceAll('-', '_')}`)
  const db = new PrismaClient({ datasources: { db: { url: databaseUrl } } })
  await ensureSchema({ schema: from, databaseUrl })
  await buildHandMade(db)
  await seed(db)
  if (before) await before(db, databaseUrl)
  // Only index changes: Prisma's reads are commands too, and would push them out of the profiler's capped collection.
  await db.$runCommandRaw({ profile: 1, filter: INDEX_CHANGES })
  const readers = startReaders(db)
  await new Promise(resolve => setTimeout(resolve, 2000))
  const began = performance.now()
  await step(db, databaseUrl)
  const took = performance.now() - began
  await new Promise(resolve => setTimeout(resolve, 1000))
  const reads = await readers.stop()
  await db.$runCommandRaw({ profile: 0 })
  const changes = await indexChanges(db)
  const sorted = [...reads.latencies].sort((a, b) => a - b)
  await db.$disconnect()
  return [`## ${label}`, '', `Step: ${(took / 1000).toFixed(1)} s. Reads: ${reads.ok} ok, ${Object.values(reads.failed).reduce((a, b) => a + b, 0)} failed` +
    `${Object.keys(reads.failed).length ? ` (${Object.entries(reads.failed).map(([k, v]) => `${v} ${k}`).join('; ')})` : ''}. ` +
    `Latency p50 ${percentile(sorted, 0.5).toFixed(1)} ms, p99 ${percentile(sorted, 0.99).toFixed(1)} ms, max ${(sorted.at(-1) ?? 0).toFixed(1)} ms.`, '',
    `Index changes (${changes.length}):`, ...changes.map(c => `- ${c}`), ''].join('\n')
}

const folder = await mkdtemp(join(tmpdir(), 'schema-release-measure-'))
const replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
  instanceOpts: [{ launchTimeout: 60_000 }], replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
const LOCK_WAIT_MS = values['lock-wait-ms'] === undefined ? null : Number(values['lock-wait-ms'])
if (LOCK_WAIT_MS !== null) {
  const admin = new PrismaClient({ datasources: { db: { url: replica.getUri('admin') } } })
  await admin.$runCommandRaw({ setParameter: 1, maxTransactionLockRequestTimeoutMillis: LOCK_WAIT_MS })
  await admin.$disconnect()
}
try {
  // The step as it was carries the schema without the declared expiry indexes, as the code before this change did.
  const undeclared = join(folder, 'undeclared.prisma')
  const declared = /^ *\/\/\/[^\n]*Declared so db push keeps[^\n]*\n *@@index\(\[\w+\], map: "\w+"\)\n/gm
  const target = await readFile(values.to, 'utf8')
  if ((target.match(declared) ?? []).length !== 22) throw new Error(`--to declares ${(target.match(declared) ?? []).length} expiry indexes, not 22`)
  await writeFile(undeclared, target.replace(declared, ''))
  const reports = [
    `# Schema step under Swarm reads: ${GROUPS} groups, ${STARTS} starts in ${SWARMS} Swarms, ${READERS} readers` +
      `${values.retry ? ', reads retry transient failures' : ''}, transactions wait ${LOCK_WAIT_MS ?? 5} ms for a lock`, '',
    await scenario(replica, 'Before this change: a release carrying the new indexes', values.from, (db, url) => oldStep(db, undeclared, url)),
    await scenario(replica, 'This change, first release: the new indexes, expiry indexes declared', values.from, (db, url) => releaseSchema(db, { schema: values.to, databaseUrl: url })),
    await scenario(replica, 'This change, next release with nothing changed', values.from, (db, url) => releaseSchema(db, { schema: values.to, databaseUrl: url }),
      (db, url) => releaseSchema(db, { schema: values.to, databaseUrl: url })),
  ]
  // Prisma's own output goes to stdout as it pushes; --out keeps the report apart from it.
  if (values.out) await writeFile(values.out, reports.join('\n'))
  else process.stdout.write(reports.join('\n'))
} finally {
  await replica.stop()
  await rm(folder, { recursive: true, force: true })
}
