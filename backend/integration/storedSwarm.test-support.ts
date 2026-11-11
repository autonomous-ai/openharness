import type { Prisma, PrismaClient } from '@prisma/client'
import { swarmTransaction } from '../src/superTabs/cache.js'
import type { Author, SuperTabState } from '../src/superTabs/model.js'
import * as parts from '../src/superTabs/parts/index.js'
import { indexesOf } from '../src/superTabs/parts/commit.js'

export interface StoredMessage {
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

/** Stores [state] as the store keeps a Swarm (store.ts create): its row in parts with its lookup lists, every part at version
 *  [revision] written at [now], and [messages]; a conversation's last activity is its newest message's. Each conversation has
 *  its link list, as every one a command wrote has (store.ts appendPullRequestUrls), so the next command rewrites only what it
 *  changes. In one transaction. */
export async function storeSwarm(db: PrismaClient, input: { state: SuperTabState; revision: number; messages?: StoredMessage[] }, now = Date.now()) {
  const { revision, messages = [] } = input
  const state = structuredClone(input.state)
  const lastActivity = new Map<string, number>()
  for (const m of messages) lastActivity.set(m.conversationId, Math.max(lastActivity.get(m.conversationId) ?? 0, m.createdAt.getTime()))
  for (const group of state.conversations) group.pullRequestUrls ??= []
  for (const group of [...state.conversations, ...state.parkedConversations ?? []]) {
    if (lastActivity.has(group.id)) group.lastActivityAt ??= new Date(lastActivity.get(group.id)!).toISOString()
  }
  await swarmTransaction(db, async tx => {
    await tx.superTab.create({ data: { id: state.id, ownerId: state.ownerId, autonomousEnv: state.environment, revision, ...indexesOf(state),
      format: 2, state: { version: 2 } } })
    await parts.insertParts(tx, parts.split(state, { tabId: state.id, version: revision, now }))
    if (messages.length) await tx.superTabMessage.createMany({ data: messages.map(m => ({ id: m.id, tabId: state.id, conversationId: m.conversationId,
      sequence: m.sequence, author: json(m.author), text: m.text, replyTo: null, recipientIds: m.recipientIds ?? [], mentions: [],
      ...(m.source ? { source: json(m.source) } : {}), createdAt: m.createdAt })) })
  })
}
