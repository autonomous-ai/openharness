import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { MemoryAttachmentStore, MemoryAvatarStore } from '../src/superTabs/attachments.js'
import type { Command } from '../src/superTabs/commands.js'
import { SwarmReads } from '../src/superTabs/read/service.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import { NOT_AVAILABLE, NOT_AVAILABLE_ROUTES, superTabRoutes } from '../src/routes/superTabs.js'

// The person routes through the real store and read service (Huy, 10-30, the follow-up of #2306): a Swarm, chat, project,
// decision, file or link the caller cannot reach gets one answer, whether it is missing, refused, revoked or in another
// project. Each case is compared byte for byte, status and body, so no route can tell them apart.
let replica: MongoMemoryReplSet
let db: PrismaClient
let app: FastifyInstance
let store: SuperTabStore
const user = (n: number, name: string): AuthUser => ({ sub: `40000000000000000000000${n}`, email: `${name}@example.com`, autonomousEnv: 'prod', role: 'user' })
const owner = user(1, 'owner'), member = user(2, 'member'), outsider = user(3, 'outsider'), removed = user(4, 'removed')
const users = new Map([owner, member, outsider, removed].map(u => [u.sub, u]))

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_not_available_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const u of users.values()) await db.user.create({ data: { id: u.sub, externalId: `fixture-${u.sub}`, email: u.email, autonomousEnv: u.autonomousEnv } })
  store = new SuperTabStore(db, () => Date.now(), { store: new MemoryAttachmentStore(), prefix: 'super-tabs', publicBase: 'https://cdn.example.test',
    avatars: new MemoryAvatarStore('https://avatars.example.test') })
  app = Fastify()
  app.setErrorHandler(errorHandler)
  app.addHook('onRequest', async request => { request.user = users.get(String(request.headers['x-user'])) as never })
  await app.register(superTabRoutes, { store, reads: new SwarmReads(store), github: null, hosts: {} as never, signIn: null,
    approvals: { approved: async () => false, approvedProjects: async () => [] } as never })
  await app.ready()
})
afterAll(async () => {
  await app?.close()
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm with a member, a person who was a member and was removed, and a private project the member is not in. */
async function swarm() {
  const tab = (await store.create(owner, randomUUID(), 'Not available', 'public')).id
  const execute = (command: Command, as = owner) => store.execute(as, tab, { operationId: randomUUID(), command })
  for (const u of [member, removed]) {
    const invitation = await execute({ type: 'invite.create', email: u.email, role: 'collaborator', conversationId: 'lead' })
    await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, u)
  }
  await execute({ type: 'member.remove', userId: removed.sub })
  const project = await execute({ type: 'project.create', name: 'Private', visibility: 'private', brief: '' })
  return { tab, privateProject: String(project.result.projectId), privateChat: String(project.result.conversationId) }
}

const MISSING = 'ffffffffffffffffffffffff'
const boundary = 'not-available-boundary'
const form = (parts: string[]) => `${parts.join('')}--${boundary}--\r\n`
const field = (name: string, value: string) => `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`
const file = (name: string, type: string, body: string) =>
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: ${type}\r\n\r\n${body}\r\n`

/** One call of each person route, about Swarm `tab`, its conversation `chat` and project `project`. */
function calls(tab: string, chat: string, project: string) {
  const op = () => randomUUID()
  const json = (method: 'GET' | 'POST', route: string, url: string, payload?: object) => ({ method, route, url, payload, headers: {} })
  const multipart = (route: string, url: string, payload: string) =>
    ({ method: 'POST' as const, route, url, payload, headers: { 'content-type': `multipart/form-data; boundary=${boundary}` } })
  const t = `/api/super-tabs/${tab}`
  return [
    json('GET', 'GET /api/super-tabs/:tabId/parts', `${t}/parts`),
    json('GET', 'GET /api/super-tabs/:tabId/parts', `${t}/parts?asAgentId=${MISSING}`),
    json('GET', 'GET /api/super-tabs/:tabId/changes', `${t}/changes?cursor=abc`),
    json('GET', 'GET /api/super-tabs/:tabId/inbox', `${t}/inbox`),
    json('POST', 'POST /api/super-tabs/:tabId/commands', `${t}/commands`,
      { operationId: op(), command: { type: 'message.send', conversationId: chat, text: 'hello', replyTo: null, recipientIds: [] } }),
    json('GET', 'GET /api/super-tabs/:tabId/mentions', `${t}/mentions?state=waiting`),
    json('GET', 'GET /api/super-tabs/:tabId/decisions', `${t}/decisions?state=open`),
    json('GET', 'GET /api/super-tabs/:tabId/leaderboard', `${t}/leaderboard?projectId=${project}`),
    json('GET', 'GET /api/super-tabs/:tabId/sharing', `${t}/sharing`),
    json('POST', 'POST /api/super-tabs/:tabId/sharing', `${t}/sharing`, { operationId: op(), revision: 0, access: { mode: 'link', role: 'viewer' } }),
    json('GET', 'GET /api/super-tabs/:tabId/routing-policy', `${t}/routing-policy`),
    json('GET', 'GET /api/super-tabs/:tabId/groups', `${t}/groups?dormant=1&projectId=${project}`),
    json('GET', 'GET /api/super-tabs/:tabId/groups/:conversationId', `${t}/groups/${chat}`),
    json('POST', 'POST /api/super-tabs/:tabId/join', `${t}/join`, { operationId: op(), token: 'a'.repeat(43) }),
    json('POST', 'POST /api/super-tabs/:tabId/join/preview', `${t}/join/preview`, { token: 'a'.repeat(43) }),
    json('POST', 'POST /api/super-tabs/:tabId/native', `${t}/native`, { operationId: op(), conversationId: chat, agentId: MISSING }),
    json('GET', 'GET /api/super-tabs/:tabId/conversations/:conversationId/messages', `${t}/conversations/${chat}/messages`),
    json('GET', 'GET /api/super-tabs/:tabId/conversations/:conversationId/catch-up', `${t}/conversations/${chat}/catch-up?after=0`),
    json('POST', 'POST /api/super-tabs/:tabId/conversations/:conversationId/read', `${t}/conversations/${chat}/read`, { sequence: 1 }),
    json('GET', 'GET /api/super-tabs/:tabId/projects/:projectId/github', `${t}/projects/${project}/github`),
    json('POST', 'POST /api/super-tabs/:tabId/projects/:projectId/github/approve', `${t}/projects/${project}/github/approve`, { scope: 'project' }),
    json('GET', 'GET /api/super-tabs/:tabId/projects/:projectId/roles/:roleId', `${t}/projects/${project}/roles/${MISSING}`),
    json('GET', 'GET /api/super-tabs/:tabId/route-decisions/:decisionId', `${t}/route-decisions/${MISSING}`),
    json('GET', 'GET /api/super-tabs/:tabId/machines/:machineId/removal', `${t}/machines/${MISSING}/removal`),
    multipart('POST /api/super-tabs/:tabId/attachments', `${t}/attachments`, form([field('conversationId', chat), file('notes.txt', 'text/plain', 'hello')])),
    multipart('POST /api/super-tabs/:tabId/avatars', `${t}/avatars`, form([file('me.png', 'image/png', 'not a png')])),
    json('POST', 'POST /api/super-tabs/:tabId/workspace-visibility', `${t}/workspace-visibility`, { visibility: 'workspace' }),
    json('POST', 'POST /api/super-tabs/:tabId/workspace-join', `${t}/workspace-join`, { operationId: op() }),
    json('GET', 'GET /api/super-tabs/:tabId/costs', `${t}/costs`),
    json('GET', 'GET /api/super-tabs/:tabId/route-decisions', `${t}/route-decisions`),
    json('GET', 'GET /api/super-tabs/:tabId/starts/:startId', `${t}/starts/${MISSING}`),
    json('GET', 'GET /api/super-tabs/:tabId/conversations/:conversationId/attempts', `${t}/conversations/${chat}/attempts`),
    json('GET', 'GET /api/super-tabs/:tabId/terminal/:requestId', `${t}/terminal/${MISSING}`),
    json('GET', 'GET /api/super-tabs/:tabId/agents/:agentId/deliveries', `${t}/agents/${MISSING}/deliveries`),
    json('GET', 'GET /api/super-tabs/:tabId/agents/:agentId/deliveries/:deliveryId', `${t}/agents/${MISSING}/deliveries/${MISSING}`),
    json('POST', 'POST /api/super-tabs/:tabId/agents/:agentId/deliveries/:deliveryId', `${t}/agents/${MISSING}/deliveries/${MISSING}`,
      { type: 'claim', claimId: op() }),
  ]
}

type Call = ReturnType<typeof calls>[number]
const answer = async (call: Call, as: AuthUser) => {
  const res = await app.inject({ method: call.method, url: call.url, headers: { ...call.headers, 'x-user': as.sub },
    payload: call.payload as never })
  return { status: res.statusCode, body: res.body }
}
const NOT_AVAILABLE_BODY = JSON.stringify({ success: false, error: { code: NOT_AVAILABLE.code, message: NOT_AVAILABLE.message } })

describe('a Swarm the caller cannot reach, on every person route', () => {
  it('answers one not-available answer: a Swarm that does not exist, one never joined, one left, read with a made-up agent id too', async () => {
    const f = await swarm()
    const real = calls(f.tab, 'lead', 'lead'), missing = calls(MISSING, 'lead', 'lead')
    // Every person route is called here, so a route added to the list without a test fails.
    expect(new Set(real.map(c => c.route))).toEqual(NOT_AVAILABLE_ROUTES)
    for (const [i, call] of real.entries()) {
      const cases = { missing: await answer(missing[i]!, outsider), refused: await answer(call, outsider), revoked: await answer(call, removed) }
      // Approving needs the server's GitHub App, which this server has not: it says so to everyone, before any Swarm is read.
      const expected = call.route.endsWith('/github/approve') ? cases.missing : { status: 404, body: NOT_AVAILABLE_BODY }
      for (const [name, got] of Object.entries(cases)) expect.soft(got, `${name}: ${call.url}`).toEqual(expected)
    }
  })

  it('answers a member alike for a private project\'s chat and project as for ones that do not exist, naming neither', async () => {
    const f = await swarm()
    const hidden = calls(f.tab, f.privateChat, f.privateProject), missing = calls(f.tab, MISSING, MISSING)
    const about = /chat|project-|conversation|Private/
    // The routes that name a chat or a project; the others answer the member normally.
    const named = hidden.filter(c => c.url.includes(f.privateChat) || c.url.includes(f.privateProject)
      || JSON.stringify(c.payload ?? '').includes(f.privateChat) || String(c.payload ?? '').includes(f.privateChat))
    expect(named.map(c => c.route)).toEqual(expect.arrayContaining(['POST /api/super-tabs/:tabId/commands', 'GET /api/super-tabs/:tabId/groups/:conversationId',
      'GET /api/super-tabs/:tabId/conversations/:conversationId/messages', 'POST /api/super-tabs/:tabId/attachments',
      'GET /api/super-tabs/:tabId/projects/:projectId/github', 'GET /api/super-tabs/:tabId/leaderboard']))
    // Checked before the chat: a terminal opens for one agent (made up here), and approving needs the server's GitHub App.
    const before = ['POST /api/super-tabs/:tabId/native', 'POST /api/super-tabs/:tabId/projects/:projectId/github/approve']
    for (const call of named) {
      const got = await answer(call, member), absent = await answer(missing[hidden.indexOf(call)]!, member)
      expect(got, call.url).toEqual(absent)
      if (before.includes(call.route)) continue
      expect(got.status, call.url).toBe(404)
      expect(got.body, call.url).toBe(NOT_AVAILABLE_BODY)
      expect(JSON.parse(got.body).error.message).not.toMatch(about)
    }
  })

  it('still reads for a member, and keeps a role refusal\'s own words inside a Swarm they read', async () => {
    const f = await swarm()
    expect((await answer(calls(f.tab, 'lead', 'lead')[0]!, member)).status).toBe(200)
    // Only the owner changes sharing: the member reads this Swarm, so being told why tells them nothing new.
    const sharing = calls(f.tab, 'lead', 'lead').find(c => c.route === 'POST /api/super-tabs/:tabId/sharing')!
    const refused = await answer(sharing, member)
    expect(refused.status).toBe(403)
    expect(JSON.parse(refused.body).error.code).toBe('OWNER_REQUIRED')
  })
})
