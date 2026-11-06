// Task #4032 (Stepos 11-06): the lane dispatch handed out lost tasks whose merge was already recorded. #3819 went out 9 minutes
// after PR #3384 merged and #3818 52 minutes after PR #3383, each time an agent spent only to set the task done, and their
// steps were revived the same way. A task whose own merge is recorded is never handed out again: the server sets it done.
import { describe, expect, it } from 'vitest'
import { DISPATCH_RULES, openTasks } from './dispatch.js'
import { sweepLiveness } from './liveness.js'
import { appendPullRequestUrls } from './model.js'
import { stepsOf } from './steps.js'
import { stepsFixture } from './steps.test-support.js'

const PR = 'https://github.com/acme/app/pull/7'
const OTHER = 'https://github.com/acme/app/pull/9'

/** A task in review on PR #7 with a Review step working and a Test step whose Tester was lost; its builder is still running. */
function fixture() {
  const f = stepsFixture()
  const assignment = f.group(f.task).assignment!.id
  f.run({ type: 'work.status', conversationId: f.task, assignmentId: assignment, status: 'review', result: `Ready for review: ${PR} at abc1234` }, f.as(f.dev))
  appendPullRequestUrls(f.group(f.task), [PR])
  const reviewer = f.add('rev', f.task), tester = f.add('tst', f.task)
  const review = f.step('Review', f.as(f.lead)), test = f.step('Test', f.as(f.lead))
  f.run({ type: 'work.assign', conversationId: review, agentId: reviewer }, f.as(f.lead))
  f.run({ type: 'work.assign', conversationId: test, agentId: tester }, f.as(f.lead))
  const lose = (id: string) => {
    const held = f.group(id).assignment!
    held.status = 'lost'
    held.lost = { reason: 'its machine went offline', at: f.now }
    f.group(id).lostAttempt = { id: held.id, agentId: held.agentId, machineId: 'host', engine: 'codex' }
  }
  lose(test)
  const merge = (url = PR) => f.run({ type: 'conversation.merged', conversationId: f.task, pullRequestUrl: url }, f.as(f.lead))
  const open = () => openTasks(f.state, 'lead', f.now).map(g => g.id)
  return Object.assign(f, { assignment, review, test, lose, merge, open })
}

describe('a task with a recorded merge', () => {
  it('lost after its merge, is never handed out again, and the sweep sets it done', () => {
    const f = fixture()
    f.merge()
    // Its builder was alive at the merge, so it stayed in review; then it was lost.
    f.lose(f.task)
    expect(f.open()).not.toContain(f.task)
    expect(f.open()).not.toContain(f.test)
    const rows = sweepLiveness(f.state, f.now, () => DISPATCH_RULES)
    expect(f.group(f.task).assignment).toMatchObject({ id: f.assignment, status: 'done' })
    expect(f.group(f.task).assignment!.result).toContain(PR)
    expect(rows.some(r => r.conversationId === f.task && r.text.startsWith('Done'))).toBe(true)
    // Its open steps close with the merge: the working Review and the lost Test.
    for (const step of [f.review, f.test]) expect(f.group(step).assignment).toMatchObject({ status: 'cancelled', result: expect.stringContaining('merged') })
    expect(rows.some(r => r.conversationId === f.review && /merged/i.test(r.text))).toBe(true)
    // A second sweep finds nothing to do.
    expect(sweepLiveness(f.state, f.now, () => DISPATCH_RULES).filter(r => r.conversationId === f.task)).toEqual([])
  })

  it('closes its open steps when the merge closes it', () => {
    const f = fixture()
    f.lose(f.task)
    f.merge()
    expect(f.group(f.task).assignment!.status).toBe('done')
    expect(stepsOf(f.state, f.task).map(s => s.assignment?.status)).toEqual(['cancelled', 'cancelled'])
  })

  it('in review with its merge recorded, never revives its lost step', () => {
    const f = fixture()
    f.merge()
    expect(f.group(f.task).assignment!.status).toBe('review')
    expect(f.open()).not.toContain(f.test)
  })

  it('unmerged, is still handed on when lost, and so is its lost step while it is in review', () => {
    const f = fixture()
    expect(f.open()).toContain(f.test)
    f.lose(f.task)
    expect(f.open()).toContain(f.task)
    sweepLiveness(f.state, f.now, () => DISPATCH_RULES)
    expect(f.group(f.task).assignment!.status).toBe('lost')
  })

  it('whose only recorded merge is another task\'s pull request, is still handed on and never closed', () => {
    const f = fixture()
    f.merge(OTHER)
    f.lose(f.task)
    expect(f.open()).toContain(f.task)
    sweepLiveness(f.state, f.now, () => DISPATCH_RULES)
    expect(f.group(f.task).assignment!.status).toBe('lost')
  })
})
