/**
 * Rollback to the previous release (design 6.4), behind the same gate as the migration. Before any write in parts, the
 * old state goes back unchanged. After writes, the state is rebuilt from the parts, numbered past everything used since,
 * and the parts are kept until the owner says they can go.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { nextConversationNumber } from '../model.js'
import * as parts from '../parts/index.js'

export interface RollbackReport { tabId: string; ok: boolean; error?: string }

const ROLLBACK_TRANSACTION = { maxWait: 5_000, timeout: 60_000 }
const PART_MODELS = ['swarmHead', 'swarmMember', 'swarmAgent', 'swarmGroup', 'swarmMachine', 'swarmStart', 'swarmProgress'] as const
class RollbackFailed extends Error {}
const fail = (message: string): never => { throw new RollbackFailed(message) }

async function run(db: PrismaClient, tabId: string, body: (tx: Prisma.TransactionClient) => Promise<void>): Promise<RollbackReport> {
  try {
    await db.$transaction(body, ROLLBACK_TRANSACTION)
    return { tabId, ok: true }
  } catch (error) {
    return { tabId, ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

async function migratedRow(tx: Prisma.TransactionClient, tabId: string) {
  const row = await tx.superTab.findUnique({ where: { id: tabId } }) ?? fail(`Swarm ${tabId} does not exist`)
  if (row.format !== 2) fail('it is not in parts')
  return row
}
const newestVersion = (stored: parts.SwarmParts) =>
  Math.max(...[stored.head, ...stored.members, ...stored.agents, ...stored.groups, ...stored.machines, ...stored.starts, ...stored.progress].map(p => p.version))
const newestSequence = async (tx: Prisma.TransactionClient, tabId: string) =>
  (await tx.superTabMessage.findFirst({ where: { tabId }, orderBy: { sequence: 'desc' }, select: { sequence: true } }))?.sequence ?? 0

/** Before any write in parts: the old state back as it was, the parts dropped. Refused once anything was written since. */
export function rollbackLegacy(db: PrismaClient, tabId: string): Promise<RollbackReport> {
  return run(db, tabId, async tx => {
    const row = await migratedRow(tx, tabId)
    if (!row.legacyState) fail('it has no old state kept')
    const stored = await parts.loadAll(tx, tabId)
    if (newestVersion(stored) > stored.sequenceBase || await newestSequence(tx, tabId) > stored.sequenceBase) {
      fail('parts were written since the migration; roll back from the parts instead')
    }
    const restored = await tx.superTab.updateMany({ where: { id: tabId, format: 2, revision: row.revision },
      data: { state: row.legacyState as Prisma.InputJsonValue, format: 1, migratedAt: null, legacyState: null } })
    if (!restored.count) fail('it changed during the rollback')
    for (const model of PART_MODELS) await (tx[model] as unknown as { deleteMany(args: unknown): Promise<unknown> }).deleteMany({ where: { tabId } })
  })
}

/** After writes in parts: the old state rebuilt from them. The old store numbers every new message from the tab revision
 *  and every new group past the highest number, so both start past anything used in parts. */
export function rollbackFromParts(db: PrismaClient, tabId: string): Promise<RollbackReport> {
  return run(db, tabId, async tx => {
    const row = await migratedRow(tx, tabId)
    const stored = await parts.loadAll(tx, tabId)
    const state = parts.toLegacyState(parts.reassemble(stored))
    if (state.version !== 1) fail(`its rebuilt state has version ${String(state.version)}, not 1`)
    if (stored.groupCounter > nextConversationNumber(state) - 1) state.retiredConversationNumber = stored.groupCounter
    const revision = Math.max(row.revision, newestVersion(stored), await newestSequence(tx, tabId)) + 1
    const restored = await tx.superTab.updateMany({ where: { id: tabId, format: 2, revision: row.revision },
      data: { state: JSON.parse(JSON.stringify(state)) as Prisma.InputJsonValue, revision, format: 1, migratedAt: null } })
    if (!restored.count) fail('it changed during the rollback')
  })
}
