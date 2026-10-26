/**
 * Rollback to the previous release (design 6.4), behind the same gate as the migration. Before any write in parts, the
 * old state goes back unchanged. After writes, the state is rebuilt from the parts, numbered past everything used since,
 * and the parts are kept until the owner says they can go. A Swarm the previous release would misread is never rolled
 * back: it checks no audience and knows no lost work (final review, Critical 2).
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { nextConversationNumber, type Conversation, type SuperTabState } from '../model.js'
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

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * What the previous release would misread in a state rebuilt from the parts. It filters conversations by project alone,
 * so a private one becomes readable by every project reader; and it ends work only on done, stopped or cancelled, so a
 * lost task (status lost, or the marker a later cancel keeps) reads as active. Null when there is neither.
 */
function downgradeHazard(state: SuperTabState): string | null {
  const groups: Conversation[] = [...state.conversations, ...state.parkedConversations ?? []]
  const hidden = groups.filter(g => g.audience).length
  const lost = groups.filter(g => g.assignment?.status === 'lost' || g.assignment?.lost).length
  const hazards = [...hidden ? [`its ${plural(hidden, 'private conversation')} would become readable by every project reader`] : [],
    ...lost ? [`its ${plural(lost, 'lost task')} would read as active work`] : []]
  return hazards.length ? `the previous release would misread it: ${hazards.join(', and ')}` : null
}

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
    const hazard = downgradeHazard(state)
    if (hazard) fail(`Swarm ${tabId} was not rolled back, and nothing was changed: ${hazard}. Roll forward with a fix instead; `
      + 'the parts stay authoritative, so nothing is lost or made public.')
    if (stored.groupCounter > nextConversationNumber(state) - 1) state.retiredConversationNumber = stored.groupCounter
    const revision = Math.max(row.revision, newestVersion(stored), await newestSequence(tx, tabId)) + 1
    const restored = await tx.superTab.updateMany({ where: { id: tabId, format: 2, revision: row.revision },
      data: { state: JSON.parse(JSON.stringify(state)) as Prisma.InputJsonValue, revision, format: 1, migratedAt: null } })
    if (!restored.count) fail('it changed during the rollback')
  })
}
