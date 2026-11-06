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
  it('to a top-level ask goes right below it in the main chat, and settles it', () => {
    const { f, ask, answer, owed } = setup()
    const question = ask('Can the board show who works?')
    expect(owed()).toEqual([question.id])
    const { sent } = answer(f.lead, question, 'Yes, from tonight.')
    expect(sent.replyTo).toBeNull()
    expect(sent.thread ?? null).toBeNull()
    expect(owed()).toEqual([])
    expect(f.group('lead').answered?.map(a => ({ id: a.id, answerId: a.answerId, thread: a.thread }))).toEqual([{ id: question.id, answerId: sent.id, thread: null }])
  })

  it('to an ask inside a thread goes in that thread, not the main chat', () => {
    const { f, ask, answer, owed } = setup()
    const root = ask('Why is Working 0?')
    const inThread = ask('Still nothing after an hour.', { reply: root.id, thread: root.id })
    const { sent } = answer(f.lead, inThread, 'Two agents start now.')
    expect(sent.replyTo).toBe(inThread.id)
    expect(sent.thread).toBe(root.id)
    expect(owed()).toEqual([])
    expect(f.group('lead').answered?.find(a => a.id === inThread.id)?.thread).toBe(root.id)
  })

  it('is refused a second time, saying where the first answer is', () => {
    const { f, ask, answer, refusal } = setup()
    const question = ask('Is the release out?')
    const { sent } = answer(f.lead, question, 'Out at 09:00.')
    const again = refusal(() => answer(f.lead, question, 'Yes, it is out.'))
    expect(again?.code).toBe(ALREADY_ANSWERED)
    expect(again?.status).toBe(409)
    expect(again?.message).toContain('right below it')
    expect(again?.message).toContain(sent.id)
  })

  it('names the thread when the first answer is there', () => {
    const { f, ask, answer, refusal } = setup()
    const root = ask('A topic.')
    const inThread = ask('A follow-up.', { reply: root.id, thread: root.id })
    answer(f.lead, inThread, 'Answered in the thread.')
    expect(refusal(() => answer(f.lead, inThread, 'Again.'))?.message).toContain('in its thread')
  })

  it('is refused after the PM already answered with a plain post right below the ask', () => {
    const { f, ask, answer, refusal } = setup()
    const question = ask('Who is on #3403?')
    answer(f.lead, question, 'Rowan is.', { plain: true })
    expect(refusal(() => answer(f.lead, question, 'Rowan, on a Team account.'))?.code).toBe(ALREADY_ANSWERED)
  })

  it('refuses a second plain answer below the same project ask', () => {
    const { f, ask, answer, refusal } = setup()
    const question = ask('Is CI green?')
    answer(f.lead, question, 'Green.')
    expect(refusal(() => answer(f.lead, question, 'Still green after the batch.', { plain: true }))?.code).toBe(ALREADY_ANSWERED)
  })

  it('to a message nobody owed is posted in its place and recorded, so a second one is refused', () => {
    const { f, ask, answer, refusal } = setup()
    const question = ask('Thanks all.')
    f.group('lead').owed = undefined
    const { sent } = answer(f.lead, question, 'You are welcome.')
    expect(sent.replyTo).toBeNull()
    expect(refusal(() => answer(f.lead, question, 'Again.'))?.code).toBe(ALREADY_ANSWERED)
  })

  it('by an Engineer leaves PM owed settlement alone but blocks a second answer', () => {
    const { f, ask, answer, owed, refusal } = setup()
    const question = ask('Is the fix in?')
    // The Engineer has work in the project, so it posts in its chat without joining it.
    answer(f.dev, question, 'I pushed it.')
    expect(owed()).toEqual([question.id])
    expect(refusal(() => answer(f.lead, question, 'Merged at 21:00.'))?.code).toBe(ALREADY_ANSWERED)
  })

  it('needs the message it answers', () => {
    const { f, refusal } = setup()
    expect(refusal(() => f.run({ type: 'message.send', conversationId: 'lead', text: 'Hi', replyTo: null, recipientIds: [], answer: true } as Command, f.as(f.lead)))?.code)
      .toBe('VALIDATION_ERROR')
  })

  it('keeps the newest 50 answered asks of one chat', () => {
    const { f, ask, answer } = setup()
    const asks = Array.from({ length: 52 }, (_, i) => { const question = ask(`Ask ${i}`); answer(f.lead, question, `Answer ${i}`); return question.id })
    const answered = f.group('lead').answered!
    expect(answered.map(a => a.id)).toEqual(asks.slice(2))
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

  it('puts a plain answer and an answer to a person\'s main-chat message in its thread, and settles it', () => {
    const { f, ask, answer, owed } = threaded()
    const question = ask('Can the board show who works?')
    const { sent } = answer(f.lead, question, 'Yes, from tonight.', { plain: true })
    expect(sent.replyTo).toBe(question.id)
    expect(sent.thread).toBe(question.id)
    expect(owed()).toEqual([])
    const second = ask('And the costs?')
    const { sent: answered } = answer(f.lead, second, 'Tomorrow.')
    expect(answered.replyTo).toBe(second.id)
    expect(answered.thread).toBe(second.id)
    expect(f.group('lead').answered?.find(a => a.id === second.id)).toMatchObject({ answerId: answered.id, thread: second.id })
  })

  it('leaves a post that answers nothing in the main chat, and an answer to an agent below it', () => {
    const { f } = threaded()
    const news = f.run({ type: 'message.send', conversationId: 'lead', text: 'v1.4.23 is out.', replyTo: null, recipientIds: [] }, f.as(f.lead))
    expect(news.messages.find(m => m.text === 'v1.4.23 is out.')).toMatchObject({ replyTo: null })
    const agent = { kind: 'agent', id: f.dev, name: 'dev' } as Author
    const effects = f.run({ type: 'message.send', conversationId: 'lead', text: 'Noted.', replyTo: null, recipientIds: [], answers: 'agent-line' } as Command,
      f.as(f.lead), { reply: { id: 'agent-line', conversationId: 'lead', author: agent, createdAt: 0, thread: null } })
    expect(effects.messages.find(m => m.text === 'Noted.')!.replyTo).toBeNull()
  })

  it('is set by the project\'s coordinator or a person who manages it, and turned off again; nobody else', () => {
    const { f, projectId, refusal } = threaded()
    expect(f.state.projects?.find(p => p.id === projectId)?.answersInThread).toBe(true)
    expect(refusal(() => f.run({ type: 'project.answers', projectId, inThread: false } as Command, f.as(f.dev)))?.code).toBe('FORBIDDEN')
    f.run({ type: 'project.answers', projectId, inThread: false } as Command, owner)
    expect(f.state.projects?.find(p => p.id === projectId)?.answersInThread).toBeUndefined()
  })

  it('other projects answer right below, as before', () => {
    const { f, ask, answer } = setup()
    const question = ask('Can the board show who works?')
    expect(answer(f.lead, question, 'Yes.', { plain: true }).sent.replyTo).toBeNull()
  })
})
