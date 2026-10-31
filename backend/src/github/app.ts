/**
 * The Harness GitHub App (docs/swarm-github-app.md): how the backend proves it is the app, finds the app's installation
 * on a repository and creates installation access tokens for that one repository.
 *
 * A token comes from an installation, never from a person: GitHub user tokens cannot be narrowed to one repository, an
 * installation token can, and it lasts an hour (docs/plans/2026-10-24-swarm-team-account.md, Findings). Only node's
 * crypto signs the app's JWT. Nothing here logs a token or the private key.
 */
import { createPrivateKey, hkdfSync, sign, type KeyObject } from 'node:crypto'
import { githubRepository, type GitHubRepository } from './repository.js'

/** What a Swarm agent's token may do, and nothing more: push to and read the repository, open and update pull requests,
 *  and read checks and workflow runs to see whether its pull request passes. */
export const TOKEN_PERMISSIONS = { contents: 'write', pull_requests: 'write', checks: 'read', actions: 'read', metadata: 'read' } as const
/** What preparing an agent's folder may do before the agent has a task: clone and fetch the repository, nothing more. */
export const PREPARE_PERMISSIONS = { contents: 'read', metadata: 'read' } as const
/** What the Swarm's tidying reads before it archives a finished group: whether its pull requests are merged or closed. */
export const PULL_READ_PERMISSIONS = { pull_requests: 'read', metadata: 'read' } as const
/** What the route's read of running CI jobs may do: read workflow runs and their jobs, nothing more. */
export const ACTIONS_READ_PERMISSIONS = { actions: 'read', metadata: 'read' } as const
export type TokenPermissions = Readonly<Record<string, 'read' | 'write'>>
/** Jobs running and waiting on a repository's GitHub Actions, in all and on macOS runners: counts only. */
export interface CiLoad { running: number; queued: number; macosRunning: number; macosQueued: number }

/** A refusal with the code clients act on; `details` adds fields beside it, such as the install link. */
export class GitHubAppError extends Error {
  constructor(readonly code: string, message: string, readonly status: number, readonly details?: Record<string, unknown>) {
    super(message)
    this.name = 'GitHubAppError'
  }
}

export interface GitHubAppConfig { appId: string; privateKey: KeyObject; slug: string | null }

/** The app's private key as GitHub hands it out (a PEM file), with its line breaks written as `\n`, or base64 of it. The
 *  error never repeats the value. */
export function readPrivateKey(value: string): KeyObject {
  let pem = value.trim().replace(/\\n/g, '\n')
  if (!pem.includes('-----BEGIN')) {
    const decoded = /^[A-Za-z0-9+/=\s]+$/.test(pem) ? Buffer.from(pem, 'base64').toString('utf8') : ''
    if (!decoded.includes('-----BEGIN')) throw new Error('GITHUB_APP_PRIVATE_KEY is not a PEM private key or base64 of one.')
    pem = decoded.trim()
  }
  let key: KeyObject
  try { key = createPrivateKey(pem) } catch { throw new Error('GITHUB_APP_PRIVATE_KEY could not be read as a private key.') }
  if (key.asymmetricKeyType !== 'rsa') throw new Error('GITHUB_APP_PRIVATE_KEY must be the RSA key GitHub generated for the app.')
  return key
}

/** Both empty: the feature is off. One without the other, or a value that cannot be right, stops the backend at startup
 *  rather than failing the first agent that asks. */
export function githubAppConfig(env: { GITHUB_APP_ID: string; GITHUB_APP_PRIVATE_KEY: string; GITHUB_APP_SLUG: string }): GitHubAppConfig | null {
  const appId = env.GITHUB_APP_ID.trim(), key = env.GITHUB_APP_PRIVATE_KEY.trim(), slug = env.GITHUB_APP_SLUG.trim()
  if (!appId && !key) return null
  if (!appId || !key) throw new Error('Set both GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY for the Harness GitHub App, or neither.')
  // The numeric App ID, or the app's Client ID, which GitHub also takes as the JWT issuer.
  if (!/^(?:[0-9]{1,12}|Iv[0-9A-Za-z.]{4,40})$/.test(appId)) throw new Error('GITHUB_APP_ID must be the app\'s numeric App ID or its Client ID.')
  if (slug && !/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug)) throw new Error('GITHUB_APP_SLUG must be the app\'s name as in github.com/apps/NAME.')
  return { appId, privateKey: readPrivateKey(key), slug: slug || null }
}

/** The key that seals cached tokens (github/tokens.ts), derived from the app's own private key: whoever can read the cache
 *  without it learns nothing, and no further secret has to be configured. */
export function cacheSecret(config: GitHubAppConfig): Buffer {
  const der = config.privateKey.export({ type: 'pkcs8', format: 'der' })
  return Buffer.from(hkdfSync('sha256', der, 'harness-github-token-cache', config.appId, 32))
}

/** Where the default branch stands: a ruleset requires a pull request; classic branch protection is on, which an app
 *  without administration access cannot read further; nothing protects it; or it could not be read. */
export type BranchProtection = 'pull_request' | 'classic' | 'none' | 'unknown'
export interface DefaultBranch { branch: string | null; protection: BranchProtection }

const base64url = (value: string | Buffer) => Buffer.from(value).toString('base64url')
const INSTALLATION_TTL_MS = 10 * 60_000
const NOT_INSTALLED_TTL_MS = 60_000
/** How often a person's "check again" may make the server ask GitHub again about one repository. */
const REFRESH_MS = 15_000
const BRANCH_TTL_MS = 10 * 60_000
const REQUEST_TIMEOUT_MS = 10_000
/** How long a CI load is kept: routes come minutes apart, and a job takes minutes. */
export const CI_LOAD_TTL_MS = 30_000
/** The most GitHub calls one CI load makes: the token, the two run lists, the jobs of at most [CI_MAX_RUNS] runs, and the
 *  revoke (Lead, 10-31: a read's calls are counted and capped). The installation lookup is kept ten minutes apart. */
export const CI_MAX_CALLS = 10
/** The most runs whose jobs are read in one CI load; a run beyond it counts as one waiting job, on no particular runner. */
export const CI_MAX_RUNS = CI_MAX_CALLS - 4
/** The most CI loads read for one repository in an hour: past it, the last load is answered while it is at most
 *  [CI_STALE_MS] old, and after that none, which the route says as "not checked". With [CI_MAX_CALLS] that is at most 200
 *  calls an hour per repository, 4% of an installation's 5,000. */
export const CI_READS_PER_HOUR = 20
export const CI_STALE_MS = 5 * 60_000
const CI_WAITING = new Set(['queued', 'waiting', 'requested', 'pending'])
const IDENTITY_RETRY_MS = 10 * 60_000

/** A git author and committer. */
export interface CommitIdentity { name: string; email: string }

export interface GitHubAppOptions {
  fetch?: typeof fetch
  now?: () => number
  /** api.github.com unless a test serves a fake. */
  apiUrl?: string
}

export class GitHubApp {
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly apiUrl: string
  private signed: { jwt: string; until: number } | null = null
  /** The app's commit identity once read; a failed read is asked again after [IDENTITY_RETRY_MS]. */
  private identity: { value: CommitIdentity | null; until: number } | null = null
  private readonly installations = new Map<string, { id: number | null; until: number }>()
  private readonly branches = new Map<string, { value: DefaultBranch; until: number }>()
  /** A repository's name now, by the name asked for (lower case): null when it was not renamed. */
  private readonly renames = new Map<string, { repository: GitHubRepository | null; until: number }>()
  private readonly shownNames = new Map<string, { name: string; until: number }>()
  /** Each repository's CI load while fresh, or being read ([ciLoad]), by its name in lower case. */
  private readonly ciLoads = new Map<string, { value: Promise<CiLoad | null>; until: number }>()
  /** Each repository's CI reads in the last hour, and its last load read, for [CI_READS_PER_HOUR]. */
  private readonly ciReads = new Map<string, { at: number[]; last: { load: CiLoad | null; at: number } | null }>()
  /** When each repository's "not installed" was last forgotten on request ([forget]). */
  private readonly forgotten = new Map<string, number>()

  constructor(readonly config: GitHubAppConfig, options: GitHubAppOptions = {}) {
    this.fetch = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
  }

  /** Where an owner installs the app, when its URL name is configured. */
  installUrl(): string | null {
    return this.config.slug ? `https://github.com/apps/${this.config.slug}/installations/new` : null
  }

  /**
   * Who the app's commits are by: its bot account as GitHub names it (`<slug>[bot]`, `<id>+<slug>[bot]@users.noreply.github.com`),
   * so a commit made with the app's token shows the app, not the made-up address of the machine account that ran git. A Harness
   * Team account has no git identity of its own, so its commits read "Harness Team <harnessteam@<host>.local>", unverified and
   * linked to nobody (PR #1934, 2026-10-28). Read once and kept; null while GitHub cannot say, asked again ten minutes later.
   * [token]: a token to ask with. Asked without one, from a server's shared address, GitHub's limit for unsigned
   * requests could refuse it, and a Team account's commits stayed the machine's (PR #1948): the token just issued is used.
   */
  async commitIdentity(token?: string): Promise<CommitIdentity | null> {
    if (this.identity && (this.identity.value || this.identity.until > this.now())) return this.identity.value
    let value: CommitIdentity | null = null
    try {
      let slug = this.config.slug
      if (!slug) {
        const app = await this.call('GET', '/app', `Bearer ${this.jwt()}`)
        const named = (app.body as { slug?: unknown }).slug
        slug = app.status === 200 && typeof named === 'string' && /^[a-z0-9-]{1,100}$/.test(named) ? named : null
      }
      if (slug) {
        const login = `${slug}[bot]`
        // The app's own JWT is not accepted here; any installation token is, and the bot's id is no secret.
        const user = await this.call('GET', `/users/${encodeURIComponent(login)}`, token ? `Bearer ${token}` : null)
        const id = (user.body as { id?: unknown }).id
        if (user.status === 200 && typeof id === 'number' && Number.isSafeInteger(id) && id > 0) {
          value = { name: login, email: `${id}+${login}@users.noreply.github.com` }
        } else console.warn(`[github] the app's bot account ${login} was not read: HTTP ${user.status}`)
      }
    } catch (error) {
      if (!(error instanceof GitHubAppError)) throw error
    }
    this.identity = { value, until: this.now() + IDENTITY_RETRY_MS }
    return value
  }

  /** The app's own JWT (RS256, ten minutes at most): issued a minute back against clock drift, valid nine minutes, and
   *  reused until a minute before it ends. */
  jwt(): string {
    const now = this.now()
    if (this.signed && this.signed.until > now) return this.signed.jwt
    const iat = Math.floor(now / 1000) - 60
    const exp = iat + 60 + 9 * 60
    const input = `${base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))}.${base64url(JSON.stringify({ iat, exp, iss: this.config.appId }))}`
    const jwt = `${input}.${base64url(sign('sha256', Buffer.from(input), this.config.privateKey))}`
    this.signed = { jwt, until: (exp - 60) * 1000 }
    return jwt
  }

  private async call(method: string, path: string, auth: string | null, body?: unknown): Promise<{ status: number; body: Record<string, unknown> | unknown[] }> {
    let response: Response
    try {
      response = await this.fetch(`${this.apiUrl}${path}`, {
        method, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'harness-backend',
          ...(auth ? { Authorization: auth } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    } catch {
      throw new GitHubAppError('GITHUB_UNAVAILABLE', 'GitHub did not answer. Try again in a minute.', 503)
    }
    const text = await response.text().catch(() => '')
    let parsed: unknown = {}
    try { parsed = text ? JSON.parse(text) : {} } catch { parsed = {} }
    return { status: response.status, body: parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {} }
  }

  private misconfigured(): GitHubAppError {
    return new GitHubAppError('GITHUB_APP_MISCONFIGURED', 'GitHub refused the Harness GitHub App\'s credentials. Check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY on the server.', 503)
  }

  notInstalled(repository: GitHubRepository): GitHubAppError {
    const installUrl = this.installUrl()
    return new GitHubAppError('GITHUB_APP_NOT_INSTALLED',
      `The Harness GitHub App is not installed on ${repository.fullName}. Ask an owner of ${repository.owner} to install it${installUrl ? `: ${installUrl}` : ''}.`,
      409, installUrl ? { installUrl } : undefined)
  }

  /** The installation that covers [repository], or null when the app is not installed there. Remembered ten minutes,
   *  and a missing installation one minute, so a busy Swarm does not ask GitHub for every token. */
  async installation(repository: GitHubRepository): Promise<number | null> {
    const key = repository.fullName.toLowerCase()
    const known = this.installations.get(key)
    if (known && known.until > this.now()) return known.id
    const answer = await this.call('GET', `/repos/${repository.owner}/${repository.name}/installation`, `Bearer ${this.jwt()}`)
    if (answer.status === 401) throw this.misconfigured()
    if (answer.status === 404) {
      this.installations.set(key, { id: null, until: this.now() + NOT_INSTALLED_TTL_MS })
      return null
    }
    const id = (answer.body as Record<string, unknown>).id
    if (answer.status !== 200 || typeof id !== 'number') throw new GitHubAppError('GITHUB_UNAVAILABLE', `GitHub could not look up the app on ${repository.fullName}.`, 502)
    this.installations.set(key, { id, until: this.now() + INSTALLATION_TTL_MS })
    return id
  }

  /**
   * The installation that covers [repository], with the repository under the name GitHub knows it by now; null when the
   * app is not installed there. A repository renamed on GitHub still answers to its old name for git, but not for the
   * app's installation lookup, and a Swarm project's repository address is set once: a project made from a checkout
   * whose remote still had the old name could never get a token (2026-10-27, autonomous-harness renamed openharness).
   */
  async resolve(repository: GitHubRepository): Promise<{ installation: number; repository: GitHubRepository } | null> {
    const direct = await this.installation(repository)
    if (direct !== null) return { installation: direct, repository }
    const current = await this.currentName(repository)
    if (!current) return null
    const renamed = await this.installation(current)
    return renamed === null ? null : { installation: renamed, repository: current }
  }

  /**
   * [repository]'s name as GitHub shows it now, for people to read: a project keeps the address it was given, and GitHub
   * answers an old name by redirect, so a renamed repository was shown by the name it no longer has (autonomous-harness
   * for autonomous-ai/openharness, 2026-10-28). Its own name when GitHub cannot say. Kept ten minutes either way, so a
   * status read costs at most one lookup per repository in that time.
   */
  async currentFullName(repository: GitHubRepository): Promise<string> {
    const key = repository.fullName.toLowerCase()
    const known = this.shownNames.get(key)
    if (known && known.until > this.now()) return known.name
    const name = (await this.currentName(repository))?.fullName ?? repository.fullName
    this.shownNames.set(key, { name, until: this.now() + INSTALLATION_TTL_MS })
    return name
  }

  /** [repository]'s name now when it was renamed, else null: read with a read-only token of its owner's installation of
   *  the app, which GitHub answers by the repository's id once it moved. The token is revoked at once. */
  private async currentName(repository: GitHubRepository): Promise<GitHubRepository | null> {
    const key = repository.fullName.toLowerCase()
    const known = this.renames.get(key)
    if (known && known.until > this.now()) return known.repository
    let current: GitHubRepository | null = null
    try {
      const owner = await this.ownerInstallation(repository.owner)
      if (owner !== null) {
        const minted = await this.call('POST', `/app/installations/${owner}/access_tokens`, `Bearer ${this.jwt()}`, { permissions: { metadata: 'read' } })
        const token = (minted.body as Record<string, unknown>).token
        if (minted.status === 201 && typeof token === 'string') {
          try {
            const read = await this.call('GET', `/repos/${repository.owner}/${repository.name}`, `Bearer ${token}`)
            const fullName = (read.body as Record<string, unknown>).full_name
            const found = read.status === 200 && typeof fullName === 'string' ? githubRepository(`https://github.com/${fullName}`) : null
            if (found && found.fullName.toLowerCase() !== key) current = found
          } finally {
            await this.revoke(token).catch(() => {})
          }
        }
      }
    } catch (error) {
      if (error instanceof GitHubAppError && error.code === 'GITHUB_APP_MISCONFIGURED') throw error
      // GitHub did not say: the repository reads as not installed, as it did before.
    }
    this.renames.set(key, { repository: current, until: this.now() + (current ? INSTALLATION_TTL_MS : NOT_INSTALLED_TTL_MS) })
    return current
  }

  /** The app's installation on [owner], an organization or a user, or null. */
  private async ownerInstallation(owner: string): Promise<number | null> {
    for (const path of [`/orgs/${owner}/installation`, `/users/${owner}/installation`]) {
      const answer = await this.call('GET', path, `Bearer ${this.jwt()}`)
      if (answer.status === 401) throw this.misconfigured()
      const id = (answer.body as Record<string, unknown>).id
      if (answer.status === 200 && typeof id === 'number') return id
    }
    return null
  }

  /** Forgets that the app was not on [repository] (and its rename), so the next lookup asks GitHub: a person just
   *  installed it. At most once every REFRESH_MS per repository, so a refresh cannot become a stream of lookups. */
  forget(repository: GitHubRepository): void {
    const key = repository.fullName.toLowerCase()
    const last = this.forgotten.get(key)
    if (last !== undefined && this.now() - last < REFRESH_MS) return
    this.forgotten.set(key, this.now())
    if (this.installations.get(key)?.id === null) this.installations.delete(key)
    if (this.renames.get(key)?.repository === null) this.renames.delete(key)
  }

  /** A token for [repository] alone, with TOKEN_PERMISSIONS alone. */
  async createToken(installationId: number, repository: GitHubRepository, permissions: TokenPermissions = TOKEN_PERMISSIONS): Promise<{ token: string; expiresAt: string }> {
    const answer = await this.call('POST', `/app/installations/${installationId}/access_tokens`, `Bearer ${this.jwt()}`,
      { repositories: [repository.name], permissions })
    const body = answer.body as Record<string, unknown>
    if (answer.status === 201 && typeof body.token === 'string' && typeof body.expires_at === 'string' && Number.isFinite(Date.parse(body.expires_at))) {
      return { token: body.token, expiresAt: body.expires_at }
    }
    if (answer.status === 401) throw this.misconfigured()
    if (answer.status === 404 || answer.status === 422 || answer.status === 403) {
      this.installations.delete(repository.fullName.toLowerCase())
      // GitHub says which: the installation lacks the repository, or has not accepted a permission asked for.
      if (/permission/i.test(String(body.message ?? ''))) {
        throw new GitHubAppError('GITHUB_APP_PERMISSIONS',
          `The Harness GitHub App on ${repository.owner} has not been granted all the permissions it needs. An owner of ${repository.owner} should accept its requested permissions in the app's installation settings.`, 409)
      }
      throw this.notInstalled(repository)
    }
    throw new GitHubAppError('GITHUB_UNAVAILABLE', `GitHub could not create a token for ${repository.fullName}.`, 502)
  }

  /** Ends [token] at once (DELETE /installation/token, authorised by the token itself). One GitHub already ended reads as
   *  done. */
  async revoke(token: string): Promise<void> {
    const answer = await this.call('DELETE', '/installation/token', `Bearer ${token}`)
    if (answer.status === 204 || answer.status === 401) return
    throw new GitHubAppError('GITHUB_UNAVAILABLE', `GitHub did not revoke the token (HTTP ${answer.status}).`, 502)
  }

  /** The jobs running and waiting on [repository]'s GitHub Actions (Scholes's goals, piece 5: work that starts heavy CI waits
   *  for the account's limit), or null when the app is not installed there. Read with a token that can only read workflow
   *  runs, revoked as soon as the counts are in; the token, run names and branches never leave this method. Kept
   *  [CI_LOAD_TTL_MS], and routes asking at once share one read; a failed read is not kept. Throws [GitHubAppError] when
   *  GitHub cannot say. */
  async ciLoad(repository: GitHubRepository): Promise<CiLoad | null> {
    const key = repository.fullName.toLowerCase(), now = this.now()
    const known = this.ciLoads.get(key)
    if (known && known.until > now) return known.value
    // Kept per repository a Swarm routes for; the expired ones go once there are many.
    if (this.ciLoads.size >= 200) for (const [k, v] of this.ciLoads) if (v.until <= now) this.ciLoads.delete(k)
    if (this.ciReads.size >= 200) for (const [k, v] of this.ciReads) if (!v.at.some(t => now - t < 3_600_000)) this.ciReads.delete(k)
    const reads = this.ciReads.get(key) ?? { at: [], last: null }
    reads.at = reads.at.filter(t => now - t < 3_600_000)
    this.ciReads.set(key, reads)
    if (reads.at.length >= CI_READS_PER_HOUR) {
      if (reads.last && now - reads.last.at <= CI_STALE_MS) return reads.last.load
      throw new GitHubAppError('GITHUB_CI_BUDGET', `This hour's CI reads for ${repository.fullName} are spent.`, 429)
    }
    reads.at.push(now)
    const value = this.readCiLoad(repository)
    this.ciLoads.set(key, { value, until: now + CI_LOAD_TTL_MS })
    value.then(load => { reads.last = { load, at: now } }, () => { this.ciLoads.delete(key) })
    return value
  }

  private async readCiLoad(repository: GitHubRepository): Promise<CiLoad | null> {
    const resolved = await this.resolve(repository)
    if (!resolved) return null
    const { token } = await this.createToken(resolved.installation, resolved.repository, ACTIONS_READ_PERMISSIONS)
    const auth = `Bearer ${token}`, runs = `/repos/${resolved.repository.owner}/${resolved.repository.name}/actions/runs`
    const read = (path: string) => this.call('GET', path, auth)
    const unavailable = () => new GitHubAppError('GITHUB_UNAVAILABLE', `GitHub did not say what runs on ${resolved.repository.fullName}.`, 502)
    const listOf = (body: unknown, field: string) => {
      const items = (body as Record<string, unknown>)[field]
      return Array.isArray(items) ? items.filter((i): i is Record<string, unknown> => !!i && typeof i === 'object') : []
    }
    try {
      const pages = await Promise.all(['in_progress', 'queued'].map(async status => {
        const answer = await read(`${runs}?status=${status}&per_page=${CI_MAX_RUNS}`)
        if (answer.status !== 200) throw unavailable()
        const listed = listOf(answer.body, 'workflow_runs'), total = (answer.body as Record<string, unknown>).total_count
        return { ids: listed.map(r => r.id).filter((id): id is number => Number.isSafeInteger(id)),
          more: Math.max(0, (Number.isSafeInteger(total) ? total as number : 0) - listed.length) }
      }))
      const ids = [...new Set(pages.flatMap(p => p.ids))]
      const counted = ids.slice(0, CI_MAX_RUNS)
      const load: CiLoad = { running: 0, queued: ids.length - counted.length + pages.reduce((n, p) => n + p.more, 0), macosRunning: 0, macosQueued: 0 }
      for (const jobs of await Promise.all(counted.map(async id => {
        const answer = await read(`${runs}/${id}/jobs?filter=latest&per_page=100`)
        if (answer.status !== 200) throw unavailable()
        return listOf(answer.body, 'jobs')
      }))) {
        for (const job of jobs) {
          const mac = Array.isArray(job.labels) && job.labels.some(l => typeof l === 'string' && /macos/i.test(l))
          if (job.status === 'in_progress') { load.running++; if (mac) load.macosRunning++ }
          else if (CI_WAITING.has(String(job.status))) { load.queued++; if (mac) load.macosQueued++ }
        }
      }
      return load
    } finally {
      await this.revoke(token).catch(() => { console.warn(`[github] a CI read's token for ${resolved.repository.fullName} was not revoked; it expires within the hour`) })
    }
  }

  /** Whether pull request [number] is open, merged or closed (GET /repos/{owner}/{repo}/pulls/{number}); null when GitHub
   *  cannot say, which a caller must read as possibly open. */
  async pullRequestState(repository: GitHubRepository, number: number, token: string): Promise<'open' | 'merged' | 'closed' | null> {
    try {
      const answer = await this.call('GET', `/repos/${repository.owner}/${repository.name}/pulls/${number}`, `Bearer ${token}`)
      const body = answer.body as Record<string, unknown>
      if (answer.status !== 200 || !['open', 'closed'].includes(String(body.state))) return null
      return body.state === 'open' ? 'open' : typeof body.merged_at === 'string' ? 'merged' : 'closed'
    } catch (error) {
      if (error instanceof GitHubAppError) return null
      throw error
    }
  }

  /** The default branch and whether pushing to it straight needs a pull request, read with the agent's own token
   *  (metadata and contents read): rulesets first (GET /repos/{owner}/{repo}/rules/branches/{branch}), then classic
   *  protection's flag on the branch. Remembered ten minutes; a failed read is `unknown`, never a refusal. */
  async defaultBranch(repository: GitHubRepository, token: string): Promise<DefaultBranch> {
    const key = repository.fullName.toLowerCase()
    const known = this.branches.get(key)
    if (known && known.until > this.now()) return known.value
    const auth = `Bearer ${token}`, path = `/repos/${repository.owner}/${repository.name}`
    let value: DefaultBranch = { branch: null, protection: 'unknown' }
    try {
      const repo = await this.call('GET', path, auth)
      const branch = (repo.body as Record<string, unknown>).default_branch
      if (repo.status === 200 && typeof branch === 'string' && branch) {
        value = { branch, protection: 'unknown' }
        const rules = await this.call('GET', `${path}/rules/branches/${encodeURIComponent(branch)}`, auth)
        if (rules.status === 200 && Array.isArray(rules.body) && rules.body.some(rule => (rule as Record<string, unknown>)?.type === 'pull_request')) {
          value = { branch, protection: 'pull_request' }
        } else {
          const classic = await this.call('GET', `${path}/branches/${encodeURIComponent(branch)}`, auth)
          const flag = (classic.body as Record<string, unknown>).protected
          if (classic.status === 200 && typeof flag === 'boolean') value = { branch, protection: flag ? 'classic' : 'none' }
        }
      }
    } catch (error) {
      if (!(error instanceof GitHubAppError)) throw error
    }
    if (value.protection !== 'unknown') this.branches.set(key, { value, until: this.now() + BRANCH_TTL_MS })
    return value
  }
}
