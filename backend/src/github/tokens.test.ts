import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { fakeApp, fakeGitHub, throwawayKey } from './fakeGitHub.js'
import { githubRepository } from './repository.js'
import { GitHubTokens, MemoryTokenCache, RedisTokenCache, REUSE_MARGIN_MS, type TokenCache } from './tokens.js'

const key = throwawayKey()
const repository = githubRepository('git@github.com:acme/app.git')!
const setup = (cacheOverride?: TokenCache) => {
  let t = Date.parse('2026-10-24T12:00:00Z')
  const now = () => t
  const github = fakeGitHub({ publicKey: key.publicKey, appId: '424242', now })
  github.installed.set('acme/app', 77)
  const cache = new MemoryTokenCache(now)
  const log = { warn: vi.fn() }
  const tokens = new GitHubTokens(fakeApp(key.privateKey, github, { now }), cacheOverride ?? cache, { now, log, secret: randomBytes(32) })
  return { github, cache, log, tokens, advance: (ms: number) => { t += ms } }
}
const request = (assignmentId = 'attempt-1', agentId = 'agent-1') => ({ tabId: 'tab-1', agentId, assignmentId, repository })

describe('preparation tokens', () => {
  it('only read the repository, and are minted each time, never cached', async () => {
    const { tokens, github } = setup()
    expect(await tokens.prepare(repository)).toMatchObject({ token: 'ghs_fixture_1', repository: 'acme/app' })
    expect((await tokens.prepare(repository)).token).toBe('ghs_fixture_2')
    const minted = github.calls.filter(c => c.path.endsWith('/access_tokens'))
    expect(minted.map(c => c.body)).toEqual([0, 1].map(() => ({ repositories: ['app'], permissions: { contents: 'read', metadata: 'read' } })))
  })

  it('refuses a repository the app is not installed on', async () => {
    const { tokens, github } = setup()
    github.installed.clear()
    await expect(tokens.prepare(repository)).rejects.toMatchObject({ code: 'GITHUB_APP_NOT_INSTALLED' })
  })
})

// A repository renamed on GitHub (2026-10-27: autonomous-harness → openharness): the project keeps the old name, which
// GitHub still answers for git, and the app is installed on the repository under its new one.
describe('a repository renamed on GitHub', () => {
  const renamedSetup = () => {
    const f = setup()
    f.github.installed.clear()
    f.github.installed.set('acme/app-next', 77)
    f.github.owners.set('acme', 77)
    f.github.renamed.set('acme/app', 'acme/app-next')
    return f
  }

  it('gets its tokens under its name now, and the read-only token used to find that name is revoked at once', async () => {
    const { tokens, github } = renamedSetup()
    expect(await tokens.prepare(repository)).toMatchObject({ repository: 'acme/app' })
    const minted = github.calls.filter(c => c.path.endsWith('/access_tokens')).map(c => c.body)
    expect(minted).toEqual([{ permissions: { metadata: 'read' } }, { repositories: ['app-next'], permissions: { contents: 'read', metadata: 'read' } }])
    expect(github.revoked).toEqual(['ghs_fixture_1'])
    expect((await tokens.issue(request())).repository).toBe('acme/app')
    expect(github.calls.filter(c => c.path.endsWith('/access_tokens')).at(-1)!.body).toMatchObject({ repositories: ['app-next'] })
    // Its name now is remembered: GitHub is not asked again for it.
    expect(github.calls.filter(c => c.path === '/orgs/acme/installation')).toHaveLength(1)
  })

  it('is not installed when its owner has no installation, or the repository was never renamed', async () => {
    const none = renamedSetup()
    none.github.owners.clear()
    await expect(none.tokens.prepare(repository)).rejects.toMatchObject({ code: 'GITHUB_APP_NOT_INSTALLED' })
    expect(none.github.calls.map(c => c.path)).toContain('/users/acme/installation')
    const same = renamedSetup()
    same.github.renamed.clear()
    await expect(same.tokens.prepare(repository)).rejects.toMatchObject({ code: 'GITHUB_APP_NOT_INSTALLED' })
    expect(same.github.revoked).toEqual(['ghs_fixture_1'])
  })

  it('reads as not installed when GitHub cannot say, and wrong credentials still say so', async () => {
    const down = renamedSetup()
    down.github.control.tokenStatus = 500
    await expect(down.tokens.prepare(repository)).rejects.toMatchObject({ code: 'GITHUB_APP_NOT_INSTALLED' })
    const app = fakeApp(throwawayKey().privateKey, down.github, { now: () => Date.parse('2026-10-24T12:00:00Z') })
    await expect(app.resolve(repository)).rejects.toMatchObject({ code: 'GITHUB_APP_MISCONFIGURED' })
  })
})

describe('agent tokens', () => {
  it('mints one for the task and gives the same token again until ten minutes before it expires', async () => {
    const { tokens, github, advance } = setup()
    const first = await tokens.issue(request())
    expect(first).toMatchObject({ token: 'ghs_fixture_1', repository: 'acme/app', defaultBranch: 'main', defaultBranchProtected: false,
      defaultBranchProtection: 'none' })
    advance(60 * 60_000 - REUSE_MARGIN_MS - 1000)
    expect((await tokens.issue(request())).token).toBe('ghs_fixture_1')
    advance(2000)
    const renewed = await tokens.issue(request())
    expect(renewed.token).toBe('ghs_fixture_2')
    // The old one is close to its end and may still be in use: it is left to expire, not revoked.
    expect(github.revoked).toEqual([])
    expect(github.calls.filter(c => c.path.endsWith('/access_tokens'))).toHaveLength(2)
  })

  it('says when the default branch requires a pull request', async () => {
    const { tokens, github } = setup()
    github.protection.set('acme/app', { rules: [{ type: 'pull_request' }] })
    expect(await tokens.issue(request())).toMatchObject({ defaultBranchProtected: true, defaultBranchProtection: 'pull_request' })
  })

  it('asks GitHub once for concurrent requests from the same task', async () => {
    const { tokens, github } = setup()
    const [a, b] = await Promise.all([tokens.issue(request()), tokens.issue(request())])
    expect(a.token).toBe(b.token)
    expect(github.calls.filter(c => c.path.endsWith('/access_tokens'))).toHaveLength(1)
  })

  it('keeps tokens apart per agent and seals them in the cache', async () => {
    const stored: string[] = []
    const memory = new MemoryTokenCache()
    const spy: TokenCache = { get: k => memory.get(k), delete: k => memory.delete(k), take: k => memory.take(k),
      set: async (k, v, ttl) => { stored.push(v); await memory.set(k, v, ttl) },
      add: async (k, v, ttl) => { stored.push(v); await memory.add(k, v, ttl) } }
    const { tokens } = setup(spy)
    const one = await tokens.issue(request('attempt-1', 'agent-1'))
    const two = await tokens.issue(request('attempt-2', 'agent-2'))
    expect(one.token).not.toBe(two.token)
    // Each token twice, as the agent's entry and among its task's minted tokens, both sealed.
    expect(stored).toHaveLength(4)
    for (const value of stored) {
      expect(value).not.toContain('ghs_')
      expect(value).not.toContain('attempt')
    }
  })

  it('mints apart for the agent\'s next task, and leaves the earlier task\'s token to that task\'s own end', async () => {
    const { tokens, github } = setup()
    const first = await tokens.issue(request('attempt-1'))
    const second = await tokens.issue(request('attempt-2'))
    expect(second.token).not.toBe(first.token)
    // A request ends only its own task (third security review of #1976); the store ends the earlier one (workEnded).
    expect(github.revoked).toEqual([])
    await tokens.release('tab-1', [{ agentId: 'agent-1', assignmentId: 'attempt-1' }])
    expect(github.revoked).toEqual([first.token])
    expect((await tokens.issue(request('attempt-2'))).token).toBe(second.token)
  })

  it('refuses a repository the app is not installed on, with the install link', async () => {
    const { tokens, github } = setup()
    github.installed.clear()
    await expect(tokens.issue(request())).rejects.toMatchObject({ code: 'GITHUB_APP_NOT_INSTALLED', status: 409,
      details: { installUrl: 'https://github.com/apps/harness-fixture/installations/new' } })
  })

  it('still answers when the cache is away, and logs that without the token', async () => {
    const broken: TokenCache = { get: async () => { throw new Error('redis down') }, set: async () => { throw new Error('redis down') },
      delete: async () => { throw new Error('redis down') }, add: async () => { throw new Error('redis down') },
      take: async () => { throw new Error('redis down') } }
    const { tokens, log } = setup(broken)
    const issued = await tokens.issue(request())
    expect(issued.token).toBe('ghs_fixture_1')
    await tokens.release('tab-1', [{ agentId: 'agent-1', assignmentId: 'attempt-1' }])
    expect(log.warn).toHaveBeenCalled()
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('ghs_')
  })

  it('ignores a cache entry it cannot open', async () => {
    const memory = new MemoryTokenCache()
    const { tokens } = setup({ get: async () => 'garbage.value', set: (k, v, t) => memory.set(k, v, t), delete: k => memory.delete(k),
      add: (k, v, t) => memory.add(k, v, t), take: async () => ['garbage.value'] })
    expect((await tokens.issue(request())).token).toBe('ghs_fixture_1')
  })
})

describe('revoking when a task ends', () => {
  it('revokes and forgets the token of each ended task, and only that task\'s', async () => {
    const { tokens, github } = setup()
    const one = await tokens.issue(request('attempt-1', 'agent-1'))
    const two = await tokens.issue(request('attempt-2', 'agent-2'))
    await tokens.release('tab-1', [{ agentId: 'agent-1', assignmentId: 'attempt-1' }, { agentId: 'agent-2', assignmentId: 'older-attempt' },
      { agentId: 'agent-3', assignmentId: 'attempt-3' }])
    expect(github.revoked).toEqual([one.token])
    // Forgotten, and the ended task gets no token again; agent-2 keeps its own.
    await expect(tokens.issue(request('attempt-1', 'agent-1'))).rejects.toMatchObject({ code: 'NO_ASSIGNMENT' })
    expect((await tokens.issue(request('attempt-2', 'agent-2'))).token).toBe(two.token)
  })

  // Lead, 2026-10-28 (local Team account run): a renewal leaves the replaced token to its last ten minutes so a push in
  // progress is not broken, but the task's end takes every token it held, replaced ones too.
  it('revokes the replaced tokens of a renewed task with its current one when the task ends', async () => {
    const { tokens, github, advance } = setup()
    const first = await tokens.issue(request())
    advance(60 * 60_000 - REUSE_MARGIN_MS + 1000)
    const second = await tokens.issue(request())
    advance(60 * 60_000 - REUSE_MARGIN_MS + 1000)
    const third = await tokens.issue(request())
    expect(github.revoked).toEqual([])
    await tokens.release('tab-1', [{ agentId: 'agent-1', assignmentId: 'attempt-1' }])
    // The first had expired by then: GitHub is not asked about it.
    expect(github.revoked.sort()).toEqual([second.token, third.token].sort())
    expect(github.revoked).not.toContain(first.token)
  })

  it('revokes a renewed task\'s replaced token too when it ends after another task took the agent', async () => {
    const { tokens, github, advance } = setup()
    const first = await tokens.issue(request('attempt-1'))
    advance(60 * 60_000 - REUSE_MARGIN_MS + 1000)
    const second = await tokens.issue(request('attempt-1'))
    await tokens.issue(request('attempt-2'))
    await tokens.release('tab-1', [{ agentId: 'agent-1', assignmentId: 'attempt-1' }])
    expect(github.revoked.sort()).toEqual([first.token, second.token].sort())
  })

  // Security review of #1976: two backend instances share the cache. One ended the task and revoked the old token while the
  // other was renewing it; the renewal then stored a new token, good for an hour, that nothing would revoke.
  it('revokes and keeps no token minted for a task that another instance ended meanwhile', async () => {
    let t = Date.parse('2026-10-24T12:00:00Z')
    const now = () => t
    const github = fakeGitHub({ publicKey: key.publicKey, appId: '424242', now })
    github.installed.set('acme/app', 77)
    const cache = new MemoryTokenCache(now), secret = randomBytes(32)
    const instance = () => new GitHubTokens(fakeApp(key.privateKey, github, { now }), cache, { now, log: { warn: vi.fn() }, secret })
    const ending = instance(), renewing = instance()
    await renewing.issue(request())
    t += 60 * 60_000 - REUSE_MARGIN_MS + 1000
    // GitHub's answer to the renewal is held until the other instance has ended the task.
    let answer!: () => void
    const held = new Promise<void>(resolve => { answer = resolve })
    const create = renewing.app.createToken.bind(renewing.app)
    const minting = vi.spyOn(renewing.app, 'createToken').mockImplementation(async (...args) => { await held; return create(...args) })
    const renewal = renewing.issue(request())
    await vi.waitFor(() => expect(minting).toHaveBeenCalled())
    await ending.release('tab-1', [{ agentId: 'agent-1', assignmentId: 'attempt-1' }])
    answer()
    await expect(renewal).rejects.toMatchObject({ code: 'NO_ASSIGNMENT' })
    // Both tokens revoked, none kept: the ended task gets no token again on either instance.
    expect(github.issued.size).toBe(0)
    expect(github.revoked).toHaveLength(2)
    await expect(ending.issue(request())).rejects.toMatchObject({ code: 'NO_ASSIGNMENT' })
    await expect(renewing.issue(request())).rejects.toMatchObject({ code: 'NO_ASSIGNMENT' })
  })

  // Second security review of #1976: two instances renewing the same live task at once each minted a token, the second's
  // cache write replaced the first's, and the task's end revoked only the one cached; the other stayed good for an hour.
  it('revokes every token minted for a task when it ends, also two renewals that ran at once on two instances', async () => {
    let t = Date.parse('2026-10-24T12:00:00Z')
    const now = () => t
    const github = fakeGitHub({ publicKey: key.publicKey, appId: '424242', now })
    github.installed.set('acme/app', 77)
    const cache = new MemoryTokenCache(now), secret = randomBytes(32)
    const instance = () => new GitHubTokens(fakeApp(key.privateKey, github, { now }), cache, { now, log: { warn: vi.fn() }, secret })
    const one = instance(), two = instance()
    await one.issue(request())
    t += 60 * 60_000 - REUSE_MARGIN_MS + 1000
    // Both instances read the cache before either has minted: GitHub's answers are held until both are asking.
    let answer!: () => void
    const held = new Promise<void>(resolve => { answer = resolve })
    const hold = (tokens: GitHubTokens) => {
      const create = tokens.app.createToken.bind(tokens.app)
      return vi.spyOn(tokens.app, 'createToken').mockImplementation(async (...args) => { await held; return create(...args) })
    }
    const asked = [hold(one), hold(two)]
    const renewals = [one.issue(request()), two.issue(request())]
    await vi.waitFor(() => { for (const spy of asked) expect(spy).toHaveBeenCalled() })
    answer()
    const [a, b] = await Promise.all(renewals)
    expect(a!.token).not.toBe(b!.token)
    await one.release('tab-1', [{ agentId: 'agent-1', assignmentId: 'attempt-1' }])
    // The first token and both renewals: none left valid.
    expect(github.issued.size).toBe(0)
  })

  // Third security review of #1976: an old task's request paused after its end check; the task ended and the agent's next
  // task got a token; the old request then read the new task's entry, took it for an ended one, revoked its token and
  // marked it ended, so the live task was refused for 70 minutes. A request ends only the task it was made for.
  it('a stale request for an ended task leaves the agent\'s next task and its token alone', async () => {
    const t = Date.parse('2026-10-24T12:00:00Z')
    const github = fakeGitHub({ publicKey: key.publicKey, appId: '424242', now: () => t })
    github.installed.set('acme/app', 77)
    const memory = new MemoryTokenCache(() => t), secret = randomBytes(32)
    // The stale instance's first read of the agent's entry waits until the next task has its token.
    let resume!: () => void
    const resumed = new Promise<void>(done => { resume = done })
    let paused = false
    const gated: TokenCache = { set: (k, v, ttl) => memory.set(k, v, ttl), delete: k => memory.delete(k), add: (k, v, ttl) => memory.add(k, v, ttl),
      take: k => memory.take(k), get: async k => {
        if (!paused && k === 'harness:github-token:v1:tab-1:agent-1') { paused = true; await resumed }
        return memory.get(k)
      } }
    const make = (cache: TokenCache) => new GitHubTokens(fakeApp(key.privateKey, github, { now: () => t }), cache, { now: () => t, log: { warn: vi.fn() }, secret })
    const stale = make(gated), fresh = make(memory)
    const old = stale.issue(request('attempt-1'))
    await vi.waitFor(() => expect(paused).toBe(true))
    await fresh.release('tab-1', [{ agentId: 'agent-1', assignmentId: 'attempt-1' }])
    const next = await fresh.issue(request('attempt-2'))
    resume()
    await expect(old).rejects.toMatchObject({ code: 'NO_ASSIGNMENT' })
    // The next task's token is still good, and the next task still gets one.
    expect(github.issued.has(next.token)).toBe(true)
    await expect(fresh.issue(request('attempt-2'))).resolves.toMatchObject({ repository: 'acme/app' })
    // The old request's own token went with its task; the next task's end takes every one of its own.
    await fresh.release('tab-1', [{ agentId: 'agent-1', assignmentId: 'attempt-2' }])
    expect(github.issued.size).toBe(0)
  })

  // Security re-check of #1976: a task lost to a usage limit resumes under the same id. Its end and its resumption are
  // handled in the order the store reported them, so a slow end never marks the resumed task ended again.
  it('forgets a task\'s end when it resumes, even when the end was still being recorded', async () => {
    const memory = new MemoryTokenCache()
    let slow: (() => void) | null = null
    const cache: TokenCache = { get: k => memory.get(k), delete: k => memory.delete(k), add: (k, v, t) => memory.add(k, v, t), take: k => memory.take(k),
      set: async (k, v, t) => { if (k.includes(':released:')) await new Promise<void>(done => { slow = done }); await memory.set(k, v, t) } }
    const { tokens, github } = setup(cache)
    const before = await tokens.issue(request())
    const ended = tokens.release('tab-1', [{ agentId: 'agent-1', assignmentId: 'attempt-1' }])
    const resumed = tokens.resume('tab-1', [{ agentId: 'agent-1', assignmentId: 'attempt-1' }])
    await vi.waitFor(() => expect(slow).not.toBeNull())
    slow!()
    await Promise.all([ended, resumed])
    expect(github.revoked).toEqual([before.token])
    const after = await tokens.issue(request())
    expect(after.token).not.toBe(before.token)
  })

  it('logs a failed revoke without the token, drops it anyway and never throws', async () => {
    const { tokens, github, log } = setup()
    const issued = await tokens.issue(request())
    github.control.revokeStatus = 500
    await expect(tokens.release('tab-1', [{ agentId: 'agent-1', assignmentId: 'attempt-1' }])).resolves.toBeUndefined()
    expect(log.warn).toHaveBeenCalledWith('[github] token revoke failed', { tabId: 'tab-1', agentId: 'agent-1', repository: 'acme/app',
      why: 'task ended', code: 'GITHUB_UNAVAILABLE' })
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(issued.token)
    github.control.revokeStatus = 204
    // Dropped: the agent's next task gets a token of its own, not this one.
    expect((await tokens.issue(request('attempt-2'))).token).not.toBe(issued.token)
  })

  it('refuses a sealing key of the wrong size', () => {
    const github = fakeGitHub({ publicKey: key.publicKey, appId: '424242' })
    expect(() => new GitHubTokens(fakeApp(key.privateKey, github), new MemoryTokenCache(), { secret: Buffer.alloc(16) })).toThrow('32-byte key')
  })
})

describe('token caches', () => {
  it('adds to a set and takes it whole, in memory and in one Redis transaction each', async () => {
    let t = 0
    const memory = new MemoryTokenCache(() => t)
    await memory.add('s', 'a', 1000)
    await memory.add('s', 'b', 1000)
    expect((await memory.take('s')).sort()).toEqual(['a', 'b'])
    expect(await memory.take('s')).toEqual([])
    await memory.add('s', 'a', 1000)
    t = 1000
    expect(await memory.take('s')).toEqual([])
    const queued: unknown[][] = []
    const results: Array<[Error | null, unknown]>[] = [[[null, 1], [null, 1]], [[null, ['x', 'y']], [null, 1]], [[new Error('READONLY'), null]]]
    const multi = () => {
      const chain = { sadd: (...a: unknown[]) => (queued.push(['sadd', ...a]), chain), pexpire: (...a: unknown[]) => (queued.push(['pexpire', ...a]), chain),
        smembers: (...a: unknown[]) => (queued.push(['smembers', ...a]), chain), del: (...a: unknown[]) => (queued.push(['del', ...a]), chain),
        exec: async () => results.shift() ?? null }
      return chain
    }
    const redis = new RedisTokenCache({ multi } as never)
    await redis.add('s', 'm', 1234.7)
    expect(await redis.take('s')).toEqual(['x', 'y'])
    expect(queued).toEqual([['sadd', 's', 'm'], ['pexpire', 's', 1234], ['smembers', 's'], ['del', 's']])
    await expect(redis.take('s')).rejects.toThrow('READONLY')
    await expect(redis.take('s')).rejects.toThrow('discarded')
  })

  it('expires memory entries', async () => {
    let t = 0
    const cache = new MemoryTokenCache(() => t)
    await cache.set('k', 'v', 1000)
    expect(await cache.get('k')).toBe('v')
    t = 1000
    expect(await cache.get('k')).toBeNull()
    await cache.set('k', 'v', 1000)
    await cache.delete('k')
    expect(await cache.get('k')).toBeNull()
  })

  it('stores Redis entries with a millisecond expiry', async () => {
    const redis = { get: vi.fn(async () => 'sealed'), set: vi.fn(async () => 'OK' as const), del: vi.fn(async () => 1) }
    const cache = new RedisTokenCache(redis as never)
    expect(await cache.get('k')).toBe('sealed')
    await cache.set('k', 'v', 1234.7)
    await cache.delete('k')
    expect(redis.set).toHaveBeenCalledWith('k', 'v', 'PX', 1234)
    expect(redis.del).toHaveBeenCalledWith('k')
  })
})
