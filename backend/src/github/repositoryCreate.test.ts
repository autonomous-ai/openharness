import { createHmac, randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { readState, signState, STATE_TTL_MS, type ApprovalRequest, type UserCall } from './approvals.js'
import { createRepository, readCreateState, repositoryNameProblem, signCreateState, type CreateRequest } from './repositoryCreate.js'
import { fakeApp, fakeGitHub, throwawayKey } from './fakeGitHub.js'

const key = throwawayKey()
const AT = Date.parse('2026-11-05T15:00:00Z')
const request: CreateRequest = { userId: 'olive', autonomousEnv: 'prod', tabId: 'tab', projectId: 'p1', owner: 'acme', name: 'notes', private: true, at: AT }

/** A GitHub that answers the person's calls from [script], by "METHOD path"; every call is kept. */
function person(script: Record<string, { status: number; body?: Record<string, unknown> } | (() => never)>) {
  const calls: Array<{ method: string; path: string; body?: unknown }> = []
  const call: UserCall = async (method, path, body) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) })
    const answer = script[`${method} ${path}`] ?? { status: 404, body: { message: 'Not Found' } }
    if (typeof answer === 'function') answer()
    const { status, body: b } = answer as { status: number; body?: Record<string, unknown> }
    return { status, body: b ?? {} }
  }
  return { call, calls }
}
const me = { 'GET /user': { status: 200, body: { login: 'olive' } } }
const made = { status: 201, body: { id: 555, full_name: 'acme/notes', html_url: 'https://github.com/acme/notes' } }
function app(options: { covered?: boolean; canAdd?: boolean } = {}) {
  const github = fakeGitHub({ publicKey: key.publicKey, appId: '424242' })
  github.owners.set('acme', 91)
  github.grants.set(91, { repository_creation: 'write', ...(options.canAdd ? { installation_repositories: 'write' as const } : {}) })
  if (options.covered) github.installed.set('acme/notes', 91)
  return { github, app: fakeApp(key.privateKey, github) }
}

describe('a new repository\'s name', () => {
  it('names follow GitHub\'s rule', () => {
    for (const ok of ['notes-app', 'a.b_c', 'A', 'x'.repeat(100)]) expect(repositoryNameProblem(ok)).toBeNull()
    for (const bad of ['', '.', '..', 'a b', 'a/b', 'é', 'x'.repeat(101)]) expect(repositoryNameProblem(bad)).toBe('Use letters, numbers, - _ or . (up to 100).')
  })
})

describe('a create sign-in\'s state', () => {
  it('a create state is not an approval state, nor the reverse', () => {
    const secret = randomBytes(32)
    const created = signCreateState(secret, request, AT)
    expect(readCreateState(secret, created, AT + STATE_TTL_MS - 1)).toEqual(request)
    expect(readCreateState(secret, created, AT + STATE_TTL_MS + 1)).toBeNull()
    expect(readCreateState(randomBytes(32), created, AT)).toBeNull()
    expect(readState(secret, created, AT)).toBeNull()
    const approval: ApprovalRequest = { userId: 'olive', autonomousEnv: 'prod', tabId: 'tab', projectId: 'p1', repository: 'acme/notes', scope: 'project' }
    expect(readCreateState(secret, signState(secret, approval, AT), AT)).toBeNull()
    const sign = (value: unknown) => { const body = Buffer.from(JSON.stringify(value)).toString('base64url'); return `${body}.${createHmac('sha256', secret).update(body).digest('base64url')}` }
    expect(readCreateState(secret, sign({ ...request, kind: 'create', name: 'a b', exp: AT + 1000 }), AT)).toBeNull()
    expect(readCreateState(secret, sign({ ...request, kind: 'create', owner: '-bad', exp: AT + 1000 }), AT)).toBeNull()
    expect(readCreateState(secret, sign({ ...request, kind: 'create', private: 'yes', exp: AT + 1000 }), AT)).toBeNull()
    expect(readCreateState(secret, `${created.split('.')[0]}.forged`, AT)).toBeNull()
  })
})

describe('creating the repository with the person\'s token', () => {
  it('creates it private with a first commit, as the person', async () => {
    const { call, calls } = person({ ...me, 'POST /orgs/acme/repos': made })
    expect(await createRepository(call, app({ covered: true }).app, request)).toEqual({ state: 'created', repository: 'acme/notes',
      repositoryUrl: 'https://github.com/acme/notes', login: 'olive', reachable: true })
    expect(calls[1]).toEqual({ method: 'POST', path: '/orgs/acme/repos', body: { name: 'notes', private: true, auto_init: true } })
    const open = person({ ...me, 'POST /orgs/acme/repos': made })
    await createRepository(open.call, app({ covered: true }).app, { ...request, private: false })
    expect(open.calls[1]!.body).toEqual({ name: 'notes', private: false, auto_init: true })
  })

  it('adds it to the installation only where that is granted', async () => {
    const granted = person({ ...me, 'POST /orgs/acme/repos': made, 'PUT /user/installations/91/repositories/555': { status: 204 } })
    expect(await createRepository(granted.call, app({ canAdd: true }).app, request)).toMatchObject({ state: 'created', reachable: true })
    expect(granted.calls.map(c => `${c.method} ${c.path}`)).toContain('PUT /user/installations/91/repositories/555')
    const refusedAdd = person({ ...me, 'POST /orgs/acme/repos': made, 'PUT /user/installations/91/repositories/555': { status: 403 } })
    expect(await createRepository(refusedAdd.call, app({ canAdd: true }).app, request)).toMatchObject({ state: 'created', reachable: false })
    const notGranted = person({ ...me, 'POST /orgs/acme/repos': made })
    expect(await createRepository(notGranted.call, app().app, request)).toMatchObject({ state: 'created', reachable: false })
    expect(notGranted.calls.some(c => c.method === 'PUT')).toBe(false)
  })

  it('a name taken by someone else is taken; the same person\'s create since the request is created', async () => {
    const exists = { status: 422, body: { message: 'Repository creation failed.', errors: [{ resource: 'Repository', field: 'name', message: 'name already exists on this account' }] } }
    const theirs = (createdAt: number, admin: boolean) => person({ ...me, 'POST /orgs/acme/repos': exists,
      'GET /repos/acme/notes': { status: 200, body: { id: 555, full_name: 'acme/notes', created_at: new Date(createdAt).toISOString(), permissions: { admin } } } })
    expect(await createRepository(theirs(AT + 5_000, true).call, app({ covered: true }).app, request)).toMatchObject({ state: 'created', repository: 'acme/notes' })
    expect(await createRepository(theirs(AT - 3_600_000, true).call, app({ covered: true }).app, request)).toEqual({ state: 'taken' })
    expect(await createRepository(theirs(AT + 5_000, false).call, app({ covered: true }).app, request)).toEqual({ state: 'taken' })
    expect(await createRepository(person({ ...me, 'POST /orgs/acme/repos': exists }).call, app().app, request)).toEqual({ state: 'taken' })
  })

  it('GitHub\'s refusal is said in its words', async () => {
    const said = (status: number, message: string) => person({ ...me, 'POST /orgs/acme/repos': { status, body: { message } } }).call
    expect(await createRepository(said(403, 'Members of this organization cannot create repositories.'), app().app, request))
      .toEqual({ state: 'refused', reason: 'Members of this organization cannot create repositories.' })
    expect(await createRepository(said(404, 'Not Found'), app().app, request)).toEqual({ state: 'refused', reason: 'Not Found' })
    expect((await createRepository(said(422, 'x'.repeat(400)), app().app, request) as { reason: string }).reason).toHaveLength(300)
    expect(await createRepository(said(502, 'Bad gateway'), app().app, request)).toEqual({ state: 'failed' })
    expect(await createRepository(person({ ...me, 'POST /orgs/acme/repos': () => { throw new TypeError('fetch failed') } }).call, app().app, request)).toEqual({ state: 'failed' })
    expect(await createRepository(person({}).call, app().app, request)).toEqual({ state: 'failed' })
  })
})
