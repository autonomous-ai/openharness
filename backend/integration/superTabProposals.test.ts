import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import { applyCommand, type Command } from '../src/superTabs/commands.js'
import { createSuperTab, type Actor, type SuperTabState } from '../src/superTabs/model.js'
import { listNamedIndexes } from '../src/superTabs/parts/indexed.js'
import { databaseProposalReads, openProposals } from '../src/superTabs/proposals.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// The Tasks view's Proposals (#2569) read the project chat's proposal roots and their threads as the chat page does. A busy
// project chat holds thousands of rows, nearly all task lines and talk: the roots' read must not walk them.
let replica: MongoMemoryReplSet
let db: PrismaClient
let state: SuperTabState
const TAB = 'swarm', CHAT = 'lead', CHAT_ROWS = 3_000
const owner: Actor = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const T0 = Date.parse('2026-11-01T00:00:00.000Z')

beforeAll(async () => {
  ({ replica, db } = await planDatabase('swarm_proposals_test'))
  await listNamedIndexes(db)
  state = createSuperTab(TAB, 'Pilot', { id: 'owner', email: 'owner@example.com' }, 'test')
  let next = 0
  const run = (command: Command) => { state = applyCommand(state, owner, command, { operationId: `op${next++}`, now: T0,
    contribution: { machineOwnerId: 'host', contributorId: 'owner' } }).state }
  run({ type: 'project.cadence', projectId: 'lead', minutes: 5 })
  run({ type: 'agent.add', conversationId: CHAT, harnessId: 'pm', machineId: 'machine', name: 'pm', configuration, lead: true })
  const pm = state.conversations.find(c => c.id === CHAT)!.leadId!
  const person = { kind: 'person', id: 'peer', name: 'peer@example.com', membershipGeneration: 'first' }
  let sequence = 0
  const message = (id: string, extra: Record<string, unknown> = {}) => ({ id, tabId: TAB, conversationId: CHAT, sequence: ++sequence, author: person,
    text: 'Talk', recipientIds: [], mentions: [], thread: id, createdAt: new Date(T0 + sequence * 1000), ...extra })
  const proposal = (id: string, title: string) => [
    message(id, { text: `Let's build: ${title}`, source: { kind: 'buddy-proposal', personId: 'peer', buddyId: 'buddy', ownerMessageId: `ask-${id}` } }),
    message(`${id}-details`, { author: { kind: 'agent', id: 'buddy', name: 'Buddy' }, text: 'Goal: ...', replyTo: id, thread: id }),
  ]
  const rows = [
    ...proposal('open', 'Sync edits'),
    ...proposal('answered', 'Answered'), message('answered-pm', { author: { kind: 'agent', id: pm, name: 'pm' }, replyTo: 'answered', thread: 'answered' }),
    ...proposal('tasked', 'Tasked'), message('tasked-line', { author: { kind: 'agent', id: pm, name: 'pm' }, replyTo: 'tasked', thread: 'tasked',
      source: { kind: 'system', ask: 'on-it' } }),
    // From before threads: no thread at all, and nobody answered it.
    { ...message('old', { text: "Let's build: Old proposal", source: { kind: 'buddy-proposal', personId: 'peer' } }), thread: undefined },
  ]
  // The project chat's other rows: task lines with their replies, and people talking.
  for (let i = 0; rows.length < CHAT_ROWS; i++) {
    rows.push(message(`line-${i}`, { source: { kind: 'task-line' } }), message(`line-${i}-reply`, { replyTo: `line-${i}`, thread: `line-${i}`, source: { kind: 'system', ask: 'on-it' } }),
      message(`talk-${i}`))
  }
  // Another proposal last, so the newest rows are not all proposals.
  rows.push(...proposal('newest', 'Newest'))
  await db.superTabMessage.createMany({ data: rows.map(({ thread, ...row }) => ({ ...row, ...thread ? { thread } : {} })) as never })
}, 180_000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

describe('the open-proposal read', () => {
  it('lists the unanswered proposals, oldest first, from the chat the database holds', async () => {
    const chat = state.conversations.find(c => c.id === CHAT)!
    expect(await openProposals(state, chat, databaseProposalReads(db, TAB, CHAT))).toEqual([
      { messageId: 'open', title: 'Sync edits', personId: 'peer', at: T0 + 1000 },
      { messageId: 'old', title: 'Old proposal', personId: 'peer', at: T0 + 9000 },
      { messageId: 'newest', title: 'Newest', personId: 'peer', at: expect.any(Number) },
    ])
  })

  it('reads the roots by their own index, examining only the proposals', async () => {
    const chat = state.conversations.find(c => c.id === CHAT)!
    const entries = await profiled(db, () => openProposals(state, chat, databaseProposalReads(db, TAB, CHAT)))
    const rows = reads(entries, 'SuperTabMessage', ['source.kind'])
    expect(rows, JSON.stringify(plan(rows))).toHaveLength(1)
    expect(rows[0]!.planSummary, JSON.stringify(plan(rows))).toMatch(/IXSCAN \{ tabId: 1, conversationId: 1, source\.kind: 1, sequence: 1 \}/)
    // Five proposal roots among 3,000 rows.
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(5)
  })
})
