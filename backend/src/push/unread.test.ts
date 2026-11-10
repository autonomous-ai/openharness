import { beforeEach, describe, expect, it, vi } from 'vitest'
const m = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../utils/logger.js', () => ({ logger: { warn: m.warn, info: vi.fn(), error: m.warn } }))
import { quietUnread } from './unread.js'
import type { PhoneNotice } from './sender.js'

const notice = (key: string, chat?: string, sequence = 5): PhoneNotice => ({ personId: 'p', key, title: 't', subtitle: '', body: '',
  link: 'swarm:t/c/message/m', slot: key, ...chat ? { unreadBefore: { mark: `mark-${chat}`, tabId: 't', conversationId: chat, sequence } } : {} })
/** A database holding these read marks and the chats' rows before the write (by chat: who wrote it), or whose reads fail. */
const held = (marks: Record<string, number>, rows: Record<string, { kind: string; id: string }> | Error) => {
  const mark = vi.fn(async () => Object.entries(marks).map(([_id, sequence]) => ({ _id, sequence })))
  const row = vi.fn(async () => {
    if (rows instanceof Error) throw rows
    return Object.entries(rows).map(([conversationId, author]) => ({ conversationId, sequence: 5, author }))
  })
  return { db: { superTabReadMark: { aggregateRaw: mark }, superTabMessage: { aggregateRaw: row } } as never, mark, row }
}

describe('quietUnread: an agent\'s chat sounds once until its person reads it (2026-11-10)', () => {
  beforeEach(() => vi.resetAllMocks())

  it('quiets a chat whose earlier agent words are unread; sounds after the person spoke, after they read, and for the rest', async () => {
    const agent = { kind: 'agent', id: 'oak' }
    const { db, mark, row } = held({ 'mark-read': 5, 'mark-behind': 3 }, { behind: agent, never: agent, read: agent, spoke: { kind: 'person', id: 'p' } })
    const notices = [notice('chat:t:behind', 'behind'), notice('chat:t:never', 'never'), notice('chat:t:read', 'read'), notice('chat:t:spoke', 'spoke'),
      notice('reply:r')]
    expect((await quietUnread(db, notices)).map(n => [n.key, n.quiet === true])).toEqual([['chat:t:behind', true], ['chat:t:never', true],
      ['chat:t:read', false], ['chat:t:spoke', false], ['reply:r', false]])
    expect(mark).toHaveBeenCalledExactlyOnceWith({ pipeline: [{ $match: { _id: { $in: ['mark-behind', 'mark-never', 'mark-read', 'mark-spoke'] } } },
      { $project: { _id: 1, sequence: 1 } }] })
    expect(row).toHaveBeenCalledOnce()
  })

  it('reads nothing when no chat notice is sent', async () => {
    const { db, mark, row } = held({}, {})
    const notices = [notice('reply:r')]
    expect(await quietUnread(db, notices)).toBe(notices)
    expect([mark.mock.calls.length, row.mock.calls.length]).toEqual([0, 0])
  })

  it('sounds every notice when what it weighs cannot be read, and says so', async () => {
    const { db } = held({}, new Error('primary stepped down'))
    const notices = [notice('chat:t:a', 'a')]
    expect(await quietUnread(db, notices)).toBe(notices)
    expect(m.warn).toHaveBeenCalledWith('phone push read marks not read', { chats: 1, error: 'primary stepped down' })
  })
})
