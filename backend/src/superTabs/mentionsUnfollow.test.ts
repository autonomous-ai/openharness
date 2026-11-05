import { describe, expect, it } from 'vitest'
import type { Prisma } from '@prisma/client'
import { writeMentions } from './mentions.js'
import { stableId, type MessageDraft, type SuperTabState } from './model.js'

// A tag in a thread the person unfollowed brings it back (Slack, anh Dee 11-05): the tag's write clears their Unfollow.

const NOW = 5_000
const state = { conversations: [{ id: 'chat', projectId: 'p' }] } as unknown as SuperTabState
const author = { kind: 'agent' as const, id: 'worker', name: 'Worker', membershipGeneration: 'g' }
const draft = (id: string, mentions: string[], thread?: string): MessageDraft =>
  ({ id, conversationId: 'chat', author, text: 'Please look.', replyTo: null, recipients: [], mentions, ...(thread ? { thread } : {}) })

/** A transaction that logs its writes: the tag rows created and the raw commands sent. */
function fakeTx() {
  const created: unknown[] = []
  const commands: Array<Record<string, any>> = []
  const tx = {
    superTabMention: { async createMany({ data }: { data: unknown[] }) { created.push(...data) } },
    async $runCommandRaw(command: Record<string, any>) { commands.push(command); return { nModified: 1 } },
  }
  return { tx: tx as unknown as Prisma.TransactionClient, created, commands }
}

describe('a tag in a thread brings back an unfollowed thread', () => {
  it('clears the tagged person\'s Unfollow of the thread, in the write of the tag', async () => {
    const { tx, created, commands } = fakeTx()
    await writeMentions(tx, 'tab', state, [draft('reply', ['peer', 'third'], 'root')], NOW)
    expect(created).toHaveLength(2)
    expect(commands).toHaveLength(1)
    const [update] = commands[0]!.updates
    expect(commands[0]!.update).toBe('SuperTabThreadMark')
    expect(update.q).toEqual({ _id: { $in: [stableId('tab', 'chat', 'root', 'peer'), stableId('tab', 'chat', 'root', 'third')] }, tabId: 'tab', follow: false })
    // Back to no choice: the tag now puts the thread on their list. updatedAt moves so their other devices read the change.
    expect(update.u).toEqual({ $set: { follow: null, updatedAt: { $date: new Date(NOW).toISOString() } } })
    expect(update.multi).toBe(true)
  })

  it('keeps an Unfollow when the reply tags nobody, and sends no extra command', async () => {
    const { tx, created, commands } = fakeTx()
    await writeMentions(tx, 'tab', state, [draft('reply', [], 'root'), draft('plain', [])], NOW)
    expect(created).toHaveLength(0)
    expect(commands).toEqual([])
  })

  it('leaves an Unfollow alone when the tag is in the chat, not in a thread', async () => {
    const { tx, created, commands } = fakeTx()
    await writeMentions(tx, 'tab', state, [draft('top', ['peer'])], NOW)
    expect(created).toHaveLength(1)
    expect(commands).toEqual([])
  })

  it('covers each thread and person of one write once', async () => {
    const { tx, commands } = fakeTx()
    await writeMentions(tx, 'tab', state, [draft('a', ['peer'], 'root'), draft('b', ['peer'], 'root'), draft('c', ['peer'], 'other')], NOW)
    expect(commands).toHaveLength(1)
    expect(commands[0]!.updates[0].q._id.$in.sort()).toEqual([stableId('tab', 'chat', 'root', 'peer'), stableId('tab', 'chat', 'other', 'peer')].sort())
  })
})
