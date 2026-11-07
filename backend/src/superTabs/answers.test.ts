/**
 * The PM answers each ask once, in its place (task #3403, anh Dee's Swarm redesign, 11-05): `answer` posts right below the ask,
 * quoting it, settles what the PM owes for it, and a second answer is refused saying where the first one is. No agent's post
 * goes in a thread (task #4555, anh Dee 11-07: every chat is one flat conversation).
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

  it('to an ask inside an old thread shows right below it in the chat, quoting it', () => {
    const { f, ask, answer, owed } = setup()
    const root = ask('Why is Working 0?')
    const inThread = ask('Still nothing after an hour.', { reply: root.id, thread: root.id })
    const { sent } = answer(f.lead, inThread, 'Two agents start now.')
    expect(sent.replyTo).toBeNull()
    expect(sent.thread ?? null).toBeNull()
    expect(sent.answers).toBe(inThread.id)
    expect(owed()).toEqual([])
    expect(f.group('lead').answered?.find(a => a.id === inThread.id)?.thread).toBeNull()
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

  it('names the thread when an answer from before #4555 is there', () => {
    const { f, ask, answer, refusal } = setup()
    const question = ask('A follow-up.')
    f.group('lead').answered = [{ id: question.id, answerId: 'old-answer', thread: 'old-root', at: 0 }]
    expect(refusal(() => answer(f.lead, question, 'Again.'))?.message).toContain('in its thread')
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

  // Every agent's reply shows in the chat now (task #4555), so another agent's answer no longer takes the PM's, which it still
  // owes (#3421): the PM answers once, and then nobody else does.
  it('by an Engineer leaves the ask owed by the PM, who still answers it once; then nobody else does', () => {
    const { f, ask, answer, owed, refusal } = setup()
    const question = ask('Is the fix in?')
    // The Engineer has work in the project, so it posts in its chat without joining it.
    answer(f.dev, question, 'I pushed it.')
    expect(owed()).toEqual([question.id])
    answer(f.lead, question, 'Merged at 21:00.')
    expect(owed()).toEqual([])
    // A third agent post on one ask is past its two in the chat, before it is a second answer.
    for (const by of [f.lead, f.dev]) expect(refusal(() => answer(by, question, 'In the next build.'))?.code).toBe('CHAT_MAIN_LIMIT')
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

// Task #4555 (anh Dee, 11-07 18:56): every chat is one flat conversation, and each reply shows which message it answers.
// Task #3747's setting, which put every answer to a person in its thread, is gone.
describe('no agent\'s post goes in a thread', () => {
  it('an agent\'s reply to a message shows in the chat, quoting it, as an older host\'s --reply-to too', () => {
    const { f, ask } = setup()
    const root = ask('Why is Working 0?')
    const inThread = ask('Still nothing after an hour.', { reply: root.id, thread: root.id })
    const person: Author = { kind: 'person', id: 'owner', name: owner.email, membershipGeneration: f.state.people[0]!.generation } as Author
    for (const [question, thread] of [[root.id, root.id], [inThread.id, root.id]] as const) {
      const text = `On ${question}.`
      const effects = f.run({ type: 'message.send', conversationId: 'lead', text, replyTo: question, recipientIds: [] }, f.as(f.dev),
        { reply: { id: question, conversationId: 'lead', author: person, createdAt: 0, thread } })
      const sent = effects.messages.find(m => m.text === text)!
      expect(sent).toMatchObject({ replyTo: null, answers: question })
      expect(sent.thread ?? null).toBeNull()
    }
  })

  it('leaves a person\'s reply in its thread, which an older app still sends', () => {
    const { f, ask } = setup()
    const root = ask('A topic.')
    const effects = f.run({ type: 'message.send', conversationId: 'lead', text: 'A reply.', replyTo: root.id, recipientIds: [] }, owner,
      { reply: { id: root.id, conversationId: 'lead', author: { kind: 'person', id: 'owner', name: owner.email, membershipGeneration: f.state.people[0]!.generation } as Author,
        createdAt: 0, thread: root.id } })
    expect(effects.messages.find(m => m.text === 'A reply.')).toMatchObject({ replyTo: root.id, thread: root.id })
  })

  it('reads a project\'s stored answer-in-thread setting no more', () => {
    const { f, ask, answer } = setup()
    const projectId = f.group('lead').projectId ?? 'lead'
    Object.assign(f.state.projects!.find(p => p.id === projectId)!, { answersInThread: true })
    const question = ask('Can the board show who works?')
    const { sent } = answer(f.lead, question, 'Yes, from tonight.', { plain: true })
    expect(sent).toMatchObject({ replyTo: null, answers: question.id })
  })

  it('has no command to turn it on', () => {
    const { f } = setup()
    expect(() => f.run({ type: 'project.answers', projectId: f.group('lead').projectId ?? 'lead', inThread: true } as unknown as Command, f.as(f.lead))).toThrow()
  })
})
