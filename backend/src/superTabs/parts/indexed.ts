/**
 * Hot SwarmGroup reads that name their index (prod slow log, 2026-10-28: ~200 ms of each read was query planning). Prisma
 * sends its filters as $expr, and a filter several indexes could serve is planned again whenever the plan cache misses: a
 * race of every candidate index over the Swarm's rows, which a bigger Swarm repeats by evicting the cached plan, and which
 * can pick an index that reads every quiet conversation to return none. A named index is never planned.
 * integration/superTabGroupPlans.test.ts holds each read to it under Mongo's profiler.
 */
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
  /** Every live group: the host signature's index. */
  live: { tabId: 1, deleted: 1, key: 1, hostDigest: 1, dormant: 1 },
} as const
export type GroupIndex = keyof typeof GROUP_INDEX

/** The indexes SwarmGroup had when last listed; none until then. A read names only these: naming one the database lacks
 *  fails the read, and in a transaction aborts it. */
let present = new Set<GroupIndex>()

/** Lists SwarmGroup's indexes, outside any transaction, and says which hot reads go without theirs. The worker's
 *  `prisma db push` builds a new index at startup (Dockerfile.k8s), possibly after a server first lists them. */
export async function listGroupIndexes(db: PrismaClient): Promise<void> {
  const reply = await db.$runCommandRaw({ listIndexes: 'SwarmGroup' }) as unknown as { cursor: { firstBatch: Array<{ key: Record<string, unknown> }> } }
  const fields = new Set(reply.cursor.firstBatch.map(index => Object.keys(index.key).join(',')))
  const names = Object.keys(GROUP_INDEX) as GroupIndex[]
  present = new Set(names.filter(name => fields.has(Object.keys(GROUP_INDEX[name]).join(','))))
  const missing = names.filter(name => !present.has(name))
  if (missing.length) logger.error('[swarm-reads] SwarmGroup lacks indexes hot reads name; they read without them', { missing: missing.map(name => GROUP_INDEX[name]) })
}

/** Lists the indexes now and every five minutes, until the process ends. */
export function watchGroupIndexes(db: PrismaClient): void {
  const list = () => listGroupIndexes(db).catch(error => logger.warn('[swarm-reads] listing SwarmGroup indexes failed', { error: error instanceof Error ? error.message : String(error) }))
  void list()
  setInterval(list, 5 * 60_000).unref()
}

/** The rows of an `aggregateRaw` pipeline on SwarmGroup, through `index` once the database is known to have it. */
export async function groupsBy(tx: Transaction, index: GroupIndex, pipeline: Prisma.InputJsonValue[]): Promise<Array<Record<string, unknown>>> {
  return await tx.swarmGroup.aggregateRaw({ pipeline, ...present.has(index) ? { options: { hint: GROUP_INDEX[index] } } : {} }) as unknown as
    Array<Record<string, unknown>>
}

/** A project's quiet conversations last active since `since`, as the project index serves them. A conversation stored with no
 *  project belongs to the first one (projects.ts groupProject); a null match is a missing field too. */
export function quietSince(tabId: string, projectId: string, since: number): Record<string, Prisma.InputJsonValue> {
  return { tabId, deleted: false, dormant: true, lastActivityAt: { $gte: { $date: new Date(since).toISOString() } },
    projectId: { $in: projectId === 'lead' ? ['lead', null] : [projectId] } }
}
