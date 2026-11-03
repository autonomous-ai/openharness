import { randomUUID } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import { swarmTransaction } from '../src/superTabs/cache.js'
import { stableId, type Author } from '../src/superTabs/model.js'
import * as parts from '../src/superTabs/parts/index.js'

/** Stores the Leads conversation a Swarm from before its removal still has (model.ts leadsRemoved), where syncLeads made it,
 *  with one message posted there; nothing makes one now. Returns its id and the message's. */
export async function storeOldLeads(db: PrismaClient, tab: string, agentIds: string[], author: Author, text = 'Who goes first?') {
  const id = stableId(tab, 'leads'), messageId = `m-${randomUUID()}`
  await swarmTransaction(db, async tx => {
    const current = await parts.loadAll(tx, tab)
    const state = parts.reassemble(current)
    state.leadsConversationId = id
    state.conversations.push({ id, kind: 'leads', title: 'Leads', leadId: null, agentIds, archived: false, brief: '', checks: [],
      assignment: null, lastMessageSequence: 1, messageSeq: 1, lastMainSequence: 1, lastActivityAt: new Date().toISOString() })
    const version = Math.max(current.head.version, ...[...current.members, ...current.agents, ...current.groups, ...current.machines,
      ...current.starts, ...current.progress].map(p => p.version)) + 1
    for (const model of [tx.swarmHead, tx.swarmMember, tx.swarmAgent, tx.swarmGroup, tx.swarmMachine, tx.swarmStart, tx.swarmProgress] as unknown as
      Array<{ deleteMany(args: unknown): Promise<unknown> }>) await model.deleteMany({ where: { tabId: tab } })
    await parts.insertParts(tx, { ...parts.split(state, { tabId: tab, version, now: Date.now(), visibilityEpoch: current.visibilityEpoch }),
      sequenceBase: current.sequenceBase })
    await tx.superTabMessage.create({ data: { id: messageId, tabId: tab, conversationId: id, sequence: 1, author: author as never, text,
      thread: messageId, recipientIds: agentIds, mentions: [], createdAt: new Date() } })
  })
  return { id, messageId }
}
