import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { GitHubSignIn, githubSignIn, PrismaApprovals, readState, signState, STATE_TTL_MS, stateSecret, WHOLE_SWARM, type ApprovalRequest } from './approvals.js'
import { throwawayKey } from './fakeGitHub.js'
import { githubRepository } from './repository.js'

const request: ApprovalRequest = { userId: 'alice', autonomousEnv: 'prod', tabId: 'tab', projectId: 'p1', repository: 'alice/a', scope: 'project' }
const repo = githubRepository('https://github.com/alice/a')!

describe('a sign-in\'s state', () => {
  it('comes back as it was signed, within ten minutes, and never changed or from elsewhere', () => {
    const secret = randomBytes(32), now = 1_000_000
    const state = signState(secret, request, now)
    expect(readState(secret, state, now + STATE_TTL_MS - 1)).toEqual(request)
    expect(readState(secret, state, now + STATE_TTL_MS + 1)).toBeNull()
    expect(readState(randomBytes(32), state, now)).toBeNull()
    const [body, signature] = state.split('.')
    const forged = Buffer.from(JSON.stringify({ ...request, projectId: 'other', exp: now + 1000 })).toString('base64url')
    for (const bad of [`${forged}.${signature}`, `${body}`, `${body}.${signature}.x`, `${body}.short`, '']) expect(readState(secret, bad, now)).toBeNull()
    const sealed = (body: string) => `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}`
    const sign = (value: unknown) => sealed(Buffer.from(JSON.stringify(value)).toString('base64url'))
    expect(readState(secret, sign({ ...request, scope: 'everything', exp: now + 1000 }), now)).toBeNull()
    expect(readState(secret, sign({ ...request, tabId: '', exp: now + 1000 }), now)).toBeNull()
    expect(readState(secret, sealed(Buffer.from('{').toString('base64url')), now)).toBeNull()
  })

  it('is signed with a key of the app\'s own, the same each time', () => {
    const config = { appId: '1', privateKey: throwawayKey().privateKey, slug: null }
    expect(stateSecret(config)).toEqual(stateSecret(config))
    expect(stateSecret(config)).toHaveLength(32)
  })
})

describe('the app\'s GitHub sign-in', () => {
  const fake = (repoStatus = 200, permissions: Record<string, boolean> = { push: true }, tokenOk = true) => {
    const calls: Array<{ url: string; method: string }> = []
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url), method = init?.method ?? 'GET'
      calls.push({ url: u, method })
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status })
      if (u.endsWith('/login/oauth/access_token')) return tokenOk ? json(200, { access_token: 'ghu_fixture' }) : json(200, { error: 'bad_verification_code' })
      if (u.endsWith('/user')) return json(200, { login: 'alice' })
      if (u.includes('/repos/')) return json(repoStatus, repoStatus === 200 ? { permissions } : { message: 'Not Found' })
      if (method === 'DELETE') return new Response(null, { status: 204 })
      return json(404, {})
    }) as unknown as typeof globalThis.fetch
    return { signIn: new GitHubSignIn({ clientId: 'Iv23client', clientSecret: 'secret', fetch, webUrl: 'https://gh.test', apiUrl: 'https://api.gh.test' }), calls }
  }

  it('sends the person to GitHub with the state', () => {
    expect(fake().signIn.authorizeUrl('a.b')).toBe('https://gh.test/login/oauth/authorize?client_id=Iv23client&state=a.b')
  })

  it('says whether the person can push, and revokes their token at once whatever it found', async () => {
    const pusher = fake()
    expect(await pusher.signIn.permission('code', repo)).toEqual({ login: 'alice', push: true })
    expect(pusher.calls.at(-1)).toEqual({ url: 'https://api.gh.test/applications/Iv23client/token', method: 'DELETE' })
    for (const permissions of [{ maintain: true }, { admin: true }] as Array<Record<string, boolean>>) expect((await fake(200, permissions).signIn.permission('c', repo))?.push).toBe(true)
    expect(await fake(200, { pull: true }).signIn.permission('c', repo)).toEqual({ login: 'alice', push: false })
    const hidden = fake(404)
    expect(await hidden.signIn.permission('c', repo)).toEqual({ login: 'alice', push: false })
    expect(hidden.calls.some(c => c.method === 'DELETE')).toBe(true)
    expect(await fake(200, {}, false).signIn.permission('c', repo)).toBeNull()
  })

  it('is on with both its client id and secret, off with neither, and refuses one alone', () => {
    expect(githubSignIn({ GITHUB_APP_CLIENT_ID: '', GITHUB_APP_CLIENT_SECRET: '' })).toBeNull()
    expect(githubSignIn({ GITHUB_APP_CLIENT_ID: 'Iv23', GITHUB_APP_CLIENT_SECRET: 's' })).toBeInstanceOf(GitHubSignIn)
    expect(() => githubSignIn({ GITHUB_APP_CLIENT_ID: 'Iv23', GITHUB_APP_CLIENT_SECRET: '' })).toThrow('or neither')
  })
})

describe('approvals', () => {
  it('cover the project approved, or every project of the Swarm, for that repository alone', async () => {
    const rows: Array<Record<string, string>> = []
    const db = { gitHubRepositoryApproval: {
      findFirst: vi.fn(async ({ where }: { where: { autonomousEnv: string; tabId: string; repository: string; projectId: { in: string[] } } }) =>
        rows.find(r => r.autonomousEnv === where.autonomousEnv && r.tabId === where.tabId && r.repository === where.repository && where.projectId.in.includes(r.projectId!)) ?? null),
      upsert: vi.fn(async ({ create }: { create: Record<string, string> }) => { rows.push(create); return create }),
    }, gitHubApprovalRefusal: { deleteMany: vi.fn(async () => ({ count: 0 })) } }
    const approvals = new PrismaApprovals(db as never)
    expect(await approvals.approved('prod', 'tab', 'p1', 'alice/a')).toBe(false)
    await approvals.approve(request, 'alice')
    expect(await approvals.approved('prod', 'tab', 'p1', 'Alice/A')).toBe(true)
    expect(await approvals.approved('prod', 'tab', 'p2', 'alice/a')).toBe(false)
    expect(await approvals.approved('prod', 'tab', 'p1', 'bob/b')).toBe(false)
    await approvals.approve({ ...request, scope: 'swarm' }, 'alice')
    expect(rows.at(-1)!.projectId).toBe(WHOLE_SWARM)
    expect(await approvals.approved('prod', 'tab', 'p2', 'alice/a')).toBe(true)
    expect(await approvals.approved('prod', 'other-tab', 'p2', 'alice/a')).toBe(false)
  })

  // Design 2026-10-30: the app shows "You can push" to someone who allowed the repository before, and asks someone GitHub
  // refused to send it on, instead of offering the same sign-in again.
  it('remember what GitHub said about the reader, and forget a refusal once the repository is allowed', async () => {
    const approved: Array<Record<string, string>> = [], refused: Array<Record<string, string>> = []
    const same = (r: Record<string, string>, w: Record<string, unknown>) => Object.entries(w).every(([k, v]) => r[k] === v)
    const db = {
      gitHubRepositoryApproval: {
        findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => approved.find(r => same(r, where)) ?? null),
        upsert: vi.fn(async ({ create }: { create: Record<string, string> }) => { approved.push(create); return create }),
      },
      gitHubApprovalRefusal: {
        findUnique: vi.fn(async ({ where }: { where: { autonomousEnv_tabId_repository_projectId_userId: Record<string, string> } }) =>
          refused.find(r => same(r, where.autonomousEnv_tabId_repository_projectId_userId)) ?? null),
        upsert: vi.fn(async ({ where, update, create }: { where: { autonomousEnv_tabId_repository_projectId_userId: Record<string, string> };
          update: Record<string, unknown>; create: Record<string, string> }) => {
          const row = refused.find(r => same(r, where.autonomousEnv_tabId_repository_projectId_userId))
          if (row) Object.assign(row, update); else refused.push(create)
        }),
        deleteMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          for (let i = refused.length - 1; i >= 0; i--) if (same(refused[i]!, where)) refused.splice(i, 1)
        }),
      },
    }
    const approvals = new PrismaApprovals(db as never)
    expect(await approvals.reader('prod', 'tab', 'p1', 'alice/a', 'alice')).toBeNull()
    await approvals.refuse(request, 'bob-gh')
    await approvals.refuse(request, 'bob-gh2')
    expect(refused).toHaveLength(1)
    expect(await approvals.reader('prod', 'tab', 'p1', 'Alice/A', 'alice')).toEqual({ canPush: false, githubLogin: 'bob-gh2' })
    expect(await approvals.reader('prod', 'tab', 'p1', 'alice/a', 'someone-else')).toBeNull()
    // Someone else allows it: the refusal goes, and whoever allowed it reads as able to push, in the Swarm's other projects too.
    await approvals.approve({ ...request, userId: 'user-2' }, 'carol')
    expect(refused).toHaveLength(0)
    expect(await approvals.reader('prod', 'tab', 'p2', 'alice/a', 'user-2')).toEqual({ canPush: true, githubLogin: 'carol' })
    await approvals.refuse({ ...request, projectId: 'p2' }, 'bob-gh')
    await approvals.approve({ ...request, scope: 'swarm', userId: 'user-2' }, 'carol')
    expect(refused).toHaveLength(0)
  })
})
