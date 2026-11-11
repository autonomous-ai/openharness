import { describe, expect, it } from 'vitest'
import type { Command } from './commands.js'
import { isAcknowledgement } from './acknowledgements.js'
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

  it('passes with a tag or a note to itself', () => {
    const f = stepsFixture()
    expect(() => send(f, f.dev, 'on it', { agentOnly: true, recipientIds: [f.dev] })).not.toThrow()
  })
})
