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
  /** Adds [member] to the set at [key] in one step, and keeps the set [ttlMs] from now. */
  add(key: string, member: string, ttlMs: number): Promise<void>
  /** Takes the set at [key] whole, removing it in the same step: two callers never both get a member. */
  take(key: string): Promise<string[]>
}

/** One process's cache, for tests and a backend without Redis. */
export class MemoryTokenCache implements TokenCache {
  private readonly entries = new Map<string, { value: string; until: number }>()
  private readonly sets = new Map<string, { members: Set<string>; until: number }>()
  constructor(private readonly now: () => number = Date.now) {}
  async get(key: string) {
    const entry = this.entries.get(key)
    if (!entry || entry.until <= this.now()) { this.entries.delete(key); return null }
    return entry.value
  }
  async set(key: string, value: string, ttlMs: number) { this.entries.set(key, { value, until: this.now() + ttlMs }) }
  async delete(key: string) { this.entries.delete(key) }
  async add(key: string, member: string, ttlMs: number) {
    const set = this.sets.get(key)
    const members = set && set.until > this.now() ? set.members : new Set<string>()
    this.sets.set(key, { members: members.add(member), until: this.now() + ttlMs })
  }
  async take(key: string) {
    const set = this.sets.get(key)
    this.sets.delete(key)
    return set && set.until > this.now() ? [...set.members] : []
  }
}

/** The backend's shared Redis (lib/bus.ts `pub`), which fails fast rather than queueing while Redis is away. */
export class RedisTokenCache implements TokenCache {
  constructor(private readonly redis: Pick<Redis, 'get' | 'set' | 'del' | 'multi'>) {}
  async get(key: string) { return this.redis.get(key) }
  async set(key: string, value: string, ttlMs: number) { await this.redis.set(key, value, 'PX', Math.max(1, Math.floor(ttlMs))) }
  async delete(key: string) { await this.redis.del(key) }
  async add(key: string, member: string, ttlMs: number) {
    failed(await this.redis.multi().sadd(key, member).pexpire(key, Math.max(1, Math.floor(ttlMs))).exec())
  }
  async take(key: string) {
    // SMEMBERS and DEL in one transaction: no other instance reads or adds between them.
    const members = failed(await this.redis.multi().smembers(key).del(key).exec())[0]
    return Array.isArray(members) ? members.filter((m): m is string => typeof m === 'string') : []
  }
}

/** A Redis transaction's results, or its first error thrown. */
function failed(results: Array<[Error | null, unknown]> | null): unknown[] {
  if (!results) throw new Error('The Redis transaction was discarded.')
  for (const [error] of results) if (error) throw error
  return results.map(([, value]) => value)
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
/** How long a task's end is remembered: longer than any token GitHub gives (an hour), so no mint outlives it unseen. */
const RELEASED_MS = 70 * 60_000
const RELEASED = 'released'

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
  /** Every token minted for one task, sealed, in one shared set: what the task's end revokes (security review of #1976: two
   *  instances renewing at once each minted one, and the cached entry kept only the last). */
  private mintedKey(tabId: string, agentId: string, assignmentId: string) { return `${KEY_PREFIX}:minted:${tabId}:${agentId}:${assignmentId}` }
  private releasedKey(tabId: string, agentId: string, assignmentId: string) { return `${KEY_PREFIX}:released:${tabId}:${agentId}:${assignmentId}` }

  /** Whether the task's end was recorded (release). A cache that cannot say is read as not ended, as before. */
  private async released(request: TokenRequest): Promise<boolean> {
    try { return await this.cache.get(this.releasedKey(request.tabId, request.agentId, request.assignmentId)) === RELEASED } catch { return false }
  }

  private ended(): GitHubAppError { return new GitHubAppError('NO_ASSIGNMENT', 'This agent has no task in progress.', 409) }

  private seal(value: unknown): string {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.secret, iv)
    const body = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()])
    return [iv, cipher.getAuthTag(), body].map(part => part.toString('base64url')).join('.')
  }

  private unseal(value: string | null): Record<string, unknown> | null {
    if (!value) return null
    try {
      const [iv, tag, body] = value.split('.').map(part => Buffer.from(part, 'base64url'))
      const decipher = createDecipheriv('aes-256-gcm', this.secret, iv!)
      decipher.setAuthTag(tag!)
      const opened = JSON.parse(Buffer.concat([decipher.update(body!), decipher.final()]).toString('utf8')) as unknown
      return opened && typeof opened === 'object' ? opened as Record<string, unknown> : null
    } catch { return null }
  }

  private open(value: string | null): Entry | null {
    const entry = this.unseal(value)
    return entry && typeof entry.token === 'string' && typeof entry.expiresAt === 'string' && typeof entry.assignmentId === 'string'
      && typeof entry.repository === 'string' ? entry as unknown as Entry : null
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
    if (await this.released(request)) throw this.ended()
    let actual = request.repository
    const cached = await this.read(key)
    let entry: Entry | null = null
    if (cached && cached.assignmentId === request.assignmentId && cached.repository === repository) {
      // Close to its end, it is left to expire: the agent may still be using it, in a push that took it before this renewal.
      // It stays among the task's minted tokens, so the task's end revokes it too (Lead, 2026-10-28).
      if (Date.parse(cached.expiresAt) - this.now() > REUSE_MARGIN_MS) entry = cached
    } else if (cached) {
      // An earlier task's, or another repository's: every token minted for it goes now. Another task means that one ended.
      await this.revokeTask(request.tabId, request.agentId, cached.assignmentId, 'replaced', cached.assignmentId !== request.assignmentId, cached)
    }
    if (!entry) {
      // Under the name GitHub knows it by now (app.ts `resolve`); the agent's checkout keeps the name it was given, which
      // GitHub still answers for git.
      const resolved = await this.app.resolve(request.repository)
      if (resolved === null) throw this.app.notInstalled(request.repository)
      actual = resolved.repository
      const minted = await this.app.createToken(resolved.installation, actual)
      entry = { ...minted, repository, assignmentId: request.assignmentId }
      // Registered before anything else: the task's end takes this set whole, whichever instance minted what.
      try { await this.cache.add(this.mintedKey(request.tabId, request.agentId, request.assignmentId), this.seal({ token: entry.token, expiresAt: entry.expiresAt }), RELEASED_MS) } catch (error) {
        this.log.warn('[github] token not registered', { tabId: request.tabId, agentId: request.agentId, repository,
          error: error instanceof Error ? error.message : String(error) })
      }
      const ttl = Date.parse(minted.expiresAt) - this.now()
      if (ttl > 0) {
        try { await this.cache.set(key, this.seal(entry), ttl) } catch (error) {
          // Not cached, it cannot be revoked when the task ends; it still expires within the hour.
          this.log.warn('[github] token not cached', { tabId: request.tabId, agentId: request.agentId, repository,
            error: error instanceof Error ? error.message : String(error) })
        }
      }
      // Stored first, then checked: a task ended on another instance meanwhile (release marks it, then revokes what is
      // stored) either finds this token there or is seen here, so a token minted for an ended task never stays valid
      // (security review of #1976: a renewal in flight across that end kept a token good for an hour).
      if (await this.released(request)) {
        await this.revokeTokens(request.tabId, request.agentId, repository, [entry.token], 'task ended while minting')
        if ((await this.read(key))?.token === entry.token) await this.forget(key)
        throw this.ended()
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

  private async revokeTokens(tabId: string, agentId: string, repository: string, tokens: readonly string[], why: string): Promise<void> {
    for (const token of new Set(tokens)) {
      try { await this.app.revoke(token) } catch (error) {
        this.log.warn('[github] token revoke failed', { tabId, agentId, repository, why, code: error instanceof GitHubAppError ? error.code : 'ERROR' })
      }
    }
  }

  /**
   * Revokes every unexpired token minted for one task, taken whole from the shared set, and the cached one ([entry], also
   * from before that set), and forgets the cached one. [ended]: the task is over, so it is marked first: a mint finishing
   * on another instance after the mark revokes its own token (mint).
   */
  private async revokeTask(tabId: string, agentId: string, assignmentId: string, why: string, ended: boolean, entry: Entry | null): Promise<void> {
    if (ended) {
      try { await this.cache.set(this.releasedKey(tabId, agentId, assignmentId), RELEASED, RELEASED_MS) } catch (error) {
        this.log.warn('[github] task end not recorded', { tabId, agentId, error: error instanceof Error ? error.message : String(error) })
      }
    }
    let minted: string[] = []
    try { minted = await this.cache.take(this.mintedKey(tabId, agentId, assignmentId)) } catch (error) {
      this.log.warn('[github] minted tokens unreadable', { tabId, agentId, error: error instanceof Error ? error.message : String(error) })
    }
    const live = minted.map(value => this.unseal(value))
      .filter((t): t is { token: string; expiresAt: string } => typeof t?.token === 'string' && typeof t.expiresAt === 'string')
      .filter(t => Date.parse(t.expiresAt) > this.now()).map(t => t.token)
    const cached = entry?.assignmentId === assignmentId ? [entry.token] : []
    await this.revokeTokens(tabId, agentId, entry?.repository ?? '', [...cached, ...live], why)
    if (entry) await this.forget(this.key(tabId, agentId))
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
      const entry = await this.read(this.key(tabId, hold.agentId))
      await this.revokeTask(tabId, hold.agentId, hold.assignmentId, 'task ended', true, entry?.assignmentId === hold.assignmentId ? entry : null)
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
