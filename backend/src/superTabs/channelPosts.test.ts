/**
 * Swarm v4: a project's channel is where its agents talk (anh Dee, 2026-11-08). The v3 limits on an agent's posts there go
 * (2026-11-10): no status-line refusal, no two-posts-per-ask budget, and no refusal of a second answer to one message, which
 * an older CLI's `answer` command still asks for.
 */
import { describe, expect, it } from 'vitest'
import type { Command, CommandContext } from './commands.js'
import type { Author } from './model.js'
import { stepsFixture } from './steps.test-support.js'

function setup() {
  const f = stepsFixture()
  const asker = { kind: 'agent', id: f.dev } as Author
  const asked = f.run({ type: 'message.send', conversationId: 'lead', text: 'Is the release out?', replyTo: null, recipientIds: [] } as Command, f.as(f.dev)).result.messageId as string
  const reply: Partial<CommandContext> = { reply: { id: asked, conversationId: 'lead', author: asker, createdAt: 0, thread: asked } }
  const post = (by: string, text: string, extra: Record<string, unknown> = {}, context: Partial<CommandContext> = {}) =>
    f.run({ type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [], ...extra } as Command, f.as(by), context)
  return { f, asked, reply, post }
}

describe('an agent\'s posts in its project\'s channel', () => {
  it('go out as written, a status line too', () => {
    const { f, post } = setup()
    expect(post(f.dev, 'Status: building the login fix.').messages.map(m => m.text)).toEqual(['Status: building the login fix.'])
  })

  it('answer one message as often as the agents need', () => {
    const { f, asked, reply, post } = setup()
    for (const text of ['Out at 09:00.', 'The hotfix too.', 'And the notes are up.']) post(f.lead, text, { answers: asked }, reply)
    expect(post(f.lead, 'Answered again.', { answers: asked, answer: true }, reply).messages.map(m => m.text)).toEqual(['Answered again.'])
  })
})
