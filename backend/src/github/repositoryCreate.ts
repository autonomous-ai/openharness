/**
 * A new repository for a new project, from New Project's "New repository" (task #1788,
 * docs/plans/2026-11-05-new-repository-design.md).
 *
 * It is created with the person's own user token from the app's sign-in, never with an installation token
 * ([NEVER_ON_INSTALLATION_TOKENS]): GitHub then decides whether they may create repositories in that organization, and its
 * record names them. The token is used for at most four calls here and revoked by [GitHubSignIn.withUserToken].
 */
import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto'
import { STATE_TTL_MS, type UserCall } from './approvals.js'
import type { GitHubApp, GitHubAppConfig } from './app.js'
import { createRateLimiter } from '../lib/rateLimit.js'
import { githubRepository } from './repository.js'

/** GitHub's repository name rule, and an organization login's. */
const NAME = /^[A-Za-z0-9._-]{1,100}$/
export const GITHUB_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/
/** How long before the request a repository found under the asked name may have been made and still be this create's own
 *  (clock skew between GitHub and the server). */
const SKEW_MS = 60_000
const REASON_MAX = 300

/** How many organizations one person may have checked against GitHub in a minute, by New Project's organization row and
 *  its create (security reviews of #3201): each check is a call signed with the app's own key. */
export const OWNER_CHECKS_PER_MINUTE = 30
const ownerChecks = createRateLimiter('github-owner-checks', 60_000, OWNER_CHECKS_PER_MINUTE)
/** Whether [userId] may have one more organization checked now. */
export const ownerCheckAllowed = (userId: string, now = Date.now()) => ownerChecks.allows(userId, now)
/** Test seam: forget this process's counts. */
export const resetOwnerChecks = () => ownerChecks.reset()

/** The key create states are signed with: the app's own private key, under a label of its own, so a create state and an
 *  approval state (approvals.ts stateSecret) never share a key (security review 2 of #3201). */
export function createStateSecret(config: GitHubAppConfig): Buffer {
  const der = config.privateKey.export({ type: 'pkcs8', format: 'der' })
  return Buffer.from(hkdfSync('sha256', der, 'harness-github-create-state', config.appId, 32))
}

/** What is wrong with [name] as a new repository's name, in the words New Project shows (F1), or null. */
export function repositoryNameProblem(name: string): string | null {
  return NAME.test(name) && name !== '.' && name !== '..' ? null : 'Use letters, numbers, - _ or . (up to 100).'
}

/** Who asked to create which repository, for which project, and when ([at], ms): signed into the sign-in's state. */
export interface CreateRequest {
  userId: string
  autonomousEnv: string
  tabId: string
  projectId: string
  owner: string
  name: string
  private: boolean
  at: number
}

export type CreateOutcome =
  | { state: 'created'; repository: string; repositoryUrl: string; login: string; reachable: boolean }
  | { state: 'taken' }
  | { state: 'refused'; reason: string }
  | { state: 'failed' }

/** A create's state, signed as an approval's is (approvals.ts signState) but marked `kind: 'create'`, so neither reads as
 *  the other. */
export function signCreateState(secret: Buffer, request: CreateRequest, now: number): string {
  const body = Buffer.from(JSON.stringify({ kind: 'create', ...request, exp: now + STATE_TTL_MS })).toString('base64url')
  return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
}

/** The create a state was signed for, or null when it is not a create's, was not signed here, was changed, or is too old. */
export function readCreateState(secret: Buffer, state: string, now: number): CreateRequest | null {
  const [body, signature, extra] = state.split('.')
  if (!body || !signature || extra !== undefined) return null
  const expected = createHmac('sha256', secret).update(body).digest()
  const given = Buffer.from(signature, 'base64url')
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString()) as Record<string, unknown>
    if (v.kind !== 'create' || typeof v.exp !== 'number' || v.exp < now || typeof v.private !== 'boolean' || typeof v.at !== 'number') return null
    for (const key of ['userId', 'autonomousEnv', 'tabId', 'projectId', 'owner', 'name'] as const) if (typeof v[key] !== 'string' || !v[key]) return null
    if (!GITHUB_OWNER.test(v.owner as string) || repositoryNameProblem(v.name as string)) return null
    return { userId: v.userId as string, autonomousEnv: v.autonomousEnv as string, tabId: v.tabId as string, projectId: v.projectId as string,
      owner: v.owner as string, name: v.name as string, private: v.private, at: v.at }
  } catch { return null }
}

const reason = (body: Record<string, unknown>) => {
  const errors = Array.isArray(body.errors) ? body.errors.map(e => (e as { message?: unknown })?.message).filter((m): m is string => typeof m === 'string') : []
  const message = typeof body.message === 'string' ? body.message : ''
  return ([message, ...errors].filter(Boolean).join(': ') || 'GitHub gave no reason.').slice(0, REASON_MAX)
}

/**
 * Creates [request]'s repository with the person's token ([call]): private unless they chose otherwise, with a first
 * commit (a repository with none cannot be cloned into a worktree). A name already taken by a repository this person made
 * since the request is this create's own, whose answer was lost (F10). Then checks the app's installation covers it, and
 * adds it where the installation granted that (Option B leaves it ungranted: GitHub gives the app access to what it
 * creates); otherwise says it is not reachable (F7).
 */
export async function createRepository(call: UserCall, app: GitHubApp, request: CreateRequest): Promise<CreateOutcome> {
  let created: Record<string, unknown>
  let login: string
  try {
    const user = await call('GET', '/user')
    if (user.status !== 200 || typeof user.body.login !== 'string') return { state: 'failed' }
    login = user.body.login
    const answer = await call('POST', `/orgs/${request.owner}/repos`, { name: request.name, private: request.private, auto_init: true })
    if (answer.status === 201) created = answer.body
    else if (answer.status === 422 && /already exists/i.test(reason(answer.body))) {
      const found = await call('GET', `/repos/${request.owner}/${request.name}`)
      const madeAt = Date.parse(String(found.body.created_at ?? ''))
      const admin = (found.body.permissions as Record<string, unknown> | undefined)?.admin === true
      if (found.status !== 200 || !admin || !(madeAt >= request.at - SKEW_MS)) return { state: 'taken' }
      created = found.body
    } else if ([401, 403, 404, 422].includes(answer.status)) return { state: 'refused', reason: reason(answer.body) }
    else return { state: 'failed' }
  } catch {
    return { state: 'failed' }
  }
  const fullName = typeof created.full_name === 'string' ? created.full_name : `${request.owner}/${request.name}`
  const repository = githubRepository(`https://github.com/${fullName}`)
  if (!repository) return { state: 'failed' }
  const result = { state: 'created' as const, repository: repository.fullName, repositoryUrl: `https://github.com/${repository.fullName}`, login }
  const covered = await app.installation(repository).catch(() => null)
  if (covered !== null) return { ...result, reachable: true }
  try {
    const readiness = await app.ownerReadiness(request.owner)
    if (readiness.state !== 'ready' || !readiness.canAdd || typeof created.id !== 'number') return { ...result, reachable: false }
    const added = await call('PUT', `/user/installations/${readiness.installation}/repositories/${created.id}`)
    if (added.status === 204 || added.status === 304) {
      app.forget(repository)
      return { ...result, reachable: true }
    }
  } catch {
    // The repository is made either way: what could not be checked reads as not reachable (F7), never as a failure.
  }
  return { ...result, reachable: false }
}
