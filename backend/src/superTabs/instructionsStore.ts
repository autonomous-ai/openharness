/**
 * A project's instructions and notes in their own collections (instructions.ts), written in the command's transaction so
 * the state's revision and the stored text never disagree. Every filter is an equality or a range on the indexed fields:
 * never `in` (hotFilters.test.ts).
 */
import type { Prisma } from '@prisma/client'
import { stableId } from './model.js'
import { MAX_REVISIONS, type InstructionsWrite, type NotesWrite, type PmNote } from './instructions.js'

type Transaction = Prisma.TransactionClient

export const instructionsId = (tabId: string, projectId: string): string => stableId(tabId, projectId)
export const revisionId = (tabId: string, projectId: string, revision: number): string => stableId(tabId, projectId, String(revision))

/** The document as of this write, its revision record, and no more than MAX_REVISIONS of them. Upserts, so a project's
 *  rows from before a backend rollback are overwritten rather than duplicated. */
export async function writeInstructions(tx: Transaction, tabId: string, write: InstructionsWrite): Promise<void> {
  const { projectId, revision, hash, text } = write, at = new Date(write.at)
  const id = instructionsId(tabId, projectId)
  await tx.superTabInstructions.upsert({ where: { id }, create: { id, tabId, projectId, revision, hash, text, updatedAt: at },
    update: { revision, hash, text, updatedAt: at } })
  const record = { revision, hash, text, summary: write.summary, writtenByKind: write.writtenBy.kind, writtenBy: write.writtenBy.id,
    askedBy: write.askedBy, at }
  const rid = revisionId(tabId, projectId, revision)
  await tx.superTabInstructionsRevision.upsert({ where: { id: rid }, create: { id: rid, tabId, projectId, ...record }, update: record })
  // Growth: the 51st revision deletes the oldest (design, Growth). Later ones than this (left by a rollback) go too: they
  // are no revision of this document any more.
  await tx.superTabInstructionsRevision.deleteMany({ where: { tabId, projectId, revision: { lte: revision - MAX_REVISIONS } } })
  await tx.superTabInstructionsRevision.deleteMany({ where: { tabId, projectId, revision: { gt: revision } } })
}

/** Everything a deleted project kept beside its state. */
export async function deleteInstructions(tx: Transaction, tabId: string, projectId: string): Promise<void> {
  await tx.superTabInstructions.deleteMany({ where: { tabId, projectId } })
  await tx.superTabInstructionsRevision.deleteMany({ where: { tabId, projectId } })
  await tx.superTabPmNote.deleteMany({ where: { tabId, projectId } })
}

/** A project's stored notes, expired ones too: the command decides what is live (instructions.ts liveNotes). At most a
 *  hundred live ones, and the expired ones go on every write, so this stays small. */
export async function readNotes(tx: Transaction, tabId: string, projectId: string): Promise<PmNote[]> {
  const rows = await tx.superTabPmNote.findMany({ where: { tabId, projectId }, orderBy: { at: 'asc' } })
  return rows.map(row => ({ id: row.id, text: row.text, askedBy: row.askedBy, at: row.at.getTime(), expiresAt: row.expiresAt?.getTime() ?? null }))
}

/** The note kept or removed, and every expired note of the project: deleted lazily, on its project's next note write. */
export async function writeNotes(tx: Transaction, tabId: string, write: NotesWrite, now: number): Promise<void> {
  const { projectId } = write
  // Prisma sends this as an $expr, where null sorts below every date: the lower bound keeps a note with no end.
  await tx.superTabPmNote.deleteMany({ where: { tabId, projectId, expiresAt: { gt: new Date(0), lte: new Date(now) } } })
  if (write.removeId) await tx.superTabPmNote.deleteMany({ where: { id: write.removeId, tabId, projectId } })
  if (write.add) {
    const { id, text, askedBy, at, expiresAt } = write.add
    await tx.superTabPmNote.create({ data: { id, tabId, projectId, text, askedBy, at: new Date(at), expiresAt: expiresAt === null ? null : new Date(expiresAt) } })
  }
}
