// A step a Swarm stored before Swarm v4, which opens none (2026-11-10), still ends with its task: an agent at work on it is
// stopped and told why, and a finished one archives with the task (task steps design; review of #3834).
import { describe, expect, it } from 'vitest'
import type { Command } from './commands.js'
import { stepsFixture } from './steps.test-support.js'

describe('a stored step ends with its task', () => {
  const fixture = () => {
    const f = stepsFixture()
    const review = f.step('Review'), tester = f.add('tester', review)
    f.run({ type: 'work.assign', conversationId: review, agentId: tester }, f.as(f.lead))
    const done = f.step('Lint'), linter = f.add('linter', done)
    const assigned = f.run({ type: 'work.assign', conversationId: done, agentId: linter }, f.as(f.lead)).result.assignmentId as string
    f.run({ type: 'work.status', conversationId: done, assignmentId: assigned, status: 'done', result: 'Clean.' } as Command, f.as(linter))
    return Object.assign(f, { review, tester, done })
  }

  it('cancels a working step when its task is cancelled, tells its agent, and leaves a finished one open until the task archives', () => {
    const f = fixture()
    const cancelled = f.run({ type: 'work.cancel', conversationId: f.task, assignmentId: f.group(f.task).assignment!.id, reason: 'Not needed' }, f.as(f.lead))
    expect(f.group(f.review).assignment).toMatchObject({ status: 'cancelled', result: 'Fix login was cancelled.' })
    expect(cancelled.messages).toContainEqual(expect.objectContaining({ conversationId: f.review, text: 'Fix login was cancelled.', recipients: [f.tester] }))
    expect(f.group(f.done).archived).toBe(false)
    f.run({ type: 'conversation.archive', conversationId: f.task, archived: true }, f.as(f.lead))
    expect(f.group(f.done).archived).toBe(true)
  })
})
