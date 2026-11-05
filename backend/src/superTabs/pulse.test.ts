/**
 * The board's pulse (task #3384, anh Dee's Swarm redesign, 11-05): what the PM owes and who works, from stored state, so
 * nothing waits unseen. On 11-05 the board showed Working 0 and five people's asks unanswered for 3-10 h because nothing
 * tracked what the PM owed and the idle checks ran only on the PM's poll.
 */
import { describe, expect, it } from 'vitest'
import type { Command, CommandContext } from './commands.js'
import type { Author } from './model.js'
import { sweepForLead } from './liveness.js'
import { projectsOf } from './projects.js'
import { recordPulse, storedPulse } from './pulse.js'
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

describe('the pulse', () => {
  /** The pulse as the next command or sweep records it on the project's chat (state edited by hand is counted too). */
  const pulseOf = (f: ReturnType<typeof stepsFixture>) => { recordPulse(f.state, f.now); return storedPulse(f.state, projectsOf(f.state)[0]!)! }
  /** The pulse as recorded, without working it out again. */
  const stored = (f: ReturnType<typeof stepsFixture>) => storedPulse(f.state, projectsOf(f.state)[0]!)!
  /** A task the PM opens, unassigned (Next up). */
  const open = (f: ReturnType<typeof stepsFixture>, title: string, extra: { notBefore?: string } = {}) => {
    const id = f.run({ type: 'conversation.create', title, brief: `${title}.`, checks: [] } as Command, f.as(f.lead)).result.conversationId as string
    if (extra.notBefore) f.run({ type: 'work.queue', conversationId: id, notBefore: extra.notBefore } as Command, f.as(f.lead))
    return id
  }
  const status = (f: ReturnType<typeof stepsFixture>, task: string, by: string, value: string, result: string | null) =>
    f.run({ type: 'work.status', conversationId: task, assignmentId: f.group(task).assignment!.id, status: value, result } as Command, f.as(by))

  it('counts the asks the PM owes, the oldest one\'s age and who asked', () => {
    const { f, post } = setup()
    const first = post(null, 'lead', 'First.')
    f.tick(4 * MINUTE)
    post(null, 'lead', 'Second.')
    const pulse = pulseOf(f)
    expect(pulse.pmId).toBe(f.lead)
    expect(pulse.asks).toMatchObject({ count: 2, oldestAt: f.now - 4 * MINUTE, personId: 'owner' })
    expect(pulse.asks.list[0]).toEqual({ conversationId: 'lead', messageId: first, personId: 'owner', at: f.now - 4 * MINUTE })
  })

  it('counts Working of the crew: agents of the project with a task they work on, never the PM', () => {
    const { f } = setup()
    const idle = f.add('idle', f.task)
    expect(pulseOf(f).working).toEqual({ count: 1, crew: 2, agentIds: [f.dev] })
    status(f, f.task, f.dev, 'review', 'PR #12')
    expect(pulseOf(f).working).toEqual({ count: 0, crew: 2, agentIds: [] })
    expect(idle).toBeTruthy()
  })

  it('counts Next up: open tasks nobody is assigned, never a step or a task set for a later day', () => {
    const { f } = setup()
    const a = open(f, 'Board strip'), b = open(f, 'Phone strip')
    f.step('Review')
    open(f, 'Later', { notBefore: '2099-01-01' })
    expect(pulseOf(f).nextUp).toEqual({ count: 2, conversationIds: [a, b] })
  })

  it('counts Lost with when the oldest lost its agent', () => {
    const { f } = setup()
    const lostAt = f.now
    f.group(f.task).assignment!.status = 'lost'
    f.group(f.task).assignment!.lost = { reason: 'its session stopped', at: lostAt }
    f.tick(3 * MINUTE)
    expect(pulseOf(f).lost).toEqual({ count: 1, since: lostAt, conversationIds: [f.task] })
  })

  it('counts Held: blocked or needs a person with its reason, an empty one as no reason, and a task set for a later day', () => {
    const { f } = setup()
    status(f, f.task, f.dev, 'blocked', 'Waiting for the Apple signing key.')
    const other = open(f, 'Second')
    const builder = f.add('builder', other)
    f.run({ type: 'work.assign', conversationId: other, agentId: builder }, f.as(f.lead))
    status(f, other, builder, 'needs_human', null)
    const later = open(f, 'Later', { notBefore: '2099-01-01' })
    const held = pulseOf(f).held
    expect(held.count).toBe(3)
    expect(held.withoutReason).toBe(1)
    expect(held.list).toEqual([{ conversationId: f.task, reason: 'Waiting for the Apple signing key.' },
      { conversationId: other, reason: null }, { conversationId: later, reason: 'not before 2099-01-01' }])
  })

  it('counts a blocked task whose agent is gone as Lost, not Held: it waits for an agent first', () => {
    const { f } = setup()
    status(f, f.task, f.dev, 'blocked', 'Waiting for the key.')
    f.group(f.task).liveness = { state: 'orphaned', why: 'removed', since: f.now }
    expect(pulseOf(f).lost.conversationIds).toEqual([f.task])
    expect(pulseOf(f).held.count).toBe(0)
  })

  it('gives no hold to a task set for a day already here', () => {
    const { f } = setup()
    const today = open(f, 'Today', { notBefore: new Date(f.now).toISOString().slice(0, 10) })
    expect(pulseOf(f).held.count).toBe(0)
    expect(pulseOf(f).nextUp.conversationIds).toContain(today)
  })

  it('says when each red rule turns red, by the limits it sends', () => {
    const { f, post } = setup()
    expect(pulseOf(f).limits).toEqual({ askMinutes: 15, idleMinutes: 10, lostMinutes: 10 })
    expect(pulseOf(f).redAt).toEqual({ asks: null, idle: null, lost: null, held: null })
    post(null, 'lead', 'An ask.')
    const askedAt = f.now
    expect(pulseOf(f).redAt.asks).toBe(askedAt + 15 * MINUTE)
    status(f, f.task, f.dev, 'blocked', null)
    expect(pulseOf(f).redAt.held).toBe(0)
  })

  it('a lost task turns red 10 minutes after it lost its agent', () => {
    const { f } = setup()
    f.group(f.task).assignment!.status = 'lost'
    f.group(f.task).assignment!.lost = { reason: 'its session stopped', at: f.now }
    expect(pulseOf(f).redAt.lost).toBe(f.now + 10 * MINUTE)
  })

  it('marks when Working fell to 0 while work waits, and turns red 10 minutes later; work again clears it', () => {
    const { f } = setup()
    open(f, 'Waiting task')
    expect(pulseOf(f).idleSince).toBeNull()
    f.tick(MINUTE)
    status(f, f.task, f.dev, 'done', 'Merged.')
    const idleAt = f.now
    f.tick(MINUTE)
    f.run({ type: 'message.send', conversationId: 'lead', text: 'Anyone?', replyTo: null, recipientIds: [] } as Command)
    expect(stored(f).idleSince).toBe(idleAt)
    expect(stored(f).asks.count).toBe(1)
    expect(pulseOf(f).redAt.idle).toBe(idleAt + 10 * MINUTE)
    const task = pulseOf(f).nextUp.conversationIds[0]!
    f.run({ type: 'work.assign', conversationId: task, agentId: f.dev }, f.as(f.lead))
    expect(pulseOf(f).idleSince).toBeNull()
    expect(pulseOf(f).redAt.idle).toBeNull()
  })

  it('marks idle on the PM\'s sweep too, where a lost task is found', () => {
    const { f } = setup()
    f.group(f.task).assignment!.status = 'lost'
    f.group(f.task).assignment!.lost = { reason: 'its session stopped', at: f.now }
    sweepForLead(f.state, f.now)
    expect(stored(f).idleSince).toBe(f.now)
    expect(stored(f).lost.count).toBe(1)
  })
})
