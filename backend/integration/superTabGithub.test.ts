import { createHash, randomBytes, randomUUID } from 'node:crypto'
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
import { fakeApp, fakeGitHub, throwawayKey } from '../src/github/fakeGitHub.js'
import { poolRows } from './hostRows.test-support.js'

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
async function fresh(options: { github?: boolean; approveAll?: boolean; signIn?: GitHubSignIn | null } = {}) {
  const github = fakeGitHub({ publicKey: key.publicKey, appId: '424242' })
  github.installed.set('example/app', 91)
  const log = { warn: vi.fn() }
  const tokens = new GitHubTokens(fakeApp(key.privateKey, github), new MemoryTokenCache(), { log, secret: randomBytes(32) })
  const releases: Promise<void>[] = []
  const store = new SuperTabStore(db, Date.now, null, { workEnded: (tab, ended) => { releases.push(tokens.release(tab, ended)) },
    workStarted: (tab, started) => { releases.push(tokens.resume(tab, started)) } })
  const app: FastifyInstance = Fastify()
  app.setErrorHandler(errorHandler)
  app.addHook('onRequest', async (request, reply) => {
    // GitHub sends a person back here without a Harness token, as the server's own gate lets it (authMiddleware.ts).
    if (request.url.startsWith('/api/github/callback')) return
    // `x-test-team` signs in as that person's Harness Team account, where one is listed.
    const team = request.headers['x-test-team'] === '1'
    const user = users.find(u => `Bearer ${u.sub}` === request.headers.authorization && (u.harnessSessionKind === 'team') === team)
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
/** The team account switched on for this test, in the Swarms of [owners] or everyone's. */
function teamAccounts(owners = '') {
  vi.stubEnv('SWARM_TEAM_ACCOUNT_REQUIRED', '1')
  vi.stubEnv('SWARM_TEAM_ACCOUNT_OWNERS', owners)
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
  const assignmentId = String((await env.run(tab, { type: 'work.assign', conversationId: group, agentId: worker } as Command)).result.assignmentId)
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
    expect(data.trailers).toEqual([`Co-authored-by: Olive Owner <${owner.email}>`, `Harness-Agent: ${data.agent}`, 'Harness-Machine: Fixture Mac'])
    expect(Date.parse(data.expiresAt)).toBeGreaterThan(Date.now() + 50 * 60_000)
    const minted = env.github.calls.find(c => c.path === '/app/installations/91/access_tokens')!
    expect(minted.body).toEqual({ repositories: ['app'],
      permissions: { contents: 'write', pull_requests: 'write', checks: 'read', actions: 'read', metadata: 'read' } })
    // A person's machine keeps its owner's git identity: the app's is for a Harness Team account.
    expect(data).not.toHaveProperty('commitAs')
    // The same task gets the same token back.
    expect((await ask(env, tab, worker)).json().data.token).toBe('ghs_fixture_1')
    // The tab tells a Lead's start that this server has the app.
    const read = await env.app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/parts`, headers: { authorization: `Bearer ${owner.sub}` } })
    expect(read.json().data.githubApp).toBe(true)
  })

  // A Harness Team account has no git identity of its own (PR #1934, 2026-10-28): its commits are the app's bot account's.
  it('names the app\'s bot account as who a Harness Team account\'s commits are by', async () => {
    const env = await fresh()
    const { tab, worker } = await working(env)
    const computerId = createHash('sha256').update('gh-host').digest('hex').slice(0, 32)
    await db.machine.update({ where: { machineId: 'gh-host' }, data: { computerId, sessionKind: 'team' } })
    onTestFinished(async () => { await db.machine.update({ where: { machineId: 'gh-host' }, data: { computerId: null, sessionKind: null } }) })
    const team: AuthUser = { ...host, sub: host.sub, harnessSessionId: 'team-gh-host', harnessSessionKind: 'team', harnessComputerId: computerId }
    users.push(team)
    onTestFinished(() => { users.splice(users.indexOf(team), 1) })
    const response = await env.app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/github-token?asAgentId=${worker}`,
      headers: { authorization: `Bearer ${host.sub}`, 'x-test-team': '1' }, payload: { machineId: 'gh-host' } })
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().data.commitAs).toEqual({ name: 'harness-fixture[bot]', email: '4242+harness-fixture[bot]@users.noreply.github.com' })
    // GitHub not saying who the bot is leaves it out, and the token is still given.
    const other = await fresh()
    other.github.control.botId = null
    const second = await working(other)
    const again = await other.app.inject({ method: 'POST', url: `/api/super-tabs/${second.tab}/github-token?asAgentId=${second.worker}`,
      headers: { authorization: `Bearer ${host.sub}`, 'x-test-team': '1' }, payload: { machineId: 'gh-host' } })
    expect(again.json().data).toMatchObject({ token: expect.any(String) })
    expect(again.json().data).not.toHaveProperty('commitAs')
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

describe('a queued start\'s preparation token', () => {
  /** The host's pool rows, now each Swarm's `pool` in the host form (design 4.10), in the shape the old pools route answered. */
  const hostPools = async (env: Env) => {
    // gh-pool is a Team machine (`queued`): its host reads are its team session's.
    const response = await env.app.inject({ method: 'GET', url: '/api/super-tabs/hosts/gh-pool/changes?full=1', headers: { authorization: `Bearer ${host.sub}`, 'x-test-team': '1' } })
    const rows = (response.json().data.tabs as Array<{ pool: unknown }>).flatMap(tab => tab.pool ? [tab.pool] : [])
    return { json: () => ({ data: rows }) }
  }
  const observed = { resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9,
    projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture CPU', os: 'macOS', gpuPercent: null }, quotas: [], tools: { git: true },
    runningHarnessIds: [], stoppedHarnessIds: [] }
  /** The owner's project on github.com, with a start queued on [machineId], a machine its owner [contributor] added to the Swarm. */
  async function queued(env: Env, machineId = 'gh-pool', contributor = host, repositoryUrl: string | null = 'https://github.com/example/app.git') {
    const tab = (await env.store.create(owner, randomUUID(), 'Pool')).id
    await env.run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'Lead',
      configuration: config, lead: true, project: { cwd: '/work/app', repositoryUrl } } as Command)
    if (contributor !== owner) {
      const invitation = await env.run(tab, { type: 'invite.create', email: contributor.email, role: 'collaborator', conversationId: 'lead' } as Command)
      await env.run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string } as Command, contributor)
    }
    await env.run(tab, { type: 'machine.contribute', machineId, name: 'Pool', cwd: '/swarm-root', scope: 'swarm', engines: ['codex'], maxAgents: 2 } as Command, contributor)
    if (contributor === owner) {
      const pool = (await poolRows(env.store, contributor, machineId)).find(p => p.tabId === tab)!
      await env.store.observeMachine(contributor, tab, machineId, { generation: pool.machine.generation, ...observed })
    } else {
      // Another person's project runs only on a Team machine (#1694): this one is used only for agents (`harness team on`).
      const computerId = createHash('sha256').update(machineId).digest('hex').slice(0, 32)
      await db.machine.update({ where: { machineId }, data: { computerId, sessionKind: 'team' } })
      onTestFinished(async () => { await db.machine.update({ where: { machineId }, data: { computerId: null, sessionKind: null } }) })
      const team: AuthUser = { ...contributor, harnessSessionId: `team-${machineId}`, harnessSessionKind: 'team', harnessComputerId: computerId }
      // Its host routes take its team session alone (security review 2 of #2089): `prepare` signs in as it.
      if (!users.some(u => u.sub === team.sub && u.harnessSessionKind === 'team')) {
        users.push(team)
        onTestFinished(() => { users.splice(users.indexOf(team), 1) })
      }
      const pool = (await poolRows(env.store, team, machineId)).find(p => p.tabId === tab)!
      await env.store.observeMachine(team, tab, machineId, { generation: pool.machine.generation, ...observed, privacy: { mode: 'dedicated' } })
    }
    const startId = String((await env.run(tab, { type: 'agent.start', request: { conversationId: 'lead', machineId, engine: 'codex', name: 'Builder',
      cwd: '/swarm-root/lead', permissionMode: 'full', worktree: true, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } } as Command)).result.startId)
    return { tab, startId }
  }
  /** As [user]'s Harness Team account by default on `gh-pool`, the Team machine `queued` makes for another person's start. */
  const prepare = (env: Env, tab: string, startId: string, machineId = 'gh-pool', user = host, payload: Record<string, unknown> = {},
    team = user === host && machineId === 'gh-pool') => env.app.inject({ method: 'POST',
    url: `/api/super-tabs/hosts/${machineId}/starts/${tab}/${startId}/github-token`, headers: { authorization: `Bearer ${user.sub}`, ...(team ? { 'x-test-team': '1' } : {}) }, payload })

  it('gives the host of another person\'s start a token that only reads the project\'s repository, and says whom the work is for', async () => {
    const env = await fresh()
    const { tab, startId } = await queued(env)
    const pools = await hostPools(env)
    expect(pools.json().data.find((row: { tabId: string }) => row.tabId === tab)).toMatchObject({ githubApp: true })
    const response = await prepare(env, tab, startId)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().data).toMatchObject({ github: true, token: 'ghs_fixture_1', repository: 'example/app', requestedBy: { name: 'Olive Owner', email: owner.email } })
    const minted = env.github.calls.find(c => c.path === '/app/installations/91/access_tokens')!
    expect(minted.body).toEqual({ repositories: ['app'], permissions: { contents: 'read', metadata: 'read' } })
  })

  it('gives no token for a repository nobody who can push to it approved for the project', async () => {
    teamAccounts()
    const env = await fresh({ approveAll: false })
    const { tab, startId } = await queued(env)
    const status = await env.app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/projects/lead/github`, headers: { authorization: `Bearer ${owner.sub}` } })
    expect(status.json().data).toMatchObject({ state: 'not-approved', repository: 'example/app' })
    const response = await prepare(env, tab, startId)
    expect(response.statusCode).toBe(403)
    expect(response.json().error).toMatchObject({ code: 'GITHUB_REPOSITORY_NOT_APPROVED' })
    expect(env.github.calls.some(c => c.path.endsWith('/access_tokens'))).toBe(false)
  })

  // Rolled out with the team account (machines.ts teamAccountRequired), so a bug in it cannot stop anyone else's Swarm.
  it('asks no approval in a Swarm the team account is not tried in, or with the switch off', async () => {
    teamAccounts('someone@example.com')
    const env = await fresh({ approveAll: false })
    const { tab, startId } = await queued(env)
    const status = await env.app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/projects/lead/github`, headers: { authorization: `Bearer ${owner.sub}` } })
    expect(status.json().data).toMatchObject({ state: 'covered', repository: 'example/app' })
    expect((await prepare(env, tab, startId)).json().data).toMatchObject({ github: true, token: 'ghs_fixture_1' })
    vi.unstubAllEnvs()
    const off = await queued(env)
    expect((await prepare(env, off.tab, off.startId)).json().data).toMatchObject({ github: true })
  })

  it('approves a repository through the app\'s sign-in, for someone who can push to it, and gives the token after', async () => {
    let push = true
    const signIn = { authorizeUrl: (state: string) => `https://github.test/login/oauth/authorize?state=${state}`,
      permission: async () => ({ login: 'olive', push }) } as unknown as GitHubSignIn
    teamAccounts()
    const env = await fresh({ approveAll: false, signIn })
    const { tab, startId } = await queued(env)
    expect((await prepare(env, tab, startId)).statusCode).toBe(403)
    const asked = await env.app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/projects/lead/github/approve`,
      headers: { authorization: `Bearer ${owner.sub}` }, payload: { scope: 'project' } })
    expect(asked.statusCode, asked.body).toBe(200)
    const { authorizeUrl, installUrl } = asked.json().data as { authorizeUrl: string; installUrl: string }
    expect(installUrl).toMatch(/\/installations\/new\?state=/)
    const state = new URL(authorizeUrl).searchParams.get('state')!
    // The state is signed, not sealed, and goes to GitHub in the address: ids and the repository only, never the project's
    // name (privacy review of #1980).
    const carried = JSON.parse(Buffer.from(state.split('.')[0]!, 'base64url').toString())
    expect(Object.keys(carried).sort()).toEqual(['autonomousEnv', 'exp', 'projectId', 'repository', 'scope', 'tabId', 'userId'])
    expect(decodeURIComponent(authorizeUrl + installUrl)).not.toContain('Pool')
    // Someone who cannot push is told so, and nothing is approved.
    push = false
    const refused = await env.app.inject({ method: 'GET', url: `/api/github/callback?code=c&state=${encodeURIComponent(state)}` })
    expect(refused.statusCode).toBe(403)
    expect(refused.body).toContain('can&#39;t push to example/app')
    // The app then knows GitHub said so, and asks them to send it on (design 2026-10-30).
    const after = await env.app.inject({ method: 'GET', url: `/api/super-tabs/${tab}/projects/lead/github`, headers: { authorization: `Bearer ${owner.sub}` } })
    expect(after.json().data).toMatchObject({ state: 'not-approved', you: { canPush: false, githubLogin: 'olive' } })
    push = true
    const done = await env.app.inject({ method: 'GET', url: `/api/github/callback?code=c&state=${encodeURIComponent(state)}` })
    expect(done.statusCode).toBe(200)
    expect(done.body).toContain('example/app is allowed')
    // The page names the project it was approved for (local Team account run, 2026-10-28: 'This project can now use it').
    expect(done.body).toContain('Teammates&#39; agents in Pool can now push to it.')
    expect(env.approved).toEqual([expect.objectContaining({ tabId: tab, projectId: 'lead', repository: 'example/app', scope: 'project', login: 'olive' })])
    expect((await prepare(env, tab, startId)).statusCode).toBe(200)
    // A forged or missing state, or an installation without a sign-in, approves nothing.
    expect((await env.app.inject({ method: 'GET', url: '/api/github/callback?code=c&state=forged.state' })).statusCode).toBe(400)
    const installed = await env.app.inject({ method: 'GET', url: `/api/github/callback?installation_id=9&setup_action=install&state=${encodeURIComponent(state)}` })
    expect(installed.body).toContain('Harness is installed')
    expect(env.approved).toHaveLength(1)
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

  // Security re-check of #1976: a task lost to a usage limit keeps its id when it resumes, and its loss marked it ended,
  // so after resuming it was refused GitHub tokens for 70 minutes.
  it('gives a task resumed after a usage limit a fresh token, while the one from before the loss stays revoked', async () => {
    const env = await fresh()
    const { tab, group, worker, assignmentId } = await working(env)
    const before = await ask(env, tab, worker)
    expect(before.statusCode, before.body).toBe(200)
    const resetAt = new Date(Date.now() + 1500).toISOString()
    await env.run(tab, { type: 'agent.alert', agentId: worker, alert: 'limit', active: true, resetAt } as Command, host, worker)
    await env.settled()
    expect(env.github.revoked).toContain(before.json().data.token)
    const lostAt = (await env.store.read(owner, tab)).state.conversations.find(c => c.id === group)!.assignment!.lost!.at
    await new Promise(done => setTimeout(done, Date.parse(resetAt) - Date.now() + 50))
    await env.run(tab, { type: 'work.resume', conversationId: group, assignmentId, lostAt } as Command, host, worker)
    await env.settled()
    const after = await ask(env, tab, worker)
    expect(after.statusCode, after.body).toBe(200)
    expect(after.json().data.token).not.toBe(before.json().data.token)
    expect(env.github.issued.has(before.json().data.token)).toBe(false)
  })

  it('says when the server cannot approve, and refuses a project not on GitHub', async () => {
    const env = await fresh({ approveAll: false })
    const { tab } = await queued(env)
    const none = await env.app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/projects/lead/github/approve`,
      headers: { authorization: `Bearer ${owner.sub}` }, payload: { scope: 'swarm' } })
    expect(none.json().error).toMatchObject({ code: 'GITHUB_APPROVAL_NOT_CONFIGURED' })
  })

  it('answers no token for the machine owner\'s own project, unless its host asks for one anyway', async () => {
    const env = await fresh()
    const { tab, startId } = await queued(env, 'owner-pool', owner)
    expect((await prepare(env, tab, startId, 'owner-pool', owner)).json().data).toEqual({ github: false })
    expect(env.github.calls).toEqual([])
    expect((await prepare(env, tab, startId, 'owner-pool', owner, { always: true })).json().data).toMatchObject({ github: true, token: 'ghs_fixture_1' })
  })

  it('refuses anyone but the start\'s host, a start that already started, and a project without a GitHub repository', async () => {
    const env = await fresh()
    const { tab, startId } = await queued(env)
    expect((await prepare(env, tab, startId, 'gh-pool', owner)).statusCode).toBe(403)
    expect((await prepare(env, tab, startId, 'gh-host-mini')).statusCode).toBe(403)
    expect((await prepare(env, tab, 'missing-start')).statusCode).toBe(404)
    expect((await prepare(env, tab, startId, 'gh-pool', host, { machineId: 'gh-pool' })).statusCode).toBe(400)
    // gh-pool is a Team machine (`queued`): its team session hosts it.
    const team = users.find(u => u.sub === host.sub && u.harnessSessionKind === 'team')!
    const hostRun = (command: Command) => env.store.execute(team, tab, { operationId: randomUUID(), command }, undefined, 'gh-pool')
    await hostRun({ type: 'agent.startDispatch', startId } as Command)
    await hostRun({ type: 'agent.started', startId, harnessId: randomUUID(), configuration: config } as Command)
    const settled = await prepare(env, tab, startId)
    expect(settled.statusCode).toBe(409)
    expect(settled.json().error.code).toBe('START_SETTLED')
    const bare = await fresh()
    const none = await queued(bare, 'gh-pool', host, null)
    expect((await prepare(bare, none.tab, none.startId)).json().error.code).toBe('REPOSITORY_NOT_GITHUB')
    expect([...env.github.calls, ...bare.github.calls].filter(c => c.path.endsWith('/access_tokens'))).toEqual([])
  })

  it('answers not configured when the server has no app, and its host rows do not claim one', async () => {
    const env = await fresh({ github: false })
    const { tab, startId } = await queued(env)
    const response = await prepare(env, tab, startId)
    expect(response.statusCode).toBe(503)
    expect(response.json().error.code).toBe('GITHUB_APP_NOT_CONFIGURED')
    const pools = await hostPools(env)
    expect(pools.json().data.find((row: { tabId: string }) => row.tabId === tab)).not.toHaveProperty('githubApp')
  })
})

describe('revoking the token when the task ends', () => {
  const issued = async (env: Env) => {
    const work = await working(env)
    const token = (await ask(env, work.tab, work.worker)).json().data.token as string
    return { ...work, token }
  }

  it('revokes on done', async () => {
    const env = await fresh()
    const { tab, group, worker, assignmentId, token } = await issued(env)
    const checkId = (await env.store.read(owner, tab)).state.conversations.find(c => c.id === group)!.checks[0]!.id
    await env.run(tab, { type: 'work.check', conversationId: group, assignmentId, checkId, passed: true, evidence: 'npm test passed' } as Command, host, worker)
    await env.run(tab, { type: 'work.status', conversationId: group, assignmentId, status: 'review', result: 'Ready' } as Command, host, worker)
    await env.settled()
    // Out for review is still the Builder's task.
    expect(env.github.revoked).toEqual([])
    await env.run(tab, { type: 'work.status', conversationId: group, assignmentId, status: 'done', result: 'Merged' } as Command, host, worker)
    await env.settled()
    expect(env.github.revoked).toEqual([token])
    expect((await ask(env, tab, worker)).json().error.code).toBe('NO_ASSIGNMENT')
  })

  it('revokes on cancel, and a reassigned task gets a new token', async () => {
    const env = await fresh()
    const { tab, group, worker, assignmentId, token } = await issued(env)
    await env.run(tab, { type: 'work.cancel', conversationId: group, assignmentId, reason: 'Not needed' } as Command)
    await env.settled()
    expect(env.github.revoked).toEqual([token])
    await env.run(tab, { type: 'agent.release', agentId: worker, decision: 'keep' } as Command).catch(() => undefined)
    await env.run(tab, { type: 'work.assign', conversationId: group, agentId: worker } as Command)
    const again = (await ask(env, tab, worker)).json().data.token
    expect(again).not.toBe(token)
  })

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
    await env.run(tab, { type: 'work.cancel', conversationId: group, assignmentId, reason: 'Not needed' } as Command)
    await env.settled()
    expect((await env.store.read(owner, tab)).state.conversations.find(c => c.id === group)!.assignment!.status).toBe('cancelled')
    expect(env.github.revoked).toEqual([])
    expect(env.log.warn).toHaveBeenCalledWith('[github] token revoke failed', expect.objectContaining({ tabId: tab, repository: 'example/app', why: 'task ended' }))
    expect(JSON.stringify(env.log.warn.mock.calls)).not.toContain(token)
  })
})

// Scholes's goals, piece 5: the route holds work that starts heavy CI while the account is at its limit of running jobs.
describe('the CI load', () => {
  const load = (env: Env, tab: string, projectId: string, user = owner, asAgentId?: string) => env.app.inject({ method: 'GET',
    url: `/api/super-tabs/${tab}/projects/${projectId}/ci-load${asAgentId ? `?asAgentId=${asAgentId}` : ''}`, headers: { authorization: `Bearer ${user.sub}` } })
  /** An agent of the project on the owner's own Mac, which the owner's sign-in speaks for. */
  const own = async (env: Env, tab: string, group: string) => String((await env.run(tab, { type: 'agent.add', conversationId: group, machineId: 'owner-mac',
    harnessId: randomUUID(), name: 'Router', configuration: config, lead: false } as Command)).result.agentId)
  const busy = (env: Env) => env.github.actions.set('example/app', [
    { id: 11, status: 'in_progress', jobs: [{ status: 'in_progress', labels: ['ubuntu-latest'] }, { status: 'in_progress', labels: ['macos-15'] }] },
    { id: 12, status: 'queued', jobs: [{ status: 'queued', labels: ['macos-15'] }] }])

  it('gives an agent of the project, and a person, the counts alone, read with a token that only reads runs and is revoked', async () => {
    const env = await fresh()
    busy(env)
    const { tab, group } = await working(env)
    const agent = await load(env, tab, 'lead', owner, await own(env, tab, group))
    expect(agent.statusCode).toBe(200)
    expect(agent.json().data).toEqual({ state: 'read', load: { running: 2, queued: 1, macosRunning: 1, macosQueued: 1 } })
    // No run's name, branch or the token reaches the answer.
    for (const text of ['secret-branch', 'run 11', 'ghs_', 'example/app']) expect(agent.body).not.toContain(text)
    expect(env.github.calls.find(c => c.path.endsWith('/access_tokens'))!.body).toEqual({ repositories: ['app'], permissions: { actions: 'read', metadata: 'read' } })
    expect(env.github.issued.size).toBe(0)
    expect((await load(env, tab, 'lead')).json().data).toMatchObject({ state: 'read' })
  })
  it('refuses another project, one the reader cannot see, and an unknown one alike, naming none and reading nothing', async () => {
    const env = await fresh()
    busy(env)
    const { tab, group, worker } = await working(env)
    const router = await own(env, tab, group)
    const secret = String((await env.run(tab, { type: 'project.create', name: 'Secret Plans', visibility: 'private', brief: '' } as Command)).result.projectId)
    // The Lead's project's agent may not read the private project, which it cannot see: refused as a project that is not there.
    const refusals = [await load(env, tab, secret, owner, router), await load(env, tab, 'nope', owner, router)]
    for (const r of refusals) {
      expect(r.statusCode).toBe(404)
      expect(r.body).not.toContain('Secret Plans')
    }
    expect(refusals[0]!.json().error).toEqual(refusals[1]!.json().error)
    // A person outside the Swarm reads nothing of it; as the host of an agent of the project, it reads what that agent may.
    const outsider = await load(env, tab, 'lead', host)
    expect(outsider.statusCode).toBe(403)
    expect(outsider.body).not.toContain('running')
    expect((await load(env, tab, secret, host, worker)).statusCode).toBe(404)
    expect((await load(env, tab, 'lead', host, worker)).json().data).toMatchObject({ state: 'read' })
  })
  it('reads nothing for a repository not approved for the project, and says when the server has no app', async () => {
    teamAccounts()
    const env = await fresh({ approveAll: false })
    busy(env)
    const { tab } = await working(env)
    expect((await load(env, tab, 'lead')).json().data).toEqual({ state: 'not-approved' })
    expect(env.github.calls.some(c => c.path.endsWith('/access_tokens'))).toBe(false)
    vi.unstubAllEnvs()
    const off = await fresh({ github: false })
    const other = await working(off)
    expect((await load(off, other.tab, 'lead')).json().data).toEqual({ state: 'unavailable' })
  })
})
