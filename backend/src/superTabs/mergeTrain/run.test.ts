import { describe, expect, it } from 'vitest'
import type { TrainProject } from '../store.js'
import { runMergeTrain, type MergeTrainDeps, type TrainMemories } from './run.js'

const project: TrainProject = { tabId: 't1', projectId: 'p1', ownerId: 'o1', autonomousEnv: 'prod', repositoryUrl: 'https://github.com/acme/app', pulls: [] }

function deps(over: Partial<MergeTrainDeps> = {}) {
  const calls: string[] = []
  const answer = (path: string) => {
    if (path.endsWith('/git/ref/heads/main')) return { status: 200, body: { ref: 'refs/heads/main', object: { type: 'commit', sha: 'c'.repeat(40) } } }
    if (path.includes('/pulls?')) return { status: 200, body: [] }
    return { status: 404, body: {} }
  }
  const value: MergeTrainDeps = {
    store: { trainProjects: async () => [project], trainMerged: async () => {}, trainTell: async () => true },
    app: {
      installation: async () => { calls.push('installation'); return 7 },
      createToken: async () => { calls.push('token'); return { token: 'ghs_x', expiresAt: '2030-01-01T00:00:00Z' } },
      installationCall: async (_token, method, path) => { calls.push(`${method} ${path}`); return answer(path) },
      revoke: async () => { calls.push('revoke') },
    },
    approved: async () => true,
    ...over,
  }
  return { value, calls }
}

describe('running the merge train', () => {
  it('is off unless the project switched it on: nothing read from GitHub', async () => {
    const { value, calls } = deps()
    expect(await runMergeTrain(value, new Map(), 1_000_000)).toBe(0)
    expect(calls).toEqual([])
  })

  it('runs a switched-on project once per interval, with one token revoked after', async () => {
    const { value, calls } = deps({ rules: async () => ({ enabled: true, everyMinutes: 10 }) })
    const memories: TrainMemories = new Map()
    expect(await runMergeTrain(value, memories, 1_000_000)).toBe(1)
    expect(calls.filter(c => c === 'token' || c === 'revoke')).toEqual(['token', 'revoke'])
    expect(await runMergeTrain(value, memories, 1_000_000 + 9 * 60_000)).toBe(0)
    expect(await runMergeTrain(value, memories, 1_000_000 + 10 * 60_000)).toBe(1)
  })

  it('skips a repository not approved for the project', async () => {
    const { value, calls } = deps({ rules: async () => ({ enabled: true, everyMinutes: 10 }), approved: async () => false })
    expect(await runMergeTrain(value, new Map(), 1_000_000)).toBe(0)
    expect(calls).toEqual([])
  })
})
