// Task #3399: a task whose pull request is ready for review is handed over. Its Engineer is free for new work and keeps
// its push access; a No verdict, red CI or a conflict brings the task back to it (docs/plans/2026-11-05-handed-on-ready-plan.md).
import { describe, expect, it } from 'vitest'
import { awaitingWorkers, workerIndex } from './model.js'
import { workHolds, startedHolds, endedHolds, tokenTask } from '../github/holds.js'
import { stepsFixture } from './steps.test-support.js'

const PR = 'https://github.com/acme/app/pull/7'

/** The fixture's task, handed over by its Engineer, and a second task for the same Engineer. */
function handedFixture() {
  const f = stepsFixture()
  f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.group(f.task).assignment!.id, status: 'review', result: `Ready for review: ${PR} at abc1234` }, f.as(f.dev))
  const next = f.run({ type: 'conversation.create', title: 'Fix logout', brief: 'Sign out works offline.', checks: [] }, f.as(f.lead)).result.conversationId as string
  return { ...f, next }
}

describe('a ready pull request frees its Engineer (#3399)', () => {
  it('lets the PM assign the Engineer its next task while the first is in review', () => {
    const f = handedFixture()
    const before = f.state
    f.run({ type: 'work.assign', conversationId: f.next, agentId: f.dev }, f.as(f.lead))
    expect(f.group(f.next).assignment).toMatchObject({ agentId: f.dev, status: 'working' })
    // The first task stays open, with the same attempt, in review.
    expect(f.group(f.task).assignment).toMatchObject({ agentId: f.dev, status: 'review', id: before.conversations.find(c => c.id === f.task)!.assignment!.id })
  })

  it('still refuses a second task while the first is in the Engineer\'s hands', () => {
    const f = stepsFixture()
    const next = f.run({ type: 'conversation.create', title: 'Fix logout', brief: 'Sign out works offline.', checks: [] }, f.as(f.lead)).result.conversationId as string
    expect(() => f.run({ type: 'work.assign', conversationId: next, agentId: f.dev }, f.as(f.lead))).toThrow(expect.objectContaining({ code: 'AGENT_BUSY' }))
  })

  it('counts the Engineer as free for routing (awaitingWorkers) once it handed over', () => {
    const f = handedFixture()
    expect(workerIndex(f.state).working.has(f.dev)).toBe(false)
    expect(awaitingWorkers(f.state, 'lead').map(a => a.id)).toContain(f.dev)
  })

  it('keeps the handed task\'s GitHub hold, adds the new task\'s, and ends neither', () => {
    const f = handedFixture()
    const handedAt = f.state
    expect(workHolds(handedAt)).toEqual([{ agentId: f.dev, assignmentId: f.group(f.task).assignment!.id }])
    f.run({ type: 'work.assign', conversationId: f.next, agentId: f.dev }, f.as(f.lead))
    expect(endedHolds(handedAt, f.state)).toEqual([])
    expect(startedHolds(handedAt, f.state)).toEqual([{ agentId: f.dev, assignmentId: f.group(f.next).assignment!.id }])
  })

  it('does not mark the Engineer finished when its handed task is done while it works on the next', () => {
    const f = handedFixture()
    f.run({ type: 'work.assign', conversationId: f.next, agentId: f.dev }, f.as(f.lead))
    f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.group(f.task).assignment!.id, status: 'done', result: `Merged ${PR}` }, f.as(f.dev))
    expect(f.state.agents.find(a => a.id === f.dev)!.workDecision).toBeUndefined()
  })

  it('gives the GitHub token for the task in the Engineer\'s hands first, then the handed one, and none without either', () => {
    const f = handedFixture()
    const dev = f.state.agents.find(a => a.id === f.dev)!
    // Only the handed task: it still gets a token, to push fixes.
    expect(tokenTask(f.state, dev)?.id).toBe(f.task)
    // A new task listed after it in the Swarm is still the one it pushes for now.
    f.run({ type: 'work.assign', conversationId: f.next, agentId: f.dev }, f.as(f.lead))
    expect(tokenTask(f.state, dev)?.id).toBe(f.next)
    f.run({ type: 'work.status', conversationId: f.next, assignmentId: f.group(f.next).assignment!.id, status: 'done', result: 'Merged' }, f.as(f.dev))
    f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.group(f.task).assignment!.id, status: 'done', result: `Merged ${PR}` }, f.as(f.dev))
    expect(tokenTask(f.state, dev)).toBeUndefined()
  })
})
