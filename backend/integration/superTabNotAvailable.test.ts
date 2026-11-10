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
import { NOT_AVAILABLE, superTabRoutes } from '../src/routes/superTabs.js'
import { RETIRED_READS, RETIRED_WRITES } from '../src/superTabs/retired.js'

// The person routes through the real store and read service (Huy, 10-30, the follow-up of #2306): a Swarm, chat, project,
// decision, file or link the caller cannot reach gets one answer, whether it is missing, refused, revoked or in another
// project. Each case is compared byte for byte, status and body, so no route can tell them apart.
let replica: MongoMemoryReplSet
let db: PrismaClient
let app: FastifyInstance
const registeredPersonRoutes = new Set<string>()
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
  app.addHook('onRoute', route => {
    if (!/^\/api\/super-tabs\/:tabId(?:\/|$)/.test(route.url)) return
    for (const method of [route.method].flat()) if (method !== 'HEAD') registeredPersonRoutes.add(`${method} ${route.url}`)
  })
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
    json('POST', 'POST /api/super-tabs/:tabId/commands', `${t}/commands`,
      { operationId: op(), command: { type: 'message.send', conversationId: chat, text: 'hello', replyTo: null, recipientIds: [] } }),
    json('GET', 'GET /api/super-tabs/:tabId/leaderboard', `${t}/leaderboard?projectId=${project}`),
    json('GET', 'GET /api/super-tabs/:tabId/shipping', `${t}/shipping`),
    json('GET', 'GET /api/super-tabs/:tabId/machine-readings', `${t}/machine-readings`),
    json('GET', 'GET /api/super-tabs/:tabId/project-list', `${t}/project-list?invitedTo=${project}`),
    json('GET', 'GET /api/super-tabs/:tabId/sharing', `${t}/sharing`),
    json('POST', 'POST /api/super-tabs/:tabId/sharing', `${t}/sharing`, { operationId: op(), revision: 0, access: { mode: 'link', role: 'viewer' } }),
    json('GET', 'GET /api/super-tabs/:tabId/routing-policy', `${t}/routing-policy`),
    json('GET', 'GET /api/super-tabs/:tabId/groups', `${t}/groups?dormant=1&projectId=${project}`),
    json('GET', 'GET /api/super-tabs/:tabId/personal-tasks', `${t}/personal-tasks`),
    json('GET', 'GET /api/super-tabs/:tabId/groups/:conversationId', `${t}/groups/${chat}`),
    json('POST', 'POST /api/super-tabs/:tabId/join', `${t}/join`, { operationId: op(), token: 'a'.repeat(43) }),
    json('POST', 'POST /api/super-tabs/:tabId/join/preview', `${t}/join/preview`, { token: 'a'.repeat(43) }),
    json('GET', 'GET /api/super-tabs/:tabId/conversations/:conversationId/messages', `${t}/conversations/${chat}/messages`),
    json('GET', 'GET /api/super-tabs/:tabId/conversations/:conversationId/messages/:messageId/attachments/:attachmentId',
      `${t}/conversations/${chat}/messages/${MISSING}/attachments/${MISSING}`),
    json('POST', 'POST /api/super-tabs/:tabId/conversations/:conversationId/read', `${t}/conversations/${chat}/read`, { sequence: 1 }),
    json('POST', 'POST /api/super-tabs/:tabId/conversations/:conversationId/unread', `${t}/conversations/${chat}/unread`, { sequence: 1 }),
    json('POST', 'POST /api/super-tabs/:tabId/conversations/:conversationId/threads/:threadId/read', `${t}/conversations/${chat}/threads/${MISSING}/read`, { sequence: 1 }),
    json('POST', 'POST /api/super-tabs/:tabId/conversations/:conversationId/notifications', `${t}/conversations/${chat}/notifications`, { notify: 'all' }),
    json('GET', 'GET /api/super-tabs/:tabId/projects/:projectId/instructions', `${t}/projects/${project}/instructions`),
    json('GET', 'GET /api/super-tabs/:tabId/projects/:projectId/instructions/revisions', `${t}/projects/${project}/instructions/revisions`),
    json('GET', 'GET /api/super-tabs/:tabId/projects/:projectId/instructions/revisions/:revision', `${t}/projects/${project}/instructions/revisions/1`),
    json('GET', 'GET /api/super-tabs/:tabId/projects/:projectId/rules', `${t}/projects/${project}/rules`),
    json('GET', 'GET /api/super-tabs/:tabId/projects/:projectId/machine-rules', `${t}/projects/${project}/machine-rules`),
    json('POST', 'POST /api/super-tabs/:tabId/attachments/uploads', `${t}/attachments/uploads`, { conversationId: chat, name: 'notes.txt', mime: 'text/plain', size: 12_000_000 }),
    json('POST', 'POST /api/super-tabs/:tabId/attachments/uploads/:uploadId/complete', `${t}/attachments/uploads/${MISSING}/complete`, {}),
    json('POST', 'POST /api/super-tabs/:tabId/attachments/:attachmentId/voice', `${t}/attachments/${MISSING}/voice?lang=en`, {}),
    json('GET', 'GET /api/super-tabs/:tabId/projects/:projectId/github', `${t}/projects/${project}/github`),
    json('POST', 'POST /api/super-tabs/:tabId/projects/:projectId/github/approve', `${t}/projects/${project}/github/approve`, { scope: 'project' }),
    json('GET', 'GET /api/super-tabs/:tabId/github/owners/:owner', `${t}/github/owners/acme`),
    json('POST', 'POST /api/super-tabs/:tabId/projects/:projectId/github/repository', `${t}/projects/${project}/github/repository`, { owner: 'acme', name: 'notes', private: true }),
    json('GET', 'GET /api/super-tabs/:tabId/projects/:projectId/roles/:roleId', `${t}/projects/${project}/roles/${MISSING}`),
    json('GET', 'GET /api/super-tabs/:tabId/projects/:projectId/ci-load', `${t}/projects/${project}/ci-load`),
    // A made-up agent: an outsider is answered as for any Swarm it cannot reach. Asked of the Lead's project, so a member's
    // in-Swarm refusal of an agent it does not run is not taken for the private project's answer.
    json('GET', 'GET /api/super-tabs/:tabId/projects/:projectId/ci-load', `${t}/projects/lead/ci-load?asAgentId=${MISSING}`),
    // Which agent wrote a GitHub comment (superTabs/githubComments.ts): a made-up agent records nothing, and a reader of no project
    // of the repository reads nothing.
    json('POST', 'POST /api/super-tabs/:tabId/github-comments', `${t}/github-comments?asAgentId=${MISSING}`, { repository: 'acme/app', kind: 'issue', commentId: '1' }),
    json('GET', 'GET /api/super-tabs/:tabId/github-comments', `${t}/github-comments?repository=acme/app&ids=issue:1`),
    json('GET', 'GET /api/super-tabs/:tabId/route-decisions/:decisionId', `${t}/route-decisions/${MISSING}`),
    json('GET', 'GET /api/super-tabs/:tabId/machines/:machineId/removal', `${t}/machines/${MISSING}/removal`),
    json('GET', 'GET /api/super-tabs/:tabId/machines/:machineId/removal/v2', `${t}/machines/${MISSING}/removal/v2`),
    multipart('POST /api/super-tabs/:tabId/attachments', `${t}/attachments`, form([field('conversationId', chat), file('notes.txt', 'text/plain', 'hello')])),
    json('GET', 'GET /api/super-tabs/:tabId/costs', `${t}/costs`),
    json('GET', 'GET /api/super-tabs/:tabId/route-decisions', `${t}/route-decisions`),
    json('GET', 'GET /api/super-tabs/:tabId/starts/:startId', `${t}/starts/${MISSING}`),
    json('GET', 'GET /api/super-tabs/:tabId/conversations/:conversationId/attempts', `${t}/conversations/${chat}/attempts`),
    json('GET', 'GET /api/super-tabs/:tabId/terminal/:requestId', `${t}/terminal/${MISSING}`),
    json('GET', 'GET /api/super-tabs/:tabId/agents/:agentId/deliveries', `${t}/agents/${MISSING}/deliveries`),
    json('GET', 'GET /api/super-tabs/:tabId/agents/:agentId/deliveries/:deliveryId', `${t}/agents/${MISSING}/deliveries/${MISSING}`),
    json('POST', 'POST /api/super-tabs/:tabId/agents/:agentId/deliveries/:deliveryId', `${t}/agents/${MISSING}/deliveries/${MISSING}`,
      { type: 'claim', claimId: op() }),
    json('POST', 'POST /api/super-tabs/:tabId/github-token', `${t}/github-token`, { machineId: MISSING }),
    json('POST', 'POST /api/super-tabs/:tabId/machines/:machineId', `${t}/machines/${MISSING}`, { generation: 'g1',
      resources: { cpuPercent: 1, memoryTotalBytes: 1e9, memoryUsedBytes: 1e8, diskFreeBytes: 1e9, diskTotalBytes: 2e9, projectDiskFreeBytes: 1e9,
        deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
      quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [] }),
    json('POST', 'POST /api/super-tabs/:tabId/stopped', `${t}/stopped`, { assignmentId: MISSING, receipt: 'stopped' }),
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
    // Compare against actual registration, so adding a route requires a real refusal test.
    // The retired full-state read always asks every client to update, the retired reads and their writes answer none (retired.ts), the
    // retired terminal recording answers ok and ignored and the retired picture upload refuses in words, each without reading a Swarm:
    // they are tried alike for everyone in the tests below (and the upload's in superTabProfile.test.ts).
    expect(new Set([...real.map(c => c.route), 'GET /api/super-tabs/:tabId', ...Object.keys(RETIRED_READS).map(url => `GET ${url}`),
      ...Object.keys(RETIRED_WRITES).map(url => `POST ${url}`), 'POST /api/super-tabs/:tabId/conversations/:conversationId/messages/:messageId/reminder',
      'GET /api/super-tabs/:tabId/conversations/:conversationId/catch-up',
      'POST /api/super-tabs/:tabId/native',
      'GET /api/super-tabs/:tabId/native/:contextId', 'POST /api/super-tabs/:tabId/native/:contextId', 'POST /api/super-tabs/:tabId/avatars'])).toEqual(registeredPersonRoutes)
    for (const [i, call] of real.entries()) {
      const cases = { missing: await answer(missing[i]!, outsider), refused: await answer(call, outsider), revoked: await answer(call, removed) }
      // Approving needs the server's GitHub App, which this server has not: it says so to everyone, before any Swarm is read.
      // So does a GitHub token, which needs the same app.
      const expected = /\/github\/approve$|\/github\/repository$|\/github-token$/.test(call.route) ? cases.missing : { status: 404, body: NOT_AVAILABLE_BODY }
      for (const [name, got] of Object.entries(cases)) expect.soft(got, `${name}: ${call.url}`).toEqual(expected)
    }
  })

  it('answers a deleted Swarm alike on every route, to its owner and members too, for its chats and private project', async () => {
    const f = await swarm()
    const execute = (command: Command, as = owner) => store.execute(as, f.tab, { operationId: randomUUID(), command })
    await execute({ type: 'swarm.delete', name: 'Not available' })
    const missing = calls(MISSING, 'lead', 'lead')
    for (const [chat, project] of [['lead', 'lead'], [f.privateChat, f.privateProject]] as const) {
      for (const [i, call] of calls(f.tab, chat, project).entries()) {
        const cases = { owner: await answer(call, owner), member: await answer(call, member), outsider: await answer(call, outsider), missing: await answer(missing[i]!, owner) }
        const expected = /\/github\/approve$|\/github\/repository$|\/github-token$/.test(call.route) ? cases.missing : { status: 404, body: NOT_AVAILABLE_BODY }
        for (const [name, got] of Object.entries(cases)) expect.soft(got, `${name}: ${call.url}`).toEqual(expected)
      }
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
    // Checked before the chat: approving needs the server's GitHub App.
    const before = ['POST /api/super-tabs/:tabId/projects/:projectId/github/approve', 'POST /api/super-tabs/:tabId/projects/:projectId/github/repository']
    for (const call of named) {
      const got = await answer(call, member), absent = await answer(missing[hidden.indexOf(call)]!, member)
      expect(got, call.url).toEqual(absent)
      if (before.includes(call.route)) continue
      // The project to pick first is only a hint (task #4540): the member's own list, alike for a private project and a missing one.
      if (call.route === 'GET /api/super-tabs/:tabId/project-list') {
        expect(got.status, call.url).toBe(200)
        expect(got.body, call.url).not.toContain(f.privateProject)
        continue
      }
      expect(got.status, call.url).toBe(404)
      expect(got.body, call.url).toBe(NOT_AVAILABLE_BODY)
      expect(JSON.parse(got.body).error.message).not.toMatch(about)
    }
  })

  it('asks every legacy full-state reader to update without revealing whether the Swarm exists', async () => {
    const f = await swarm()
    for (const as of [owner, member, outsider, removed]) {
      const real = await app.inject({ url: `/api/super-tabs/${f.tab}`, headers: { 'x-user': as.sub } })
      const missing = await app.inject({ url: `/api/super-tabs/${MISSING}`, headers: { 'x-user': as.sub } })
      expect(real.statusCode).toBe(426)
      expect(real.json().error.code).toBe('UPDATE_REQUIRED')
      expect({ status: real.statusCode, body: real.body }).toEqual({ status: missing.statusCode, body: missing.body })
    }
  })

  // The scorecard is gone with Swarm v4: an older Desktop's Scorecard tab still reads it, and gets no days, whoever asks and
  // whatever Swarm or project it names, even one that is missing, so the answer says nothing of any of them.
  it('answers the retired scorecard read with no days, alike to everyone, naming nothing of the Swarm', async () => {
    const f = await swarm()
    const read = (tab: string, project: string, as: AuthUser) => app.inject({ url: `/api/super-tabs/${tab}/scorecard?projectId=${project}&scope=all`, headers: { 'x-user': as.sub } })
    for (const as of [owner, member, outsider, removed]) {
      for (const [tab, project] of [[f.tab, 'lead'], [f.tab, f.privateProject], [MISSING, 'lead']] as const) {
        const res = await read(tab, project, as)
        expect({ status: res.statusCode, body: res.body }, `${as.email} ${tab} ${project}`).toEqual({ status: 200, body: JSON.stringify({ success: true, data: { days: [] } }) })
      }
    }
  })

  // Decisions, tags, Activity, reminders, followed threads, the inbox, catch-up and proposals are gone with Swarm v4: an older Desktop, phone or
  // host still reads and marks them, and gets the same answer whoever asks and whatever Swarm it names, even a missing one, so the
  // answer says nothing of any of them.
  it('answers the retired reads and writes alike to everyone, naming nothing of the Swarm', async () => {
    const f = await swarm()
    const url = (path: string, tab: string) => path.replace(':tabId', tab).replace(':conversationId', 'lead').replace(':threadId', MISSING).replace(':messageId', MISSING)
    for (const as of [owner, member, outsider, removed]) {
      for (const tab of [f.tab, MISSING]) {
        for (const [path, data] of Object.entries(RETIRED_READS)) {
          const res = await app.inject({ url: url(path, tab), headers: { 'x-user': as.sub } })
          expect({ status: res.statusCode, body: res.body }, `${as.email} ${path}`).toEqual({ status: 200, body: JSON.stringify({ success: true, data }) })
        }
        for (const [path, data] of Object.entries(RETIRED_WRITES)) {
          const res = await app.inject({ method: 'POST', url: url(path, tab), headers: { 'x-user': as.sub }, payload: {} })
          expect({ status: res.statusCode, body: res.body }, `${as.email} ${path}`).toEqual({ status: 200, body: JSON.stringify({ success: true, data }) })
        }
        const caughtUp = await app.inject({ url: `/api/super-tabs/${tab}/conversations/lead/catch-up?after=7`, headers: { 'x-user': as.sub } })
        expect(caughtUp.json().data).toMatchObject({ after: 7, through: 7, unread: 0 })
        const reminder = await app.inject({ method: 'POST', url: `/api/super-tabs/${tab}/conversations/lead/messages/${MISSING}/reminder`,
          headers: { 'x-user': as.sub }, payload: { at: new Date(Date.now() + 60_000).toISOString() } })
        expect({ status: reminder.statusCode, code: reminder.json().error.code }).toEqual({ status: 410, code: 'REMINDERS_RETIRED' })
      }
    }
  })

  // Terminal recording is gone with Swarm v4: an older Desktop opens a terminal's context, and an older host reads it and records into
  // it. Each is answered ok and ignored, whoever asks and whatever Swarm it names, even a missing one, so the answer says nothing of any.
  it('answers the retired terminal recording ok and ignored, alike to everyone, naming nothing of the Swarm', async () => {
    const f = await swarm()
    const observation = { turnId: 'turn-1', kind: 'prompt', previousEventId: null, text: 'hello', truncated: false, interrupted: false }
    const ask = (as: AuthUser, tab: string, method: 'GET' | 'POST', path: string, payload?: object) =>
      app.inject({ method, url: `/api/super-tabs/${tab}/native${path}`, headers: { 'x-user': as.sub }, payload: payload as never })
    for (const as of [owner, member, outsider, removed]) {
      for (const tab of [f.tab, MISSING]) {
        const label = `${as.email} ${tab}`
        const opened = await ask(as, tab, 'POST', '', { operationId: randomUUID(), conversationId: 'lead', agentId: MISSING })
        expect({ status: opened.statusCode, body: opened.body }, label).toEqual({ status: 200, body: JSON.stringify({ success: true, data: { ok: true, ignored: true } }) })
        const read = await ask(as, tab, 'GET', `/${MISSING}`)
        expect({ status: read.statusCode, body: read.body }, label).toEqual({ status: 200, body: JSON.stringify({ success: true, data: { ok: true, ignored: true } }) })
        const recorded = await ask(as, tab, 'POST', `/${MISSING}`, observation)
        expect(recorded.statusCode, label).toBe(200)
        expect(recorded.json().data, label).toMatchObject({ ok: true, ignored: true, eventId: expect.stringMatching(/^[0-9a-f]{24}$/) })
      }
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

// Task #4540: the Cmd-N and join project list shows only the projects its reader can read, decided by the server.
describe('the project list', () => {
  it('lists a private project only to the people who read it', async () => {
    const f = await swarm()
    const list = async (as: AuthUser) => {
      const res = await app.inject({ method: 'GET', url: `/api/super-tabs/${f.tab}/project-list?invitedTo=${f.privateProject}`, headers: { 'x-user': as.sub } })
      expect(res.statusCode).toBe(200)
      return JSON.parse(res.body).data as { projects: Array<{ id: string }>; pick: string | null }
    }
    const mine = await list(owner), theirs = await list(member)
    expect(mine.pick).toBe(f.privateProject)
    expect(theirs.projects.map(p => p.id)).toEqual(['lead'])
    expect(theirs.pick).toBe('lead')
    expect(JSON.stringify(theirs)).not.toContain(f.privateProject)
  })
})
