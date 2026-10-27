/**
 * Installation tokens for Swarm agents (routes/superTabs.ts `github-token`): one per agent and task, kept until ten
 * minutes before it expires, and revoked as soon as that task ends (superTabs/store.ts `workEnded`).
 *
 * The cache is shared by every backend process (Redis in production), so a task closed on one process revokes the token
 * another process issued. Entries are sealed with a key derived from the app's private key (github/app.ts
 * `cacheSecret`). Nothing here logs a token.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Redis } from 'ioredis'
import { logger } from '../utils/logger.js'
import { GitHubApp, GitHubAppError, PREPARE_PERMISSIONS, cacheSecret, githubAppConfig, type BranchProtection } from './app.js'
import type { GitHubRepository } from './repository.js'
import type { WorkHold } from './holds.js'

export interface TokenCache {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ttlMs: number): Promise<void>
  delete(key: string): Promise<void>
}

/** One process's cache, for tests and a backend without Redis. */
export class MemoryTokenCache implements TokenCache {
  private readonly entries = new Map<string, { value: string; until: number }>()
  constructor(private readonly now: () => number = Date.now) {}
  async get(key: string) {
    const entry = this.entries.get(key)
    if (!entry || entry.until <= this.now()) { this.entries.delete(key); return null }
    return entry.value
  }
  async set(key: string, value: string, ttlMs: number) { this.entries.set(key, { value, until: this.now() + ttlMs }) }
  async delete(key: string) { this.entries.delete(key) }
}

/** The backend's shared Redis (lib/bus.ts `pub`), which fails fast rather than queueing while Redis is away. */
export class RedisTokenCache implements TokenCache {
  constructor(private readonly redis: Pick<Redis, 'get' | 'set' | 'del'>) {}
  async get(key: string) { return this.redis.get(key) }
  async set(key: string, value: string, ttlMs: number) { await this.redis.set(key, value, 'PX', Math.max(1, Math.floor(ttlMs))) }
  async delete(key: string) { await this.redis.del(key) }
}

/** What one agent's task may use. */
export interface TokenRequest { tabId: string; agentId: string; assignmentId: string; repository: GitHubRepository }
export interface IssuedToken {
  token: string
  expiresAt: string
  repository: string
  defaultBranch: string | null
  /** True only when a ruleset is known to require a pull request on the default branch. False asks the Lead to warn
   *  people that this token can push to it straight. */
  defaultBranchProtected: boolean
  defaultBranchProtection: BranchProtection
}
interface Entry { token: string; expiresAt: string; repository: string; assignmentId: string }

/** A token is handed out again until this long before it expires, so whoever holds it has at least that long. */
export const REUSE_MARGIN_MS = 10 * 60_000
const KEY_PREFIX = 'harness:github-token:v1'

export interface GitHubTokensOptions {
  now?: () => number
  log?: Pick<typeof logger, 'warn'>
  /** The sealing key (github/app.ts `cacheSecret`). */
  secret: Buffer
}

export class GitHubTokens {
  private readonly now: () => number
  private readonly log: Pick<typeof logger, 'warn'>
  private readonly secret: Buffer
  private readonly flights = new Map<string, Promise<IssuedToken>>()

  constructor(readonly app: GitHubApp, private readonly cache: TokenCache, options: GitHubTokensOptions) {
    this.now = options.now ?? Date.now
    this.log = options.log ?? logger
    if (options.secret.length !== 32) throw new Error('The GitHub token cache needs a 32-byte key.')
    this.secret = options.secret
  }

  private key(tabId: string, agentId: string) { return `${KEY_PREFIX}:${tabId}:${agentId}` }

  private seal(entry: Entry): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.secret, iv)
    const body = Buffer.concat([cipher.update(JSON.stringify(entry), 'utf8'), cipher.final()])
    return [iv, cipher.getAuthTag(), body].map(part => part.toString('base64url')).join('.')
  }

  private open(value: string | null): Entry | null {
    if (!value) return null
    try {
      const [iv, tag, body] = value.split('.').map(part => Buffer.from(part, 'base64url'))
      const decipher = createDecipheriv('aes-256-gcm', this.secret, iv!)
      decipher.setAuthTag(tag!)
      const entry = JSON.parse(Buffer.concat([decipher.update(body!), decipher.final()]).toString('utf8')) as Entry
      return typeof entry.token === 'string' && typeof entry.expiresAt === 'string' && typeof entry.assignmentId === 'string'
        && typeof entry.repository === 'string' ? entry : null
    } catch { return null }
  }

  private async read(key: string): Promise<Entry | null> {
    try { return this.open(await this.cache.get(key)) } catch (error) {
      this.log.warn('[github] token cache unreadable', { error: error instanceof Error ? error.message : String(error) })
      return null
    }
  }

  /** The agent's token for its task: the cached one while it has more than REUSE_MARGIN_MS left, else a new one. A token
   *  cached for an earlier task or another repository is revoked first. */
  async issue(request: TokenRequest): Promise<IssuedToken> {
    const key = this.key(request.tabId, request.agentId)
    const flight = `${key}:${request.assignmentId}:${request.repository.fullName}`
    const running = this.flights.get(flight)
    if (running) return running
    const work = this.mint(key, request).finally(() => this.flights.delete(flight))
    this.flights.set(flight, work)
    return work
  }

  private async mint(key: string, request: TokenRequest): Promise<IssuedToken> {
    const repository = request.repository.fullName
    let actual = request.repository
    const cached = await this.read(key)
    let entry: Entry | null = null
    if (cached && cached.assignmentId === request.assignmentId && cached.repository === repository) {
      if (Date.parse(cached.expiresAt) - this.now() > REUSE_MARGIN_MS) entry = cached
      // Close to its end, it is left to expire: the agent may still be using it.
    } else if (cached) {
      await this.revoke(request.tabId, request.agentId, cached, 'replaced')
      await this.forget(key)
    }
    if (!entry) {
      // Under the name GitHub knows it by now (app.ts `resolve`); the agent's checkout keeps the name it was given, which
      // GitHub still answers for git.
      const resolved = await this.app.resolve(request.repository)
      if (resolved === null) throw this.app.notInstalled(request.repository)
      actual = resolved.repository
      const minted = await this.app.createToken(resolved.installation, actual)
      entry = { ...minted, repository, assignmentId: request.assignmentId }
      const ttl = Date.parse(minted.expiresAt) - this.now()
      if (ttl > 0) {
        try { await this.cache.set(key, this.seal(entry), ttl) } catch (error) {
          // Not cached, it cannot be revoked when the task ends; it still expires within the hour.
          this.log.warn('[github] token not cached', { tabId: request.tabId, agentId: request.agentId, repository,
            error: error instanceof Error ? error.message : String(error) })
        }
      }
    }
    const branch = await this.app.defaultBranch(actual, entry.token)
    return { token: entry.token, expiresAt: entry.expiresAt, repository, defaultBranch: branch.branch,
      defaultBranchProtected: branch.protection === 'pull_request', defaultBranchProtection: branch.protection }
  }

  /**
   * A token that only reads [repository], for a machine preparing a Swarm agent's folder before the agent exists (routes/
   * superTabs.ts, a start's `github-token`): the clone and the fetch of its default branch, so that the machine's own git
   * login is never used for another person's project. Never cached: one start asks once, and it lasts at most an hour.
   */
  async prepare(repository: GitHubRepository): Promise<{ token: string; expiresAt: string; repository: string }> {
    const resolved = await this.app.resolve(repository)
    if (resolved === null) throw this.app.notInstalled(repository)
    const minted = await this.app.createToken(resolved.installation, resolved.repository, PREPARE_PERMISSIONS)
    return { ...minted, repository: repository.fullName }
  }

  private async revoke(tabId: string, agentId: string, entry: Entry, why: string): Promise<void> {
    try { await this.app.revoke(entry.token) } catch (error) {
      this.log.warn('[github] token revoke failed', { tabId, agentId, repository: entry.repository, why,
        code: error instanceof GitHubAppError ? error.code : 'ERROR' })
    }
  }

  private async forget(key: string): Promise<void> {
    try { await this.cache.delete(key) } catch (error) {
      this.log.warn('[github] token cache entry not removed', { error: error instanceof Error ? error.message : String(error) })
    }
  }

  /** The tasks that ended in [tabId] (done, cancelled, stopped, reassigned, or the agent removed): each one's cached token is
   *  revoked and forgotten. Never throws; a failed revoke is logged without the token and leaves the token to expire. */
  async release(tabId: string, ended: readonly WorkHold[]): Promise<void> {
    for (const hold of ended) {
      const key = this.key(tabId, hold.agentId)
      const entry = await this.read(key)
      if (!entry || entry.assignmentId !== hold.assignmentId) continue
      await this.revoke(tabId, hold.agentId, entry, 'task ended')
      await this.forget(key)
    }
  }
}

/** The app from the server's environment, sharing tokens through Redis; null when it is not configured. */
export async function githubTokensFromEnv(env: { GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: string; GITHUB_APP_SLUG: string }): Promise<GitHubTokens | null> {
  const config = githubAppConfig(env)
  if (!config) return null
  // Loaded only when configured: importing the bus opens its Redis connections.
  const { pub } = await import('../lib/bus.js')
  return new GitHubTokens(new GitHubApp(config), new RedisTokenCache(pub), { secret: cacheSecret(config) })
}
