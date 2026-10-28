import { createHash } from 'node:crypto'
import type { Prisma } from '@prisma/client'
import { activeWork, stableId, type AgentStart, type Agent } from '../model.js'
import type { GroupData, MachineData, PartKind } from './types.js'
import { RETENTION_MS } from './types.js'

type Transaction = Prisma.TransactionClient
const json = (value: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

/** A part changed after it was read. Code P2034 so the transaction retries it like a Mongo write conflict (store.ts). */
export class PartConflict extends Error {
  readonly code = 'P2034'
  constructor(readonly kind: PartKind, readonly key: string) {
    super(`The ${kind} part ${key} changed after it was read.`)
    this.name = 'PartConflict'
  }
}

/** The head's own columns: they are not in its data. */
export interface HeadColumns { groupCounter: number; visibilityEpoch: number; sequenceBase: number }

export type PartWrite =
  /** `first`: a new key's version, the Swarm's sequence base + 1 (design section 2.1). */
  | { op: 'insert'; kind: PartKind; key: string; data: unknown; ordinal: number; first?: number; head?: HeadColumns; host?: HostColumns }
  | { op: 'update'; kind: PartKind; key: string; seen: number; data: unknown; head?: HeadColumns; host?: HostColumns }
  | { op: 'remove'; kind: PartKind; key: string; seen: number; data: unknown; host?: HostColumns }
  | { op: 'touch'; kind: PartKind; key: string; seen: number }

/** What a write tells host reads (read/host.ts), set by the commit that knows the part's data before and after. */
export interface HostColumns { hostChangedAt?: Date; hostMachineIds?: string[] }

/** The part model behind each kind. They share their columns (schema.prisma, Swarm state by parts). */
export function delegate(tx: Transaction, kind: PartKind) {
  const models = { head: tx.swarmHead, member: tx.swarmMember, agent: tx.swarmAgent, group: tx.swarmGroup,
    machine: tx.swarmMachine, start: tx.swarmStart, progress: tx.swarmProgress }
  return models[kind] as unknown as {
    findUnique(args: { where: { id: string } }): Promise<{ version: number; deleted: boolean } | null>
    findMany(args: unknown): Promise<PartRow[]>
    create(args: { data: Record<string, unknown> }): Promise<unknown>
    createMany(args: { data: Record<string, unknown>[] }): Promise<unknown>
    updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>
    findFirst(args: unknown): Promise<{ tabId: string; changedAt: Date } | null>
  }
}
export interface PartRow { id: string; tabId: string; key: string; version: number; changedAt: Date; deleted: boolean; ordinal: number; data: unknown
  dormant?: boolean; groupCounter?: number; visibilityEpoch?: number; sequenceBase?: number }

export const partId = (tabId: string, key: string) => `${tabId}:${key}`

/** A start leaves command state once it failed, or started and (when pooled) settled. */
export const startFinished = (start: AgentStart) => !!start.error || (!!start.harnessId && (!start.poolGeneration || !!start.poolSettled))

/** What host rows read of a conversation (read/hostRows.ts), with its id, as a short hash: a post, a rename or a new brief
 *  leaves it, so the host form can answer 'unchanged' from this column alone (group 3b). */
function hostDigest(group: GroupData): string {
  const work = group.assignment
  return createHash('sha256').update(JSON.stringify([group.id, group.kind ?? null, group.projectId ?? null, group.archived, group.agentIds, group.leadId ?? null,
    !!group.audience, work ? [work.id, work.agentId, work.status, work.execution, work.result?.slice(0, 500) ?? null] : null])).digest('base64url').slice(0, 22)
}

/** The columns each kind keeps out of its data for queries (schema.prisma). */
export function extracted(kind: PartKind, data: unknown, stamp: number): Record<string, unknown> {
  switch (kind) {
    case 'group': {
      const group = data as GroupData
      return { projectId: group.projectId ?? null, kind: group.kind ?? null, archived: group.archived, dormant: !!group.dormant,
        agentIds: group.agentIds, executionMachineId: activeWork(group) ? group.assignment!.execution.machineId : null,
        messageSeq: group.messageSeq ?? 0, reportSeq: group.reportSeq ?? 0,
        lastActivityAt: group.lastActivityAt ? new Date(group.lastActivityAt) : new Date(stamp), hostDigest: hostDigest(group),
        workFinished: ['done', 'cancelled'].includes(group.assignment?.status ?? '') }
    }
    case 'agent': {
      const agent = data as Agent
      return { machineId: agent.machineId, machineOwnerId: agent.machineOwnerId, contributorId: agent.contributorId }
    }
    case 'machine': {
      const machine = data as MachineData
      return { machineId: machine.machineId, contributed: !!machine.contribution, cleanupOwnerIds: machine.cleanups.map(c => c.machineOwnerId) }
    }
    case 'start': {
      const start = data as AgentStart
      return { machineId: start.request.machineId, conversationId: start.request.conversationId,
        agentId: start.harnessId ? stableId(start.request.machineId, start.harnessId) : null,
        finishedAt: startFinished(start) ? new Date(stamp) : null }
    }
    default: return {}
  }
}

/** The finished time a start keeps once set: a later write of a finished start does not push its expiry back. */
async function keepFinishedAt(tx: Transaction, id: string, fields: Record<string, unknown>) {
  if (!fields.finishedAt) return fields
  const row = await tx.swarmStart.findUnique({ where: { id }, select: { finishedAt: true } })
  return row?.finishedAt ? { ...fields, finishedAt: row.finishedAt } : fields
}

/**
 * Writes one part inside the command's transaction, guarded by the version it was read at (design section 3.2). The
 * guard checks the committed version at write time, so it holds whatever the transaction's read concern: a part another
 * transaction changed since the read throws PartConflict, and the transaction runs again on the new state.
 */
export async function guardedWrite(tx: Transaction, tabId: string, write: PartWrite, stamp: number): Promise<number> {
  const model = delegate(tx, write.kind), id = partId(tabId, write.key)
  if (write.op === 'insert') {
    let fields = { ...extracted(write.kind, write.data, stamp), ...write.head, ...write.host }
    // A part added again under the same key continues from its tombstone's version (spec ruling 6).
    const prior = await model.findUnique({ where: { id } })
    if (prior && !prior.deleted) throw new PartConflict(write.kind, write.key)
    if (prior) {
      if (write.kind === 'start') fields = await keepFinishedAt(tx, id, fields)
      const updated = await model.updateMany({ where: { id, version: prior.version, deleted: true }, data: { version: prior.version + 1,
        changedAt: new Date(stamp), deleted: false, purgeAt: null, data: json(write.data), ...fields } })
      if (!updated.count) throw new PartConflict(write.kind, write.key)
      return prior.version + 1
    }
    const version = write.first ?? 1
    await model.create({ data: { id, tabId, key: write.key, version, changedAt: new Date(stamp), deleted: false, ordinal: write.ordinal,
      data: json(write.data), ...fields } })
    return version
  }
  const data = write.op === 'touch' ? {}
    : write.op === 'remove' ? { changedAt: new Date(stamp), deleted: true, purgeAt: new Date(stamp + RETENTION_MS), data: json(write.data), ...write.host }
    : { changedAt: new Date(stamp), data: json(write.data), ...(write.kind === 'start'
      ? await keepFinishedAt(tx, id, extracted(write.kind, write.data, stamp)) : extracted(write.kind, write.data, stamp)), ...write.head, ...write.host }
  const updated = await model.updateMany({ where: { id, version: write.seen, deleted: false }, data: { version: write.seen + 1, ...data } })
  if (!updated.count) throw new PartConflict(write.kind, write.key)
  return write.seen + 1
}
