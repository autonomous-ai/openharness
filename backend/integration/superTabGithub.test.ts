import { randomBytes, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import Fastify, { type FastifyInstance } from 'fastify'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import type { Command } from '../src/superTabs/commands.js'
import { GitHubTokens, MemoryTokenCache } from '../src/github/tokens.js'
import { fakeApp, fakeGitHub, throwawayKey } from '../src/github/fakeGitHub.js'

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
  for (const [machineId, userId, name] of [['gh-host', host.sub, 'Fixture Mac'], ['gh-host-mini', host.sub, 'Fixture Mini'], ['owner-mac', owner.sub, 'Owner Mac']]) {
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
async function fresh(options: { github?: boolean } = {}) {
  const github = fakeGitHub({ publicKey: key.publicKey, appId: '424242' })
  github.installed.set('example/app', 91)
  const log = { warn: vi.fn() }
  const tokens = new GitHubTokens(fakeApp(key.privateKey, github), new MemoryTokenCache(), { log, secret: randomBytes(32) })
  const releases: Promise<void>[] = []
  const store = new SuperTabStore(db, Date.now, null, { workEnded: (tab, ended) => { releases.push(tokens.release(tab, ended)) } })
  const app: FastifyInstance = Fastify()
  app.setErrorHandler(errorHandler)
  app.addHook('onRequest', async (request, reply) => {
    const user = users.find(u => `Bearer ${u.sub}` === request.headers.authorization)
    if (!user) return reply.code(401).send({ success: false })
    request.user = user
  })
  await app.register(superTabRoutes, { store, github: options.github === false ? null : tokens })
  await app.ready()
  const run = (tab: string, command: Command, user = owner, asAgentId?: string) =>
    store.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const settled = async () => { await Promise.all(releases.splice(0)) }
  return { github, log, tokens, store, app, run, settled }
}

type Env = Awaited<ReturnType<typeof fresh>>
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
    // The same task gets the same token back.
    expect((await ask(env, tab, worker)).json().data.token).toBe('ghs_fixture_1')
    // The tab tells a Lead's start that this server has the app.
    const read = await env.app.inject({ method: 'GET', url: `/api/super-tabs/${tab}`, headers: { authorization: `Bearer ${owner.sub}` } })
    expect(read.json().data.githubApp).toBe(true)
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
    const read = await env.app.inject({ method: 'GET', url: `/api/super-tabs/${tab}`, headers: { authorization: `Bearer ${owner.sub}` } })
    expect(read.json().data).not.toHaveProperty('githubApp')
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
