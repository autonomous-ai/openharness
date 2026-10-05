import { describe, expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { Run, StartSpec, TaskSpec } from './model.js'

const legacyRun = {
  version: 1, id: '0123456789abcdef0123456789abcdef', fingerprint: 'f', prompt: 'Make it', engine: 'claude',
  bypassPermission: false, parallelism: 3, root: '/tmp/p', directorId: 'agent-1', directorWorking: false, state: 'active',
  error: null, revision: 3, createdAt: 1, updatedAt: 2, messages: [],
  tasks: [{ id: 'part', title: 'part', harness: 'test/cad', prompt: 'Build', dependsOn: [], state: 'running', attempt: 1,
    agentId: 'agent-2', cwd: '/tmp/p/tasks/part/attempt-1', summary: '', error: null, uncertain: false, artifacts: [], inputs: {} }],
}

describe('model compatibility', () => {
  it('reads a run saved before flows existed and writes it back unchanged', () => {
    expect(JSON.parse(JSON.stringify(Run.parse(legacyRun)))).toEqual(legacyRun)
  })
  it('reads a flow run saved without the pinned source name unchanged', () => {
    const flow = { name: 'demo', path: '/p/demo.yaml', sha256: 'a'.repeat(64), inputs: {}, warnings: [] }
    expect(JSON.parse(JSON.stringify(Run.parse({ ...legacyRun, flow })))).toEqual({ ...legacyRun, flow })
    expect(Run.parse({ ...legacyRun, flow: { ...flow, source: 'flow.json' } }).flow!.source).toBe('flow.json')
  })
  it('keeps the fingerprint of an old start request stable', () => {
    const raw = { id: legacyRun.id, prompt: 'Make it', engine: 'claude' }
    const fingerprint = (spec: unknown) => createHash('sha256').update(JSON.stringify(spec)).digest('hex')
    expect(fingerprint(StartSpec.parse(raw))).toBe(fingerprint({ ...raw, bypassPermission: false, parallelism: 3 }))
  })
  it('accepts flow fields on tasks and starts', () => {
    expect(TaskSpec.parse({ id: 'check', title: 'check', harness: 'run', prompt: 'npm test', run: 'npm test', timeoutMs: 600_000, retry: { maxAttempts: 1 } }))
      .toMatchObject({ run: 'npm test', retry: { maxAttempts: 1 } })
    expect(TaskSpec.parse({ id: 'part', title: 'part', harness: 'test/cad', prompt: 'Build', outputs: { files: ['*.step'], verdict: 'ready' } }).outputs)
      .toEqual({ files: ['*.step'], verdict: 'ready' })
    expect(StartSpec.parse({ id: legacyRun.id, prompt: 'Flow x', engine: 'claude', flow: { source: 'spec: 1', path: '/p/x.yaml' }, inputs: { a: '1' } }))
      .toMatchObject({ flow: { path: '/p/x.yaml' }, inputs: { a: '1' } })
    expect(() => TaskSpec.parse({ id: 'x', title: 'x', harness: 'run', prompt: 'p', retry: { maxAttempts: 7 } })).toThrow()
  })
})

const filledTask = {
  id: 'review', title: 'review', harness: 'test/cad', prompt: 'Review', dependsOn: ['plan'],
  outputs: { files: ['review.md'], verdict: 'ready' }, timeoutMs: 60_000, retry: { maxAttempts: 3, delayMs: 30_000 },
  when: 'plan.verdict.errors == 0', triggerRule: 'none_failed_min_one_success', idleTimeoutMs: 900_000,
  loop: { untilRun: 'npm run lint', maxIterations: 3 },
  state: 'running', attempt: 2, agentId: 'agent-3', cwd: '/r/tasks/review/attempt-2', summary: 's', error: null, uncertain: false,
  artifacts: [{ path: 'review.md', size: 3, sha256: 'a'.repeat(64) }], inputs: { plan: 1 }, engine: 'claude', promptSha256: 'b'.repeat(64),
  deadline: 5, pid: 7, verdict: { ready: true, errors: 0, warnings: 2 },
  loopState: { phase: 'checking', completed: 1, turn: 2, eligibleAfter: 1, check: { pid: 9, startedAt: 4 }, finish: { summary: 'done', paths: ['review.md'] }, feedbackId: 'c'.repeat(32) },
  retryAt: 6, scripts: [{ path: '/p/check.sh', sha256: 'd'.repeat(64) }],
}
const approvalTask = {
  id: 'ok', title: 'ok', harness: 'approval', prompt: 'Ship?', dependsOn: [], approval: { message: 'Ship?', decisions: [{ id: 'ship', label: 'Ship it' }] },
  state: 'waiting', attempt: 1, agentId: null, cwd: '/r/tasks/ok/attempt-1', summary: '', error: null, uncertain: false, artifacts: [], inputs: {},
  decision: { outcome: 'approved', decision: 'ship', comment: 'go', at: 8 },
}
const cancelTask = { id: 'stop', title: 'stop', harness: 'cancel', prompt: 'Rework', dependsOn: ['ok'], cancel: 'Rework', when: 'ok.decision == ship',
  state: 'skipped', attempt: 1, agentId: null, cwd: '', summary: 'Skipped: ok.decision == ship is false', error: null, uncertain: false, artifacts: [], inputs: {} }

describe('model fields for conditions, approvals, loops and retries', () => {
  it('round-trips every optional field before and after execution', () => {
    const run = { ...legacyRun, directorId: null, flow: { name: 'x', path: '/p/x.yaml', sha256: 'e'.repeat(64), inputs: {}, warnings: [], source: 'flow.yaml' }, tasks: [filledTask, approvalTask, cancelTask] }
    expect(JSON.parse(JSON.stringify(Run.parse(run)))).toEqual(run)
    const queued = { ...filledTask, state: 'queued', attempt: 3, agentId: null, cwd: '', artifacts: [], inputs: {} }
    for (const key of ['verdict', 'loopState', 'retryAt', 'scripts', 'deadline', 'pid', 'engine'] as const) delete (queued as Record<string, unknown>)[key]
    expect(JSON.parse(JSON.stringify(Run.parse({ ...run, tasks: [queued] })))).toEqual({ ...run, tasks: [queued] })
  })
  it('bounds the new fields', () => {
    const base = { id: 'a', title: 'a', harness: 'approval', prompt: 'p' }
    expect(() => TaskSpec.parse({ ...base, approval: { message: 'p', decisions: [] } })).toThrow()
    expect(() => TaskSpec.parse({ ...base, approval: { message: 'p', decisions: Array.from({ length: 9 }, (_, i) => ({ id: `d${i}`, label: 'x' })) } })).toThrow()
    expect(() => TaskSpec.parse({ ...base, approval: { message: 'p', decisions: [{ id: 'Bad', label: 'x' }] } })).toThrow()
    expect(() => TaskSpec.parse({ ...base, retry: { maxAttempts: 2, delayMs: 61_000 } })).toThrow()
    expect(() => TaskSpec.parse({ ...base, loop: { untilRun: 'x', maxIterations: 21 } })).toThrow()
    expect(() => TaskSpec.parse({ ...base, idleTimeoutMs: 86_400_001 })).toThrow()
  })
})
