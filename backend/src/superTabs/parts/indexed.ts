/**
 * Hot SwarmGroup reads that name their index (prod slow log, 2026-10-28: ~200 ms of each read was query planning). Prisma
 * sends its filters as $expr, and a filter several indexes could serve is planned again whenever the plan cache misses: a
 * race of every candidate index over the Swarm's rows, which a bigger Swarm repeats by evicting the cached plan, and which
 * can pick an index that reads every quiet conversation to return none. A named index is never planned.
 * integration/superTabGroupPlans.test.ts holds each read to it under Mongo's profiler.
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Prisma, PrismaClient } from '@prisma/client'
import { logger } from '../../utils/logger.js'

type Transaction = Prisma.TransactionClient

/** The SwarmGroup indexes hot reads name, as prisma/schema.prisma declares them. */
export const GROUP_INDEX = {
  key: { tabId: 1, key: 1 },
  running: { tabId: 1, executionMachineId: 1 },
  agents: { tabId: 1, agentIds: 1 },
  project: { tabId: 1, projectId: 1, dormant: 1, lastActivityAt: 1, key: 1 },
  dormancy: { tabId: 1, dormant: 1, changedAt: 1 },
  changes: { tabId: 1, changedAt: 1 },
  /** A host's changed conversations: led by the host, so the wake check reads no other host's. */
  wake: { hostMachineIds: 1, tabId: 1, changedAt: 1 },
  /** Every live group: the host signature's index. */
  live: { tabId: 1, deleted: 1, key: 1, hostDigest: 1, dormant: 1 },
} as const
export type GroupIndex = keyof typeof GROUP_INDEX

/** Every index a hot read names, by collection, as prisma/schema.prisma declares them (roadmap Phase 3). */
export const NAMED_INDEX = {
  SwarmGroup: GROUP_INDEX,
  SuperTab: {
    /** An owner's Swarms in id order: the grid poll. */
    owner: { autonomousEnv: 1, ownerId: 1, _id: 1 },
  },
} as const
export type NamedCollection = keyof typeof NAMED_INDEX
export type NamedIndex<C extends NamedCollection> = keyof typeof NAMED_INDEX[C] & string

/** The named indexes each collection had when last listed; none until then. A read names only these: naming one the
 *  database lacks fails the read, and in a transaction aborts it. */
let present = new Map<NamedCollection, Set<string>>()

const COLLECTIONS = Object.keys(NAMED_INDEX) as NamedCollection[]
const indexOf = (collection: NamedCollection, name: string) => (NAMED_INDEX[collection] as Record<string, Record<string, number>>)[name]!

/** Lists the named collections' indexes, outside any transaction, and says which hot reads go without theirs. The worker's
 *  `prisma db push` builds a new index at startup (Dockerfile.k8s), possibly after a server first lists them. */
export async function listNamedIndexes(db: PrismaClient): Promise<void> {
  const generation = drops
  const listed = await Promise.all(COLLECTIONS.map(async collection => {
    const reply = await db.$runCommandRaw({ listIndexes: collection }).catch(error => {
      // A collection nothing has written yet has no indexes either.
      if (/NamespaceNotFound|ns does not exist/i.test(error instanceof Error ? error.message : String(error))) return null
      throw error
    }) as unknown as { cursor: { firstBatch: Array<{ key: Record<string, unknown> }> } } | null
    return [collection, new Set((reply?.cursor.firstBatch ?? []).map(index => Object.keys(index.key).join(',')))] as const
  }))
  // A read dropped the listing while this one was on its way: its reply may predate the removal (review of #1994).
  if (drops !== generation) return
  const next = new Map<NamedCollection, Set<string>>()
  const missing: Array<Record<string, number>> = []
  for (const [collection, fields] of listed) {
    const names = Object.keys(NAMED_INDEX[collection])
    next.set(collection, new Set(names.filter(name => fields.has(Object.keys(indexOf(collection, name)).join(',')))))
    missing.push(...names.filter(name => !next.get(collection)!.has(name)).map(name => ({ [collection]: 1, ...indexOf(collection, name) })))
  }
  present = next
  if (missing.length) logger.error('[swarm-reads] Swarm collections lack indexes hot reads name; they read without them', { missing })
}
/** The SwarmGroup listing's older name: it lists every named collection now. */
export const listGroupIndexes = listNamedIndexes

/** Lists the indexes now and every five minutes, until the process ends. */
export function watchGroupIndexes(db: PrismaClient): void {
  const list = () => listNamedIndexes(db).catch(error => logger.warn('[swarm-reads] listing Swarm indexes failed', { error: error instanceof Error ? error.message : String(error) }))
  void list()
  setInterval(list, 5 * 60_000).unref()
}

/** How many times a read dropped the listing. A transaction a dropped index aborted fails in whichever of its reads Mongo
 *  answers first, often not the one that named it: its runner reruns it when this moved during the attempt. */
let drops = 0
export const listingDrops = (): number => drops

/** Set while a transaction a dropped index aborted runs again: its reads name no index, whatever a listing since says. */
const rerun = new AsyncLocalStorage<true>()
export const withoutHints = <T>(run: () => Promise<T>): Promise<T> => rerun.run(true, run)

/** Runs a transaction opened directly (outside store.ts `transaction`) once more when a read in it dropped the listing:
 *  the second attempt names no index (`withoutHints`). */
export async function retryStaleIndex<T>(run: () => Promise<T>): Promise<T> {
  const before = drops
  try {
    return await run()
  } catch (error) {
    if (drops === before) throw error
    return withoutHints(run)
  }
}

/**
 * The rows of an `aggregateRaw` pipeline on `collection`, through its index `name` once the database is known to have it.
 * An index removed since the last listing (a rollback, an index replaced) fails the read: the listing is dropped, said, and
 * the read runs without it at once outside a transaction. In one, the failed command aborted it, and Prisma may report only
 * that: its runner runs it again (`listingDrops`).
 */
export async function readBy<C extends NamedCollection>(tx: Transaction, collection: C, name: NamedIndex<C>,
  pipeline: Prisma.InputJsonValue[]): Promise<Array<Record<string, unknown>>> {
  const model = (tx as unknown as Record<string, { aggregateRaw(args: unknown): Promise<unknown> }>)[collection[0]!.toLowerCase() + collection.slice(1)]!
  const run = async (hint?: Record<string, number>) => await model.aggregateRaw({ pipeline, ...hint ? { options: { hint } } : {} }) as
    Array<Record<string, unknown>>
  if (rerun.getStore() || !present.get(collection)?.has(name)) return run()
  try {
    return await run(indexOf(collection, name))
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (!/hint provided does not correspond to an existing index|has been aborted/.test(message)) throw error
    present = new Map()
    drops++
    logger.error('[swarm-reads] A Swarm collection lacks an index a hot read names; reads name none until the next listing',
      { collection, index: indexOf(collection, name) })
    if (typeof (tx as { $transaction?: unknown }).$transaction === 'function') return run()
    throw error
  }
}

/** The rows of an `aggregateRaw` pipeline on SwarmGroup through `index` (readBy). */
export const groupsBy = (tx: Transaction, index: GroupIndex, pipeline: Prisma.InputJsonValue[]): Promise<Array<Record<string, unknown>>> =>
  readBy(tx, 'SwarmGroup', index, pipeline)

/** A project's quiet conversations last active since `since`, as the project index serves them. A conversation stored with no
 *  project belongs to the first one (projects.ts groupProject); a null match is a missing field too. */
export function quietSince(tabId: string, projectId: string, since: number): Record<string, Prisma.InputJsonValue> {
  return { tabId, deleted: false, dormant: true, lastActivityAt: { $gte: { $date: new Date(since).toISOString() } },
    projectId: { $in: projectId === 'lead' ? ['lead', null] : [projectId] } }
}
