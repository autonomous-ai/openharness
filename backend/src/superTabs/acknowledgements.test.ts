import { describe, expect, it } from 'vitest'
import type { Command } from './commands.js'
import { isAcknowledgement, isEmojiOnly } from './acknowledgements.js'
import { owner, stepsFixture } from './steps.test-support.js'

describe('isAcknowledgement (task #3391)', () => {
  it.each(['on it', 'On it!', 'Got it.', 'got it, thanks', 'Thanks!', 'thank you', 'Will do', 'Noted. Will do.', 'Understood 👍', 'ack', 'copy that'])(
    'reads %j as an acknowledgement', text => expect(isAcknowledgement(text)).toBe(true))

  it.each(['Yes at 1a2b3c', 'Yes', 'ok', 'Done', 'on it?', 'got it #12', 'thanks, merged', 'on it: https://github.com/a/b/pull/3',
    'see github.com/a/b', 'Will do after the build', 'will do in 5 minutes', 'on it @Ken', 'Thanks for the review, fixed in abc123', '', '   ', '👍',
    // A courtesy after an answer does not make the answer an acknowledgement (review of #3391: Hugo).
    'Yes, thanks.', 'Okay, thanks.', 'Yes', 'Yep, got it', 'Sure, will do', 'ok, on it', 'Great, thanks'])(
    'lets %j through', text => expect(isAcknowledgement(text)).toBe(false))
})

describe('isEmojiOnly (the rehearsal of 2026-11-11)', () => {
  it.each(['👍', '👍🏽', '👋', '🙏🙏', '✅ ', '👍!', '❤️', '❌', '❓'])('reads %j as emoji alone', text => expect(isEmojiOnly(text)).toBe(true))

  it.each(['Yes 👍', 'ok 👍', '👍?', '1️⃣', '@Ken 👍', '#12 ✅', 'see a/b 👍', '...', '', '   ', 'thanks'])(
    'lets %j through', text => expect(isEmojiOnly(text)).toBe(false))
})

describe('an agent post that only acknowledges', () => {
  const send = (f: ReturnType<typeof stepsFixture>, by: string | null, text: string, extra: Record<string, unknown> = {}, on = f.task) =>
    f.run({ type: 'message.send', conversationId: on, text, replyTo: null, recipientIds: [], ...extra } as Command, by ? f.as(by) : owner)

  it('is refused with ACK_ONLY and the next step', () => {
    const f = stepsFixture()
    for (const text of ['on it', 'Got it, thanks!', 'will do']) {
      // The next step is to say nothing until there is substance.
      expect(() => send(f, f.dev, text)).toThrow(expect.objectContaining({ code: 'ACK_ONLY', message: expect.stringMatching(/^(?!.*react).*substance/is) }))
    }
  })

  it('is refused in the project chat and as a reply too', () => {
    const f = stepsFixture()
    expect(() => send(f, f.dev, 'on it', {}, 'lead')).toThrow(expect.objectContaining({ code: 'ACK_ONLY' }))
    expect(() => send(f, f.lead, 'thanks', { recipientIds: [f.dev] })).toThrow(expect.objectContaining({ code: 'ACK_ONLY' }))
  })

  // A person posts only in their own chat with their agent (agentsOnly.test.ts).
  it('lets real short answers through, and never refuses a person', () => {
    const f = stepsFixture()
    for (const text of ['Yes at 1a2b3c', 'https://github.com/a/b/pull/3', 'Merged.', 'on it?', 'Yes, thanks.', 'Okay, thanks.']) expect(() => send(f, f.dev, text)).not.toThrow()
    const chat = f.run({ type: 'agent.new', kind: 'regular', name: 'Ada', machineId: 'owner-mac', engine: 'claude', local: true } as Command, owner,
      { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).result.conversationId as string
    expect(() => send(f, null, 'on it', {}, chat)).not.toThrow()
    expect(() => send(f, null, 'thanks', {}, chat)).not.toThrow()
  })

  // The rehearsal of 2026-11-11: Kai posted "thanks @Ray, stopping. 👋" and the PM replied 👍, which reached Kai, the agent whose
  // message it answered, and started its turn again; the same under Cy's.
  const under = (f: ReturnType<typeof stepsFixture>, by: string, text: string, author: string) =>
    f.run({ type: 'message.send', conversationId: 'lead', text, replyTo: 'bye', recipientIds: [] } as Command, f.as(by),
      { reply: { id: 'bye', conversationId: 'lead', author: { kind: 'agent', id: author }, createdAt: 0, thread: 'bye' } as never })
  const reached = (effects: ReturnType<typeof under>) => effects.messages.filter(m => m.source?.kind !== 'system').map(m => m.recipients)

  it('of emoji alone, under another agent\'s goodbye, is refused, so it reaches nobody', () => {
    const f = stepsFixture()
    for (const text of ['👍', '👋', '🙏']) expect(() => under(f, f.lead, text, f.dev)).toThrow(expect.objectContaining({ code: 'ACK_ONLY' }))
    // Words beside it still reach the agent it answers.
    expect(reached(under(f, f.lead, 'Yes 👍', f.dev))).toEqual([[f.dev]])
  })

  it('of emoji alone is told to say in words what it answers or asks, and else to post nothing', () => {
    const f = stepsFixture()
    expect(() => under(f, f.lead, '👍', f.dev)).toThrow(expect.objectContaining({ message: expect.stringMatching(/answers or asks.*in words.*post nothing/i) }))
  })

  it('of emoji alone still reaches the agent from its person, whose answer it can be', () => {
    const f = stepsFixture()
    const chat = f.state.conversations.find(c => c.kind === 'agent-chat' && c.agentIds.includes(f.lead))!.id
    expect(reached(send(f, null, '👍', {}, chat))).toEqual([[f.lead]])
  })

  it('passes with a tag or a note to itself', () => {
    const f = stepsFixture()
    expect(() => send(f, f.dev, 'on it', { agentOnly: true, recipientIds: [f.dev] })).not.toThrow()
  })
})
