import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import Fastify, { type FastifyInstance } from 'fastify'
import { PrismaClient } from '@prisma/client'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { NOT_AVAILABLE, superTabRoutes } from '../src/routes/superTabs.js'
import { errorHandler } from '../src/middlewares/errorHandler.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import type { Command } from '../src/superTabs/commands.js'
import { migrateWorkspaces, rollbackWorkspaces } from '../src/superTabs/migration/workspaces.js'
import { hasWorkspaceAccess, SwarmWorkspaces } from '../src/superTabs/workspaceStore.js'

// Workspaces above Swarms (docs/plans/2026-10-27-swarm-workspaces.md): every route, authorization and Mongo transaction is real.
let replica: MongoMemoryReplSet, db: PrismaClient, store: SuperTabStore, app: FastifyInstance

const user = (n: number, email: string): AuthUser => ({ sub: `30000000000000000000000${n}`, email, autonomousEnv: 'prod', role: 'user' })
const owner = user(1, 'owner@example.com'), peer = user(2, 'peer@example.com'), other = user(3, 'other@elsewhere.test'),
  admin = user(4, 'admin@example.com'), member = user(5, 'member@example.com')
const legacyOwner = user(6, 'legacy-owner@example.com'), legacyPeer = user(7, 'legacy-peer@example.com')
const accounts = [owner, peer, other, admin, member, legacyOwner, legacyPeer]
const call = (method: 'GET' | 'POST', url: string, as: AuthUser, body?: object) =>
  app.inject({ method, url, headers: { authorization: `Bearer ${as.sub}` }, ...(body ? { payload: body } : {}) })
const run = async (tab: string, command: Command, as = owner) => {
  const reply = await call('POST', `/api/super-tabs/${tab}/commands`, as, { operationId: randomUUID(), command })
  if (reply.statusCode !== 200) throw new Error(`${command.type}: ${reply.statusCode} ${reply.body}`)
  return reply.json().data as { result: Record<string, unknown> }
}
const create = async (as = owner, name = 'Fixture Swarm', workspaceId?: string) => {
  const reply = await call('POST', '/api/super-tabs', as, { operationId: randomUUID(), name, ...(workspaceId ? { workspaceId } : {}) })
  if (reply.statusCode !== 200) throw new Error(`create: ${reply.statusCode} ${reply.body}`)
  return reply.json().data.id as string
}
const workspacesOf = async (as: AuthUser) => (await call('GET', '/api/super-tabs/workspaces', as)).json().data.workspaces as
  Array<{ id: string; name: string; role: string; swarms: Array<{ id: string; name: string; member: boolean }> }>
const listed = async (as: AuthUser) => ((await call('GET', '/api/super-tabs/list', as)).json().data.tabs as Array<{ id: string; workspaceId: string | null }>)
/** Adds `who` to the Swarm the way an owner does today: an invitation, accepted. */
const invite = async (tab: string, who: AuthUser, by = owner) => {
  const invitation = await run(tab, { type: 'invite.create', email: who.email, role: 'collaborator', conversationId: 'lead' } as Command, by)
  await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string } as Command, who)
}

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_workspaces_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  store = new SuperTabStore(db)
  for (const account of accounts) await db.user.create({ data: { id: account.sub, externalId: `workspaces-fixture-${account.sub}`,
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

describe('a new Swarm lands in a Workspace', () => {
  it('puts a person\'s Swarms in their own Workspace, made on first need, and lists it with its Swarms', async () => {
    const first = await create(other, 'Lamp OS'), second = await create(other, 'Second')
    const workspaces = await workspacesOf(other)
    expect(workspaces).toHaveLength(1)
    expect(workspaces[0]).toMatchObject({ name: 'Lamp OS', role: 'owner' })
    expect(workspaces[0]!.swarms.map(s => s.id).sort()).toEqual([first, second].sort())
    const rows = await listed(other)
    expect(rows.filter(r => r.id === first || r.id === second).map(r => r.workspaceId)).toEqual([workspaces[0]!.id, workspaces[0]!.id])
  })
})

describe('the Workspace check on every Swarm read and command', () => {
  it('refuses a person whose Workspace membership was removed on every read path and command, before their Swarm removal runs', async () => {
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
    const [workspace] = await workspacesOf(owner)
    const removed = await db.swarmWorkspaceMember.update({ where: { id: `${workspace!.id}:${peer.sub}` }, data: { removedAt: new Date(), removedBy: owner.sub } })
    await db.swarmWorkspaceRemoval.create({ data: { id: `${removed.id}:${removed.generation}`, workspaceId: workspace!.id, userId: peer.sub, email: peer.email,
      generation: removed.generation, autonomousEnv: 'prod', removedAt: new Date(), removedBy: owner.sub, finishedAt: null } })

    // The person routes answer as for a Swarm that does not exist; the routing reads agents make keep their own answer.
    for (const url of reads) {
      const reply = await call('GET', url, peer)
      const agentRoute = /\/route-decisions$|\/attempts$/.test(url)
      expect(reply.statusCode, url).toBe(agentRoute ? 403 : NOT_AVAILABLE.status)
      expect(reply.json().error.code, url).toBe(agentRoute ? 'WORKSPACE_ACCESS_REVOKED' : NOT_AVAILABLE.code)
    }
    const send = await call('POST', `/api/super-tabs/${tab}/commands`, peer,
      { operationId: randomUUID(), command: { type: 'message.send', conversationId: 'lead', text: 'still here?', replyTo: null, recipientIds: [] } })
    expect(send.statusCode).toBe(NOT_AVAILABLE.status)
    expect((await listed(peer)).map(r => r.id)).not.toContain(tab)
    // The Swarm's own people are untouched.
    expect((await call('GET', `/api/super-tabs/${tab}/parts`, owner)).statusCode).toBe(200)
    // The sweep finishes the Swarm removal that did not run.
    expect(await swarmPeople(tab)).toContain(peer.sub)
    expect(await store.workspaces.finishRemovals()).toBe(0)
    expect(await swarmPeople(tab)).not.toContain(peer.sub)
  })

  it('keeps a person of one Workspace out of another Workspace\'s Swarm', async () => {
    const theirs = await create(other, 'Elsewhere')
    const reply = await call('GET', `/api/super-tabs/${theirs}/parts`, owner)
    expect(reply.json().error).toEqual({ code: NOT_AVAILABLE.code, message: NOT_AVAILABLE.message })
    expect(JSON.stringify(reply.json())).not.toContain('Elsewhere')
    expect((await workspacesOf(owner)).flatMap(o => o.swarms.map(s => s.id))).not.toContain(theirs)
  })
})

/** A Workspace of the owner with an admin, a member and a guest, each having accepted their invitation. */
async function workspace(name: string) {
  const created = await call('POST', '/api/super-tabs/workspaces', owner, { operationId: randomUUID(), name })
  if (created.statusCode !== 200) throw new Error(`workspace create: ${created.statusCode} ${created.body}`)
  const workspaceId = created.json().data.id as string
  for (const [who, role] of [[admin, 'admin'], [member, 'member'], [peer, 'guest']] as const) {
    const invited = await call('POST', `/api/super-tabs/workspaces/${workspaceId}/invitations`, owner, { email: who.email, role })
    if (invited.statusCode !== 200) throw new Error(`invite: ${invited.statusCode} ${invited.body}`)
    const accepted = await call('POST', `/api/super-tabs/workspaces/${workspaceId}/accept`, who, {})
    if (accepted.statusCode !== 200) throw new Error(`accept: ${accepted.statusCode} ${accepted.body}`)
  }
  return workspaceId
}
const people = async (workspaceId: string, as: AuthUser) => call('GET', `/api/super-tabs/workspaces/${workspaceId}/members`, as)
const roleOf = async (workspaceId: string, who: AuthUser) =>
  ((await people(workspaceId, owner)).json().data.members as Array<{ userId: string; role: string }>).find(m => m.userId === who.sub)?.role
const swarmPeople = async (tab: string) => ((await call('GET', `/api/super-tabs/${tab}/parts`, owner)).json().data.members as Array<{ data: { id: string } }>).map(p => p.data.id)

describe('Workspace people and roles', () => {
  it('shows the people list to members and up, never to guests or outsiders, and lets only owners and admins invite', async () => {
    const workspaceId = await workspace('People')
    const list = await people(workspaceId, member)
    expect(list.statusCode).toBe(200)
    expect((list.json().data.members as Array<{ email: string; role: string }>).map(m => [m.email, m.role]).sort()).toEqual([
      [admin.email, 'admin'], [member.email, 'member'], [owner.email, 'owner'], [peer.email, 'guest']].sort())
    expect((await people(workspaceId, peer)).statusCode).toBe(403)
    expect((await people(workspaceId, other)).statusCode).toBe(404)
    // Someone not invited cannot accept.
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/accept`, other, {})).statusCode).toBe(404)
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/invitations`, member, { email: other.email, role: 'guest' })).statusCode).toBe(403)
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/invitations`, admin, { email: other.email, role: 'admin' })).statusCode).toBe(403)
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/invitations`, admin, { email: other.email, role: 'guest' })).statusCode).toBe(200)
  })

  it('lets an admin change members and guests but not another admin, and the owner anyone but themselves', async () => {
    const workspaceId = await workspace('Roles')
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/members/${peer.sub}`, admin, { role: 'member' })).statusCode).toBe(200)
    expect(await roleOf(workspaceId, peer)).toBe('member')
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/members/${admin.sub}`, admin, { role: 'member' })).statusCode).toBe(403)
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/members/${member.sub}`, admin, { role: 'admin' })).statusCode).toBe(403)
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/members/${admin.sub}`, owner, { role: 'member' })).statusCode).toBe(200)
    expect(await roleOf(workspaceId, admin)).toBe('member')
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/members/${owner.sub}`, owner, { role: 'admin' })).statusCode).toBe(403)
  })

  it('transfers ownership only to an admin; the old owner becomes an admin', async () => {
    const workspaceId = await workspace('Transfer')
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/transfer`, owner, { userId: member.sub })).statusCode).toBe(409)
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/transfer`, admin, { userId: admin.sub })).statusCode).toBe(403)
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/transfer`, owner, { userId: admin.sub })).statusCode).toBe(200)
    expect([await roleOf(workspaceId, admin), await roleOf(workspaceId, owner)]).toEqual(['owner', 'admin'])
  })
})

describe('Swarms open to the Workspace', () => {
  it('lets members, not guests, find and join a Swarm only once it is open to the Workspace', async () => {
    const workspaceId = await workspace('Open')
    const tab = await create(owner, 'Shared work', workspaceId)
    const names = async (who: AuthUser) => (await workspacesOf(who)).find(o => o.id === workspaceId)?.swarms.map(s => s.id) ?? []
    expect(await names(member)).not.toContain(tab)
    expect(await names(admin)).toContain(tab)
    expect((await call('POST', `/api/super-tabs/${tab}/workspace-join`, member, { operationId: randomUUID() })).statusCode).toBe(403)
    expect((await call('POST', `/api/super-tabs/${tab}/workspace-visibility`, member, { visibility: 'workspace' })).statusCode).toBe(403)
    expect((await call('POST', `/api/super-tabs/${tab}/workspace-visibility`, owner, { visibility: 'workspace' })).statusCode).toBe(200)
    expect(await names(member)).toContain(tab)
    const joinedOf = async (who: AuthUser) => (await workspacesOf(who)).find(o => o.id === workspaceId)!.swarms.find(s => s.id === tab)!.member
    expect([await joinedOf(member), await joinedOf(owner)]).toEqual([false, true])
    expect(await names(peer)).not.toContain(tab)
    expect((await call('POST', `/api/super-tabs/${tab}/workspace-join`, peer, { operationId: randomUUID() })).statusCode).toBe(403)
    const joined = await call('POST', `/api/super-tabs/${tab}/workspace-join`, member, { operationId: randomUUID() })
    expect(joined.statusCode).toBe(200)
    expect(joined.json().data.role).toBe('collaborator')
    expect((await call('GET', `/api/super-tabs/${tab}/parts`, member)).statusCode).toBe(200)
    // Closing it again leaves those who joined, and hides it from the others.
    expect((await call('POST', `/api/super-tabs/${tab}/workspace-visibility`, admin, { visibility: 'invite-only' })).statusCode).toBe(200)
    expect((await call('GET', `/api/super-tabs/${tab}/parts`, member)).statusCode).toBe(200)
  })

  it('refuses creating a Swarm in a Workspace for a guest or an outsider', async () => {
    const workspaceId = await workspace('Create')
    for (const who of [peer, other]) {
      const reply = await call('POST', '/api/super-tabs', who, { operationId: randomUUID(), name: 'Mine', workspaceId })
      expect(reply.statusCode, who.email).not.toBe(200)
    }
  })
})

describe('removing someone from a Workspace', () => {
  it('removes them from every Swarm of the Workspace at once, and leaves their other Workspaces alone', async () => {
    const workspaceId = await workspace('Removal')
    const a = await create(owner, 'A', workspaceId), b = await create(owner, 'B', workspaceId)
    for (const tab of [a, b]) await invite(tab, member)
    const elsewhere = await create(other, 'Their own')
    await invite(elsewhere, member, other)
    const removed = await call('POST', `/api/super-tabs/workspaces/${workspaceId}/members/${member.sub}/remove`, admin, {})
    expect(removed.statusCode).toBe(200)
    for (const tab of [a, b]) {
      expect(await swarmPeople(tab)).not.toContain(member.sub)
      expect((await call('GET', `/api/super-tabs/${tab}/parts`, member)).statusCode).toBe(NOT_AVAILABLE.status)
    }
    expect((await workspacesOf(member)).map(o => o.id)).not.toContain(workspaceId)
    expect((await call('GET', `/api/super-tabs/${elsewhere}/parts`, member)).statusCode).toBe(200)
  })

  it('never removes the owner, nor someone who owns one of the Workspace\'s Swarms, and lets a person leave by themselves', async () => {
    const workspaceId = await workspace('Guards')
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/members/${owner.sub}/remove`, owner, {})).statusCode).toBe(409)
    await create(member, 'Member owned', workspaceId)
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/members/${member.sub}/remove`, owner, {})).statusCode).toBe(409)
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/members/${peer.sub}/remove`, peer, {})).statusCode).toBe(200)
    expect((await workspacesOf(peer)).map(o => o.id)).not.toContain(workspaceId)
  })

  it('keeps a removed person from rejoining by a link, while a new invitation brings them back', async () => {
    const workspaceId = await workspace('Rejoin')
    const tab = await create(owner, 'Linked', workspaceId)
    const sharing = await store.sharing(owner, tab)
    const saved = await store.saveSharing(owner, tab, { operationId: randomUUID(), revision: sharing.revision, access: { mode: 'link', role: 'collaborator' } })
    const token = new URL(saved.joinUrl!).searchParams.get('token')!
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/members/${peer.sub}/remove`, owner, {})).statusCode).toBe(200)
    const again = await call('POST', `/api/super-tabs/${tab}/join`, peer, { operationId: randomUUID(), token })
    expect(again.json().error).toEqual({ code: NOT_AVAILABLE.code, message: NOT_AVAILABLE.message })
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/invitations`, owner, { email: peer.email, role: 'guest' })).statusCode).toBe(200)
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/accept`, peer, {})).statusCode).toBe(200)
    expect((await call('POST', `/api/super-tabs/${tab}/join`, peer, { operationId: randomUUID(), token })).statusCode).toBe(200)
  })
})

describe('a machine contributed to Swarms of two Workspaces', () => {
  /** A contributed machine as the Swarm's parts hold it (only the fields this lookup reads). */
  const contribute = (tabId: string, machineId: string) => db.swarmMachine.create({ data: { id: `${tabId}:machine:${machineId}`, tabId,
    key: machineId, version: 1, changedAt: new Date(), ordinal: 0, data: {}, machineId, contributed: true, cleanupOwnerIds: [] } })
  const lookup = async (tabId: string, machineId: string) => db.$transaction(async tx => {
    const state = { ...(await store.load(tx, owner, tabId)).state }
    return store.otherWorkspaceMachines(tx, { ...state, machines: [{ machineId } as never] })
  })

  it('is named for this Swarm only when the other Swarm is in another Workspace', async () => {
    const workspaceId = await workspace('Machines')
    const here = await create(owner, 'Here', workspaceId), sameWorkspace = await create(owner, 'Same Workspace', workspaceId), elsewhere = await create(other, 'Other Workspace')
    await contribute(sameWorkspace, 'shared-mac')
    expect(await lookup(here, 'shared-mac')).toEqual([])
    await contribute(elsewhere, 'shared-mac')
    expect(await lookup(here, 'shared-mac')).toEqual(['shared-mac'])
  })
})

describe('the migration of today\'s Swarms into Workspaces, and its undo', () => {
  /** A Swarm as it was before Workspaces: no Workspace on its row or head, and no Workspace of its owner. */
  async function legacy(as: AuthUser, name: string) {
    const tab = await create(as, name)
    const head = await db.swarmHead.findUniqueOrThrow({ where: { id: `${tab}:head` } })
    const { workspaceId: _workspaceId, ...data } = head.data as Record<string, unknown>
    await db.swarmHead.update({ where: { id: head.id }, data: { data: data as never } })
    await db.superTab.update({ where: { id: tab }, data: { workspaceId: null } })
    await db.swarmWorkspaceMember.deleteMany({ where: { userId: as.sub } })
    await db.swarmWorkspace.deleteMany({ where: { ownerId: as.sub } })
    return tab
  }

  it('dry-runs without writing, then puts each owner\'s Swarms in one Workspace with everyone else a guest, once; the undo restores today', async () => {
    const first = await legacy(legacyOwner, 'Legacy one'), second = await legacy(legacyOwner, 'Legacy two')
    await invite(first, legacyPeer, legacyOwner)
    const before = await call('GET', `/api/super-tabs/${second}/parts`, legacyOwner)

    const dry = await migrateWorkspaces(db, { apply: false })
    expect(dry.swarms).toBe(2)
    expect(dry.workspacesCreated).toBe(1)
    expect(await db.superTab.count({ where: { id: { in: [first, second] }, workspaceId: { not: null } } })).toBe(0)
    expect(await db.swarmWorkspace.count({ where: { ownerId: legacyOwner.sub } })).toBe(0)

    const applied = await migrateWorkspaces(db, { apply: true })
    expect(applied).toMatchObject({ swarms: 2, workspacesCreated: 1, guestsAdded: 1, failed: [] })
    const [ownerWorkspace] = await workspacesOf(legacyOwner)
    expect(ownerWorkspace).toMatchObject({ name: 'Legacy one', role: 'owner' })
    expect(ownerWorkspace!.swarms.map(s => s.id).sort()).toEqual([first, second].sort())
    const peerWorkspaces = await workspacesOf(legacyPeer)
    expect(peerWorkspaces.map(o => [o.id, o.role, o.swarms.map(s => s.id)])).toEqual([[ownerWorkspace!.id, 'guest', [first]]])
    // Nobody gains or loses access.
    expect((await call('GET', `/api/super-tabs/${first}/parts`, legacyPeer)).statusCode).toBe(200)
    expect((await call('GET', `/api/super-tabs/${second}/parts`, legacyPeer)).statusCode).toBe(NOT_AVAILABLE.status)
    expect((await call('GET', `/api/super-tabs/${second}/parts`, legacyOwner)).json().data.members).toEqual(before.json().data.members)
    expect((await call('GET', `/api/super-tabs/${second}/parts`, legacyOwner)).json().data.head.data.workspaceId).toBe(ownerWorkspace!.id)

    expect(await migrateWorkspaces(db, { apply: true })).toMatchObject({ swarms: 0, workspacesCreated: 0, guestsAdded: 0 })

    const undone = await rollbackWorkspaces(db, { apply: true })
    expect(undone.failed).toEqual([])
    expect(await db.superTab.count({ where: { id: { in: [first, second] }, workspaceId: { not: null } } })).toBe(0)
    expect((await call('GET', `/api/super-tabs/${second}/parts`, legacyOwner)).json().data.head.data.workspaceId).toBeUndefined()
    expect(await db.swarmWorkspaceMember.count({ where: { userId: { in: [legacyOwner.sub, legacyPeer.sub] } } })).toBe(0)
    expect((await call('GET', `/api/super-tabs/${first}/parts`, legacyPeer)).statusCode).toBe(200)
  })

  it('serves a Swarm without a Workspace by its own membership until the switch is on, then refuses and stops listing it', async () => {
    const tab = await legacy(legacyOwner, 'Before Workspaces')
    expect((await call('GET', `/api/super-tabs/${tab}/parts`, legacyOwner)).statusCode).toBe(200)
    process.env.SWARM_WORKSPACES_REQUIRED = '1'
    try {
      const reply = await call('GET', `/api/super-tabs/${tab}/parts`, legacyOwner)
      expect(reply.statusCode).toBe(NOT_AVAILABLE.status)
      expect(reply.json().error.code).toBe(NOT_AVAILABLE.code)
      expect((await listed(legacyOwner)).map(r => r.id)).not.toContain(tab)
    } finally { delete process.env.SWARM_WORKSPACES_REQUIRED }
    await migrateWorkspaces(db, { apply: true })
    await rollbackWorkspaces(db, { apply: true })
  })

  it('lists the machines that would serve two Workspaces afterwards, before anything is written', async () => {
    const mine = await legacy(legacyOwner, 'Mine'), theirs = await legacy(legacyPeer, 'Theirs')
    for (const tabId of [mine, theirs]) await db.swarmMachine.create({ data: { id: `${tabId}:machine:both`, tabId, key: 'both-mac', version: 1,
      changedAt: new Date(), ordinal: 0, data: {}, machineId: 'both-mac', contributed: true, cleanupOwnerIds: [] } })
    const dry = await migrateWorkspaces(db, { apply: false })
    expect(dry.anomalies.machinesInTwoWorkspaces).toContainEqual({ machineId: 'both-mac', tabIds: [mine, theirs].sort() })
    await migrateWorkspaces(db, { apply: true })
    await rollbackWorkspaces(db, { apply: true })
  })
})

describe('what the Workspace check costs', () => {
  it('reads one small Workspace row per person per request, once however many agents that person contributed', async () => {
    let reads = 0
    const counted = db.$extends({ query: { swarmWorkspaceMember: { async findUnique({ args, query }) { reads++; return query(args) } } } }) as unknown as PrismaClient
    const counting = new SuperTabStore(counted)
    const tab = await create(owner, 'Counted')
    reads = 0
    await counting.read(owner, tab)
    expect(reads).toBe(1)
    reads = 0
    await counted.$transaction(async tx => {
      const { state } = await counting.load(tx, owner, tab)
      for (let i = 0; i < 5; i++) expect(await hasWorkspaceAccess(tx, state, owner.sub)).toBe(true)
    })
    expect(reads).toBe(1)
  })
})

describe('a removal whose Swarm cleanup failed', () => {
  /** As a removal leaves things when leaving one Swarm failed: removed from the Workspace, its record open, still in the Swarm. */
  async function failedRemoval(workspaceId: string, who: AuthUser) {
    const row = await db.swarmWorkspaceMember.findUniqueOrThrow({ where: { id: `${workspaceId}:${who.sub}` } })
    await db.swarmWorkspaceMember.update({ where: { id: row.id }, data: { removedAt: new Date(), removedBy: owner.sub } })
    await db.swarmWorkspaceRemoval.create({ data: { id: `${row.id}:${row.generation}`, workspaceId, userId: who.sub, email: who.email,
      generation: row.generation, autonomousEnv: 'prod', removedAt: new Date(), removedBy: owner.sub, finishedAt: null } })
  }

  it('is finished before a Workspace-only re-invite brings the person back, so the old private Swarm stays closed to them', async () => {
    const workspaceId = await workspace('Revival')
    const privateTab = await create(owner, 'Private work', workspaceId)
    await invite(privateTab, member)
    const operationId = randomUUID(), command = { type: 'message.send', conversationId: 'lead', text: 'before', replyTo: null, recipientIds: [] }
    expect((await call('POST', `/api/super-tabs/${privateTab}/commands`, member, { operationId, command })).statusCode).toBe(200)
    await failedRemoval(workspaceId, member)

    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/invitations`, owner, { email: member.email, role: 'member' })).statusCode).toBe(200)
    expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/accept`, member, {})).statusCode).toBe(200)
    expect((await workspacesOf(member)).map(o => o.id)).toContain(workspaceId)
    expect(await swarmPeople(privateTab)).not.toContain(member.sub)
    expect((await call('GET', `/api/super-tabs/${privateTab}/parts`, member)).statusCode).toBe(NOT_AVAILABLE.status)
    expect((await call('POST', `/api/super-tabs/${privateTab}/commands`, member, { operationId, command })).statusCode).toBe(NOT_AVAILABLE.status)
  })

  it('keeps the person out while the earlier removal cannot finish', async () => {
    const workspaceId = await workspace('Stuck')
    const tab = await create(owner, 'Stuck work', workspaceId), elsewhere = await create(owner, 'Healthy work', workspaceId)
    await invite(tab, member)
    await failedRemoval(workspaceId, member)
    // The Swarm cannot be loaded for now, so leaving it fails again.
    await db.superTab.update({ where: { id: tab }, data: { format: 1 } })
    try {
      expect((await call('POST', `/api/super-tabs/workspaces/${workspaceId}/invitations`, owner, { email: member.email, role: 'member' })).statusCode).toBe(200)
      const accepted = await call('POST', `/api/super-tabs/workspaces/${workspaceId}/accept`, member, {})
      expect(accepted.statusCode).toBe(409)
      expect((await workspacesOf(member)).map(o => o.id)).not.toContain(workspaceId)
      // Nor does a Swarm invitation make them a guest of the Workspace meanwhile.
      const invitation = await run(elsewhere, { type: 'invite.create', email: member.email, role: 'collaborator', conversationId: 'lead' } as Command)
      const viaSwarm = await call('POST', `/api/super-tabs/${elsewhere}/commands`, member,
        { operationId: randomUUID(), command: { type: 'invite.accept', inviteId: invitation.result.inviteId } })
      expect(viaSwarm.statusCode).toBe(409)
    } finally { await db.superTab.update({ where: { id: tab }, data: { format: 2 } }) }
  })
})

describe('the sweep of unfinished removals', () => {
  it('reaches every open removal, however many, including one whose first try failed', async () => {
    const workspaceId = await workspace('Many removals')
    const tab = await create(owner, 'Last one', workspaceId)
    await invite(tab, member)
    const removedAt = new Date(Date.now() - 60_000)
    await db.swarmWorkspaceRemoval.createMany({ data: Array.from({ length: 500 }, (_, i) => ({ id: `${workspaceId}:filler-${i}:g`, workspaceId,
      userId: `filler-${i}`, email: `filler-${i}@example.com`, generation: 'g', autonomousEnv: 'prod', removedAt, removedBy: owner.sub, finishedAt: null })) })
    const row = await db.swarmWorkspaceMember.findUniqueOrThrow({ where: { id: `${workspaceId}:${member.sub}` } })
    await db.swarmWorkspaceMember.update({ where: { id: row.id }, data: { removedAt: new Date() } })
    await db.swarmWorkspaceRemoval.create({ data: { id: `${row.id}:${row.generation}`, workspaceId, userId: member.sub, email: member.email,
      generation: row.generation, autonomousEnv: 'prod', removedAt: new Date(), removedBy: owner.sub, finishedAt: null } })

    let failOnce = true
    const leaves: string[] = []
    const workspaces = new SwarmWorkspaces(db, { transaction: body => db.$transaction(body), now: Date.now, leave: async (person, tabId, operationId) => {
      if (tabId !== tab) return store.workspaces['deps'].leave(person, tabId, operationId)
      leaves.push(`${person.sub}:${tabId}`)
      if (failOnce) { failOnce = false; throw new Error('the Swarm was busy') }
      return store.workspaces['deps'].leave(person, tabId, operationId)
    } })
    expect(await workspaces.finishRemovals()).toBeGreaterThanOrEqual(1)
    expect(await workspaces.finishRemovals()).toBe(0)
    expect(leaves).toEqual([`${member.sub}:${tab}`, `${member.sub}:${tab}`])
    expect(await swarmPeople(tab)).not.toContain(member.sub)
    expect(await db.swarmWorkspaceRemoval.count({ where: { workspaceId, finishedAt: null } })).toBe(0)
  })
})

describe('who may invite people to a Workspace\'s Swarm', () => {
  it('lets the Swarm\'s owner and the Workspace\'s owners, admins and members in it invite, never a guest; revoking is for owners and admins', async () => {
    const workspaceId = await workspace('Inviting')
    const tab = await create(owner, 'Invites', workspaceId)
    for (const who of [admin, member, peer]) await invite(tab, who)
    const inviteAs = async (who: AuthUser, email: string) => call('POST', `/api/super-tabs/${tab}/commands`, who,
      { operationId: randomUUID(), command: { type: 'invite.create', email, role: 'collaborator', conversationId: 'lead' } })
    for (const [who, email] of [[owner, 'a@example.com'], [admin, 'b@example.com'], [member, 'c@example.com']] as const) {
      const reply = await inviteAs(who, email)
      expect(reply.statusCode, who.email).toBe(200)
    }
    const refused = await inviteAs(peer, 'd@example.com')
    expect(refused.statusCode).toBe(403)
    const inviteId = (await inviteAs(member, 'e@example.com')).json().data.result.inviteId as string
    const revokeAs = (who: AuthUser) => call('POST', `/api/super-tabs/${tab}/commands`, who,
      { operationId: randomUUID(), command: { type: 'invite.revoke', inviteId } })
    expect((await revokeAs(member)).statusCode).toBe(403)
    expect((await revokeAs(admin)).statusCode).toBe(200)
  })
})
