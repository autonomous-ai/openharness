/**
 * The PM answers each ask once, in its place (task #3403, anh Dee's Swarm redesign, 11-05): `answer` posts in the ask's thread
 * when it is in one, or right below it in the main chat, settles what the PM owes for it, and a second answer is refused saying
 * where the first one is.
 */
import { describe, expect, it } from 'vitest'
import type { Command, CommandContext } from './commands.js'
import { SuperTabError, type Author } from './model.js'
import { ALREADY_ANSWERED } from './answers.js'
import { owner, stepsFixture } from './steps.test-support.js'

function setup() {
  const f = stepsFixture()
  const person: Author = { kind: 'person', id: 'owner', name: owner.email, membershipGeneration: f.state.people[0]!.generation } as Author
  /** A person's message in the project chat, top-level or a reply in the thread of [reply] (whose root is [thread]). */
  const ask = (text: string, options: { reply?: string; thread?: string } = {}) => {
    const context: Partial<CommandContext> = options.reply
      ? { reply: { id: options.reply, conversationId: 'lead', author: person, createdAt: 0, thread: options.thread ?? options.reply } } : {}
    return { id: f.run({ type: 'message.send', conversationId: 'lead', text, replyTo: options.reply ?? null, recipientIds: [] }, owner, context).result.messageId as string,
      thread: options.reply ? options.thread ?? options.reply : null }
  }
  /** [by]'s answer to [question]: the store reads the message it answers into context.reply, its thread root included. */
  const answer = (by: string, question: { id: string; thread: string | null }, text: string, mode: { plain?: true } = {}) => {
    const effects = f.run({ type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [], answers: question.id,
      ...mode.plain ? {} : { answer: true } } as Command, f.as(by),
      { reply: { id: question.id, conversationId: 'lead', author: person, createdAt: 0, thread: question.thread } })
    return { effects, sent: effects.messages.find(m => m.text === text)! }
  }
  const refusal = (body: () => unknown): SuperTabError | null => {
    try { body(); return null } catch (error) { if (error instanceof SuperTabError) return error; throw error }
  }
  const owed = () => (f.group('lead').owed ?? []).map(a => a.id)
  return { f, ask, answer, refusal, owed }
}

describe('the PM\'s answer', () => {

  it('needs the message it answers', () => {
    const { f, refusal } = setup()
    expect(refusal(() => f.run({ type: 'message.send', conversationId: 'lead', text: 'Hi', replyTo: null, recipientIds: [], answer: true } as Command, f.as(f.lead)))?.code)
      .toBe('VALIDATION_ERROR')
  })

})

// Task #3747 (anh Dee, 11-06: "i don't know which one you reply to which... why don't you answer in those replies as threads?"):
// answers right below their asks stacked in the main chat and lost their questions. A project can answer every person's
// message in its thread instead.
describe('in a project that answers people in threads', () => {
  function threaded() {
    const s = setup()
    const projectId = s.f.group('lead').projectId ?? 'lead'
    s.f.run({ type: 'project.answers', projectId, inThread: true } as Command, s.f.as(s.f.lead))
    return { ...s, projectId }
  }

  it('leaves a post that answers nothing in the main chat, and an answer to an agent below it', () => {
    const { f } = threaded()
    const news = f.run({ type: 'message.send', conversationId: 'lead', text: 'v1.4.23 is out.', replyTo: null, recipientIds: [] }, f.as(f.lead))
    expect(news.messages.find(m => m.text === 'v1.4.23 is out.')).toMatchObject({ replyTo: null })
    const agent = { kind: 'agent', id: f.dev, name: 'dev' } as Author
    const effects = f.run({ type: 'message.send', conversationId: 'lead', text: 'The login fix ships tonight.', replyTo: null, recipientIds: [], answers: 'agent-line' } as Command,
      f.as(f.lead), { reply: { id: 'agent-line', conversationId: 'lead', author: agent, createdAt: 0, thread: null } })
    expect(effects.messages.find(m => m.text === 'The login fix ships tonight.')!.replyTo).toBeNull()
  })

  it('is set by the project\'s coordinator or a person who manages it, and turned off again; nobody else', () => {
    const { f, projectId, refusal } = threaded()
    expect(f.state.projects?.find(p => p.id === projectId)?.answersInThread).toBe(true)
    expect(refusal(() => f.run({ type: 'project.answers', projectId, inThread: false } as Command, f.as(f.dev)))?.code).toBe('COORDINATOR_REQUIRED')
    f.run({ type: 'project.answers', projectId, inThread: false } as Command, owner)
    expect(f.state.projects?.find(p => p.id === projectId)?.answersInThread).toBeUndefined()
  })

})
