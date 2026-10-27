/**
 * The Harness GitHub App (docs/swarm-github-app.md): how the backend proves it is the app, finds the app's installation
 * on a repository and creates installation access tokens for that one repository.
 *
 * A token comes from an installation, never from a person: GitHub user tokens cannot be narrowed to one repository, an
 * installation token can, and it lasts an hour (docs/plans/2026-10-24-swarm-team-account.md, Findings). Only node's
 * crypto signs the app's JWT. Nothing here logs a token or the private key.
 */
import { createPrivateKey, hkdfSync, sign, type KeyObject } from 'node:crypto'
import type { GitHubRepository } from './repository.js'

/** What a Swarm agent's token may do, and nothing more: push to and read the repository, open and update pull requests,
 *  and read checks and workflow runs to see whether its pull request passes. */
export const TOKEN_PERMISSIONS = { contents: 'write', pull_requests: 'write', checks: 'read', actions: 'read', metadata: 'read' } as const
/** What preparing an agent's folder may do before the agent has a task: clone and fetch the repository, nothing more. */
export const PREPARE_PERMISSIONS = { contents: 'read', metadata: 'read' } as const
/** What the Swarm's tidying reads before it archives a finished group: whether its pull requests are merged or closed. */
export const PULL_READ_PERMISSIONS = { pull_requests: 'read', metadata: 'read' } as const
export type TokenPermissions = Readonly<Record<string, 'read' | 'write'>>

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
const BRANCH_TTL_MS = 10 * 60_000
const REQUEST_TIMEOUT_MS = 10_000

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
  private readonly installations = new Map<string, { id: number | null; until: number }>()
  private readonly branches = new Map<string, { value: DefaultBranch; until: number }>()

  constructor(readonly config: GitHubAppConfig, options: GitHubAppOptions = {}) {
    this.fetch = options.fetch ?? fetch
    this.now = options.now ?? Date.now
    this.apiUrl = (options.apiUrl ?? 'https://api.github.com').replace(/\/$/, '')
  }

  /** Where an owner installs the app, when its URL name is configured. */
  installUrl(): string | null {
    return this.config.slug ? `https://github.com/apps/${this.config.slug}/installations/new` : null
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

  private async call(method: string, path: string, auth: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> | unknown[] }> {
    let response: Response
    try {
      response = await this.fetch(`${this.apiUrl}${path}`, {
        method, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'harness-backend',
          Authorization: auth, ...(body ? { 'Content-Type': 'application/json' } : {}) },
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
