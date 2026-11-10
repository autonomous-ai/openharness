/**
 * Swarm v4 keeps no task lines, pulse or owed asks (2026-11-10): a task is the project's GitHub issue, and a PM is a plain agent.
 * A PM agent of an older CLI still names, for 30 days, the person's message a task came from and the ask it hands to another
 * agent. Its post and its task go through as before, and nothing of the board is kept or written.
 */
import { describe, expect, it } from 'vitest'
import type { Command } from './commands.js'
import { owner, stepsFixture } from './steps.test-support.js'

describe('what an older PM sends for the board', () => {
  it('posts a hand-off as written, to the agent it names, though no ask is owed', () => {
    const f = stepsFixture()
    const effects = f.run({ type: 'message.send', conversationId: f.task, text: 'Please answer Ken in the project chat.', replyTo: null,
      recipientIds: [f.dev], handoff: 'ask-1' } as Command, f.as(f.lead))
    expect(effects.messages.map(m => ({ text: m.text, recipients: m.recipients }))).toEqual([{ text: 'Please answer Ken in the project chat.', recipients: [f.dev] }])
  })

  it('opens a task from a person\'s message without reading it, and writes nothing in the project chat', () => {
    const f = stepsFixture()
    const effects = f.run({ type: 'conversation.create', title: 'Dark mode', brief: 'Add dark mode.', checks: [{ description: 'Dark mode works', independent: false }],
      priority: 'P2', requesterId: 'owner', requestMessageId: 'm-asked' } as Command, f.as(f.lead))
    const task = f.group(effects.result.conversationId as string)
    expect(task.title).toBe('Dark mode')
    expect(task.cards?.line).toBeUndefined()
    expect(effects.messages.filter(m => m.conversationId === 'lead')).toEqual([])
  })

  it('owes nothing for a person\'s message to the PM', () => {
    const f = stepsFixture()
    f.run({ type: 'message.send', conversationId: 'lead', text: 'Can the board show who is working?', replyTo: null, recipientIds: [] } as Command, owner)
    expect(f.group('lead')).not.toHaveProperty('owed')
    expect(f.group('lead')).not.toHaveProperty('pulse')
  })
})
