import { describe, expect, it } from 'vitest'
import type { Command, CommandContext } from './commands.js'
import { owner, stepsFixture } from './steps.test-support.js'

function setup() {
  const f = stepsFixture()
  const send = (text: string, options: { person?: boolean; by?: string; group?: string; extra?: Record<string, unknown>; reply?: CommandContext['reply'] } = {}) =>
    f.run({ type: 'message.send', conversationId: options.group ?? 'lead', text, replyTo: null, recipientIds: [], ...options.extra } as Command,
      options.person ? owner : f.as(options.by ?? f.lead), options.reply ? { reply: options.reply } : {})
  const person = { kind: 'person' as const, id: owner.userId, name: owner.email }
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
    const { send } = setup()
    expect(() => send('Status: tests running.', { extra: { mentions: [owner.userId] } })).toThrow(expect.objectContaining({ code: 'CHAT_STATUS' }))
  })

  it('refuses a repeated pull request card pointer but allows new facts with its link', () => {
    const { f, send } = setup()
    const url = 'https://github.com/acme/repo/pull/12'
    f.group('lead').cards = { pullRequests: [{ url, messageId: 'card' }] }
    expect(() => send(url)).toThrow(expect.objectContaining({ code: 'CHAT_CARD_REPEAT', message: expect.stringMatching(/card|thread/i) }))
    expect(() => send(`PR #12: ${url}`)).toThrow(expect.objectContaining({ code: 'CHAT_CARD_REPEAT' }))
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
