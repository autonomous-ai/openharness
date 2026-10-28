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
    const spy: TokenCache = { get: k => memory.get(k), delete: k => memory.delete(k),
      set: async (k, v, ttl) => { stored.push(v); await memory.set(k, v, ttl) } }
    const { tokens } = setup(spy)
    const one = await tokens.issue(request('attempt-1', 'agent-1'))
    const two = await tokens.issue(request('attempt-2', 'agent-2'))
    expect(one.token).not.toBe(two.token)
    expect(stored).toHaveLength(2)
    for (const value of stored) {
      expect(value).not.toContain('ghs_')
      expect(value).not.toContain('attempt')
    }
  })

  it('revokes a token cached for an earlier task before minting for the new one', async () => {
    const { tokens, github } = setup()
    const first = await tokens.issue(request('attempt-1'))
    const second = await tokens.issue(request('attempt-2'))
    expect(second.token).not.toBe(first.token)
    expect(github.revoked).toEqual([first.token])
  })

  it('refuses a repository the app is not installed on, with the install link', async () => {
    const { tokens, github } = setup()
    github.installed.clear()
    await expect(tokens.issue(request())).rejects.toMatchObject({ code: 'GITHUB_APP_NOT_INSTALLED', status: 409,
      details: { installUrl: 'https://github.com/apps/harness-fixture/installations/new' } })
  })

  it('still answers when the cache is away, and logs that without the token', async () => {
    const broken: TokenCache = { get: async () => { throw new Error('redis down') }, set: async () => { throw new Error('redis down') },
      delete: async () => { throw new Error('redis down') } }
    const { tokens, log } = setup(broken)
    const issued = await tokens.issue(request())
    expect(issued.token).toBe('ghs_fixture_1')
    await tokens.release('tab-1', [{ agentId: 'agent-1', assignmentId: 'attempt-1' }])
    expect(log.warn).toHaveBeenCalled()
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain('ghs_')
  })

  it('ignores a cache entry it cannot open', async () => {
    const memory = new MemoryTokenCache()
    const { tokens } = setup({ get: async () => 'garbage.value', set: (k, v, t) => memory.set(k, v, t), delete: k => memory.delete(k) })
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
    // Forgotten: the next request for the same task mints a fresh token, and agent-2 keeps its own.
    expect((await tokens.issue(request('attempt-1', 'agent-1'))).token).not.toBe(one.token)
    expect((await tokens.issue(request('attempt-2', 'agent-2'))).token).toBe(two.token)
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
    expect((await tokens.issue(request())).token).not.toBe(issued.token)
  })

  it('refuses a sealing key of the wrong size', () => {
    const github = fakeGitHub({ publicKey: key.publicKey, appId: '424242' })
    expect(() => new GitHubTokens(fakeApp(key.privateKey, github), new MemoryTokenCache(), { secret: Buffer.alloc(16) })).toThrow('32-byte key')
  })
})

describe('token caches', () => {
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
