// Task #3510 (anh Dee's Swarm redesign): a recorded merge closes a task whose builder is gone, so a released builder no longer
// leaves its merged task in review for good; a live builder still closes its own task.
import { describe, expect, it } from 'vitest'
import { appendPullRequestUrls } from './model.js'
import { stepsFixture } from './steps.test-support.js'

const PR = 'https://github.com/acme/app/pull/7'

function mergedFixture() {
  const f = stepsFixture()
  const assignment = f.group(f.task).assignment!.id
  f.run({ type: 'work.status', conversationId: f.task, assignmentId: assignment, status: 'review', result: `Ready for review: ${PR} at abc1234` }, f.as(f.dev))
  // As the store does after each command: the Ready line's link is the task's linked pull request.
  appendPullRequestUrls(f.group(f.task), [PR])
  const merge = (conversationId = f.task) => f.run({ type: 'conversation.merged', conversationId, pullRequestUrl: PR }, f.as(f.lead))
  /** The builder released and its session gone, as a host's confirmed stop leaves it. */
  const removeBuilder = () => { f.state.agents.splice(f.state.agents.findIndex(a => a.id === f.dev), 1) }
  return Object.assign(f, { assignment, merge, removeBuilder })
}

describe('a recorded merge closes a task whose builder is gone (#3510)', () => {
  it('closes the task of a released builder with the merge as its result', () => {
    const f = mergedFixture()
    f.removeBuilder()
    const effects = f.merge()
    expect(f.group(f.task).assignment).toMatchObject({ id: f.assignment, status: 'done' })
    expect(f.group(f.task).assignment!.result).toContain(PR)
    expect(f.group(f.task).ledger?.shippedAt).toBe(f.now)
    // The store closes the attempt as a builder's own done does.
    expect(effects.closedAssignment).toEqual({ assignmentId: f.assignment, outcome: 'done' })
    expect(effects.messages.some(m => m.conversationId === f.task && m.text.startsWith('Done'))).toBe(true)
  })

  it('closes it while the released builder is still stopping', () => {
    const f = mergedFixture()
    // A stop on its way (an idle stop, or a release after its work closed), before its host confirms it.
    f.state.agents.find(a => a.id === f.dev)!.workDecision = 'stop'
    f.merge()
    expect(f.group(f.task).assignment).toMatchObject({ status: 'done' })
  })

  it('closes a task whose attempt already ended without finishing', () => {
    const f = mergedFixture()
    f.group(f.task).assignment!.status = 'lost'
    f.merge()
    expect(f.group(f.task).assignment).toMatchObject({ status: 'done' })
  })

  // Aster's review of #3259: a merge of a pull request the task never linked closes nothing.
  it('leaves the task in review when the merged pull request was never linked to it', () => {
    const f = mergedFixture()
    expect(f.group(f.task).pullRequestUrls).toContain(PR)
    f.removeBuilder()
    const effects = f.run({ type: 'conversation.merged', conversationId: f.task, pullRequestUrl: 'https://github.com/acme/app/pull/99' }, f.as(f.lead))
    expect(f.group(f.task).assignment).toMatchObject({ id: f.assignment, status: 'review' })
    expect(effects.closedAssignment).toBeUndefined()
  })

  it('leaves a live builder\'s task for the builder to close', () => {
    const f = mergedFixture()
    const effects = f.merge()
    expect(f.group(f.task).assignment).toMatchObject({ id: f.assignment, status: 'review' })
    expect(effects.closedAssignment).toBeUndefined()
  })

  it('never closes the parent task, or a step, when a merge is recorded on a step', () => {
    const f = mergedFixture()
    const review = f.step('Review')
    const reviewer = f.add('reviewer', review)
    f.run({ type: 'work.assign', conversationId: review, agentId: reviewer }, f.as(f.dev))
    f.removeBuilder()
    f.state.agents.splice(f.state.agents.findIndex(a => a.id === reviewer), 1)
    const effects = f.merge(review)
    expect(f.group(f.task).assignment).toMatchObject({ status: 'review' })
    expect(f.group(review).assignment).toMatchObject({ status: 'working' })
    expect(effects.closedAssignment).toBeUndefined()
  })

  it('leaves a finished or cancelled task as it is', () => {
    const f = mergedFixture()
    f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.assignment, status: 'done', result: `Merged ${PR}` }, f.as(f.dev))
    f.removeBuilder()
    const effects = f.merge()
    expect(f.group(f.task).assignment).toMatchObject({ status: 'done', result: `Merged ${PR}` })
    expect(effects.closedAssignment).toBeUndefined()
  })
})
