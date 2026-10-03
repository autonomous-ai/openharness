import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { SessionGitHistoryStore } from './sessionGitHistory.js'
import type { RegisteredSession } from './registry.js'
import type { SessionGitContext } from './sessionGitContext.js'

const dirs: string[] = []
const at = '2026-09-27T13:00:00.000Z'
const target = { engine: 'claude', sessionId: 'hn', agentId: 'agent', registeredAt: 1 } as RegisteredSession
const context = (branch: string, extra: Partial<SessionGitContext> = {}): SessionGitContext => ({
  state: 'observed', current: { name: 'app', cwd: '/ship-hn', root: '/ship-hn', remote: 'github.com/acme/app', branch },
  observedAt: at, locations: [], pullRequests: [], truncated: false, ...extra,
})
afterEach(async () => { await Promise.all(dirs.splice(0).map(p => rm(p, { recursive: true, force: true }))) })
describe('durable session Git history', () => {
  it('orders completed PRs by GitHub event time across refreshes and restarts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'git-history-')); dirs.push(dir)
    const store = new SessionGitHistoryStore(dir)
    for (const [number, state, mergedAt, closedAt] of [
      [12, 'Merged', '2026-09-20T10:00:00Z', undefined],
      [13, 'Closed', undefined, '2026-09-22T10:00:00Z'],
      [14, 'Open', undefined, undefined],
    ] as const) {
      const url = `https://github.com/acme/app/pull/${number}`
      await store.recordPullRequest(target, { url, cwd: '/ship-hn', at },
        { status: 'found', number, url, state, mergedAt, closedAt }, at)
    }
    await store.settled()
    const saved = await new SessionGitHistoryStore(dir).get(target)
    expect(saved.pullRequests.map(p => p.result?.status === 'found' ? p.result.number : null)).toEqual([14, 13, 12])
  })
  it('merges saved URL aliases after a repository rename without downgrading newer status', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'git-history-')); dirs.push(dir)
    const store = new SessionGitHistoryStore(dir)
    const alias = { url: 'https://github.com/acme/old/pull/12', cwd: '/work', at }
    const canonical = { ...alias, url: 'https://github.com/acme/new/pull/12' }
    await store.recordPullRequest(target, alias, { status: 'found', number: 12, url: alias.url, state: 'Open' }, at)
    await store.recordPullRequest(target, canonical, { status: 'found', number: 12, url: canonical.url, state: 'Merged' }, '2026-09-27T16:00:00Z')
    await store.recordPullRequest(target, alias, { status: 'found', number: 12, url: canonical.url, state: 'Open' }, at)
    await store.recordPullRequest(target, alias, { status: 'found', number: 12, url: alias.url, state: 'Open' }, at)
    await store.observe(target, context('feature', { pullRequests: [alias] }))
    const saved = await store.get(target)
    expect(saved.pullRequests).toHaveLength(1)
    expect(saved.pullRequests[0]).toMatchObject({ url: canonical.url, result: { state: 'Merged', url: canonical.url } })
    await store.settled()
  })
  it('does not evict in-flight writes or let an older lookup undo a merge', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'git-history-')); dirs.push(dir)
    const store = new SessionGitHistoryStore(dir, 1)
    await Promise.all(Array.from({ length: 12 }, (_, i) =>
      store.observe({ ...target, sessionId: `other-${i}` }, context('feature'))))
    const pr = { url: 'https://github.com/acme/app/pull/12', cwd: '/ship-hn', at }
    await store.recordPullRequest(target, pr, { status: 'found', number: 12, url: pr.url, state: 'Merged' }, '2026-09-27T15:00:00Z')
    await store.observe({ ...target, sessionId: 'eviction-pressure' }, context('other'))
    await store.recordPullRequest(target, pr, { status: 'found', number: 12, url: pr.url, state: 'Open' }, at)
    await store.settled()
    expect((await new SessionGitHistoryStore(dir).get(target)).pullRequests[0].result).toMatchObject({ state: 'Merged' })
    expect((await readdir(dir)).filter(p => p.endsWith('.json'))).toHaveLength(14)
  })
  it('retains multiple branches and PR states across daemon restart and missing checkouts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'git-history-')); dirs.push(dir)
    const store = new SessionGitHistoryStore(dir)
    await store.observe(target, context('hn/nfc'))
    await store.observe(target, context('hn/preview'))
    await store.observe(target, context('hn/preview'))
    const pr = { url: 'https://github.com/acme/app/pull/12', cwd: '/ship-hn', at }
    const merged = { status: 'found' as const, number: 12, state: 'Merged' as const, url: pr.url }
    await store.recordPullRequest(target, pr, merged, at)
    await store.recordPullRequest(target, pr, { status: 'unavailable' }, '2026-09-27T14:00:00.000Z')
    await store.settled()
    const restarted = new SessionGitHistoryStore(dir)
    const saved = await restarted.observe(target, context('', { state: 'unavailable', current: null }))
    expect(saved.branches.map(b => b.branch).sort()).toEqual(['hn/nfc', 'hn/preview'])
    expect(saved.pullRequests).toEqual([{ ...pr, result: merged, checkedAt: at }])
    const file = join(dir, (await readdir(dir))[0])
    expect((await stat(file)).mode & 0o777).toBe(0o600)
    expect(await readFile(file, 'utf8')).not.toContain('command')
    expect((await restarted.get({ ...target, sessionId: 'other' })).branches).toEqual([])
    expect((await restarted.get({ ...target, forkedFrom: { agentId: 'parent', name: 'Parent' }, registeredAt: 2 })).branches).toEqual([])
  })

  it('records the assigned branch without requiring tool activity, without inventing unknown branches', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'git-history-')); dirs.push(dir)
    const store = new SessionGitHistoryStore(dir)
    await store.observe(target, context('main', { state: 'workspace' }))
    await store.observe(target, context('maybe', { state: 'uncertain', current: null }))
    expect((await store.get(target)).branches.map(b => b.branch)).toEqual(['main'])
    await store.settled()
  })
})
