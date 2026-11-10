// A step a Swarm stored before Swarm v4, which opens none (2026-11-10), still ends with its task: an agent at work on it is
// stopped and told why, and a finished one archives with the task (task steps design; review of #3834).
import { describe, expect, it } from 'vitest'
import { stepsFixture } from './steps.test-support.js'
import { storedAssignment, storedStatus } from './storedWork.test-support.js'

describe('a stored step ends with its task', () => {
  const fixture = () => {
    const f = stepsFixture()
    const review = f.step('Review'), tester = f.add('tester', review)
    storedAssignment(f.state, review, tester, f.now)
    const done = f.step('Lint'), linter = f.add('linter', done)
    storedAssignment(f.state, done, linter, f.now)
    storedStatus(f.state, done, 'done', 'Clean.')
    return Object.assign(f, { review, tester, done })
  }

  it('cancels a working step when its task archives, tells its agent, and archives a finished one with it', () => {
    const f = fixture()
    // The task as work.cancel left it before Swarm v4.
    storedStatus(f.state, f.task, 'cancelled', 'Not needed')
    const archived = f.run({ type: 'conversation.archive', conversationId: f.task, archived: true }, f.as(f.lead))
    expect(f.group(f.review).assignment).toMatchObject({ status: 'cancelled', result: 'Fix login was archived.' })
    expect(archived.messages).toContainEqual(expect.objectContaining({ conversationId: f.review, text: 'Fix login was archived.', recipients: [f.tester] }))
    expect(f.group(f.done).archived).toBe(true)
  })
})
