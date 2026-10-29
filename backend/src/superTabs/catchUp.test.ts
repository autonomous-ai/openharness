import { describe, expect, it } from 'vitest'
import { catchUpSummary, type CatchUpRow } from './catchUp.js'

const READER = 'reader-person'
const lead = { kind: 'agent' as const, id: 'lead-agent', name: 'Lead', displayName: 'River' }
const builder = { kind: 'agent' as const, id: 'builder-agent', name: 'Builder', displayName: 'Iris' }
const me = { kind: 'person' as const, id: READER, name: 'dee@example.com' }

let next = 0
/** One row as the store reads it, in the main stream unless a thread is given. */
function row(text: string, extra: Partial<CatchUpRow> = {}): CatchUpRow {
  const sequence = ++next
  return { id: `m${sequence}`, sequence, author: lead, source: null, text, thread: null, alsoInChat: null, mentions: [], ...extra }
}
const status = (text: string, author = builder) => row(text, { author, source: { kind: 'system' } })
const summary = (rows: CatchUpRow[], span: Partial<{ after: number; more: boolean; decisions: number }> = {}) =>
  catchUpSummary(rows, READER, { after: 0, more: false, decisions: 0, ...span })
const texts = (list: { items: Array<{ text: string }> }) => list.items.map(i => i.text)

describe('catch-up summary of the unread span', () => {
  it('lists a shipped row as landed, by its title, with a link to the row', () => {
    const shipped = row('🎉 Shipped: Avatars, built by Iris. https://github.com/o/r/pull/7', { source: { kind: 'ship', title: 'Avatars' } })
    const result = summary([row('Morning'), shipped])
    expect(result.landed).toEqual({ total: 1, items: [{ messageId: shipped.id, sequence: shipped.sequence, author: 'River', text: 'Avatars' }] })
    expect(result.blocked.total).toBe(0)
  })

  it('counts only the latest status: a task that moved on is no longer blocked', () => {
    expect(summary([status('Stuck\n\nNo simulator.'), status('Working')]).blocked.total).toBe(0)
    const stuck = summary([status('Working'), status('Stuck\n\nNo simulator on this Mac.\nMore detail.')])
    expect(texts(stuck.blocked)).toEqual(['Stuck: No simulator on this Mac.'])
    expect(texts(summary([status('Needs a human\n\nWhich colour?')]).blocked)).toEqual(['Needs a human: Which colour?'])
  })

  it('lists the latest Done as landed, with its result', () => {
    const result = summary([status('Stuck\n\nCI red.'), status('Done\n\nMerged #42.')])
    expect(texts(result.landed)).toEqual(['Done: Merged #42.'])
    expect(result.blocked.total).toBe(0)
  })

  it('reads a status only from a system row, not a message that says the same word', () => {
    expect(summary([row('Stuck')]).blocked.total).toBe(0)
  })

  it('lists messages that tag the reader, threads included, and not those tagging someone else', () => {
    const tagged = row('Dee, which colour?', { mentions: [READER] })
    const inThread = row('Dee, one more question', { mentions: [READER], thread: 'm1' })
    const result = summary([row('Ken, look', { mentions: ['someone-else'] }), tagged, inThread])
    expect(result.needsYou.items.map(i => i.messageId)).toEqual([tagged.id, inThread.id])
    expect(result.needsYou.items[0]).toMatchObject({ author: 'River', text: 'Dee, which colour?' })
  })

  it('counts unread main-stream messages from others only', () => {
    const result = summary([row('Mine', { author: me }), row('One'), row('Thread only', { thread: 'm1' }),
      row('Also in chat', { thread: 'm1', alsoInChat: true })])
    expect(result.unread).toBe(2)
  })

  it('starts after the reader\'s own newest message, since writing in a chat reads what came before', () => {
    const before = row('Before my answer', { mentions: [READER] })
    const stuck = status('Stuck\n\nOld.')
    const mine = row('My answer', { author: me })
    const after = row('After my answer', { mentions: [READER] })
    const result = summary([before, stuck, mine, after])
    expect(result.needsYou.items.map(i => i.messageId)).toEqual([after.id])
    expect(result.blocked.total).toBe(0)
    expect(result.unread).toBe(1)
    // A reply of the reader's own that lives only in a thread reads that thread, not the chat.
    expect(summary([before, row('Thread reply', { author: me, thread: 'm1' })]).needsYou.total).toBe(1)
  })

  it('keeps the five newest items of a list, oldest first, and counts them all', () => {
    const rows = Array.from({ length: 7 }, (_, i) => row(`Question ${i + 1}`, { mentions: [READER] }))
    const result = summary(rows)
    expect(result.needsYou.total).toBe(7)
    expect(texts(result.needsYou)).toEqual(['Question 3', 'Question 4', 'Question 5', 'Question 6', 'Question 7'])
  })

  it('past the cap, never lists a status as current: a later one may have replaced it; shipped rows and tags stand', () => {
    const shipped = row('🎉 Shipped: Avatars.', { source: { kind: 'ship', title: 'Avatars' } })
    const tagged = row('Dee, which colour?', { mentions: [READER] })
    const partial = summary([status('Stuck\n\nNo simulator.'), shipped, tagged], { more: true })
    expect(partial.blocked.total).toBe(0)
    expect(texts(partial.landed)).toEqual(['Avatars'])
    expect(texts(partial.needsYou)).toEqual(['Dee, which colour?'])
    expect(summary([status('Done\n\nMerged #42.')], { more: true }).landed.total).toBe(0)
  })

  it('shortens an item to its first line and 140 characters', () => {
    const [item] = summary([row(`${'a'.repeat(200)}\nsecond line`, { mentions: [READER] })]).needsYou.items
    expect(item!.text).toBe(`${'a'.repeat(139)}…`)
  })

  it('names a person by the start of their email, and answers the span it read', () => {
    const peer = { kind: 'person' as const, id: 'peer', name: 'ken@example.com' }
    const tagged = row('Dee?', { author: peer, mentions: [READER] })
    const result = summary([tagged], { after: 3, more: true, decisions: 2 })
    expect(result.needsYou.items[0]!.author).toBe('ken')
    expect(result).toMatchObject({ after: 3, through: tagged.sequence, more: true, decisions: 2 })
    expect(summary([], { after: 9 })).toMatchObject({ after: 9, through: 9, unread: 0 })
  })
})
