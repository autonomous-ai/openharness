import type { PrismaClient } from '@prisma/client'
import { percentile } from './metrics.js'

/** One `system.profile` document, with only the fields this reads. */
export interface ProfileEntry {
  op: string
  ns: string
  command?: Record<string, unknown>
  planSummary?: string
  docsExamined?: number
  keysExamined?: number
  nreturned?: number
  millis: number
}

/** The operations of one collection with one filter shape: their plans, what they read, and how long they took. */
export interface ShapeRow {
  collection: string
  op: string
  shape: string
  count: number
  collscans: number
  plans: string[]
  docsExaminedMax: number
  docsExaminedP95: number
  keysExaminedMax: number
  returnedMax: number
  p50Ms: number
  p95Ms: number
  maxMs: number
}

export interface ProfileSummary { operations: number; collscans: number; p95Ms: number | null; shapes: ShapeRow[] }

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

/** What an operation filtered on, by how the profiler records each kind: Prisma reads through `aggregate`. */
function filterOf(entry: ProfileEntry): { op: string; filter: unknown } | null {
  const command = entry.command ?? {}
  if (Array.isArray(command.pipeline)) {
    const match = (command.pipeline as Array<Record<string, unknown>>).find(stage => '$match' in stage)
    return { op: 'aggregate', filter: match?.$match ?? {} }
  }
  if ('filter' in command) return { op: command.find ? 'find' : entry.op, filter: command.filter }
  if ('q' in command) return { op: entry.op, filter: command.q }
  if ('query' in command) return { op: entry.op, filter: command.query }
  return null
}

const collectionOf = (ns: string) => ns.slice(ns.indexOf('.') + 1)

/** The profiled operations that read a collection, grouped by collection and filter shape, most frequent first. */
export function summarizeProfile(entries: readonly ProfileEntry[]): ProfileSummary {
  const groups = new Map<string, { collection: string; op: string; shape: string; entries: ProfileEntry[] }>()
  for (const entry of entries) {
    const collection = collectionOf(entry.ns)
    if (collection.startsWith('system.') || collection === '$cmd') continue
    const read = filterOf(entry)
    if (!read) continue
    const shape = queryShape(read.filter), key = `${collection}\0${read.op}\0${shape}`
    const group = groups.get(key) ?? { collection, op: read.op, shape, entries: [] }
    group.entries.push(entry)
    groups.set(key, group)
  }
  const counted = [...groups.values()].flatMap(g => g.entries)
  const shapes = [...groups.values()].map(({ collection, op, shape, entries: rows }): ShapeRow => {
    const ms = rows.map(r => r.millis), docs = rows.map(r => r.docsExamined ?? 0)
    return { collection, op, shape, count: rows.length, collscans: rows.filter(r => r.planSummary === 'COLLSCAN').length,
      plans: [...new Set(rows.map(r => r.planSummary ?? 'none'))].sort(), docsExaminedMax: Math.max(...docs), docsExaminedP95: percentile(docs, 95)!,
      keysExaminedMax: Math.max(...rows.map(r => r.keysExamined ?? 0)), returnedMax: Math.max(...rows.map(r => r.nreturned ?? 0)),
      p50Ms: percentile(ms, 50)!, p95Ms: percentile(ms, 95)!, maxMs: Math.max(...ms) }
  }).sort((a, b) => b.count - a.count || a.collection.localeCompare(b.collection) || a.shape.localeCompare(b.shape))
  return { operations: counted.length, collscans: counted.filter(r => r.planSummary === 'COLLSCAN').length,
    p95Ms: percentile(counted.map(r => r.millis), 95), shapes }
}

/** The report section: the KPI line (full scans, p95, peak connections), then every shape, most frequent first. */
export function renderProfile(profile: ProfileSummary & { peakConnections: number }): string {
  const header = ['Collection', 'Op', 'Filter shape', 'Count', 'COLLSCAN', 'Plans', 'Docs read p95', 'Docs read max', 'Returned max', 'p50 ms', 'p95 ms', 'max ms']
  const rows = profile.shapes.map(r => [r.collection, r.op, `\`${r.shape}\``, r.count, r.collscans, r.plans.join(', '), r.docsExaminedP95, r.docsExaminedMax,
    r.returnedMax, r.p50Ms, r.p95Ms, r.maxMs].map(String))
  return ['## Database operations (Mongo profiler)', '',
    `Operations: ${profile.operations}. Full collection scans: ${profile.collscans}. p95: ${profile.p95Ms ?? '–'} ms. Peak server connections: ${profile.peakConnections}.`, '',
    `| ${header.join(' | ')} |`, `|${header.map(() => '---').join('|')}|`, ...rows.map(r => `| ${r.join(' | ')} |`), ''].join('\n')
}

/** A `system.profile` aggregation that keeps of each operation only what `ProfileEntry` reads: its filter (a find's, an update's,
 *  or the first `$match` of a pipeline, as `match`) and never its whole command. Session ids, cluster times and a pipeline's
 *  own `$type` expressions are more than Prisma's raw reply can decode. */
export const PROFILE_STAGES = [{ $project: { _id: 0, op: 1, ns: 1, planSummary: 1, docsExamined: 1, keysExamined: 1, nreturned: 1, millis: 1,
  'command.aggregate': 1, 'command.find': 1, 'command.filter': 1, 'command.q': 1, 'command.query': 1,
  match: { $first: { $map: { input: { $filter: { input: { $ifNull: ['$command.pipeline', []] },
    cond: { $ne: [{ $type: { $getField: { field: { $literal: '$match' }, input: '$$this' } } }, 'missing'] } } },
  in: { $getField: { field: { $literal: '$match' }, input: '$$this' } } } } } } }]

/** A row of PROFILE_STAGES as the ProfileEntry it stands for. */
export function profileEntry(row: ProfileEntry & { match?: unknown }): ProfileEntry {
  const { match, ...entry } = row
  return { ...entry, millis: Number(entry.millis),
    ...match !== undefined || entry.command?.aggregate ? { command: { ...entry.command, pipeline: [{ $match: match ?? {} }] } } : {} }
}

/** Profiles every operation on the bench's database from now on (level 2: all, whatever their time). The default
 *  `system.profile` keeps 1 MB, a few seconds of the load; this one keeps 1 GB. */
export async function startProfiling(db: PrismaClient): Promise<void> {
  await db.$runCommandRaw({ profile: 0 })
  await db.$runCommandRaw({ drop: 'system.profile' }).catch(() => {})
  await db.$runCommandRaw({ create: 'system.profile', capped: true, size: 1024 * 1024 * 1024 })
  await db.$runCommandRaw({ profile: 2, slowms: 0 })
}

/** Stops profiling and summarizes what it recorded. */
export async function readProfile(db: PrismaClient): Promise<ProfileSummary> {
  await db.$runCommandRaw({ profile: 0 })
  const entries: ProfileEntry[] = []
  let reply = await db.$runCommandRaw({ aggregate: 'system.profile', pipeline: PROFILE_STAGES, cursor: { batchSize: 10000 } }) as unknown as Cursor
  entries.push(...reply.cursor.firstBatch ?? [])
  while (reply.cursor.id && Number((reply.cursor.id as { $numberLong?: string }).$numberLong ?? reply.cursor.id)) {
    reply = await db.$runCommandRaw({ getMore: reply.cursor.id as never, collection: 'system.profile', batchSize: 10000 }) as unknown as Cursor
    entries.push(...reply.cursor.nextBatch ?? [])
  }
  return summarizeProfile(entries.map(profileEntry))
}

interface Cursor { cursor: { id: unknown; firstBatch?: ProfileEntry[]; nextBatch?: ProfileEntry[] } }
