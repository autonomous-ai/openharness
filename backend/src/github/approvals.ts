/**
 * Which repositories a Swarm may use the Harness GitHub App on (docs/plans/2026-10-28-swarm-project-github-access.md).
 *
 * A project's repository address is text its owner types, and the app is installed on many people's repositories: without
 * this, anyone could name a repository the app is on as their project's and have the backend mint write tokens for it
 * (found 2026-10-28, with the app on autonomous-ai/openharness). Now a token goes to a project only once someone GitHub
 * says can push to the repository approved it, for that project or for every project of the Swarm. They approve by
 * signing in to GitHub through the app's own sign-in (its Client ID and secret): their short-lived token reads their
 * permission on the repository, is revoked at once, and is never stored.
 */
import { createHmac, hkdfSync, randomUUID, timingSafeEqual } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type { GitHubAppConfig } from './app.js'
import type { GitHubRepository } from './repository.js'

/** Every project of the Swarm, in an approval's `projectId`. */
export const WHOLE_SWARM = '*'
/** How long a sign-in may take, from the app asking to GitHub sending the person back. */
export const STATE_TTL_MS = 10 * 60_000

/** What a sign-in is for: who asked, in which Swarm and project, for which repository, and how widely. */
export interface ApprovalRequest {
  userId: string
  autonomousEnv: string
  tabId: string
  projectId: string
  /** owner/name, lower case. */
  repository: string
  scope: 'project' | 'swarm'
}

/** The key that signs a sign-in's state, derived from the app's private key: nothing further to configure. */
export function stateSecret(config: GitHubAppConfig): Buffer {
  const der = config.privateKey.export({ type: 'pkcs8', format: 'der' })
  return Buffer.from(hkdfSync('sha256', der, 'harness-github-approval-state', config.appId, 32))
}

export function signState(secret: Buffer, request: ApprovalRequest, now: number): string {
  const body = Buffer.from(JSON.stringify({ ...request, exp: now + STATE_TTL_MS })).toString('base64url')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

/** The request a state was signed for, or null when it was not signed here, was changed, or is too old. */
export function readState(secret: Buffer, state: string, now: number): ApprovalRequest | null {
  const [body, signature, extra] = state.split('.')
  if (!body || !signature || extra !== undefined) return null
  const expected = createHmac('sha256', secret).update(body).digest()
  const given = Buffer.from(signature, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const value = JSON.parse(Buffer.from(body, 'base64url').toString()) as ApprovalRequest & { exp: number }
    if (typeof value.exp !== 'number' || value.exp < now || (value.scope !== 'project' && value.scope !== 'swarm')) return null
    for (const key of ['userId', 'autonomousEnv', 'tabId', 'projectId', 'repository'] as const) if (typeof value[key] !== 'string' || !value[key]) return null
    return { userId: value.userId, autonomousEnv: value.autonomousEnv, tabId: value.tabId, projectId: value.projectId, repository: value.repository, scope: value.scope }
  } catch { return null }
}

export interface GitHubSignInDeps { clientId: string; clientSecret: string; fetch?: typeof fetch; webUrl?: string; apiUrl?: string }

/** The Harness GitHub App's sign-in (GitHub's web application flow for an app's user access token). */
export class GitHubSignIn {
  private readonly fetch: typeof fetch
  private readonly webUrl: string
  private readonly apiUrl: string
  constructor(private readonly deps: GitHubSignInDeps) {
    this.fetch = deps.fetch ?? fetch
    this.webUrl = deps.webUrl ?? 'https://github.com'
    this.apiUrl = deps.apiUrl ?? 'https://api.github.com'
  }

  authorizeUrl(state: string): string {
    return `${this.webUrl}/login/oauth/authorize?client_id=${encodeURIComponent(this.deps.clientId)}&state=${encodeURIComponent(state)}`
  }

  /** What GitHub says [code]'s person may do on [repository]: their login, and whether they can push. The person's token
   *  is revoked before this answers, whatever it found. */
  async permission(code: string, repository: GitHubRepository): Promise<{ login: string; push: boolean } | null> {
    const exchanged = await this.fetch(`${this.webUrl}/login/oauth/access_token`, {
      method: 'POST', signal: AbortSignal.timeout(15_000),
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: this.deps.clientId, client_secret: this.deps.clientSecret, code }),
    })
    const token = ((await exchanged.json().catch(() => ({}))) as { access_token?: unknown }).access_token
    if (!exchanged.ok || typeof token !== 'string' || !token) return null
    try {
      const headers = { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}`, 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'harness-backend' }
      const user = await this.fetch(`${this.apiUrl}/user`, { headers, signal: AbortSignal.timeout(15_000) })
      const login = ((await user.json().catch(() => ({}))) as { login?: unknown }).login
      if (!user.ok || typeof login !== 'string') return null
      // A renamed repository answers by redirect, which fetch follows; one the person cannot see answers 404.
      const repo = await this.fetch(`${this.apiUrl}/repos/${repository.owner}/${repository.name}`, { headers, signal: AbortSignal.timeout(15_000) })
      const permissions = ((await repo.json().catch(() => ({}))) as { permissions?: Record<string, unknown> }).permissions ?? {}
      return { login, push: repo.ok && (permissions.push === true || permissions.maintain === true || permissions.admin === true) }
    } finally {
      await this.fetch(`${this.apiUrl}/applications/${encodeURIComponent(this.deps.clientId)}/token`, {
        method: 'DELETE', signal: AbortSignal.timeout(15_000),
        headers: { Accept: 'application/vnd.github+json', Authorization: `Basic ${Buffer.from(`${this.deps.clientId}:${this.deps.clientSecret}`).toString('base64')}`,
          'Content-Type': 'application/json' },
        body: JSON.stringify({ access_token: token }),
      }).catch(() => undefined)
    }
  }
}

export function githubSignIn(env: { GITHUB_APP_CLIENT_ID: string; GITHUB_APP_CLIENT_SECRET: string }): GitHubSignIn | null {
  const clientId = env.GITHUB_APP_CLIENT_ID.trim(), clientSecret = env.GITHUB_APP_CLIENT_SECRET.trim()
  if (!clientId && !clientSecret) return null
  if (!clientId || !clientSecret) throw new Error('Set both GITHUB_APP_CLIENT_ID and GITHUB_APP_CLIENT_SECRET for the Harness GitHub App\'s sign-in, or neither.')
  return new GitHubSignIn({ clientId, clientSecret })
}

/** Where approvals are kept. */
export interface Approvals {
  approved(autonomousEnv: string, tabId: string, projectId: string, repository: string): Promise<boolean>
  approve(request: ApprovalRequest, githubLogin: string): Promise<void>
}

export class PrismaApprovals implements Approvals {
  constructor(private readonly db: Pick<PrismaClient, 'gitHubRepositoryApproval'>) {}

  async approved(autonomousEnv: string, tabId: string, projectId: string, repository: string): Promise<boolean> {
    return !!await this.db.gitHubRepositoryApproval.findFirst({ where: { autonomousEnv, tabId, repository: repository.toLowerCase(),
      projectId: { in: [projectId, WHOLE_SWARM] } }, select: { id: true } })
  }

  async approve(request: ApprovalRequest, githubLogin: string): Promise<void> {
    const projectId = request.scope === 'swarm' ? WHOLE_SWARM : request.projectId
    const where = { autonomousEnv_tabId_repository_projectId: { autonomousEnv: request.autonomousEnv, tabId: request.tabId,
      repository: request.repository, projectId } }
    await this.db.gitHubRepositoryApproval.upsert({ where, update: { approvedBy: request.userId, githubLogin },
      create: { id: randomUUID(), autonomousEnv: request.autonomousEnv, tabId: request.tabId, projectId, repository: request.repository,
        approvedBy: request.userId, githubLogin } })
  }
}
