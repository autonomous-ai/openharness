import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import type { Approvals, GitHubSignIn } from '../src/github/approvals.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import type { Command } from '../src/superTabs/commands.js'
import { GitHubTokens, MemoryTokenCache } from '../src/github/tokens.js'
import { OWNER_CHECKS_PER_MINUTE, resetOwnerChecks } from '../src/github/repositoryCreate.js'
import { fakeApp, fakeGitHub, throwawayKey } from '../src/github/fakeGitHub.js'
import { poolRows } from './hostRows.test-support.js'
import { storeAssignment } from './storedWork.test-support.js'
import { logger } from '../src/utils/logger.js'

// The Harness GitHub App's token endpoint on the real control API: a fresh loopback MongoDB and a fake GitHub. This suite
// never reads DATABASE_URL, an existing database or github.com.
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '200000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '200000000000000000000002', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const key = throwawayKey()
const users = [owner, host]

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`super_tab_github_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  await db.user.create({ data: { id: owner.sub, externalId: `fixture-${owner.sub}`, email: owner.email, autonomousEnv: 'prod', name: 'Olive Owner' } })
  await db.user.create({ data: { id: host.sub, externalId: `fixture-${host.sub}`, email: host.email, autonomousEnv: 'prod' } })
  for (const [machineId, userId, name] of [['gh-host', host.sub, 'Fixture Mac'], ['gh-host-mini', host.sub, 'Fixture Mini'], ['owner-mac', owner.sub, 'Owner Mac'],
    ['gh-pool', host.sub, 'Fixture Pool'], ['owner-pool', owner.sub, 'Owner Pool']]) {
    await db.machine.create({ data: { machineId: machineId!, userId: userId!, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod',
      authMode: 'remote', name } })
  }
  await db.machineShare.create({ data: { machineId: 'gh-host', ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** One control API with the app configured against a fresh fake GitHub, its store revoking as tasks end. */
async function fresh(options: { github?: boolean; approveAll?: boolean; signIn?: GitHubSignIn | null; now?: () => number
  /** Another server's GitHub, shared: a second control API on the same database and GitHub, with its own caches. */
  shared?: ReturnType<typeof fakeGitHub> } = {}) {
  const github = options.shared ?? fakeGitHub({ publicKey: key.publicKey, appId: '424242' })
  if (!options.shared) github.installed.set('example/app', 91)
  const log = { warn: vi.fn() }
  const tokens = new GitHubTokens(fakeApp(key.privateKey, github, { now: options.now }), new MemoryTokenCache(), { log, secret: randomBytes(32) })
  const releases: Promise<void>[] = []
  const store = new SuperTabStore(db, Date.now, null, { workEnded: (tab, ended) => { releases.push(tokens.release(tab, ended)) },
    workStarted: (tab, started) => { releases.push(tokens.resume(tab, started)) } })
  const app: FastifyInstance = Fastify()
  app.setErrorHandler(errorHandler)
  app.addHook('onRequest', async (request, reply) => {
    // GitHub sends a person back here without a Harness token, as the server's own gate lets it (authMiddleware.ts).
    if (request.url.startsWith('/api/github/callback')) return
    const user = users.find(u => `Bearer ${u.sub}` === request.headers.authorization)
    if (!user) return reply.code(401).send({ success: false })
    request.user = user
  })
  // Every project approved unless a test says otherwise (github/approvals.ts); what was approved, kept here.
  const approved: Array<{ tabId: string; projectId: string; repository: string; scope: string; login: string }> = []
  const refused = new Map<string, string>()
  const approvals: Approvals = {
    approved: async (_env, tabId, projectId, repository) => options.approveAll !== false
      || approved.some(a => a.tabId === tabId && a.repository === repository.toLowerCase() && (a.scope === 'swarm' || a.projectId === projectId)),
    approve: async (request, login) => { approved.push({ ...request, login }) },
    approvedProjects: async (_env, tabId, repository) => approved
      .filter(a => a.tabId === tabId && a.repository === repository.toLowerCase() && a.scope === 'project').map(a => a.projectId),
    refuse: async (request, login) => { refused.set(`${request.tabId}/${request.projectId}/${request.repository}/${request.userId}`, login) },
    reader: async (_env, tabId, projectId, repository, userId) => {
      const login = refused.get(`${tabId}/${projectId}/${repository.toLowerCase()}/${userId}`)
      return login ? { canPush: false, githubLogin: login } : null
    },
  }
  await app.register(superTabRoutes, { store, github: options.github === false ? null : tokens, approvals, signIn: options.signIn ?? null })
  await app.ready()
  const run = (tab: string, command: Command, user = owner, asAgentId?: string) =>
    store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const settled = async () => { await Promise.all(releases.splice(0)) }
  return { github, log, tokens, store, app, run, settled, approved }
}

type Env = Awaited<ReturnType<typeof fresh>>
/** [person] joins the owner's Swarm [tab] as a collaborator. */
async function invited(env: Env, tab: string, person: AuthUser) {
  const invitation = await env.run(tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' } as Command)
  await env.run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string } as Command, person)
}
/** The owner's account without an email for this test, as an account can be: the owner's email is the token's gate. */
async function ownerWithoutEmail() {
  await db.user.update({ where: { id: owner.sub }, data: { email: '' } })
  onTestFinished(async () => { await db.user.update({ where: { id: owner.sub }, data: { email: owner.email } }) })
}
/** The team account switched on for this test, in every Swarm. */
function teamAccounts() {
  vi.stubEnv('SWARM_TEAM_ACCOUNT_REQUIRED', '1')
  onTestFinished(() => { vi.unstubAllEnvs() })
}
/** A tab whose project is on [repositoryUrl], with a Builder on the host's machine working on a task. */
async function working(env: Env, repositoryUrl: string | null = 'https://github.com/example/app.git') {
  const tab = (await env.store.create(owner, randomUUID(), 'Pilot')).id
  await env.run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'gh-host', harnessId: randomUUID(), name: 'Lead',
    configuration: config, lead: true, project: { cwd: '/work/app', repositoryUrl } } as Command)
  const group = String((await env.run(tab, { type: 'conversation.create', title: 'Add search', brief: 'Add a search field',
    checks: [{ description: 'Search works', independent: false }] } as Command)).result.conversationId)
  const worker = String((await env.run(tab, { type: 'agent.add', conversationId: group, machineId: 'gh-host', harnessId: randomUUID(),
    name: 'Builder', configuration: config, lead: false } as Command)).result.agentId)
  const assignmentId = (await storeAssignment(db, tab, group, worker)).id
  return { tab, group, worker, assignmentId }
}
const ask = (env: Env, tab: string, agentId: string | null, machineId = 'gh-host', user = host) => env.app.inject({ method: 'POST',
  url: `/api/super-tabs/${tab}/github-token${agentId ? `?asAgentId=${agentId}` : ''}`, headers: { authorization: `Bearer ${user.sub}` }, payload: { machineId } })

describe('the GitHub token endpoint', () => {
  it('gives the working agent\'s host a token for its project\'s repository, with who the work is for', async () => {
    const env = await fresh()
    const { tab, worker } = await working(env)
    const response = await ask(env, tab, worker)
    expect(response.statusCode, response.body).toBe(200)
    const data = response.json().data
    expect(data).toMatchObject({ token: 'ghs_fixture_1', repository: 'example/app', defaultBranch: 'main', defaultBranchProtected: false,
      defaultBranchProtection: 'none', requestedBy: { name: 'Olive Owner', email: owner.email }, agent: expect.any(String), machine: 'Fixture Mac',
      pullRequestLine: `Requested by Olive Owner (${owner.email}) through Harness.` })
    expect(data.trailers).toEqual([`Co-authored-by: Olive Owner <${owner.email}>`, 'Co-authored-by: Harness by Autonomous <noreply@autonomous.ai>', `Harness-Agent: ${data.agent}`, 'Harness-Machine: Fixture Mac'])
    expect(Date.parse(data.expiresAt)).toBeGreaterThan(Date.now() + 50 * 60_000)
    const minted = env.github.calls.find(c => c.path === '/app/installations/91/access_tokens')!
    expect(minted.body).toEqual({ repositories: ['app'],
      permissions: { contents: 'write', pull_requests: 'write', checks: 'read', actions: 'read', metadata: 'read' } })
    // A person's machine keeps its owner's git identity.
    expect(data).not.toHaveProperty('commitAs')
    // The same task gets the same token back.
    expect((await ask(env, tab, worker)).json().data.token).toBe('ghs_fixture_1')
    // Swarm v4 (slice S6): the tab no longer tells a start that this server has the app.
    const read = await env.app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/parts`, headers: { authorization: `Bearer ${owner.sub}` } })
    expect(read.json().data).not.toHaveProperty('githubApp')
  })

  // Security reviews 1 and 2 of #2492: who asked for a group changes no token. The owner's email is the gate and the commits
  // name the owner, as on main.
  it('gives the token and owner trailers whoever asked, and refuses it when the owner has no email, though the requester has one', async () => {
    const env = await fresh()
    const tab = (await env.store.create(owner, randomUUID(), 'Pilot')).id
    await env.run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'Lead',
      configuration: config, lead: true, project: { cwd: '/work/app', repositoryUrl: 'https://github.com/example/app.git' } } as Command)
    await invited(env, tab, host)
    const group = String((await env.run(tab, { type: 'conversation.create', title: 'Add search', brief: 'Add a search field', checks: [],
      requesterId: host.sub } as Command)).result.conversationId)
    const worker = String((await env.run(tab, { type: 'agent.add', conversationId: group, machineId: 'owner-mac', harnessId: randomUUID(),
      name: 'Builder', configuration: config, lead: false } as Command)).result.agentId)
    await storeAssignment(db, tab, group, worker)
    const given = await ask(env, tab, worker, 'owner-mac', owner)
    expect(given.statusCode, given.body).toBe(200)
    expect(given.json().data).toMatchObject({ requestedBy: { name: 'Olive Owner', email: owner.email },
      pullRequestLine: `Requested by Olive Owner (${owner.email}) through Harness.` })
    expect(given.json().data.trailers[0]).toBe(`Co-authored-by: Olive Owner <${owner.email}>`)
    expect(given.body).not.toContain(host.email)
    await ownerWithoutEmail()
    const refused = await ask(env, tab, worker, 'owner-mac', owner)
    expect(refused.statusCode, refused.body).toBe(404)
    // Refused as on main (here before the owner's own check, as this owner's account no longer matches): no token, whoever asked.
    expect(refused.json().error.code).toBe('NOT_FOUND')
    expect(env.github.calls.filter(c => c.path.endsWith('/access_tokens'))).toHaveLength(1)
  })

  it('warns, but still gives the token, when the default branch does not require a pull request; and says when it does', async () => {
    const env = await fresh()
    const { tab, worker } = await working(env)
    env.github.protection.set('example/app', { protected: true })
    expect((await ask(env, tab, worker)).json().data).toMatchObject({ defaultBranchProtected: false, defaultBranchProtection: 'classic' })
    const other = await fresh()
    const second = await working(other)
    other.github.protection.set('example/app', { rules: [{ type: 'pull_request' }] })
    expect((await ask(other, second.tab, second.worker)).json().data).toMatchObject({ defaultBranchProtected: true, defaultBranchProtection: 'pull_request' })
  })

  it('refuses another account\'s agent, its own agent on another machine, and a request with no agent', async () => {
    const env = await fresh()
    const { tab, worker } = await working(env)
    const ownAgent = String((await env.run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(),
      name: 'Owner agent', configuration: config, lead: false } as Command)).result.agentId)
    expect((await ask(env, tab, ownAgent, 'owner-mac')).json().error).toMatchObject({ code: 'FORBIDDEN' })
    expect((await ask(env, tab, worker, 'gh-host', owner)).json().error).toMatchObject({ code: 'FORBIDDEN' })
    const elsewhere = await ask(env, tab, worker, 'gh-host-mini')
    expect(elsewhere.statusCode).toBe(403)
    expect(elsewhere.json().error).toMatchObject({ code: 'FORBIDDEN', message: 'Only the machine running this agent can ask for its GitHub token.' })
    const none = await ask(env, tab, null)
    expect(none.statusCode).toBe(400)
    expect(none.json().error.code).toBe('AGENT_REQUIRED')
    expect(env.github.calls).toEqual([])
  })

  it('refuses an agent with no task in progress', async () => {
    const env = await fresh()
    const { tab } = await working(env)
    const idle = String((await env.run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'gh-host', harnessId: randomUUID(),
      name: 'Idle', configuration: config, lead: false } as Command)).result.agentId)
    const response = await ask(env, tab, idle)
    expect(response.statusCode).toBe(409)
    expect(response.json().error.code).toBe('NO_ASSIGNMENT')
  })

  it('refuses a project whose repository is not on GitHub or has no address', async () => {
    for (const url of ['https://gitlab.com/example/app.git', null]) {
      const env = await fresh()
      const { tab, worker } = await working(env, url)
      const response = await ask(env, tab, worker)
      expect(response.statusCode).toBe(409)
      expect(response.json().error.code).toBe('REPOSITORY_NOT_GITHUB')
      expect(env.github.calls).toEqual([])
    }
  })

  it('refuses a repository the app is not installed on, with the install link', async () => {
    const env = await fresh()
    env.github.installed.clear()
    const { tab, worker } = await working(env)
    const response = await ask(env, tab, worker)
    expect(response.statusCode).toBe(409)
    expect(response.json().error).toEqual({ code: 'GITHUB_APP_NOT_INSTALLED', installUrl: 'https://github.com/apps/harness-fixture/installations/new',
      message: 'The Harness GitHub App is not installed on example/app. Ask an owner of example to install it: https://github.com/apps/harness-fixture/installations/new.' })
  })

  it('answers not configured when the server has no app, and says nothing about it on the tab', async () => {
    const env = await fresh({ github: false })
    const { tab, worker } = await working(env)
    const response = await ask(env, tab, worker)
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('GITHUB_APP_NOT_CONFIGURED')
    const read = await env.app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/parts`, headers: { authorization: `Bearer ${owner.sub}` } })
    expect(read.json().data).not.toHaveProperty('githubApp')
  })
})

// What was the start token's describe: a queued start for approvals (slice S6 left it).
describe('approving a repository', () => {
  const observed = { resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9,
    projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture CPU', os: 'macOS', gpuPercent: null }, quotas: [], tools: { git: true },
    runningHarnessIds: [], stoppedHarnessIds: [] }
  /** The owner's project on github.com, with a start queued on [machineId], a machine its owner [contributor] added to the Swarm. */
  async function queued(env: Env, machineId = 'gh-pool', contributor = host, repositoryUrl: string | null = 'https://github.com/example/app.git',
    requester?: AuthUser) {
    const tab = (await env.store.create(owner, randomUUID(), 'Pool')).id
    await env.run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'Lead',
      configuration: config, lead: true, project: { cwd: '/work/app', repositoryUrl } } as Command)
    if (contributor !== owner) {
      const invitation = await env.run(tab, { type: 'invite.create', email: contributor.email, role: 'collaborator', conversationId: 'lead' } as Command)
      await env.run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string } as Command, contributor)
    }
    await env.run(tab, { type: 'machine.contribute', machineId, name: 'Pool', cwd: '/swarm-root', scope: 'swarm', engines: ['codex'], maxAgents: 2 } as Command, contributor)
    // Its own person's computer, as v3 runs every agent (task #4120): no Team account, and the contributor starts its own agent.
    const pool = (await poolRows(env.store, contributor, machineId)).find(p => p.tabId === tab)!
    await env.store.observeMachine(contributor, tab, machineId, { generation: pool.machine.generation, ...observed })
    // A group of the project, its start's conversation: no agent but the coordinator starts into the project chat (#2207).
    // [requester] asked for it, where given. The contributor joined above.
    const conversationId = String((await env.run(tab, { type: 'conversation.create', title: 'Add search', brief: 'Add a search field',
      checks: [], ...(requester ? { requesterId: requester.sub } : {}) } as Command)).result.conversationId)
    const startId = String((await env.run(tab, { type: 'agent.start', request: { conversationId, machineId, engine: 'codex', name: 'Builder',
      cwd: '/swarm-root/lead', worktree: true, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } } as Command,
      contributor)).result.startId)
    return { tab, startId }
  }

  it('approves nothing for a Swarm deleted since the link was made, and says so as for an expired link', async () => {
    const signIn = { authorizeUrl: (state: string) => `https://github.test/login/oauth/authorize?state=${state}`,
      permission: async () => ({ login: 'olive', push: true }) } as unknown as GitHubSignIn
    teamAccounts()
    const env = await fresh({ approveAll: false, signIn })
    const { tab } = await queued(env)
    const asked = await env.app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/projects/lead/github/approve`,
      headers: { authorization: `Bearer ${owner.sub}` }, payload: { scope: 'project' } })
    const state = new URL((asked.json().data as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')!
    await env.run(tab, { type: 'swarm.delete', name: 'Pool' } as Command)
    const late = await env.app.inject({ method: 'GET', url: `/api/github/callback?code=c&state=${encodeURIComponent(state)}` })
    expect(late.statusCode).toBe(400)
    expect(late.body).toContain('This link has expired')
    expect(env.approved).toEqual([])
  })

  it('says nothing was approved when the person cancels GitHub\'s sign-in', async () => {
    const signIn = { authorizeUrl: (state: string) => `https://github.test/login/oauth/authorize?state=${state}`,
      permission: async () => ({ login: 'olive', push: true }) } as unknown as GitHubSignIn
    teamAccounts()
    const env = await fresh({ approveAll: false, signIn })
    const { tab } = await queued(env)
    const asked = await env.app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/projects/lead/github/approve`,
      headers: { authorization: `Bearer ${owner.sub}` }, payload: { scope: 'project' } })
    const state = new URL((asked.json().data as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')!
    // GitHub sends a person who chose Cancel back with an error and no code (its web application flow).
    const cancelled = await env.app.inject({ method: 'GET',
      url: `/api/github/callback?error=access_denied&error_description=The+user+has+denied+your+application+access.&state=${encodeURIComponent(state)}` })
    expect(cancelled.statusCode).toBe(200)
    expect(cancelled.body).toContain('Sign-in was cancelled')
    expect(cancelled.body).toContain('Nothing was allowed. Go back to Harness and choose Continue in GitHub to try again.')
    expect(cancelled.body).not.toContain('Harness is installed')
    expect(env.approved).toEqual([])
  })

  // Local Team account run, 2026-10-28: a second project on a repository already approved for another asked again with no hint.
  it('names the reader\'s other projects the repository is approved for, when it is not approved for this one', async () => {
    const signIn = { authorizeUrl: (state: string) => `https://github.test/login/oauth/authorize?state=${state}`,
      permission: async () => ({ login: 'olive', push: true }) } as unknown as GitHubSignIn
    teamAccounts()
    const env = await fresh({ approveAll: false, signIn })
    const { tab } = await working(env)
    const invited = await env.run(tab, { type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' } as Command)
    await env.run(tab, { type: 'invite.accept', inviteId: invited.result.inviteId as string } as Command, host)
    const project = async (name: string, visibility: 'public' | 'private') => {
      const made = (await env.run(tab, { type: 'project.create', name, visibility, brief: '' } as Command)).result
      await env.run(tab, { type: 'agent.add', conversationId: made.conversationId, machineId: 'owner-mac', harnessId: randomUUID(), name: 'Lead',
        configuration: config, lead: true, project: { cwd: `/work/${name}`, repositoryUrl: 'https://github.com/example/app.git' } } as Command)
      return String(made.projectId)
    }
    const docs = await project('Docs', 'public'), secret = await project('Secret', 'private')
    const approve = async (projectId: string) => {
      const asked = await env.app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/projects/${projectId}/github/approve`,
        headers: { authorization: `Bearer ${owner.sub}` }, payload: { scope: 'project' } })
      const state = new URL((asked.json().data as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')!
      expect((await env.app.inject({ method: 'GET', url: `/api/github/callback?code=c&state=${encodeURIComponent(state)}` })).statusCode).toBe(200)
    }
    await approve('lead')
    await approve(secret)
    const read = async (user: AuthUser, projectId: string) => (await env.app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/projects/${projectId}/github`,
      headers: { authorization: `Bearer ${user.sub}` } })).json().data
    expect(await read(owner, docs)).toMatchObject({ state: 'not-approved', repository: 'example/app', approvedFor: ['Pilot', 'Secret'] })
    // A teammate who cannot open Secret reads only Pilot.
    expect(await read(host, docs)).toMatchObject({ state: 'not-approved', approvedFor: ['Pilot'] })
    // An approved project says nothing of the others.
    expect(await read(owner, 'lead')).not.toHaveProperty('approvedFor')
  })

  it('says when the server cannot approve, and refuses a project not on GitHub', async () => {
    const env = await fresh({ approveAll: false })
    const { tab } = await queued(env)
    const none = await env.app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/projects/lead/github/approve`,
      headers: { authorization: `Bearer ${owner.sub}` }, payload: { scope: 'swarm' } })
    expect(none.json().error).toMatchObject({ code: 'GITHUB_APPROVAL_NOT_CONFIGURED' })
  })
})

describe('revoking the token when the task ends', () => {
  const issued = async (env: Env) => {
    const work = await working(env)
    const token = (await ask(env, work.tab, work.worker)).json().data.token as string
    return { ...work, token }
  }

  it('revokes when the host confirms the agent stopped', async () => {
    const env = await fresh()
    const { tab, assignmentId, token } = await issued(env)
    await env.store.stopped(host, tab, assignmentId, 'fixture stop receipt')
    await env.settled()
    expect(env.github.revoked).toEqual([token])
  })

  it('revokes when the agent is removed', async () => {
    const env = await fresh()
    const { tab, worker, token } = await issued(env)
    await env.run(tab, { type: 'agent.remove', agentId: worker } as Command)
    await env.settled()
    expect(env.github.revoked).toEqual([token])
  })

  it('a failed revoke is logged without the token and does not hold up the task', async () => {
    const env = await fresh()
    const { tab, group, assignmentId, token } = await issued(env)
    env.github.control.revokeStatus = 502
    await env.store.stopped(host, tab, assignmentId, 'fixture stop receipt')
    await env.settled()
    expect((await env.store.read(owner, tab)).state.conversations.find(c => c.id === group)!.assignment!.status).toBe('stopped')
    expect(env.github.revoked).toEqual([])
    expect(env.log.warn).toHaveBeenCalledWith('[github] token revoke failed', expect.objectContaining({ tabId: tab, repository: 'example/app', why: 'task ended' }))
    expect(JSON.stringify(env.log.warn.mock.calls)).not.toContain(token)
  })
})

// Swarm v4 (slice S6): the server stops advertising the app, so new starts use their own person's login. A start's token and
// the CI load answer what a server without the app did; agent tokens keep coming for sessions started with the app.
describe('the retired start token and CI load', () => {
  const load = (env: Env, tab: string, projectId: string, user = owner, asAgentId?: string) => env.app.inject({ method: 'GET',
    url: `/api/super-tabs/${tab}/projects/${projectId}/ci-load${asAgentId ? `?asAgentId=${asAgentId}` : ''}`, headers: { authorization: `Bearer ${user.sub}` } })
  const prepare = (env: Env, tab: string, startId: string, payload: Record<string, unknown> = {}) => env.app.inject({ method: 'POST',
    url: `/api/super-tabs/hosts/gh-host/starts/${tab}/${startId}/github-token`, headers: { authorization: `Bearer ${host.sub}` }, payload })
  const minted = (env: Env) => env.github.calls.filter(c => c.path.endsWith('/access_tokens'))

  it('claim no app on the tab or on any host row, so a new start prepares and runs with its own login', async () => {
    const env = await fresh()
    const { tab } = await working(env)
    const read = await env.app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/parts`, headers: { authorization: `Bearer ${owner.sub}` } })
    expect(read.json().data).not.toHaveProperty('githubApp')
    const rows = await env.app.inject({ method: 'GET', url: '/api/super-tabs/hosts/gh-host/changes?full=1', headers: { authorization: `Bearer ${host.sub}` } })
    expect(rows.statusCode).toBe(200)
    expect(rows.body).not.toContain('githubApp')
  })

  it('answer a start\'s host `github: false`, and a Harness Team host, which has no login, that the server has no app', async () => {
    const env = await fresh()
    const { tab } = await working(env)
    const plain = await prepare(env, tab, randomUUID())
    expect(plain.statusCode, plain.body).toBe(200)
    expect(plain.json().data).toEqual({ github: false })
    const team = await prepare(env, tab, randomUUID(), { always: true })
    expect(team.statusCode).toBe(503)
    expect(team.json().error.code).toBe('GITHUB_APP_NOT_CONFIGURED')
    expect(minted(env)).toEqual([])
  })

  it('answer the CI load as unavailable to whoever may read the project, and refuse anyone else as before', async () => {
    const env = await fresh()
    const { tab, worker } = await working(env)
    expect((await load(env, tab, 'lead')).json().data).toEqual({ state: 'unavailable' })
    expect((await load(env, tab, 'lead', host, worker)).json().data).toEqual({ state: 'unavailable' })
    const secret = String((await env.run(tab, { type: 'project.create', name: 'Secret Plans', visibility: 'private', brief: '' } as Command)).result.projectId)
    for (const refused of [await load(env, tab, secret, host, worker), await load(env, tab, 'nope', owner), await load(env, tab, 'lead', host)]) {
      expect(refused.statusCode).toBe(404)
      expect(refused.body).not.toContain('Secret Plans')
    }
    expect(minted(env)).toEqual([])
  })
})

// Task #2316 (Dee, 2026-11-03): after lampos's repository was allowed, "Set up GitHub for teammates" stayed on everyone's
// computer for up to 5 minutes. Each project's GitHub revision moves in the Swarm state, so members' apps read again.
describe('the GitHub revision', () => {
  const signIn = { authorizeUrl: (state: string) => `https://github.test/login/oauth/authorize?state=${state}`,
    permission: async () => ({ login: 'olive', push: true }) } as unknown as GitHubSignIn
  /** A Swarm whose project and Docs are on example/app, and Other on example/other. */
  async function swarm(env: Env) {
    const { tab } = await working(env)
    const project = async (name: string, repositoryUrl: string) => {
      const made = (await env.run(tab, { type: 'project.create', name, visibility: 'public', brief: '' } as Command)).result
      await env.run(tab, { type: 'agent.add', conversationId: made.conversationId, machineId: 'owner-mac', harnessId: randomUUID(), name: 'Lead',
        configuration: config, lead: true, project: { cwd: `/work/${name}`, repositoryUrl } } as Command)
      return String(made.projectId)
    }
    return { tab, docs: await project('Docs', 'https://github.com/Example/App'), other: await project('Other', 'https://github.com/example/other.git') }
  }
  const revisions = async (env: Env, tab: string) =>
    Object.fromEntries(((await env.store.read(owner, tab)).state.projects ?? []).map(p => [p.id, p.githubRevision ?? 0]))
  const allow = async (env: Env, tab: string, projectId: string, scope: 'project' | 'swarm') => {
    const asked = await env.app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/projects/${projectId}/github/approve`,
      headers: { authorization: `Bearer ${owner.sub}` }, payload: { scope } })
    const state = new URL((asked.json().data as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')!
    return { state, page: await env.app.inject({ method: 'GET', url: `/api/github/callback?code=c&state=${encodeURIComponent(state)}` }) }
  }
  const check = (env: Env, tab: string, projectId: string, refresh = true, record = true) => env.app.inject({ method: 'GET',
    url: `/api/super-tabs/${tab}/projects/${projectId}/github${refresh ? `?refresh=1${record ? '' : '&record=0'}` : ''}`,
    headers: { authorization: `Bearer ${owner.sub}` } })

  it('moves every project on the repository when someone allows it, and a swarm-wide approval moves them all', async () => {
    teamAccounts()
    const env = await fresh({ approveAll: false, signIn })
    const { tab, docs, other } = await swarm(env)
    const before = await revisions(env, tab)
    expect((await allow(env, tab, 'lead', 'project')).page.statusCode).toBe(200)
    const once = await revisions(env, tab)
    expect(once).toEqual({ ...before, lead: before.lead! + 1, [docs]: before[docs]! + 1 })
    expect((await allow(env, tab, docs, 'swarm')).page.statusCode).toBe(200)
    expect(await revisions(env, tab)).toEqual({ lead: once.lead! + 1, [docs]: once[docs]! + 1, [other]: before[other] })
  })

  it('a dialog read that finds the app installed now moves it once; the same answer again moves nothing', async () => {
    teamAccounts()
    let at = Date.now()
    const env = await fresh({ approveAll: false, signIn, now: () => at })
    const { tab, docs } = await swarm(env)
    env.github.installed.delete('example/app')
    expect((await check(env, tab, 'lead')).json().data).toMatchObject({ state: 'not-installed' })
    const missing = await revisions(env, tab)
    // Installed on GitHub's own site; the dialog asks again (at most every 15 s per repository).
    env.github.installed.set('example/app', 91)
    at += 16_000
    expect((await check(env, tab, 'lead')).json().data).toMatchObject({ state: 'not-approved' })
    const found = await revisions(env, tab)
    expect(found.lead).toBe(missing.lead! + 1)
    expect(found[docs]).toBe(missing[docs])
    at += 16_000
    expect((await check(env, tab, 'lead')).json().data).toMatchObject({ state: 'not-approved' })
    expect(await revisions(env, tab)).toEqual(found)
    // A read that does not ask GitHub again records nothing: another server's cache may be older.
    expect((await check(env, tab, docs, false)).json().data).toMatchObject({ state: 'not-approved' })
    expect(await revisions(env, tab)).toEqual(found)
  })

  // Review of #2713: every member's app reads again when the revision moves, and those reads land on servers whose caches
  // differ (an installation is kept 10 minutes, "not installed" 1 minute). Had they recorded what they found, two servers
  // would move the revision back and forth, each move making every app read again.
  it('a read that follows a revision move records nothing, whatever answer it gets; a person\'s check still does', async () => {
    teamAccounts()
    const one = await fresh({ approveAll: false, signIn })
    const two = await fresh({ approveAll: false, signIn, shared: one.github })
    const { tab } = await swarm(one)
    expect((await check(one, tab, 'lead')).json().data).toMatchObject({ state: 'not-approved' })
    const seen = await revisions(one, tab)
    // Removed from the repository: the first server still keeps the installation (10 minutes), the second asks GitHub.
    one.github.installed.delete('example/app')
    for (const [server, state] of [[one, 'not-approved'], [two, 'not-installed'], [one, 'not-approved'], [two, 'not-installed']] as const) {
      expect((await check(server, tab, 'lead', true, false)).json().data).toMatchObject({ state })
      expect(await revisions(one, tab)).toEqual(seen)
    }
    // A person checks again: that records the answer, once.
    expect((await check(two, tab, 'lead')).json().data).toMatchObject({ state: 'not-installed' })
    expect((await revisions(one, tab)).lead).toBe(seen.lead! + 1)
  })

  it('GitHub sending a person back after installing forgets the cache and moves every project on the repository', async () => {
    teamAccounts()
    const env = await fresh({ approveAll: false, signIn })
    const { tab, docs, other } = await swarm(env)
    env.github.installed.delete('example/app')
    expect((await check(env, tab, 'lead', false)).json().data).toMatchObject({ state: 'not-installed' })
    const before = await revisions(env, tab)
    env.github.installed.set('example/app', 91)
    const asked = await env.app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/projects/lead/github/approve`,
      headers: { authorization: `Bearer ${owner.sub}` }, payload: { scope: 'project' } })
    const state = new URL((asked.json().data as { authorizeUrl: string }).authorizeUrl).searchParams.get('state')!
    const installed = await env.app.inject({ method: 'GET', url: `/api/github/callback?installation_id=9&setup_action=install&state=${encodeURIComponent(state)}` })
    expect(installed.body).toContain('Harness is installed')
    expect(await revisions(env, tab)).toEqual({ lead: before.lead! + 1, [docs]: before[docs]! + 1, [other]: before[other] })
    // Read without asking again: the cache was forgotten, so it is installed now.
    expect((await check(env, tab, 'lead', false)).json().data).toMatchObject({ state: 'not-approved' })
  })

  it('an approval whose move fails still says it is allowed, and says why in the log', async () => {
    teamAccounts()
    const env = await fresh({ approveAll: false, signIn })
    const { tab } = await swarm(env)
    const warn = vi.spyOn(logger, 'warn')
    onTestFinished(() => { warn.mockRestore() })
    vi.spyOn(env.store, 'githubChanged').mockRejectedValueOnce(new Error('write conflict'))
    const { page } = await allow(env, tab, 'lead', 'project')
    expect(page.statusCode).toBe(200)
    expect(page.body).toContain('example/app is allowed')
    expect(warn).toHaveBeenCalledWith('[github] access change not recorded', expect.objectContaining({ tabId: tab, error: 'Error: write conflict' }))
    expect(env.approved).toHaveLength(1)
  })
})

describe('a new repository from New Project (task #1788)', () => {
  type Script = Record<string, { status: number; body?: Record<string, unknown> }>
  const made: Script = {
    'GET /user': { status: 200, body: { login: 'olive' } },
    'POST /orgs/acme/repos': { status: 201, body: { id: 555, full_name: 'acme/notes', html_url: 'https://github.com/acme/notes' } },
  }
  /** The app's sign-in, answering the person's calls from [script]; a code 'bad' is one GitHub refuses, and each code works
   *  once, as GitHub's do. [onCreate] runs while the create call is in flight. */
  const signInWith = (script: () => Script, onCreate?: () => Promise<void>) => {
    const used = new Set<string>()
    return {
      authorizeUrl: (state: string) => `https://github.test/login/oauth/authorize?state=${state}`,
      permission: async () => ({ login: 'olive', push: true }),
      withUserToken: async (code: string, use: (call: (m: string, p: string, b?: unknown) => Promise<{ status: number; body: Record<string, unknown> }>) => Promise<unknown>) => {
        if (code === 'bad' || used.has(code)) return null
        used.add(code)
        return use(async (method, path) => {
          if (method === 'POST' && onCreate) await onCreate()
          const answer = script()[`${method} ${path}`] ?? { status: 404, body: { message: 'Not Found' } }
          return { status: answer.status, body: answer.body ?? {} }
        })
      },
    } as unknown as GitHubSignIn
  }
  async function project(env: Env) {
    const tab = (await env.store.create(owner, randomUUID(), 'Pilot')).id
    const projectId = String((await env.run(tab, { type: 'project.create', name: 'Notes', visibility: 'public', brief: '' } as Command)).result.projectId)
    return { tab, projectId }
  }
  const ready = (env: Env, grants: Record<string, 'read' | 'write'> = { repository_creation: 'write' }) => {
    env.github.owners.set('acme', 91)
    env.github.grants.set(91, grants)
  }
  const askCreate = (env: Env, tab: string, projectId: string, payload: Record<string, unknown> = { owner: 'acme', name: 'notes', private: true }, user = owner) =>
    env.app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/projects/${projectId}/github/repository`, headers: { authorization: `Bearer ${user.sub}` }, payload })
  const callback = (env: Env, query: string) => env.app.inject({ method: 'GET', url: `/api/github/callback?${query}` })
  const stateOf = (authorizeUrl: string) => encodeURIComponent(new URL(authorizeUrl).searchParams.get('state')!)
  const creation = async (env: Env, tab: string, projectId: string) =>
    (await env.store.readLoad(owner, tab)).state.projects?.find(p => p.id === projectId)?.repositoryCreation

  it('the owner creates a new repository for their new project, approved for it and ready for its PM', async () => {
    const env = await fresh({ approveAll: false, signIn: signInWith(() => made) })
    ready(env)
    env.github.installed.set('acme/notes', 91)
    const { tab, projectId } = await project(env)
    const asked = await askCreate(env, tab, projectId)
    expect(asked.statusCode, asked.body).toBe(200)
    const { authorizeUrl, at } = asked.json().data as { authorizeUrl: string; at: number }
    expect(await creation(env, tab, projectId)).toEqual({ owner: 'acme', name: 'notes', private: true, by: owner.sub, at, state: 'waiting' })
    // Ids, the owner and the name only go to GitHub in the address, never the project's name (privacy review of #1980).
    expect(decodeURIComponent(authorizeUrl)).not.toContain('Notes')
    const done = await callback(env, `code=c&state=${stateOf(authorizeUrl)}`)
    expect(done.statusCode).toBe(200)
    expect(done.body).toContain('acme/notes is ready')
    expect(await creation(env, tab, projectId)).toEqual({ owner: 'acme', name: 'notes', private: true, by: owner.sub, at, state: 'created',
      repositoryUrl: 'https://github.com/acme/notes', reachable: true })
    expect(env.approved).toEqual([expect.objectContaining({ tabId: tab, projectId, repository: 'acme/notes', scope: 'project', login: 'olive' })])
    // The same link again changes nothing and creates nothing more.
    const again = await callback(env, `code=c2&state=${stateOf(authorizeUrl)}`)
    expect(again.body).toContain('This link has expired')
    expect(env.approved).toHaveLength(1)
  })

  it('another member, a bad name or owner, or a project with a repository can\'t start it', async () => {
    const env = await fresh({ approveAll: false, signIn: signInWith(() => made) })
    ready(env)
    const { tab, projectId } = await project(env)
    await invited(env, tab, host)
    expect((await askCreate(env, tab, projectId, undefined, host)).json()).toMatchObject({ error: { code: 'PROJECT_OWNER_REQUIRED' } })
    const named = await askCreate(env, tab, projectId, { owner: 'acme', name: 'a b', private: true })
    expect(named.statusCode).toBe(400)
    expect(named.json()).toMatchObject({ error: { code: 'REPOSITORY_NAME', message: 'Use letters, numbers, - _ or . (up to 100).' } })
    expect((await askCreate(env, tab, projectId, { owner: '-acme', name: 'notes', private: true })).statusCode).toBe(400)
    const { tab: shared } = await working(env)
    expect((await askCreate(env, shared, 'lead')).json()).toMatchObject({ error: { code: 'PROJECT_REPOSITORY_SET' } })
    expect(await creation(env, tab, projectId)).toBeUndefined()
  })

  it('each organization state is said before sign-in', async () => {
    const env = await fresh({ approveAll: false, signIn: signInWith(() => made) })
    const { tab, projectId } = await project(env)
    const owners = (owner_ = 'acme', user = owner) => env.app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/github/owners/${owner_}`, headers: { authorization: `Bearer ${user.sub}` } })
    expect((await owners()).json().data).toEqual({ state: 'not-installed', installUrl: 'https://github.com/apps/harness-fixture/installations/new' })
    const notInstalled = await askCreate(env, tab, projectId)
    expect(notInstalled.statusCode).toBe(409)
    expect(notInstalled.json()).toMatchObject({ error: { code: 'GITHUB_APP_NOT_INSTALLED' } })
    env.github.owners.set('acme', 91)
    env.github.grants.set(91, { contents: 'write' })
    env.github.owners.set('beta', 92)
    env.github.grants.set(92, { repository_creation: 'write' })
    expect((await owners('beta')).json().data).toEqual({ state: 'ready' })
    expect((await askCreate(env, tab, projectId, { owner: 'beta', name: 'notes', private: true })).statusCode).toBe(200)
    expect((await owners('-bad')).statusCode).toBe(400)
    // Someone outside the Swarm reads nothing.
    expect((await owners('beta', host)).statusCode).toBeGreaterThanOrEqual(403)
    const off = await fresh({ approveAll: false, signIn: null })
    const other = await project(off)
    const offOwners = await off.app.inject({ method: 'GET', url: `/api/super-tabs/${other.tab}/github/owners/acme`, headers: { authorization: `Bearer ${owner.sub}` } })
    expect(offOwners.json().data).toEqual({ state: 'not-configured' })
    expect((await askCreate(off, other.tab, other.projectId)).statusCode).toBe(503)
  })

  it('an organization that has not accepted the permission is said before sign-in', async () => {
    const env = await fresh({ approveAll: false, signIn: signInWith(() => made) })
    ready(env, { contents: 'write' })
    const { tab, projectId } = await project(env)
    const owners = await env.app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/github/owners/acme`, headers: { authorization: `Bearer ${owner.sub}` } })
    expect(owners.json().data).toEqual({ state: 'not-accepted' })
    expect((await askCreate(env, tab, projectId)).json()).toMatchObject({ error: { code: 'GITHUB_APP_PERMISSIONS' } })
  })

  it('cancel, a taken name, GitHub\'s refusal and a refused code come back to the app', async () => {
    let script: Script = made
    const env = await fresh({ approveAll: false, signIn: signInWith(() => script) })
    ready(env)
    const { tab, projectId } = await project(env)
    const start = async () => (await askCreate(env, tab, projectId)).json().data as { authorizeUrl: string; at: number }

    let asked = await start()
    const cancelled = await callback(env, `error=access_denied&state=${stateOf(asked.authorizeUrl)}`)
    expect(cancelled.body).toContain('Nothing was created')
    expect(await creation(env, tab, projectId)).toMatchObject({ state: 'cancelled', at: asked.at })

    asked = await start()
    script = { ...made, 'POST /orgs/acme/repos': { status: 422, body: { message: 'Repository creation failed.', errors: [{ message: 'name already exists on this account' }] } } }
    expect((await callback(env, `code=c3&state=${stateOf(asked.authorizeUrl)}`)).body).toContain('acme/notes already exists')
    expect(await creation(env, tab, projectId)).toMatchObject({ state: 'taken' })

    asked = await start()
    script = { ...made, 'POST /orgs/acme/repos': { status: 403, body: { message: 'Members cannot create repositories.' } } }
    expect((await callback(env, `code=c4&state=${stateOf(asked.authorizeUrl)}`)).body).toContain('Members cannot create repositories.')
    expect(await creation(env, tab, projectId)).toMatchObject({ state: 'refused', reason: 'Members cannot create repositories.' })

    asked = await start()
    expect((await callback(env, `code=bad&state=${stateOf(asked.authorizeUrl)}`)).body).toContain('Nothing was created')
    expect(await creation(env, tab, projectId)).toMatchObject({ state: 'failed' })
    expect(env.approved).toEqual([])
  })

  it('an older link changes nothing once a newer ask replaced it, and creates nothing', async () => {
    let creates = 0
    const env = await fresh({ approveAll: false, signIn: signInWith(() => { creates++; return made }) })
    ready(env)
    const { tab, projectId } = await project(env)
    const first = (await askCreate(env, tab, projectId)).json().data as { authorizeUrl: string; at: number }
    await new Promise(resolve => setTimeout(resolve, 5))
    const second = (await askCreate(env, tab, projectId, { owner: 'acme', name: 'notes2', private: true })).json().data as { authorizeUrl: string; at: number }
    expect(second.at).toBeGreaterThan(first.at)
    const late = await callback(env, `code=c&state=${stateOf(first.authorizeUrl)}`)
    expect(late.body).toContain('This link has expired')
    expect(creates).toBe(0)
    expect(await creation(env, tab, projectId)).toMatchObject({ name: 'notes2', state: 'waiting' })
  })

  it('a replayed callback while the first is still creating changes nothing (security review 2 of #3201)', async () => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    let entered!: () => void
    const inside = new Promise<void>(resolve => { entered = resolve })
    const env = await fresh({ approveAll: false, signIn: signInWith(() => made, async () => { entered(); await held }) })
    ready(env)
    env.github.installed.set('acme/notes', 91)
    const { tab, projectId } = await project(env)
    const asked = (await askCreate(env, tab, projectId)).json().data as { authorizeUrl: string; at: number }
    const first = callback(env, `code=c&state=${stateOf(asked.authorizeUrl)}`)
    await inside
    expect(await creation(env, tab, projectId)).toMatchObject({ state: 'creating' })
    const replay = await callback(env, `code=c&state=${stateOf(asked.authorizeUrl)}`)
    expect(replay.body).toContain('This link has expired')
    release()
    expect((await first).body).toContain('acme/notes is ready')
    expect(await creation(env, tab, projectId)).toMatchObject({ state: 'created', repositoryUrl: 'https://github.com/acme/notes' })
    expect(env.approved).toHaveLength(1)
  })

  it('allows nothing for a project deleted while GitHub was creating its repository (security review 1 of #3201)', async () => {
    let deleteNow: () => Promise<void> = async () => {}
    const env = await fresh({ approveAll: false, signIn: signInWith(() => made, () => deleteNow()) })
    ready(env)
    const { tab, projectId } = await project(env)
    const asked = (await askCreate(env, tab, projectId)).json().data as { authorizeUrl: string }
    deleteNow = async () => { await env.run(tab, { type: 'project.delete', projectId } as Command) }
    const done = await callback(env, `code=c&state=${stateOf(asked.authorizeUrl)}`)
    expect(done.body).toContain('The project was deleted meanwhile')
    expect(env.approved).toEqual([])
  })

  it('asks GitHub nothing for someone who may not create, and limits organization checks per person (security reviews of #3201)', async () => {
    const env = await fresh({ approveAll: false, signIn: signInWith(() => made) })
    ready(env)
    const { tab, projectId } = await project(env)
    await invited(env, tab, host)
    const lookups = () => env.github.calls.filter(c => c.path.startsWith('/orgs/')).length
    expect((await askCreate(env, tab, projectId, undefined, host)).statusCode).toBe(403)
    expect(lookups()).toBe(0)
    resetOwnerChecks()
    onTestFinished(() => { resetOwnerChecks() })
    const owners = (name: string) => env.app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/github/owners/${name}`, headers: { authorization: `Bearer ${owner.sub}` } })
    for (let i = 0; i < OWNER_CHECKS_PER_MINUTE; i++) expect((await owners(`org${i}`)).statusCode).toBe(200)
    const before = lookups()
    const limited = await owners('one-more')
    expect(limited.statusCode).toBe(429)
    expect(limited.json().error.code).toBe('RATE_LIMITED')
    expect((await askCreate(env, tab, projectId, { owner: 'another', name: 'notes', private: true })).statusCode).toBe(429)
    expect(lookups()).toBe(before)
  })

  it('a project deleted while its person was in GitHub is said, and nothing is created', async () => {
    const env = await fresh({ approveAll: false, signIn: signInWith(() => made) })
    ready(env)
    const { tab, projectId } = await project(env)
    const asked = (await askCreate(env, tab, projectId)).json().data as { authorizeUrl: string }
    await env.run(tab, { type: 'project.delete', projectId } as Command)
    const late = await callback(env, `code=c&state=${stateOf(asked.authorizeUrl)}`)
    expect(late.body).toContain('The project was deleted meanwhile')
    expect(env.approved).toEqual([])
  })
})
