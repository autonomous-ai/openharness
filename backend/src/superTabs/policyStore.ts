/**
 * A project's rules record in its own collection (policy.ts), one row per revision, written in the command's transaction.
 * Every filter is an equality or a range on the indexed fields (tabId, projectId, revision): never `in` (hotFilters.test.ts).
 */
import type { Prisma } from '@prisma/client'
import { stableId } from './model.js'
import { MAX_RULES_REVISIONS, type ProjectRules, type RulesChange, type RulesWrite } from './policy.js'

type Transaction = Prisma.TransactionClient

export const rulesRevisionId = (tabId: string, projectId: string, revision: number): string => stableId(tabId, projectId, 'rules', String(revision))

/** One kept revision as the history lists it. */
export interface RulesRevision {
  revision: number
  rules: ProjectRules
  diff: RulesChange[]
  summary: string
  writtenBy: { kind: string; id: string }
  askedBy: string
  askedIn: { conversationId: string; messageId: string } | null
  at: Date
}

/** The project's newest revision, or null when none is saved (the seed, revision 0). One indexed read. */
export async function readRules(tx: Transaction, tabId: string, projectId: string): Promise<{ revision: number; rules: ProjectRules } | null> {
  const row = await tx.superTabProjectRules.findFirst({ where: { tabId, projectId }, orderBy: { revision: 'desc' }, select: { revision: true, rules: true } })
  return row && { revision: row.revision, rules: row.rules as unknown as ProjectRules }
}

/** Every kept revision, newest first: at most MAX_RULES_REVISIONS rows of the same index. */
export async function readRulesHistory(tx: Transaction, tabId: string, projectId: string): Promise<RulesRevision[]> {
  const rows = await tx.superTabProjectRules.findMany({ where: { tabId, projectId }, orderBy: { revision: 'desc' }, take: MAX_RULES_REVISIONS })
  return rows.map(row => ({ revision: row.revision, rules: row.rules as unknown as ProjectRules, diff: row.diff as unknown as RulesChange[],
    summary: row.summary, writtenBy: { kind: row.writtenByKind, id: row.writtenBy }, askedBy: row.askedBy,
    askedIn: (row.askedIn ?? null) as RulesRevision['askedIn'], at: row.at }))
}

/** The new revision, created (never upserted: a second writer of the same revision meets the taken key and retries into
 *  RULES_STALE), and no more than MAX_RULES_REVISIONS of them. */
export async function writeRules(tx: Transaction, tabId: string, write: RulesWrite): Promise<void> {
  const { projectId, revision } = write
  await tx.superTabProjectRules.create({ data: { id: rulesRevisionId(tabId, projectId, revision), tabId, projectId, revision,
    rules: write.rules as unknown as Prisma.InputJsonValue, diff: write.diff as unknown as Prisma.InputJsonValue, summary: write.summary,
    writtenByKind: write.writtenBy.kind, writtenBy: write.writtenBy.id, askedBy: write.askedBy,
    askedIn: write.askedIn === null ? undefined : write.askedIn as unknown as Prisma.InputJsonValue, at: new Date(write.at) } })
  // Growth: the 51st revision deletes the oldest.
  await tx.superTabProjectRules.deleteMany({ where: { tabId, projectId, revision: { lte: revision - MAX_RULES_REVISIONS } } })
}

/** Everything a deleted project kept of its rules. */
export async function deleteRules(tx: Transaction, tabId: string, projectId: string): Promise<void> {
  await tx.superTabProjectRules.deleteMany({ where: { tabId, projectId } })
}
