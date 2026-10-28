/**
 * Writes a Swarm the way the store before parts did: one `SuperTab` row (format 1) holding the whole state at a
 * revision, and its messages numbered by the tab revision that carried them. For the migration's tests and dry run only.
 */
import type { Prisma, PrismaClient } from '@prisma/client'
import { activeWork, type Author, type SuperTabState } from '../../src/superTabs/model.js'

export interface LegacyMessage {
  id: string
  conversationId: string
  sequence: number
  text: string
  author: Author
  recipientIds?: string[]
  source?: Record<string, unknown>
  createdAt: Date
}

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue

/** Report progress as rows from before parts keep it, in tab revisions (parts keep a watermark per group instead). */
export interface LegacyProgress { dirtyRevision: number; summarizedRevision: number; since: number; requestedRevision: number; requestedAt?: number; requestMessageId?: string }
export function setLegacyProgress(project: NonNullable<SuperTabState['projects']>[number], progress: LegacyProgress): void {
  (project as { progress?: unknown }).progress = progress
}

/** The row's lookup lists as the old store kept them (store.ts indexes). */
export function legacyIndexes(state: SuperTabState) {
  return {
    memberIds: state.people.map(p => p.id), invitedEmails: state.invitations.map(i => i.email),
    machineIds: [...new Set([...state.agents.map(a => a.machineId), ...(state.machines ?? []).map(m => m.machineId),
      ...state.conversations.filter(activeWork).map(c => c.assignment!.execution.machineId), ...(state.closingSessions ?? []).map(c => c.machineId),
      ...(state.machineCleanups ?? []).map(c => c.machineId)])],
    cleanupMachineIds: [...(state.machines ?? []).filter(m => m.removal).map(m => m.machineId), ...(state.machineCleanups ?? []).map(c => c.machineId)],
  }
}

export async function writeLegacySwarm(db: PrismaClient, input: { state: SuperTabState; revision: number; autonomousEnv?: string; messages?: LegacyMessage[] }) {
  const { state, revision, autonomousEnv = 'prod', messages = [] } = input
  await db.superTab.create({ data: { id: state.id, ownerId: state.ownerId, autonomousEnv, revision, state: json(state), ...legacyIndexes(state) } })
  for (let i = 0; i < messages.length; i += 5_000) {
    await db.superTabMessage.createMany({ data: messages.slice(i, i + 5_000).map(m => ({ id: m.id, tabId: state.id, conversationId: m.conversationId,
      sequence: m.sequence, author: json(m.author), text: m.text, replyTo: null, recipientIds: m.recipientIds ?? [], mentions: [],
      ...(m.source ? { source: json(m.source) } : {}), createdAt: m.createdAt })) })
  }
}
