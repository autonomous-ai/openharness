import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'

/** One `system.profile` document, with only the fields these checks read. */
export interface ProfileEntry {
  op: string
  ns: string
  command?: Record<string, unknown>
  planSummary?: string
  docsExamined?: number
  keysExamined?: number
  nreturned?: number
  /** The bytes of the operation's reply to the backend. */
  responseLength?: number
  millis: number
}

/** A filter with every value replaced by `?` and its fields sorted: queries that differ only in their values share it. Field
 *  paths inside `$expr` (Prisma's filters, `{ $eq: ['$tabId', value] }`) stay, and a list of values is one `?`. */
export function queryShape(filter: unknown): string {
  const shape = (value: unknown): unknown => {
    if (typeof value === 'string' && value.startsWith('$')) return value
    if (Array.isArray(value)) {
      const items = value.map(shape)
      return items.length && items.some(item => item !== '?') ? items : '?'
    }
    if (!value || typeof value !== 'object') return '?'
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, shape((value as Record<string, unknown>)[key])]))
  }
  return JSON.stringify(shape(filter))
}

/** A `system.profile` aggregation that keeps of each operation only what `ProfileEntry` reads: its filter (a find's, an update's,
 *  or the first `$match` of a pipeline, as `match`) and never its whole command. Session ids, cluster times and a pipeline's
 *  own `$type` expressions are more than Prisma's raw reply can decode. */
const PROFILE_STAGES = [{ $project: { _id: 0, op: 1, ns: 1, planSummary: 1, docsExamined: 1, keysExamined: 1, nreturned: 1, responseLength: 1, millis: 1,
  'command.aggregate': 1, 'command.find': 1, 'command.filter': 1, 'command.q': 1, 'command.query': 1,
  match: { $first: { $map: { input: { $filter: { input: { $ifNull: ['$command.pipeline', []] },
    cond: { $ne: [{ $type: { $getField: { field: { $literal: '$match' }, input: '$$this' } } }, 'missing'] } } },
  in: { $getField: { field: { $literal: '$match' }, input: '$$this' } } } } } } }]

/** A row of PROFILE_STAGES as the ProfileEntry it stands for. */
function profileEntry(row: ProfileEntry & { match?: unknown }): ProfileEntry {
  const { match, ...entry } = row
  return { ...entry, millis: Number(entry.millis), ...entry.responseLength !== undefined ? { responseLength: Number(entry.responseLength) } : {},
    ...match !== undefined || entry.command?.aggregate ? { command: { ...entry.command, pipeline: [{ $match: match ?? {} }] } } : {} }
}

/** A fresh loopback replica set with the schema pushed; never DATABASE_URL. */
export async function planDatabase(prefix: string): Promise<{ replica: MongoMemoryReplSet; db: PrismaClient; uri: string }> {
  const replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`${prefix}_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  return { replica, db: new PrismaClient({ datasources: { db: { url: uri } } }), uri }
}

/** Every operation `run` sends, as the profiler records it. */
export async function profiled(db: PrismaClient, run: () => Promise<unknown>): Promise<ProfileEntry[]> {
  await db.$runCommandRaw({ profile: 0 })
  await db.$runCommandRaw({ drop: 'system.profile' }).catch(() => {})
  await db.$runCommandRaw({ create: 'system.profile', capped: true, size: 64 * 1024 * 1024 })
  await db.$runCommandRaw({ profile: 2, slowms: 0 })
  try {
    await run()
  } finally {
    await db.$runCommandRaw({ profile: 0 })
  }
  const reply = await db.$runCommandRaw({ aggregate: 'system.profile', pipeline: [
    { $project: { ...PROFILE_STAGES[0]!.$project, 'command.hint': 1 } }], cursor: { batchSize: 100000 } }) as unknown as
    { cursor: { firstBatch: ProfileEntry[] } }
  return reply.cursor.firstBatch.map(profileEntry)
}

/** What an entry filtered on: an aggregate's first $match, a find's filter, or an update's query. */
export function filterOf(entry: ProfileEntry): unknown {
  return (entry.command?.pipeline as Array<{ $match?: unknown }> | undefined)?.[0]?.$match ?? entry.command?.filter ?? entry.command?.q
}

/** The profiled operations on one collection whose filter mentions every field of `fields` and none of `not`. */
export function reads(entries: ProfileEntry[], collection: string, fields: string[], not: string[] = []): ProfileEntry[] {
  const mentions = (shape: string, field: string) => shape.includes(`"$${field}"`) || shape.includes(`"${field}":`)
  return entries.filter(e => e.ns.endsWith(`.${collection}`)).filter(e => {
    const filter = filterOf(e)
    if (filter === undefined) return false
    const shape = queryShape(filter)
    return fields.every(f => mentions(shape, f)) && !not.some(f => mentions(shape, f))
  })
}

export const plan = (rows: ProfileEntry[]) => rows.map(r => ({ plan: r.planSummary, docsExamined: r.docsExamined, keysExamined: r.keysExamined,
  returned: r.nreturned, hint: r.command?.hint }))
