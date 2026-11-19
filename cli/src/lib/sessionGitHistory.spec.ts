import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionGitHistoryStore } from './sessionGitHistory.js'
import type { RegisteredSession } from './registry.js'
import type { SessionGitContext } from './sessionGitContext.js'

// Pass-through, recording what replaced a file and what was opened by name through fs/promises; `sync`: each rename's
// target and each path opened through node:fs's synchronous calls, which a save that must not block its event loop never
// makes.
const disk = vi.hoisted(() => ({ renamed: [] as Array<[string, string]>, opened: [] as string[], sync: [] as string[] }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => { disk.sync.push(`rename ${String(args[1])}`); return actual.renameSync(...args) },
    openSync: (...args: Parameters<typeof actual.openSync>) => { disk.sync.push(`open ${String(args[0])}`); return actual.openSync(...args) },
  }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual,
    rename: (...args: Parameters<typeof actual.rename>) => {
      disk.renamed.push([String(args[0]), String(args[1])])
      return actual.rename(...args)
    },
    open: (...args: Parameters<typeof actual.open>) => { disk.opened.push(String(args[0])); return actual.open(...args) },
  }
})
/** The synchronous writes of [file]: onto it, or of its temporary file. */
const syncWrites = (file: string): string[] => disk.sync.filter(event => event === `rename ${file}` || event.startsWith(`open ${file}.`))

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

  it('the save goes through a temporary file renamed onto the target, and never blocks the event loop', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'git-history-')); dirs.push(dir)
    const store = new SessionGitHistoryStore(dir)
    disk.renamed = []; disk.opened = []; disk.sync = []
    await store.observe(target, context('main'))
    await store.settled()
    const file = join(dir, (await readdir(dir)).find(name => name.endsWith('.json'))!)
    expect(disk.renamed.filter(([, to]) => to === file).map(([from]) => from)).toEqual([expect.stringMatching(/\.tmp$/)])
    expect(disk.renamed[0]![0].startsWith(`${file}.`)).toBe(true)
    expect(disk.opened).not.toContain(file)
    expect(syncWrites(file)).toEqual([])
  })

  it('a torn history is set aside, not written over', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'git-history-')); dirs.push(dir)
    const first = new SessionGitHistoryStore(dir)
    await first.observe(target, context('main'))
    await first.settled()
    const name = (await readdir(dir)).find(n => n.endsWith('.json'))!
    const file = join(dir, name)
    await writeFile(file, '{"')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const store = new SessionGitHistoryStore(dir)
      expect((await store.get(target)).branches).toEqual([])
      await store.observe(target, context('feature'))
      await store.settled()
      expect(await readFile(`${file}.unreadable`, 'utf8')).toBe('{"')
      expect(JSON.parse(await readFile(file, 'utf8')).branches.map((b: { branch: string }) => b.branch)).toEqual(['feature'])
      expect(warn).toHaveBeenCalledWith(
        `[state] ${name} could not be read (not valid JSON); kept as ${name}.unreadable, starting empty.`)
    } finally { warn.mockRestore() }
  })

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('a history this account cannot read is not written over', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'git-history-')); dirs.push(dir)
    const first = new SessionGitHistoryStore(dir)
    await first.observe(target, context('main'))
    await first.settled()
    const file = join(dir, (await readdir(dir)).find(n => n.endsWith('.json'))!)
    const before = await readFile(file, 'utf8')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await chmod(file, 0o000)
      const store = new SessionGitHistoryStore(dir)
      await store.observe(target, context('feature'))
      await store.settled()
      await chmod(file, 0o600)
      expect(await readFile(file, 'utf8')).toBe(before)
    } finally { warn.mockRestore() }
  })
})
