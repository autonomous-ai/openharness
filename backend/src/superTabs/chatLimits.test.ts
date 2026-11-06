import { describe, expect, it } from 'vitest'
import type { Command, CommandContext } from './commands.js'
import { owner, stepsFixture } from './steps.test-support.js'

function setup() {
  const f = stepsFixture()
  const send = (text: string, options: { person?: boolean; by?: string; group?: string; extra?: Record<string, unknown>; reply?: CommandContext['reply'] } = {}) =>
    f.run({ type: 'message.send', conversationId: options.group ?? 'lead', text, replyTo: null, recipientIds: [], ...options.extra } as Command,
      options.person ? owner : f.as(options.by ?? f.lead), options.reply ? { reply: options.reply } : {})
  const person = { kind: 'person' as const, id: owner.userId, name: owner.email, membershipGeneration: f.state.people[0]!.generation }
  const ask = () => {
    const id = send('Can you fix login?', { person: true }).result.messageId as string
    return { id, conversationId: 'lead', author: person, createdAt: f.now, thread: id }
  }
  return { f, send, ask }
}

describe('project chat content limits', () => {
  it.each(['Status: tests running.', 'Ready for review: PR #12.', 'On it: I am fixing login.', 'CI: 3 checks pending.', 'Progress update: branch pushed.'])(
    'refuses the status line %j with thread guidance', text => {
      const { send } = setup()
      expect(() => send(text)).toThrow(expect.objectContaining({ code: 'CHAT_STATUS', message: expect.stringMatching(/thread|status/i) }))
    })

  it('does not let a file or person tag bypass a status refusal', () => {
    const { f, send } = setup()
    expect(() => send('Status: tests running.', { extra: { mentions: [owner.userId] } })).toThrow(expect.objectContaining({ code: 'CHAT_STATUS' }))
    expect(() => f.run({ type: 'message.send', conversationId: 'lead', text: 'Status: tests running.', replyTo: null, recipientIds: [], attachmentIds: ['file'] }, f.as(f.lead),
      { attachments: [{ id: 'file', name: 'evidence.txt', mime: 'text/plain', size: 12, url: 'https://files.invalid/evidence' }] }))
      .toThrow(expect.objectContaining({ code: 'CHAT_STATUS' }))
  })

  it('refuses a repeated pull request card pointer but allows new facts with its link', () => {
    const { f, send } = setup()
    const url = 'https://github.com/acme/repo/pull/12'
    f.group('lead').cards = { pullRequests: [{ url, messageId: 'card' }] }
    expect(() => send(url)).toThrow(expect.objectContaining({ code: 'CHAT_CARD_REPEAT', message: expect.stringMatching(/card|thread/i) }))
    expect(() => send(`PR #12: ${url}`)).toThrow(expect.objectContaining({ code: 'CHAT_CARD_REPEAT' }))
    expect(() => send('PR #12')).toThrow(expect.objectContaining({ code: 'CHAT_CARD_REPEAT' }))
    expect(() => send(`The login fix shipped in 2.3. ${url}`)).not.toThrow()
    expect(() => send('https://github.com/acme/repo/pull/13')).not.toThrow()
  })

  it('refuses an exact repeat of the task card title or number', () => {
    const { f, send } = setup()
    f.group(f.task).cards = { line: { messageId: 'task-card', conversationId: 'lead' } }
    expect(() => send(`#${f.group(f.task).number} ${f.group(f.task).title}`)).toThrow(expect.objectContaining({ code: 'CHAT_CARD_REPEAT' }))
    expect(() => send(`#${f.group(f.task).number}`)).toThrow(expect.objectContaining({ code: 'CHAT_CARD_REPEAT' }))
    expect(() => send('Login now works offline.')).not.toThrow()
  })

  it('preserves people, task posts, thread followups and substantive short answers', () => {
    const { f, send, ask } = setup()
    const question = ask()
    expect(() => send('Status: tests running.', { person: true })).not.toThrow()
    expect(() => send('Ready for review: PR #12.', { group: f.task, by: f.dev })).not.toThrow()
    expect(() => send('CI: 3 checks pending.', { extra: { replyTo: question.id }, reply: question })).not.toThrow()
    expect(() => send('Is CI green?')).not.toThrow()
    expect(() => send('The release is out; login works offline.')).not.toThrow()
    expect(() => send('Status: tests running.', { extra: { agentOnly: true, recipientIds: [f.lead] } })).not.toThrow()
  })

  it('checks status on a thread reply mirrored into main chat', () => {
    const { send, ask } = setup()
    const question = ask()
    expect(() => send('CI: still running.', { reply: question, extra: { replyTo: question.id, alsoSend: true } }))
      .toThrow(expect.objectContaining({ code: 'CHAT_STATUS' }))
  })
})

describe('two main posts per ask', () => {
  it('shares the budget across agents and directs the third post to the thread', () => {
    const { f, send, ask } = setup()
    ask()
    send('I can fix login.')
    send('Login now works offline.', { by: f.dev })
    expect(() => send('The fix also handles expired tokens.')).toThrow(expect.objectContaining({ code: 'CHAT_MAIN_LIMIT', message: expect.stringMatching(/two|2/i) }))
  })

  it('gives a new top-level person ask its own budget, without resetting an older linked ask', () => {
    const { send, ask } = setup()
    const first = ask()
    send('I can fix login.')
    send('Login now works offline.')
    ask()
    expect(() => send('I can fix logout too.')).not.toThrow()
    expect(() => send('The old fix also handles expired tokens.', { reply: first, extra: { answers: first.id } }))
      .toThrow(expect.objectContaining({ code: 'CHAT_MAIN_LIMIT' }))
  })

  it('allows thread followups but counts replies mirrored into main', () => {
    const { send, ask } = setup()
    const question = ask()
    send('I can fix login.')
    const first = send('Login works offline now.', { reply: question, extra: { replyTo: question.id, alsoSend: true } })
    const response = { ...question, id: String(first.result.messageId), author: first.messages[0]!.author }
    expect(() => send('Expired tokens work too.', { reply: response, extra: { replyTo: response.id } })).not.toThrow()
    expect(() => send('The mobile build also has the fix.', { reply: question, extra: { replyTo: question.id, alsoSend: true } }))
      .toThrow(expect.objectContaining({ code: 'CHAT_MAIN_LIMIT' }))
  })

  it('does not let a thread person followup reset its root main budget', () => {
    const { send, ask } = setup()
    const question = ask()
    send('I can fix login.')
    send('Login now works offline.')
    send('Does it work on phones?', { person: true, reply: question, extra: { replyTo: question.id } })
    expect(() => send('Yes, on phones too.')).toThrow(expect.objectContaining({ code: 'CHAT_MAIN_LIMIT' }))
  })

  it('never limits person posts, task posts or agent-only notices', () => {
    const { f, send, ask } = setup()
    ask()
    send('I can fix login.')
    send('Login now works offline.')
    for (let i = 0; i < 3; i++) {
      expect(() => send(`Person followup ${i}`, { person: true })).not.toThrow()
      expect(() => send(`Task detail ${i}`, { group: f.task, by: f.dev })).not.toThrow()
      expect(() => send(`Private note ${i}`, { extra: { agentOnly: true, recipientIds: [f.lead] } })).not.toThrow()
    }
  })

  it('cannot reopen an evicted ask after 50 newer asks, and does not expose its ledger', async () => {
    const { f, send, ask } = setup()
    const first = ask()
    send('I can fix login.')
    send('Login now works offline.')
    for (let i = 0; i < 50; i++) { f.tick(1); ask() }
    expect(() => send('An old result.', { reply: first, extra: { answers: first.id } })).toThrow(expect.objectContaining({ code: 'CHAT_ASK_CLOSED' }))
    const { groupView } = await import('./read/views.js')
    expect(groupView(f.group('lead'), new Set())).not.toHaveProperty('chatLimits')
  })
})


describe('one answer across main and thread', () => {
  it.each(['main', 'thread'] as const)('refuses a plain second answer after the first in %s, even by another agent', place => {
    const { f, send, ask } = setup()
    const question = ask()
    const first = send('Login works offline.', { by: f.dev, reply: question,
      extra: place === 'main' ? { answers: question.id } : { replyTo: question.id } })
    const messageId = first.result.messageId
    for (const extra of [{ answers: question.id }, { replyTo: question.id }]) {
      expect(() => send('Yes, it works offline.', { reply: question, extra }))
        .toThrow(expect.objectContaining({ code: 'ALREADY_ANSWERED', message: expect.stringContaining(String(messageId)) }))
    }
  })

  it('allows replying to an agent answer and answering a new person followup in that thread', () => {
    const { f, send, ask } = setup()
    const question = ask()
    const first = send('Login works offline.', { reply: question, extra: { answers: question.id } })
    const reply = { ...question, id: String(first.result.messageId), author: first.messages[0]!.author }
    expect(() => send('The phone build includes it too.', { reply, extra: { replyTo: reply.id } })).not.toThrow()
    const next = send('Does it handle expired tokens?', { person: true, reply, extra: { replyTo: reply.id } })
    const followup = { ...question, id: String(next.result.messageId) }
    expect(() => send('Expired tokens are refreshed.', { by: f.dev, reply: followup, extra: { replyTo: followup.id } })).not.toThrow()
    expect(() => send('They are refreshed automatically.', { reply: followup, extra: { answers: followup.id, answer: true } }))
      .toThrow(expect.objectContaining({ code: 'ALREADY_ANSWERED' }))
  })

  it('preserves person answers and agent duplicates in a task chat', () => {
    const { f, send, ask } = setup()
    const question = ask()
    send('Login works offline.', { reply: question, extra: { answers: question.id } })
    for (let i = 0; i < 3; i++) expect(() => send(`Person answer ${i}`, { person: true, reply: question, extra: { answers: question.id } })).not.toThrow()
    const taskReply = { ...question, conversationId: f.task }
    for (let i = 0; i < 3; i++) expect(() => send(`Task answer ${i}`, { by: f.dev, group: f.task, reply: taskReply, extra: { answers: taskReply.id } })).not.toThrow()
  })

  it('does not reopen a formal answer after its ask has left the active ledger', () => {
    const { f, send, ask } = setup()
    const first = ask()
    send('Login works offline.', { by: f.dev, reply: first, extra: { replyTo: first.id } })
    for (let i = 0; i < 51; i++) { f.tick(1); ask() }
    expect(() => send('Yes, offline works.', { reply: first, extra: { replyTo: first.id, answers: undefined } }))
      .toThrow(expect.objectContaining({ code: 'CHAT_ASK_CLOSED' }))
  })
})
