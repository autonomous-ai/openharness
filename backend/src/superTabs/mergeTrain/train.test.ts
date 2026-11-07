import { describe, expect, it } from 'vitest'
import type { Check, Conversation } from '../model.js'
import { fakeTrainGitHub, type FakePull } from './fakeTrainGitHub.js'
import type { TrainTask } from './plan.js'
import { newTrainMemory, trainPass, type TrainRules, type TrainSwarm, type TrainTaskPull } from './train.js'
import { SEED_RULES } from '../policy.js'

const MINUTE = 60_000
const ON: TrainRules = { enabled: true, rules: SEED_RULES }

/** A task whose one review step passed at [head] of [url]. */
function approvedTask(url: string, head: string, reviewers = ['agent:reviewer']): TrainTask {
  const check = (by: string): Check => ({ id: `c-${by}`, description: 'Review', independent: true, evidence: 'ok', passedBy: by,
    verdicts: [{ by, passed: true, evidence: 'ok', at: 1, pullRequest: url, head, patch: `patch-${head}`, base: 'main' }] as unknown as Check['verdicts'] })
  return {
    checks: [],
    pullRequestHeads: { [url]: { head, patch: `patch-${head}`, at: 1, base: 'main' } },
    steps: reviewers.map(by => ({ step: 'Review', title: 'Review', archived: false, checks: [check(by)], assignment: { status: 'done' } as Conversation['assignment'] })),
  }
}

function fakeSwarm() {
  const tasks = new Map<string, TrainTaskPull>()
  const merged: Array<{ taskId: string; url: string; mergedAt: number }> = []
  const told: Array<{ taskId: string; url: string; key: string; text: string }> = []
  const swarm: TrainSwarm = {
    async pulls() { return [...tasks.values()].map(t => ({ ...t })) },
    async merged(taskId, url, mergedAt) { merged.push({ taskId, url, mergedAt }) },
    async tell(taskId, url, key, text) { if (!told.some(t => t.taskId === taskId && t.key === key)) told.push({ taskId, url, key, text }) },
  }
  /** The task of [pull], approved at its current head. */
  const approve = (pull: FakePull, reviewers?: string[]) => {
    tasks.set(`task-${pull.number}`, { taskId: `task-${pull.number}`, url: pull.url, task: approvedTask(pull.url, pull.head, reviewers) })
  }
  return { swarm, tasks, merged, told, approve }
}

const setup = () => {
  const repo = fakeTrainGitHub(), swarm = fakeSwarm(), memory = newTrainMemory()
  let now = Date.UTC(2026, 10, 5, 15)
  const pass = (rules: TrainRules = ON) => trainPass({ projectId: 'p1', github: repo.github, swarm: swarm.swarm, memory, now: (now += 10 * MINUTE), rules })
  return { repo, swarm, memory, pass }
}

describe('the merge train builds batches', () => {
  it('batches eligible code pull requests on a branch from main, listing each member at its head', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts']), b = repo.addPull(8, ['desktop/lib/b.dart'])
    swarm.approve(a); swarm.approve(b)
    const main = repo.state.main
    await pass()
    const [batch] = repo.batches()
    expect(repo.batches()).toHaveLength(1)
    expect(batch!.headRef.startsWith('harness-train/p1/')).toBe(true)
    expect(repo.state.contents.get(batch!.head)).toEqual([a.head, b.head])
    expect(batch!.body).toContain(`#7 at ${a.head.slice(0, 12)}`)
    expect(batch!.body).toContain(`#8 at ${b.head.slice(0, 12)}`)
    expect(batch!.body).toContain(main.slice(0, 12))
    expect(swarm.merged).toEqual([])
  })

  it('keeps two pull requests that change the same file in separate batches, so no combination goes unread', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts']), b = repo.addPull(8, ['backend/src/a.ts', 'backend/src/b.ts']), c = repo.addPull(9, ['cli/src/c.ts'])
    swarm.approve(a); swarm.approve(b); swarm.approve(c)
    await pass()
    expect(repo.batches().map(p => repo.state.contents.get(p.head))).toEqual([[a.head, c.head]])
    repo.state.ci.set(repo.batches()[0]!.head, 'success')
    await pass()
    expect(repo.batches().map(p => repo.state.contents.get(p.head))).toEqual([[b.head]])
  })

  it('never batches a pull request retargeted to main after its review was read against another branch (Ledger, #3218)', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts'])
    swarm.approve(a)
    // The review passed at this head against "release", and the watch last read it there; GitHub now shows it into main.
    const task = swarm.tasks.get('task-7')!.task
    task.pullRequestHeads![a.url] = { ...task.pullRequestHeads![a.url]!, base: 'release' }
    for (const step of task.steps) for (const check of step.checks) for (const verdict of check.verdicts!) verdict.base = 'release'
    await pass()
    expect(repo.batches()).toEqual([])
    expect(repo.state.squashes).toEqual([])
  })

  it('never batches a pull request whose verdict is not at its head', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts'])
    swarm.approve(a)
    repo.push(7)
    await pass()
    expect(repo.batches()).toEqual([])
  })

  it('waits for the reads the review table asks: two on a security path', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/github/tokens.ts'])
    swarm.approve(a)
    await pass()
    expect(repo.batches()).toEqual([])
    expect(swarm.told.map(t => t.key)).toEqual([`train-reads:${a.head}`])
    swarm.approve(a, ['agent:one', 'agent:two'])
    await pass()
    expect(repo.batches()).toHaveLength(1)
  })

  it('drops a conflicting pull request and tells its owner to merge main once, once per head', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts']), b = repo.addPull(8, ['backend/src/b.ts'])
    swarm.approve(a); swarm.approve(b)
    repo.state.conflicts.add(b.head)
    await pass()
    expect(repo.state.contents.get(repo.batches()[0]!.head)).toEqual([a.head])
    expect(swarm.told).toHaveLength(1)
    expect(swarm.told[0]).toMatchObject({ taskId: 'task-8', key: `train-conflict:${b.head}` })
    expect(swarm.told[0]!.text).toMatch(/merge main into its branch once/i)
  })

  it('tells the owner of a pull request GitHub already reads as conflicting', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts'], { mergeable: false })
    swarm.approve(a)
    await pass()
    await pass()
    expect(repo.batches()).toEqual([])
    expect(swarm.told.map(t => t.key)).toEqual([`train-conflict:${a.head}`])
  })

  it('merges a docs pull request on its own green CI, with no batch', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['docs/a.md', 'cli/README.md'])
    swarm.approve(a)
    await pass()
    expect(repo.batches()).toEqual([])
    expect(repo.state.squashes.map(s => s.number)).toEqual([7])
    expect(swarm.merged.map(m => [m.taskId, m.url])).toEqual([['task-7', a.url]])
  })

  it('holds a fast-lane pull request while a code batch is in CI, so main does not move under it', async () => {
    const { repo, swarm, pass } = setup()
    swarm.approve(repo.addPull(7, ['backend/src/a.ts']))
    await pass()
    swarm.approve(repo.addPull(8, ['docs/a.md']))
    await pass()
    expect(repo.state.squashes).toEqual([])
  })
})

describe('the merge train finishes batches', () => {
  it('squash-merges a green batch at its tip, closes the originals with a link and records each merge', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts']), b = repo.addPull(8, ['desktop/lib/b.dart'])
    swarm.approve(a); swarm.approve(b)
    await pass()
    const batch = repo.batches()[0]!
    repo.state.ci.set(batch.head, 'success')
    await pass()
    expect(repo.state.squashes).toEqual([expect.objectContaining({ number: batch.number })])
    // The form main's batches use, which the release watch (#3405) reads: the originals before the batch's own number.
    expect(repo.state.squashes[0]!.title).toBe(`Merge batch 11-05 train-1510: #7 #8 (#${batch.number})`)
    const commit = repo.state.squashes[0]!.sha
    expect(repo.state.pulls.get(7)!.state).toBe('closed')
    expect(repo.state.pulls.get(8)!.state).toBe('closed')
    for (const n of [7, 8]) {
      const said = repo.state.comments.find(c => c.number === n)!.text
      expect(said).toContain(batch.url)
      expect(said).toContain(commit)
    }
    expect(swarm.merged.map(m => [m.taskId, m.url])).toEqual([['task-7', a.url], ['task-8', b.url]])
    expect(repo.state.branches.has(batch.headRef)).toBe(false)
  })

  it('titles a batch of one in the same form', async () => {
    const { repo, swarm, pass } = setup()
    swarm.approve(repo.addPull(7, ['backend/src/a.ts']))
    await pass()
    const batch = repo.batches()[0]!
    repo.state.ci.set(batch.head, 'success')
    await pass()
    expect(repo.state.squashes[0]!.title).toBe(`Merge batch 11-05 train-1510: #7 (#${batch.number})`)
  })

  it('records every member\'s merge even when GitHub fails to take a comment after the squash', async () => {
    const { repo, swarm, pass } = setup()
    swarm.approve(repo.addPull(7, ['backend/src/a.ts'])); swarm.approve(repo.addPull(8, ['backend/src/b.ts']))
    await pass()
    repo.state.ci.set(repo.batches()[0]!.head, 'success')
    repo.state.failing.add('comment')
    await pass()
    expect(swarm.merged.map(m => m.taskId)).toEqual(['task-7', 'task-8'])
  })

  it('never hands the batch pull request to the Swarm, so no task links it or reads it as Team-written', async () => {
    const { repo, swarm, pass } = setup()
    swarm.approve(repo.addPull(7, ['backend/src/a.ts']))
    await pass()
    const batch = repo.batches()[0]!
    repo.state.ci.set(batch.head, 'success')
    await pass()
    const said = JSON.stringify([swarm.merged, swarm.told])
    expect(said).not.toContain(batch.url)
    expect(said).not.toContain(`#${batch.number}`)
  })

  it('splits a red batch by component and runs each part again', async () => {
    const { repo, swarm, pass } = setup()
    for (const [n, files] of [[7, ['backend/src/a.ts']], [8, ['desktop/lib/b.dart']], [9, ['backend/src/c.ts']]] as const) swarm.approve(repo.addPull(n, [...files]))
    await pass()
    const first = repo.batches()[0]!
    repo.state.ci.set(first.head, 'failure')
    await pass()
    expect(repo.state.pulls.get(first.number)!.state).toBe('closed')
    const parts = repo.batches().map(p => repo.state.contents.get(p.head)!.map(h => [...repo.state.pulls.values()].find(x => x.head === h)!.number))
    expect(parts).toEqual([[7, 9], [8]])
    expect(repo.state.squashes).toEqual([])
  })

  it('sends a pull request that fails alone back to its owner, and batches it again only at a new head', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts'])
    swarm.approve(a)
    await pass()
    repo.state.ci.set(repo.batches()[0]!.head, 'failure')
    await pass()
    expect(swarm.told).toEqual([expect.objectContaining({ taskId: 'task-7', key: `train-red:${a.head}` })])
    expect(swarm.told[0]!.text).toMatch(/CI failed/)
    await pass()
    expect(repo.batches()).toEqual([])
    const head = repo.push(7)
    swarm.approve(repo.state.pulls.get(7)!)
    await pass()
    expect(repo.state.contents.get(repo.batches()[0]!.head)).toEqual([head])
  })

  it('rebuilds from the new main when main moved, a person\'s hand merge included', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts'])
    swarm.approve(a)
    await pass()
    const first = repo.batches()[0]!
    repo.state.main = 'f'.repeat(40)
    repo.state.ci.set(first.head, 'success')
    await pass()
    expect(repo.state.squashes).toEqual([])
    expect(repo.state.pulls.get(first.number)!.state).toBe('closed')
    const [second] = repo.batches()
    expect(second!.body).toContain('f'.repeat(12))
  })

  it('builds the fresh batch on the main it reads right before building, not the main the pass began with (#3496, 11-07)', async () => {
    const { repo, swarm, pass } = setup()
    swarm.approve(repo.addPull(7, ['backend/src/a.ts']))
    const moved = 'e'.repeat(40)
    // A hand merge lands while the pass reads its candidates, after it read main.
    repo.state.afterRead = name => { if (name === 'files') { repo.state.main = moved; repo.state.afterRead = null } }
    await pass()
    const [batch] = repo.batches()
    expect(batch!.body).toContain(moved.slice(0, 12))
    repo.state.ci.set(batch!.head, 'success')
    await pass()
    expect(repo.state.squashes.map(s => s.number)).toEqual([batch!.number])
  })

  it('rebuilds a batch closed because main moved on the next pass, while GitHub still reads its members as not worked out', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts']), b = repo.addPull(8, ['cli/src/b.ts'])
    swarm.approve(a); swarm.approve(b)
    await pass()
    const first = repo.batches()[0]!
    // A hand merge moves main mid-batch; GitHub answers mergeable null for every open pull request until it has worked it out.
    repo.state.main = 'd'.repeat(40)
    a.mergeable = null; b.mergeable = null
    await pass()
    expect(repo.state.pulls.get(first.number)!.state).toBe('closed')
    const [second] = repo.batches()
    expect(second!.body).toContain('d'.repeat(12))
    expect(repo.state.contents.get(second!.head)).toEqual([a.head, b.head])
  })

  it('leaves out a member that now conflicts with the new main, with its reason, and rebuilds the rest', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts']), b = repo.addPull(8, ['cli/src/b.ts'])
    swarm.approve(a); swarm.approve(b)
    await pass()
    repo.state.main = 'd'.repeat(40)
    a.mergeable = null; b.mergeable = null
    repo.state.conflicts.add(b.head)
    await pass()
    expect(repo.batches().map(p => repo.state.contents.get(p.head))).toEqual([[a.head]])
    expect(swarm.told.map(t => [t.taskId, t.key])).toEqual([['task-8', `train-conflict:${b.head}`]])
  })

  it('never merges a docs pull request GitHub has not worked out yet: the fast lane merges on GitHub, with no batch to test it', async () => {
    const { repo, swarm, pass } = setup()
    swarm.approve(repo.addPull(7, ['docs/a.md'], { mergeable: null }))
    await pass()
    expect(repo.state.squashes).toEqual([])
    expect(repo.batches()).toEqual([])
  })

  it('tells a member left waiting after main moved why it waits and when the next batch starts, once', async () => {
    const { repo, swarm, pass } = setup()
    const rules: TrainRules = { ...ON, everyMinutes: 10 }
    const a = repo.addPull(7, ['backend/src/a.ts']), b = repo.addPull(8, ['cli/src/b.ts'])
    swarm.approve(a); swarm.approve(b)
    await pass(rules)
    const first = repo.batches()[0]!
    repo.state.main = 'd'.repeat(40)
    b.labels = ['hold']
    await pass(rules)
    expect(repo.batches().map(p => repo.state.contents.get(p.head))).toEqual([[a.head]])
    expect(swarm.told.map(t => [t.taskId, t.key])).toEqual([['task-8', `train-moved:${first.number}:${b.head}`]])
    expect(swarm.told[0]!.text).toMatch(/main moved/i)
    expect(swarm.told[0]!.text).toContain('hold label')
    expect(swarm.told[0]!.text).toContain('in about 10 minutes')
    await pass(rules)
    expect(swarm.told).toHaveLength(1)
  })

  it('says nothing on a member merged by hand meanwhile, often why main moved', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts']), b = repo.addPull(8, ['cli/src/b.ts'])
    swarm.approve(a); swarm.approve(b)
    await pass()
    repo.state.main = 'd'.repeat(40)
    Object.assign(b, { state: 'closed', merged: true })
    await pass()
    expect(repo.batches().map(p => repo.state.contents.get(p.head))).toEqual([[a.head]])
    expect(swarm.told).toEqual([])
  })

  it('never merges a member pushed after its batch went green: the heads are read again first', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts']), b = repo.addPull(8, ['backend/src/b.ts'])
    swarm.approve(a); swarm.approve(b)
    await pass()
    const first = repo.batches()[0]!
    repo.state.ci.set(first.head, 'success')
    repo.push(8)
    await pass()
    expect(repo.state.squashes).toEqual([])
    expect(repo.state.contents.get(repo.batches()[0]!.head)).toEqual([a.head])
  })

  it('never merges a member whose verdict stopped counting after the batch was built', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts'])
    swarm.approve(a)
    await pass()
    repo.state.ci.set(repo.batches()[0]!.head, 'success')
    swarm.tasks.get('task-7')!.task.steps[0]!.assignment = { status: 'working' } as Conversation['assignment']
    await pass()
    expect(repo.state.squashes).toEqual([])
  })

  it('closes a batch someone else pushed to, or one it did not build (a restart), without merging it', async () => {
    const { repo, swarm, pass, memory } = setup()
    swarm.approve(repo.addPull(7, ['backend/src/a.ts']))
    await pass()
    const first = repo.batches()[0]!
    first.head = 'e'.repeat(40)
    repo.state.ci.set(first.head, 'success')
    await pass()
    expect(repo.state.squashes).toEqual([])
    expect(repo.state.pulls.get(first.number)!.state).toBe('closed')
    const second = repo.batches()[0]!
    memory.batches.clear()
    repo.state.ci.set(second.head, 'success')
    await pass()
    expect(repo.state.squashes).toEqual([])
    expect(repo.state.pulls.get(second.number)!.state).toBe('closed')
  })

  it('never touches a fork\'s pull request named like a live batch', async () => {
    const { repo, swarm, pass } = setup()
    swarm.approve(repo.addPull(7, ['backend/src/a.ts']))
    await pass()
    const batch = repo.batches()[0]!
    repo.addPull(50, ['README.md'], { headRef: batch.headRef, headRepository: 'outsider/app' })
    const writes = repo.state.writes.length
    await pass()
    expect(repo.state.writes.length).toBe(writes)
    expect(repo.state.pulls.get(50)!.state).toBe('open')
    expect(repo.state.branches.has(batch.headRef)).toBe(true)
  })

  it('forgets a batch someone closed, and still builds the next one', async () => {
    const { repo, swarm, pass } = setup()
    swarm.approve(repo.addPull(7, ['backend/src/a.ts']))
    await pass()
    const first = repo.batches()[0]!
    first.state = 'closed'
    swarm.approve(repo.addPull(8, ['backend/src/b.ts']))
    await pass()
    expect(repo.batches()).toHaveLength(1)
    expect(repo.batches()[0]!.number).not.toBe(first.number)
  })

  it('closes a batch GitHub refuses to merge, tells each Engineer why, and leaves those heads out', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts'])
    swarm.approve(a)
    await pass()
    const batch = repo.batches()[0]!
    repo.state.ci.set(batch.head, 'success')
    repo.state.squashRefusal = 'At least 1 approving review is required by reviewers with write access.'
    await pass()
    expect(repo.state.pulls.get(batch.number)!.state).toBe('closed')
    expect(swarm.told).toEqual([expect.objectContaining({ taskId: 'task-7', key: `train-refused:${a.head}` })])
    expect(swarm.told[0]!.text).toContain('At least 1 approving review is required')
    await pass()
    expect(repo.batches()).toEqual([])
  })

  it('leaves out a pull request that changes CI workflows, which its token cannot merge, with a line to its task', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['.github/workflows/ci.yml', 'scripts/ci-plan.py'])
    swarm.approve(a)
    await pass()
    expect(repo.batches()).toEqual([])
    expect(repo.state.squashes).toEqual([])
    expect(swarm.told.map(t => t.key)).toEqual([`train-workflows:${a.head}`])
  })

  it('records the other members and closes every original when one record fails after the squash', async () => {
    const { repo, swarm, pass } = setup()
    swarm.approve(repo.addPull(7, ['backend/src/a.ts'])); swarm.approve(repo.addPull(8, ['backend/src/b.ts']))
    await pass()
    repo.state.ci.set(repo.batches()[0]!.head, 'success')
    const merged = swarm.swarm.merged
    swarm.swarm.merged = async (taskId, url, at) => { if (taskId === 'task-7') throw new Error('database down'); return merged(taskId, url, at) }
    await pass()
    expect(swarm.merged.map(m => m.taskId)).toEqual(['task-8'])
    expect(repo.state.pulls.get(7)!.state).toBe('closed')
    expect(repo.state.pulls.get(8)!.state).toBe('closed')
  })

  it('drops a member whose head is already in main', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts']), b = repo.addPull(8, ['backend/src/b.ts'])
    swarm.approve(a); swarm.approve(b)
    repo.state.inMain.add(a.head)
    await pass()
    expect(repo.state.contents.get(repo.batches()[0]!.head)).toEqual([b.head])
    expect(swarm.told).toEqual([])
  })

  it('never builds on a train branch someone pushed to mid-build: no batch opened, the branch removed', async () => {
    const { repo, swarm, pass } = setup()
    swarm.approve(repo.addPull(7, ['backend/src/a.ts'])); swarm.approve(repo.addPull(8, ['backend/src/b.ts']))
    let merges = 0
    repo.state.beforeMerge = branch => { if (++merges === 2) repo.state.branches.set(branch, 'e'.repeat(40)) }
    await pass()
    expect(repo.batches()).toEqual([])
    expect([...repo.state.branches.keys()].filter(b => b.startsWith('harness-train/'))).toEqual([])
    expect(repo.state.squashes).toEqual([])
  })

  it('closes a batch whose pull request opened at another head than the tip it built', async () => {
    const { repo, swarm, pass } = setup()
    swarm.approve(repo.addPull(7, ['backend/src/a.ts']))
    const openPull = repo.github.openPull
    repo.github.openPull = async (branch, title, body) => { repo.state.branches.set(branch, 'e'.repeat(40)); return openPull(branch, title, body) }
    await pass()
    expect(repo.batches()).toEqual([])
    expect(repo.state.squashes).toEqual([])
  })

  it('stops with the kill switch: no read, no write, an open batch left as it is', async () => {
    const { repo, swarm, pass } = setup()
    swarm.approve(repo.addPull(7, ['backend/src/a.ts']))
    await pass()
    const batch = repo.batches()[0]!
    repo.state.ci.set(batch.head, 'success')
    const before = { reads: repo.state.reads.length, writes: repo.state.writes.length }
    expect(await pass({ enabled: false, rules: SEED_RULES })).toEqual({ off: true })
    expect({ reads: repo.state.reads.length, writes: repo.state.writes.length }).toEqual(before)
    expect(repo.batches()).toEqual([batch])
  })

  it('fails closed: a read GitHub fails writes nothing for that batch', async () => {
    const { repo, swarm, pass } = setup()
    swarm.approve(repo.addPull(7, ['backend/src/a.ts']))
    await pass()
    repo.state.ci.set(repo.batches()[0]!.head, 'success')
    const writes = repo.state.writes.length
    repo.state.failing.add('ciRequired')
    const line = await pass()
    expect(repo.state.writes.length).toBe(writes)
    expect(line).toMatchObject({ unreadable: expect.any(Number) })
    repo.state.failing.clear()
    repo.state.failing.add('mainHead')
    await pass()
    expect(repo.state.writes.length).toBe(writes)
  })

  it('waits on a batch still in CI, and rebuilds one stuck past its time', async () => {
    const { repo, swarm, pass } = setup()
    swarm.approve(repo.addPull(7, ['backend/src/a.ts']))
    await pass()
    const first = repo.batches()[0]!
    await pass()
    expect(repo.batches()).toEqual([first])
    for (let i = 0; i < 9; i++) await pass()
    expect(repo.state.pulls.get(first.number)!.state).toBe('closed')
    expect(repo.batches()).toHaveLength(1)
  })
})

describe('the merge train says why it passes over a done task\'s pull request (task #3902)', () => {
  const doneTask = (swarm: ReturnType<typeof fakeSwarm>, pull: FakePull) => { swarm.approve(pull); swarm.tasks.get(`task-${pull.number}`)!.task.done = true }
  const unpassedCheck: Check = { id: 'c0', description: 'A widget test per first-join path', independent: false, evidence: null, passedBy: null }

  it('writes the rule once after two passes in a row, as for #3367: the steps passed but the task\'s own check never did', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['desktop/lib/a.dart'])
    doneTask(swarm, a)
    swarm.tasks.get('task-7')!.task.checks = [unpassedCheck]
    await pass()
    expect(swarm.told).toEqual([])
    await pass()
    expect(swarm.told).toEqual([expect.objectContaining({ taskId: 'task-7', key: expect.stringContaining('train-skip:'), text: expect.stringContaining('for 2 passes in a row') })])
    expect(swarm.told[0]!.text).toContain('the task\'s check "A widget test per first-join path": nobody has passed it yet')
    await pass(); await pass()
    expect(swarm.told).toHaveLength(1)
    expect(repo.batches()).toEqual([])
  })

  it('writes again only when the reason changes', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['desktop/lib/a.dart'])
    doneTask(swarm, a)
    swarm.tasks.get('task-7')!.task.checks = [unpassedCheck]
    await pass(); await pass()
    a.labels = ['hold']
    await pass()
    expect(swarm.told).toHaveLength(1)
    await pass()
    expect(swarm.told).toHaveLength(2)
    expect(swarm.told[1]!.text).toContain('it has the hold label')
  })

  it('counts passes in a row: a pass that read it eligible starts the count again', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['desktop/lib/a.dart'], { draft: true })
    doneTask(swarm, a)
    await pass()
    a.draft = false
    await pass()
    a.draft = true
    await pass()
    expect(swarm.told).toEqual([])
  })

  it('tells nothing for a task that is not done, a conflict or too few reads (their own lines), or an eligible pull request', async () => {
    const { repo, swarm, pass } = setup()
    const working = repo.addPull(7, ['desktop/lib/a.dart'], { draft: true })
    swarm.approve(working)
    const conflicting = repo.addPull(8, ['cli/src/b.ts'], { mergeable: false })
    doneTask(swarm, conflicting)
    const ready = repo.addPull(9, ['backend/src/c.ts'])
    doneTask(swarm, ready)
    for (let i = 0; i < 4; i++) await pass()
    expect(swarm.told.map(t => t.key)).toEqual([`train-conflict:${conflicting.head}`])
  })

  it('says a ready pull request waits for the next batch when it shares a file with one in the batch, pass after pass', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['backend/src/a.ts']), b = repo.addPull(8, ['backend/src/a.ts'])
    doneTask(swarm, a); doneTask(swarm, b)
    await pass()
    repo.state.main = 'f'.repeat(40)
    await pass()
    expect(swarm.told).toEqual([expect.objectContaining({ taskId: 'task-8', key: `train-skip:files:7:${b.head}` })])
    expect(swarm.told[0]!.text).toContain('changes a file that #7 also changes')
  })

  it('still batches a verdict at the current head by an agent that has since left the project', async () => {
    const { repo, swarm, pass } = setup()
    doneTask(swarm, repo.addPull(7, ['backend/src/a.ts']))
    swarm.approve(repo.state.pulls.get(7)!, ['agent:rowtest-who-left'])
    await pass()
    expect(repo.batches()).toHaveLength(1)
  })
})
