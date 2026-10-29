import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import { PROFILE_STAGES, profileEntry, queryShape, type ProfileEntry } from './bench/profile.js'

/** A fresh loopback replica set with the schema pushed; never DATABASE_URL. */
export async function planDatabase(prefix: string): Promise<{ replica: MongoMemoryReplSet; db: PrismaClient }> {
  const replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`${prefix}_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  return { replica, db: new PrismaClient({ datasources: { db: { url: uri } } }) }
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
