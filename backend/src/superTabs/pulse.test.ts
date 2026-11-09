/**
 * The board's pulse (task #3384, anh Dee's Swarm redesign, 11-05): what the PM owes and who works, from stored state, so
 * nothing waits unseen. On 11-05 the board showed Working 0 and five people's asks unanswered for 3-10 h because nothing
 * tracked what the PM owed and the idle checks ran only on the PM's poll.
 */
import { describe, expect, it } from 'vitest'
import type { Command, CommandContext } from './commands.js'
import type { Author } from './model.js'
import { projectsOf } from './projects.js'
import { recordPulse, storedPulse } from './pulse.js'
import { owner, stepsFixture } from './steps.test-support.js'
import { owedLines } from './inbox.js'

const MINUTE = 60_000
/** What a task an agent opens must say (commands.ts): at least one check, with a priority and who asked. */
const DONE_WHEN = [{ description: 'It works', independent: false }]

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
  const react = (by: string, on: string, messageId: string, emoji: string, add = true) => f.run({ type: 'message.react', conversationId: on, messageId, emoji, on: add } as Command,
    f.as(by), { reaction: { messageId, reacted: false } })
  const request = (id: string) => ({ id, conversationId: 'lead', replyTo: null, source: null, author: person })
  const taskFrom = (ask: string) => f.run({ type: 'conversation.create', title: 'From the ask', brief: 'Do it.', checks: DONE_WHEN, priority: 'P2', requestMessageId: ask } as Command,
    f.as(f.lead), { request: request(ask) } as Partial<CommandContext>)
  return { f, post, owed, react, taskFrom, person, request }
}

describe('what the PM owes', () => {

  it('is not a message in a private chat', () => {
    const { f, post, owed } = setup()
    // An older Chat with PM: its audience is the person alone (new ones are closed, so it is written as stored).
    f.state.conversations.push({ id: 'private', title: 'Chat with PM', leadId: f.lead, agentIds: [f.lead], archived: false, brief: '', checks: [],
      assignment: null, lastMessageSequence: 0, audience: { people: [{ id: 'owner', generation: f.state.people[0]!.generation }] } } as never)
    try { post(null, 'private', 'A private question.') } catch { /* closed to new messages: nothing can be owed there either */ }
    expect(owed('private')).toEqual([])
  })

})

describe('the pulse', () => {
  /** The pulse as the next command or sweep records it on the project's chat (state edited by hand is counted too). */
  const pulseOf = (f: ReturnType<typeof stepsFixture>) => { recordPulse(f.state, f.now); return storedPulse(f.state, projectsOf(f.state)[0]!)! }
  /** The pulse as recorded, without working it out again. */
  const stored = (f: ReturnType<typeof stepsFixture>) => storedPulse(f.state, projectsOf(f.state)[0]!)!
  /** A task the PM opens, unassigned (Next up). */
  const open = (f: ReturnType<typeof stepsFixture>, title: string, extra: { notBefore?: string } = {}) => {
    const id = f.run({ type: 'conversation.create', title, brief: `${title}.`, checks: DONE_WHEN, priority: 'P2', requesterId: 'owner' } as Command, f.as(f.lead)).result.conversationId as string
    if (extra.notBefore) f.run({ type: 'work.queue', conversationId: id, notBefore: extra.notBefore, hold: { kind: 'requester' } } as Command, f.as(f.lead))
    return id
  }
  const status = (f: ReturnType<typeof stepsFixture>, task: string, by: string, value: string, result: string | null) =>
    f.run({ type: 'work.status', conversationId: task, assignmentId: f.group(task).assignment!.id, status: value, result } as Command, f.as(by))

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

  // ReviewPulse2's review of the merge with #3390: a hold's reason is the one main records (heldReason.ts heldView), never the
  // agent's result text; a hold with none recorded is "no reason", as the board shows it.
  it('counts Held with the reason recorded for it: blocked or needs a person, and a task set for a later day', () => {
    const { f } = setup()
    const later = '2099-01-01T00:00:00.000Z'
    f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.group(f.task).assignment!.id, status: 'blocked', result: null,
      hold: { kind: 'reset', what: 'quota', at: later } } as Command, f.as(f.dev))
    const other = open(f, 'Second')
    const builder = f.add('builder', other)
    f.run({ type: 'work.assign', conversationId: other, agentId: builder }, f.as(f.lead))
    status(f, other, builder, 'needs_human', 'Which bucket should the logs go to?')
    const dated = open(f, 'Later', { notBefore: '2099-01-01' })
    const held = pulseOf(f).held
    expect(held.count).toBe(3)
    expect(held.withoutReason).toBe(1)
    expect(held.list).toEqual([{ conversationId: f.task, reason: 'waits for a quota reset' },
      { conversationId: other, reason: null }, { conversationId: dated, reason: 'the requester asked for later, not before 2099-01-01' }])
  })

  it('turns red for a hold with no reason recorded, not for one with a reason and no words', () => {
    const { f } = setup()
    f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.group(f.task).assignment!.id, status: 'blocked', result: null,
      hold: { kind: 'requester' } } as Command, f.as(f.dev))
    expect(pulseOf(f).redAt.held).toBeNull()
    status(f, f.task, f.dev, 'blocked', 'Stuck on the key, says why in words only.')
    expect(pulseOf(f).redAt.held).toBe(0)
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

  it('a lost task turns red 10 minutes after it lost its agent', () => {
    const { f } = setup()
    f.group(f.task).assignment!.status = 'lost'
    f.group(f.task).assignment!.lost = { reason: 'its session stopped', at: f.now }
    expect(pulseOf(f).redAt.lost).toBe(f.now + 10 * MINUTE)
  })

})
