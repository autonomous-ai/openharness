import { describe, expect, it } from 'vitest'
import type { Check, Conversation } from '../model.js'
import { fakeTrainGitHub, type FakePull } from './fakeTrainGitHub.js'
import type { TrainTask } from './plan.js'
import { newTrainMemory, trainPass, type TrainSwarm, type TrainTaskPull } from './train.js'

const MINUTE = 60_000
const ON = { enabled: true }

/** A task whose one review step passed at [head] of [url]. */
function approvedTask(url: string, head: string, reviewers = ['agent:reviewer']): TrainTask {
  const check = (by: string): Check => ({ id: `c-${by}`, description: 'Review', independent: true, evidence: 'ok', passedBy: by,
    verdicts: [{ by, passed: true, evidence: 'ok', at: 1, pullRequest: url, head, patch: `patch-${head}` }] as unknown as Check['verdicts'] })
  return {
    checks: [],
    pullRequestHeads: { [url]: { head, patch: `patch-${head}`, at: 1 } },
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
  const pass = (rules: { enabled: boolean } = ON) => trainPass({ projectId: 'p1', github: repo.github, swarm: swarm.swarm, memory, now: (now += 10 * MINUTE), rules })
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

  it('merges a docs or scripts pull request on its own green CI, with no batch', async () => {
    const { repo, swarm, pass } = setup()
    const a = repo.addPull(7, ['docs/a.md', 'scripts/b.py'])
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
    expect(repo.state.squashes).toEqual([expect.objectContaining({ number: batch.number, title: expect.stringContaining(`(#${batch.number})`) })])
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

  it('stops with the kill switch: no read, no write, an open batch left as it is', async () => {
    const { repo, swarm, pass } = setup()
    swarm.approve(repo.addPull(7, ['backend/src/a.ts']))
    await pass()
    const batch = repo.batches()[0]!
    repo.state.ci.set(batch.head, 'success')
    const before = { reads: repo.state.reads.length, writes: repo.state.writes.length }
    expect(await pass({ enabled: false })).toEqual({ off: true })
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
