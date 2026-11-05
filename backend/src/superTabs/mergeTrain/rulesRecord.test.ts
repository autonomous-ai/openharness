/**
 * Task #3475 (anh Dee's Swarm redesign): the merge train reads the project rules record (policy.ts, task #3393) for the reads
 * a change needs and for its switch and interval, so one rules edit changes both the review steps and what the train waits
 * for. With no saved record the seed applies; a record that cannot be read holds the project.
 */
import { describe, expect, it } from 'vitest'
import type { Check, Conversation } from '../model.js'
import { requiredReads, SEED_RULES, type ProjectRules } from '../policy.js'
import type { TrainProject } from '../store.js'
import { fakeTrainGitHub, type FakePull } from './fakeTrainGitHub.js'
import type { TrainTask } from './plan.js'
import { recordTrainRules, runMergeTrain, type MergeTrainDeps } from './run.js'
import { newTrainMemory, trainPass, type TrainSwarm, type TrainTaskPull } from './train.js'

const MINUTE = 60_000

/** A task whose review step passed at [head] of [url], once by each of [reviewers]. */
function approvedTask(url: string, head: string, reviewers: string[]): TrainTask {
  const check = (by: string): Check => ({ id: `c-${by}`, description: 'Review', independent: true, evidence: 'ok', passedBy: by,
    verdicts: [{ by, passed: true, evidence: 'ok', at: 1, pullRequest: url, head, patch: `patch-${head}` }] as unknown as Check['verdicts'] })
  return {
    checks: [],
    pullRequestHeads: { [url]: { head, patch: `patch-${head}`, at: 1 } },
    steps: reviewers.map(by => ({ step: 'Review', title: 'Review', archived: false, checks: [check(by)], assignment: { status: 'done' } as Conversation['assignment'] })),
  }
}

/** One pass over a pull request changing [files], approved by [reads] reviewers, with [rules]: whether the train batched it. */
async function batched(rules: ProjectRules, files: string[], reads: number): Promise<{ batched: boolean; told: string[] }> {
  const repo = fakeTrainGitHub(), memory = newTrainMemory()
  const tasks = new Map<string, TrainTaskPull>(), told: string[] = []
  const swarm: TrainSwarm = {
    async pulls() { return [...tasks.values()] },
    async merged() {},
    async tell(_taskId, _url, _key, text) { told.push(text) },
  }
  const pull: FakePull = repo.addPull(7, files)
  tasks.set('task-7', { taskId: 'task-7', url: pull.url, task: approvedTask(pull.url, pull.head, Array.from({ length: reads }, (_, i) => `agent:r${i}`)) })
  await trainPass({ projectId: 'p1', github: repo.github, swarm, memory, now: Date.UTC(2026, 10, 6, 4), rules: { enabled: true, rules } })
  return { batched: repo.batches().length === 1, told }
}

/** The seed with one more area: three reads on payments code. */
const PAYMENTS: ProjectRules = { ...structuredClone(SEED_RULES), reviews: { ...structuredClone(SEED_RULES.reviews),
  rows: [...structuredClone(SEED_RULES.reviews.rows), { area: 'Payments', reads: 3, paths: ['**/payments/**'] }] } }

describe('the merge train reads the project rules record', () => {
  it('waits for the reads a saved rules record asks: a new area changes what it takes', async () => {
    const files = ['backend/src/payments/charge.ts']
    // The seed has no payments area: one read is enough.
    expect((await batched(SEED_RULES, files, 1)).batched).toBe(true)
    // The saved record asks three: two are not enough, and the Engineer is told how many.
    const short = await batched(PAYMENTS, files, 2)
    expect(short.batched).toBe(false)
    expect(short.told.join('\n')).toContain('needs 3 passed reviews')
    expect((await batched(PAYMENTS, files, 3)).batched).toBe(true)
  })

  // River, 11-06: a saved record can raise a security area, never lower it below two reads (policy.ts floor).
  it('never merges a security change on one read, whatever a saved record says', async () => {
    const one = { ...structuredClone(SEED_RULES), reviews: { ...structuredClone(SEED_RULES.reviews),
      rows: SEED_RULES.reviews.rows.map(row => ({ ...row, reads: 1 })) } }
    for (const file of ['backend/src/github/tokens.ts', 'backend/src/lib/deviceRevoke.ts', 'backend/src/superTabs/ruleGuard.ts']) {
      expect((await batched(one, [file], 1)).batched, file).toBe(false)
      expect((await batched(one, [file], 2)).batched, file).toBe(true)
    }
  })

  // The train batches a change exactly when it has the reads the record's requiredReads gives, for the seed and a saved record,
  // over every kind of change. The review steps (task #3401, not on main yet) are to plan with the same requiredReads; this
  // pins the train to that function, not to the review steps' own code (review of #3250).
  it('requires the same reads as the review steps for the same files', async () => {
    const changes = [
      ['backend/src/superTabs/cards.ts'],
      ['backend/src/github/tokens.ts'],
      ['backend/src/lib/ssoAuth.ts', 'desktop/lib/a.dart'],
      ['backend/src/superTabs/purge.ts'],
      ['mobile/lib/e2ee/box.dart'],
      ['backend/src/payments/charge.ts', 'backend/src/superTabs/cards.ts'],
      ['desktop/test/a_test.dart'],
      ['backend/src/superTabs/latests/x.ts'],
    ]
    for (const rules of [SEED_RULES, PAYMENTS]) {
      for (const files of changes) {
        const needed = requiredReads(rules, files)
        expect((await batched(rules, files, needed - 1)).batched, `${files} with ${needed - 1}`).toBe(false)
        expect((await batched(rules, files, needed)).batched, `${files} with ${needed}`).toBe(true)
      }
    }
  })
})

describe('the merge train reads each project\'s record', () => {
  const project: TrainProject = { tabId: 't1', projectId: 'p1', ownerId: 'o1', autonomousEnv: 'prod', repositoryUrl: 'https://github.com/acme/app', pulls: [] }
  const row = (rules: ProjectRules) => ({ revision: 4, rules })
  /** A database whose newest saved rules row is [answer] (null: none), or whose read fails. */
  const db = (answer: ReturnType<typeof row> | null | Error) => ({
    superTabProjectRules: { findFirst: async () => { if (answer instanceof Error) throw answer; return answer } },
  }) as unknown as Parameters<typeof recordTrainRules>[0]
  function deps(rules: MergeTrainDeps['rules']) {
    const calls: string[] = []
    const value: MergeTrainDeps = {
      store: { trainProjects: async () => [project], trainMerged: async () => {}, trainTell: async () => true },
      app: {
        installation: async () => { calls.push('installation'); return 7 },
        createToken: async () => { calls.push('token'); return { token: 'ghs_x', expiresAt: '2030-01-01T00:00:00Z' } },
        installationCall: async (_token, method, path) => {
          calls.push(`${method} ${path}`)
          if (path.endsWith('/git/ref/heads/main')) return { status: 200, body: { ref: 'refs/heads/main', object: { type: 'commit', sha: 'c'.repeat(40) } } }
          if (path.includes('/pulls?')) return { status: 200, body: [] }
          return { status: 404, body: {} }
        },
        revoke: async () => { calls.push('revoke') },
      },
      approved: async () => true,
      rules,
    }
    return { value, calls }
  }

  it('applies the seed with no saved record: the train is off and reads nothing', async () => {
    const { value, calls } = deps(recordTrainRules(db(null)))
    expect(await runMergeTrain(value, new Map(), 1_000_000)).toBe(0)
    expect(calls).toEqual([])
  })

  it('runs on a saved record\'s switch, at its interval', async () => {
    const on = { ...structuredClone(SEED_RULES), mergeTrain: { enabled: true, everyMinutes: 30 } }
    const { value } = deps(recordTrainRules(db(row(on))))
    const memories = new Map(), start = 100 * MINUTE
    expect(await runMergeTrain(value, memories, start)).toBe(1)
    expect(await runMergeTrain(value, memories, start + 20 * MINUTE)).toBe(0)
    expect(await runMergeTrain(value, memories, start + 30 * MINUTE)).toBe(1)
  })

  it('holds a project whose record cannot be read: nothing read from GitHub, never the seed\'s numbers instead', async () => {
    const { value, calls } = deps(recordTrainRules(db(new Error('database unavailable'))))
    expect(await runMergeTrain(value, new Map(), 1_000_000)).toBe(0)
    expect(calls).toEqual([])
  })
})
