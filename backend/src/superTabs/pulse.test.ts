/**
 * The board's pulse (task #3384, anh Dee's Swarm redesign, 11-05): what the PM owes and who works, from stored state, so
 * nothing waits unseen. On 11-05 the board showed Working 0 and five people's asks unanswered for 3-10 h because nothing
 * tracked what the PM owed and the idle checks ran only on the PM's poll.
 */
import { describe, expect, it } from 'vitest'
import type { Command, CommandContext } from './commands.js'
import type { Author } from './model.js'
import { owner, stepsFixture } from './steps.test-support.js'

const MINUTE = 60_000

function setup() {
  const f = stepsFixture()
  const person: Author = { kind: 'person', id: 'owner', name: owner.email, membershipGeneration: f.state.people[0]!.generation } as Author
  /** A message in [on] by [by] (a person when null); in reply to [reply] (its thread root [thread]) or answering [answers]. */
  const post = (by: string | null, on: string, text: string, options: { reply?: string; thread?: string; answers?: string; replyAuthor?: Author; recipientIds?: string[] } = {}) => {
    const target = options.reply ?? options.answers
    const context: Partial<CommandContext> = target
      ? { reply: { id: target, conversationId: on, author: options.replyAuthor ?? person, createdAt: 0, thread: options.thread ?? target } } : {}
    const effects = f.run({ type: 'message.send', conversationId: on, text, replyTo: options.reply ?? null, recipientIds: options.recipientIds ?? [],
      ...options.answers ? { answers: options.answers } : {} } as Command, by ? f.as(by) : owner, context)
    return effects.result.messageId as string
  }
  const owed = (on = 'lead') => (f.group(on).owed ?? []).map(ask => ask.id)
  const react = (by: string, on: string, messageId: string, emoji: string) => f.run({ type: 'message.react', conversationId: on, messageId, emoji, on: true } as Command,
    f.as(by), { reaction: { messageId, reacted: false } })
  const request = (id: string) => ({ id, conversationId: 'lead', replyTo: null, source: null, author: person })
  const taskFrom = (ask: string) => f.run({ type: 'conversation.create', title: 'From the ask', brief: 'Do it.', checks: [], requestMessageId: ask } as Command,
    f.as(f.lead), { request: request(ask) } as Partial<CommandContext>)
  return { f, post, owed, react, taskFrom, person }
}

describe('what the PM owes', () => {
  it('is a person\'s message to the PM, with who asked and when', () => {
    const { f, post } = setup()
    const ask = post(null, 'lead', 'Can the board show who is working?')
    expect(f.group('lead').owed).toEqual([{ id: ask, personId: 'owner', at: f.now, thread: ask }])
  })

  it('is not an agent\'s message, nor a person\'s to another agent', () => {
    const { f, post, owed } = setup()
    post(f.dev, 'lead', 'PR #12 is ready.')
    const line = post(f.dev, 'lead', 'Engineer here: a question for Ken.')
    // A person answering the Engineer's line in its thread talks to the Engineer, not the PM.
    post(null, 'lead', 'Use the second option.', { reply: line, replyAuthor: { kind: 'agent', id: f.dev, name: 'dev' } as Author })
    expect(owed()).toEqual([])
  })

  it('is not a message in a private chat', () => {
    const { f, post, owed } = setup()
    // An older Chat with PM: its audience is the person alone (new ones are closed, so it is written as stored).
    f.state.conversations.push({ id: 'private', title: 'Chat with PM', leadId: f.lead, agentIds: [f.lead], archived: false, brief: '', checks: [],
      assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'owner', generation: f.state.people[0]!.generation }] } } as never)
    try { post(null, 'private', 'A private question.') } catch { /* closed to new messages: nothing can be owed there either */ }
    expect(owed('private')).toEqual([])
  })

  it('is settled by the PM\'s reply in its thread, which settles the whole thread', () => {
    const { f, post, owed } = setup()
    const ask = post(null, 'lead', 'Why is Working 0?')
    const more = post(null, 'lead', 'Still nothing.', { reply: ask })
    const other = post(null, 'lead', 'And a second topic.')
    expect(owed()).toEqual([ask, more, other])
    post(f.lead, 'lead', 'Two agents start now.', { reply: more, thread: ask })
    expect(owed()).toEqual([other])
  })

  it('is settled by the PM\'s answer right below it, that message alone', () => {
    const { f, post, owed } = setup()
    const first = post(null, 'lead', 'First ask.')
    const second = post(null, 'lead', 'Second ask.')
    post(f.lead, 'lead', 'Done.', { answers: second })
    expect(owed()).toEqual([first])
  })

  it('is settled by the PM\'s verdict reaction, never by eyes', () => {
    const { f, post, owed, react } = setup()
    const ask = post(null, 'lead', 'Please merge #12.')
    react(f.lead, 'lead', ask, 'eyes')
    expect(owed()).toEqual([ask])
    react(f.lead, 'lead', ask, 'check')
    expect(owed()).toEqual([])
    for (const emoji of ['thumbs_up', 'rocket', 'tada']) {
      const next = post(null, 'lead', `Another ${emoji}.`)
      react(f.lead, 'lead', next, emoji)
      expect(owed()).toEqual([])
    }
  })

  it('is settled by a task the PM opens from it', () => {
    const { post, owed, taskFrom } = setup()
    const ask = post(null, 'lead', 'Show unanswered asks on the board.')
    taskFrom(ask)
    expect(owed()).toEqual([])
  })

  it('is not settled by another agent\'s reply or reaction', () => {
    const { f, post, owed, react } = setup()
    const ask = post(null, 'lead', 'Who reviews #12?')
    post(f.dev, 'lead', 'I can.', { reply: ask })
    react(f.dev, 'lead', ask, 'check')
    expect(owed()).toEqual([ask])
  })

  it('keeps the newest 50 of one chat', () => {
    const { f, post, owed } = setup()
    const asks = Array.from({ length: 55 }, (_, i) => { f.tick(MINUTE); return post(null, 'lead', `Ask ${i}.`) })
    expect(owed()).toEqual(asks.slice(5))
  })
})
