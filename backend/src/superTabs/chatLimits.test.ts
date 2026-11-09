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

  it('lets a visible response to an agent-only notice stand on its own, while still checking main content', () => {
    const { f, send } = setup()
    const note: NonNullable<CommandContext['reply']> = { id: 'notice', conversationId: 'lead', author: { kind: 'agent' as const, id: f.lead, name: 'PM', membershipGeneration: f.state.agents.find(a => a.id === f.lead)!.membershipGeneration }, createdAt: f.now, thread: 'notice', agentOnly: true }
    expect(() => send('The worker has resumed.', { reply: note, extra: { replyTo: note.id } })).not.toThrow()
    expect(() => send('Status: worker resumed.', { reply: note, extra: { replyTo: note.id } })).toThrow(expect.objectContaining({ code: 'CHAT_STATUS' }))
  })

})


