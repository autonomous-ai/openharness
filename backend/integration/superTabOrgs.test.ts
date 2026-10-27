import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import Fastify, { type FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import type { Command } from '../src/superTabs/commands.js'

// Teams above Swarms (docs/plans/2026-10-27-swarm-teams.md): every route, authorization and Mongo transaction is real.
let replica: MongoMemoryReplSet, db: PrismaClient, store: SuperTabStore, app: FastifyInstance

const user = (n: number, email: string): AuthUser => ({ sub: `30000000000000000000000${n}`, email, autonomousEnv: 'prod', role: 'user' })
const owner = user(1, 'owner@example.com'), peer = user(2, 'peer@example.com'), other = user(3, 'other@elsewhere.test'),
  admin = user(4, 'admin@example.com'), member = user(5, 'member@example.com')
const accounts = [owner, peer, other, admin, member]
const call = (method: 'GET' | 'POST' | 'DELETE', url: string, as: AuthUser, body?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${as.sub}` }, ...(body ? { payload: body } : {}) })
const run = async (tab: string, command: Command, as = owner) => {
  const reply = await call('POST', `/api/super-tabs/${tab}/commands`, as, { operationId: randomUUID(), command })
  if (reply.statusCode !== 200) throw new Error(`${command.type}: ${reply.statusCode} ${reply.body}`)
  return reply.json().data as { result: Record<string, unknown> }
}
const create = async (as = owner, name = 'Fixture Swarm', orgId?: string) => {
  const reply = await call('POST', '/api/super-tabs', as, { operationId: randomUUID(), name, ...(orgId ? { orgId } : {}) })
  if (reply.statusCode !== 200) throw new Error(`create: ${reply.statusCode} ${reply.body}`)
  return reply.json().data.id as string
}
const orgsOf = async (as: AuthUser) => (await call('GET', '/api/super-tabs/orgs', as)).json().data.orgs as
  Array<{ id: string; name: string; role: string; swarms: Array<{ id: string; name: string }> }>
const listed = async (as: AuthUser) => ((await call('GET', '/api/super-tabs/list', as)).json().data.tabs as Array<{ id: string; orgId: string | null }>)
/** Adds `who` to the Swarm the way an owner does today: an invitation, accepted. */
const invite = async (tab: string, who: AuthUser) => {
  const invitation = await run(tab, { type: 'invite.create', email: who.email, role: 'collaborator', conversationId: 'lead' } as Command)
  await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string } as Command, who)
}

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_orgs_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  store = new SuperTabStore(db)
  for (const account of accounts) await db.user.create({ data: { id: account.sub, externalId: `orgs-fixture-${account.sub}`,
    email: account.email, autonomousEnv: account.autonomousEnv } })
  app = Fastify()
  app.setErrorHandler(errorHandler)
  app.addHook('onRequest', async (req, reply) => {
    const account = accounts.find(a => `Bearer ${a.sub}` === req.headers.authorization)
    if (!account) return reply.code(401).send({ success: false })
    req.user = account
  })
  await app.register(superTabRoutes, { store })
  await app.ready()
})
afterAll(async () => { await app?.close(); await db?.$disconnect(); await replica?.stop() })

describe('a new Swarm lands in a Team', () => {
  it('puts a person\'s Swarms in their own Team, made on first need, and lists it with its Swarms', async () => {
    const first = await create(other, 'Lamp OS'), second = await create(other, 'Second')
    const orgs = await orgsOf(other)
    expect(orgs).toHaveLength(1)
    expect(orgs[0]).toMatchObject({ name: 'Lamp OS', role: 'owner' })
    expect(orgs[0]!.swarms.map(s => s.id).sort()).toEqual([first, second].sort())
    const rows = await listed(other)
    expect(rows.filter(r => r.id === first || r.id === second).map(r => r.orgId)).toEqual([orgs[0]!.id, orgs[0]!.id])
  })
})

describe('the Team check on every Swarm read and command', () => {
  it('refuses a person whose Team membership was removed on every read path and command, before their Swarm removal runs', async () => {
    const tab = await create(owner, 'Checked')
    await invite(tab, peer)
    const cursor = (await call('GET', `/api/super-tabs/${tab}/parts`, peer)).json().data.cursor as string
    const reads = [`/api/super-tabs/${tab}/parts`, `/api/super-tabs/${tab}/changes?cursor=${encodeURIComponent(cursor)}`, `/api/super-tabs/${tab}/groups?dormant=1`,
      `/api/super-tabs/${tab}/groups/lead`, `/api/super-tabs/${tab}/conversations/lead/messages`, `/api/super-tabs/${tab}/mentions?state=waiting`,
      `/api/super-tabs/${tab}/decisions?state=open`, `/api/super-tabs/${tab}/route-decisions`, `/api/super-tabs/${tab}/leaderboard?projectId=lead`,
      `/api/super-tabs/${tab}/routing-policy`, `/api/super-tabs/${tab}/conversations/lead/attempts`]
    for (const url of reads) expect((await call('GET', url, peer)).statusCode, url).toBe(200)
    expect((await listed(peer)).map(r => r.id)).toContain(tab)

    // As a removal whose Swarm cleanup has not run yet leaves it: the person is still in the Swarm's people.
    const [org] = await orgsOf(owner)
    await db.swarmOrgMember.update({ where: { id: `${org!.id}:${peer.sub}` }, data: { removedAt: new Date(), removedBy: owner.sub } })

    for (const url of reads) {
      const reply = await call('GET', url, peer)
      expect(reply.statusCode, url).toBe(403)
      expect(JSON.stringify(reply.json()), url).toContain('ORG_ACCESS_REVOKED')
    }
    const send = await call('POST', `/api/super-tabs/${tab}/commands`, peer,
      { operationId: randomUUID(), command: { type: 'message.send', conversationId: 'lead', text: 'still here?', replyTo: null, recipientIds: [] } })
    expect(send.statusCode).toBe(403)
    expect((await listed(peer)).map(r => r.id)).not.toContain(tab)
    // The Swarm's own people are untouched.
    expect((await call('GET', `/api/super-tabs/${tab}/parts`, owner)).statusCode).toBe(200)
  })

  it('keeps a person of one Team out of another Team\'s Swarm', async () => {
    const theirs = await create(other, 'Elsewhere')
    const reply = await call('GET', `/api/super-tabs/${theirs}/parts`, owner)
    expect(reply.statusCode).toBe(403)
    expect(JSON.stringify(reply.json())).not.toContain('Elsewhere')
    expect((await orgsOf(owner)).flatMap(o => o.swarms.map(s => s.id))).not.toContain(theirs)
  })
})
