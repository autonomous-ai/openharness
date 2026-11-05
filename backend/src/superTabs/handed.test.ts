// Task #3399: a task whose pull request is ready for review is handed over. Its Engineer is free for new work and keeps
// its push access; a No verdict, red CI or a conflict brings the task back to it (docs/plans/2026-11-05-handed-on-ready-plan.md).
import { describe, expect, it } from 'vitest'
import { awaitingWorkers, workerIndex, type SuperTabState } from './model.js'
import type { Command } from './commands.js'
import { sweepLiveness } from './liveness.js'
import { REOPEN_OWNER_MS, reopenOnEvents } from './handed.js'
import { workHolds, startedHolds, endedHolds, tokenTask } from '../github/holds.js'
import { stepsFixture } from './steps.test-support.js'

const PR = 'https://github.com/acme/app/pull/7'

/** The fixture's task, handed over by its Engineer, and a second task for the same Engineer. */
function handedFixture() {
  const f = stepsFixture()
  f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.group(f.task).assignment!.id, status: 'review', result: `Ready for review: ${PR} at abc1234` }, f.as(f.dev))
  const next = f.run({ type: 'conversation.create', title: 'Fix logout', brief: 'Sign out works offline.', checks: [] }, f.as(f.lead)).result.conversationId as string
  // Not a spread: it would copy the fixture's `state` getter as a snapshot.
  return Object.assign(f, { next })
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
    const handedAt = structuredClone(f.state)
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

const MINUTE = 60_000
/** The Engineer's machine last reported at [receivedAt]: its session running with progress then (busy on another task), or
 *  stopped. */
function report(state: SuperTabState, receivedAt: number, session: 'running' | 'stopped' = 'running') {
  state.machines = [{ machineId: 'host', name: 'Studio', observation: { runningHarnessIds: session === 'running' ? ['dev'] : [],
    stoppedHarnessIds: session === 'stopped' ? ['dev'] : [], receivedAt, harnessProgress: { dev: receivedAt } } }] as never
}

describe('a handed task is never lost for its Engineer (#3399)', () => {
  it('stays in review when the Engineer\'s session stops, its machine goes offline or it hits a usage limit', () => {
    const stopped = handedFixture()
    report(stopped.state, stopped.now, 'stopped')
    expect(sweepLiveness(stopped.state, stopped.now)).toEqual([])
    expect(stopped.group(stopped.task).assignment!.status).toBe('review')
    const offline = handedFixture()
    report(offline.state, offline.now)
    expect(sweepLiveness(offline.state, offline.now + 10 * MINUTE)).toEqual([])
    expect(offline.group(offline.task).assignment!.status).toBe('review')
    const limited = handedFixture()
    Object.assign(limited.state.agents.find(a => a.id === limited.dev)!, { alerting: ['limit'], limitedUntil: new Date(limited.now + 60 * MINUTE).toISOString() })
    expect(sweepLiveness(limited.state, limited.now)).toEqual([])
    expect(limited.group(limited.task).assignment!.status).toBe('review')
  })
})

describe('No, red CI or a conflict reopens the task pinned to its owner (#3399)', () => {
  const reviewed = () => {
    const f = handedFixture()
    const rev = f.add('rev', f.task)
    const before = structuredClone(f.group(f.task))
    return Object.assign(f, { rev, before })
  }
  const fail = (f: ReturnType<typeof reviewed>, by: string, conversationId = f.task) => {
    const group = f.group(conversationId)
    return f.run({ type: 'work.check', conversationId, assignmentId: group.assignment!.id, checkId: group.checks[0]!.id, passed: false,
      evidence: 'Ready to merge: No. The offline path has no test.' }, f.as(by))
  }

  it('a Reviewer\'s failed check brings the same attempt back to its Engineer, who is told why', () => {
    const f = reviewed()
    const effects = fail(f, f.rev)
    const after = f.group(f.task)
    expect(after.assignment).toMatchObject({ id: f.before.assignment!.id, agentId: f.dev, status: 'working', reopened: { at: f.now } })
    expect(after.assignment!.reopened!.why).toContain('The offline path has no test.')
    // Built by: the attempt and its run stay the Engineer's.
    expect(after.ledger?.runs).toEqual(f.before.ledger?.runs)
    expect(effects.messages).toContainEqual(expect.objectContaining({ conversationId: f.task, recipients: [f.dev], text: expect.stringContaining('back with you') }))
    // The hold is the same assignment's: none starts or ends.
    expect(workHolds(f.state)).toEqual([{ agentId: f.dev, assignmentId: f.before.assignment!.id }])
  })

  it('the Engineer\'s own failed check does not reopen it', () => {
    const f = reviewed()
    fail(f, f.dev)
    expect(f.group(f.task).assignment).toMatchObject({ status: 'review' })
    expect(f.group(f.task).assignment!.reopened).toBeUndefined()
  })

  it('a step\'s own agent failing its step\'s check reopens the task it reviews', () => {
    const f = reviewed()
    const step = f.step('Test', f.as(f.dev), f.task, [{ description: 'Works on a phone', independent: true }])
    const tester = f.add('tester', step)
    f.run({ type: 'work.assign', conversationId: step, agentId: tester }, f.as(f.dev))
    fail(f, tester, step)
    expect(f.group(f.task).assignment).toMatchObject({ agentId: f.dev, status: 'working', reopened: { at: f.now } })
  })

  it('CI failing on the head, or a merge conflict, reopens it; CI passing does not', () => {
    for (const key of ['ci-red:abc1234', 'conflict:abc1234']) {
      const f = reviewed()
      const told = reopenOnEvents(f.group(f.task), [{ key, text: 'CI failed on your pull request #7.' }], f.now)
      expect(f.group(f.task).assignment).toMatchObject({ status: 'working', reopened: { at: f.now, why: 'CI failed on your pull request #7.' } })
      expect(told[0]!.text).toMatch(/^CI failed on your pull request #7\. .*back with you/)
    }
    const green = reviewed()
    const told = reopenOnEvents(green.group(green.task), [{ key: 'ci-green:abc1234', text: 'CI passed.' }], green.now)
    expect(told).toEqual([{ key: 'ci-green:abc1234', text: 'CI passed.' }])
    expect(green.group(green.task).assignment!.status).toBe('review')
  })

  it('is picked up by the Engineer\'s own post in the task, then kept as any working task', () => {
    const f = reviewed()
    fail(f, f.rev)
    f.tick(10 * MINUTE)
    f.run({ type: 'message.send', conversationId: f.task, text: 'Fixing the offline test now.', replyTo: null, recipientIds: [] } as Command, f.as(f.dev))
    expect(f.group(f.task).assignment!.reopened).toBeUndefined()
    report(f.state, f.now + REOPEN_OWNER_MS)
    sweepLiveness(f.state, f.now + REOPEN_OWNER_MS)
    expect(f.group(f.task).assignment!.status).toBe('working')
  })

  it('is released to anyone free once its Engineer has not picked it up in 60 minutes', () => {
    const f = reviewed()
    fail(f, f.rev)
    const reopenedAt = f.now
    // Busy on its next task: its session keeps reporting progress, which keeps any working task's lease.
    report(f.state, reopenedAt + REOPEN_OWNER_MS)
    expect(sweepLiveness(f.state, reopenedAt + REOPEN_OWNER_MS)).toEqual([])
    expect(f.group(f.task).assignment!.status).toBe('working')
    report(f.state, reopenedAt + REOPEN_OWNER_MS + 1)
    sweepLiveness(f.state, reopenedAt + REOPEN_OWNER_MS + 1)
    expect(f.group(f.task).assignment).toMatchObject({ status: 'lost', lost: { reason: expect.stringContaining('60 minutes') } })
  })

  it('is released at once when its Engineer is down', () => {
    const f = reviewed()
    fail(f, f.rev)
    report(f.state, f.now, 'stopped')
    sweepLiveness(f.state, f.now)
    expect(f.group(f.task).assignment!.status).toBe('lost')
  })

  it('is handed over again by the Engineer\'s next Ready, which clears the reopen', () => {
    const f = reviewed()
    fail(f, f.rev)
    f.run({ type: 'work.status', conversationId: f.task, assignmentId: f.group(f.task).assignment!.id, status: 'review', result: `Ready for review: ${PR} at def5678` }, f.as(f.dev))
    expect(f.group(f.task).assignment).toMatchObject({ status: 'review' })
    expect(f.group(f.task).assignment!.reopened).toBeUndefined()
  })
})
