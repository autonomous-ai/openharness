// Task #3510 (anh Dee's Swarm redesign): a recorded merge closes a task whose builder is gone, so a released builder no longer
// leaves its merged task in review for good; a live builder still closes its own task.
import { describe, expect, it } from 'vitest'
import { appendCodePullRequestUrls, appendPullRequestUrls } from './model.js'
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

  // Aster's re-check of #3259: the first record of an unrelated pull request links it to the task, so a second record (a
  // retry, a backfill) must still close nothing. Ownership is what the task said itself, which a merge record never writes.
  it('leaves the task in review when an unrelated pull request\'s merge is recorded twice', () => {
    const f = mergedFixture()
    f.removeBuilder()
    const other = { type: 'conversation.merged' as const, conversationId: f.task, pullRequestUrl: 'https://github.com/acme/app/pull/99' }
    f.run(other, f.as(f.lead))
    appendPullRequestUrls(f.group(f.task), ['https://github.com/acme/app/pull/99'])
    const effects = f.run(other, f.as(f.lead))
    expect(f.group(f.task).assignment).toMatchObject({ id: f.assignment, status: 'review' })
    expect(effects.closedAssignment).toBeUndefined()
  })

  it('closes on a pull request a check\'s evidence names, as the task\'s own', () => {
    const f = mergedFixture()
    const own = 'https://github.com/acme/app/pull/12'
    f.group(f.task).checks[0]!.evidence = `Passed on ${own} at abc1234`
    f.removeBuilder()
    f.run({ type: 'conversation.merged', conversationId: f.task, pullRequestUrl: own }, f.as(f.lead))
    expect(f.group(f.task).assignment).toMatchObject({ status: 'done' })
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

// Task #3574: seven merged tasks stayed lost on the board. A builder that is lost before its Ready line has no result naming its
// pull request; the pull request its own posts named (the code list) is still the task's own, so its merge closes the task.
describe('a merged task ends done whatever happened to its builder (#3574)', () => {
  /** A task whose builder posted its pull request (the store lists it as the task's code) but never wrote a Ready line naming it. */
  function postedFixture() {
    const f = mergedFixture()
    f.group(f.task).assignment!.result = 'Working on it'
    appendPullRequestUrls(f.group(f.task), [PR])
    appendCodePullRequestUrls(f.group(f.task), [PR])
    return f
  }

  it('closes a lost attempt, whose result names no pull request, when its merge is recorded', () => {
    const f = postedFixture()
    f.group(f.task).assignment!.status = 'lost'
    const effects = f.merge()
    expect(f.group(f.task).assignment).toMatchObject({ id: f.assignment, status: 'done' })
    expect(f.group(f.task).assignment!.result).toContain(PR)
    expect(effects.closedAssignment).toEqual({ assignmentId: f.assignment, outcome: 'done' })
  })

  it('closes a task whose merge was already recorded when it is recorded again after its attempt was lost', () => {
    const f = postedFixture()
    f.merge()
    expect(f.group(f.task).assignment).toMatchObject({ status: 'working' })
    f.group(f.task).assignment!.status = 'lost'
    const effects = f.merge()
    expect(f.group(f.task).assignment).toMatchObject({ id: f.assignment, status: 'done' })
    expect(effects.closedAssignment).toEqual({ assignmentId: f.assignment, outcome: 'done' })
  })

  it('closes a stopped attempt the same way', () => {
    const f = postedFixture()
    f.group(f.task).assignment!.status = 'stopped'
    f.merge()
    expect(f.group(f.task).assignment).toMatchObject({ status: 'done' })
  })

  it('lets the closed task be archived, where a lost one was refused', () => {
    const f = postedFixture()
    f.group(f.task).assignment!.status = 'lost'
    expect(() => f.run({ type: 'conversation.archive', conversationId: f.task, archived: true }, f.as(f.lead))).toThrow(/did not finish/)
    f.merge()
    f.run({ type: 'conversation.archive', conversationId: f.task, archived: true }, f.as(f.lead))
    expect(f.group(f.task).archived).toBe(true)
  })

  // The ownership Aster's review asked for still holds: a pull request only the merge record linked never closes a task.
  it('still closes nothing for a pull request only a merge record linked, however often it is recorded', () => {
    const f = postedFixture()
    const other = { type: 'conversation.merged' as const, conversationId: f.task, pullRequestUrl: 'https://github.com/acme/app/pull/99' }
    f.group(f.task).assignment!.status = 'lost'
    f.run(other, f.as(f.lead))
    f.run(other, f.as(f.lead))
    expect(f.group(f.task).assignment).toMatchObject({ status: 'lost' })
  })
})
