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
import { migrateOrgs, rollbackOrgs } from '../src/superTabs/migration/orgs.js'

// Teams above Swarms (docs/plans/2026-10-27-swarm-teams.md): every route, authorization and Mongo transaction is real.
let replica: MongoMemoryReplSet, db: PrismaClient, store: SuperTabStore, app: FastifyInstance

const user = (n: number, email: string): AuthUser => ({ sub: `30000000000000000000000${n}`, email, autonomousEnv: 'prod', role: 'user' })
const owner = user(1, 'owner@example.com'), peer = user(2, 'peer@example.com'), other = user(3, 'other@elsewhere.test'),
  admin = user(4, 'admin@example.com'), member = user(5, 'member@example.com')
const legacyOwner = user(6, 'legacy-owner@example.com'), legacyPeer = user(7, 'legacy-peer@example.com')
const accounts = [owner, peer, other, admin, member, legacyOwner, legacyPeer]
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
  Array<{ id: string; name: string; role: string; swarms: Array<{ id: string; name: string; member: boolean }> }>
const listed = async (as: AuthUser) => ((await call('GET', '/api/super-tabs/list', as)).json().data.tabs as Array<{ id: string; orgId: string | null }>)
/** Adds `who` to the Swarm the way an owner does today: an invitation, accepted. */
const invite = async (tab: string, who: AuthUser, by = owner) => {
  const invitation = await run(tab, { type: 'invite.create', email: who.email, role: 'collaborator', conversationId: 'lead' } as Command, by)
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
    // The sweep finishes the Swarm removal that did not run.
    expect(await swarmPeople(tab)).toContain(peer.sub)
    expect(await store.orgs.finishRemovals()).toBe(0)
    expect(await swarmPeople(tab)).not.toContain(peer.sub)
  })

  it('keeps a person of one Team out of another Team\'s Swarm', async () => {
    const theirs = await create(other, 'Elsewhere')
    const reply = await call('GET', `/api/super-tabs/${theirs}/parts`, owner)
    expect(reply.statusCode).toBe(403)
    expect(JSON.stringify(reply.json())).not.toContain('Elsewhere')
    expect((await orgsOf(owner)).flatMap(o => o.swarms.map(s => s.id))).not.toContain(theirs)
  })
})

/** A Team of the owner with an admin, a member and a guest, each having accepted their invitation. */
async function team(name: string) {
  const created = await call('POST', '/api/super-tabs/orgs', owner, { operationId: randomUUID(), name })
  if (created.statusCode !== 200) throw new Error(`org create: ${created.statusCode} ${created.body}`)
  const orgId = created.json().data.id as string
  for (const [who, role] of [[admin, 'admin'], [member, 'member'], [peer, 'guest']] as const) {
    const invited = await call('POST', `/api/super-tabs/orgs/${orgId}/invitations`, owner, { email: who.email, role })
    if (invited.statusCode !== 200) throw new Error(`invite: ${invited.statusCode} ${invited.body}`)
    const accepted = await call('POST', `/api/super-tabs/orgs/${orgId}/accept`, who, {})
    if (accepted.statusCode !== 200) throw new Error(`accept: ${accepted.statusCode} ${accepted.body}`)
  }
  return orgId
}
const people = async (orgId: string, as: AuthUser) => call('GET', `/api/super-tabs/orgs/${orgId}/members`, as)
const roleOf = async (orgId: string, who: AuthUser) =>
  ((await people(orgId, owner)).json().data.members as Array<{ userId: string; role: string }>).find(m => m.userId === who.sub)?.role
const swarmPeople = async (tab: string) => ((await call('GET', `/api/super-tabs/${tab}/parts`, owner)).json().data.members as Array<{ data: { id: string } }>).map(p => p.data.id)

describe('Team people and roles', () => {
  it('shows the people list to members and up, never to guests or outsiders, and lets only owners and admins invite', async () => {
    const orgId = await team('People')
    const list = await people(orgId, member)
    expect(list.statusCode).toBe(200)
    expect((list.json().data.members as Array<{ email: string; role: string }>).map(m => [m.email, m.role]).sort()).toEqual([
      [admin.email, 'admin'], [member.email, 'member'], [owner.email, 'owner'], [peer.email, 'guest']].sort())
    expect((await people(orgId, peer)).statusCode).toBe(403)
    expect((await people(orgId, other)).statusCode).toBe(404)
    // Someone not invited cannot accept.
    expect((await call('POST', `/api/super-tabs/orgs/${orgId}/accept`, other, {})).statusCode).toBe(404)
    expect((await call('POST', `/api/super-tabs/orgs/${orgId}/invitations`, member, { email: other.email, role: 'guest' })).statusCode).toBe(403)
    expect((await call('POST', `/api/super-tabs/orgs/${orgId}/invitations`, admin, { email: other.email, role: 'admin' })).statusCode).toBe(403)
    expect((await call('POST', `/api/super-tabs/orgs/${orgId}/invitations`, admin, { email: other.email, role: 'guest' })).statusCode).toBe(200)
  })

  it('lets an admin change members and guests but not another admin, and the owner anyone but themselves', async () => {
    const orgId = await team('Roles')
    expect((await call('POST', `/api/super-tabs/orgs/${orgId}/members/${peer.sub}`, admin, { role: 'member' })).statusCode).toBe(200)
    expect(await roleOf(orgId, peer)).toBe('member')
    expect((await call('POST', `/api/super-tabs/orgs/${orgId}/members/${admin.sub}`, admin, { role: 'member' })).statusCode).toBe(403)
    expect((await call('POST', `/api/super-tabs/orgs/${orgId}/members/${member.sub}`, admin, { role: 'admin' })).statusCode).toBe(403)
    expect((await call('POST', `/api/super-tabs/orgs/${orgId}/members/${admin.sub}`, owner, { role: 'member' })).statusCode).toBe(200)
    expect(await roleOf(orgId, admin)).toBe('member')
    expect((await call('POST', `/api/super-tabs/orgs/${orgId}/members/${owner.sub}`, owner, { role: 'admin' })).statusCode).toBe(403)
  })

  it('transfers ownership only to an admin; the old owner becomes an admin', async () => {
    const orgId = await team('Transfer')
    expect((await call('POST', `/api/super-tabs/orgs/${orgId}/transfer`, owner, { userId: member.sub })).statusCode).toBe(409)
    expect((await call('POST', `/api/super-tabs/orgs/${orgId}/transfer`, admin, { userId: admin.sub })).statusCode).toBe(403)
    expect((await call('POST', `/api/super-tabs/orgs/${orgId}/transfer`, owner, { userId: admin.sub })).statusCode).toBe(200)
    expect([await roleOf(orgId, admin), await roleOf(orgId, owner)]).toEqual(['owner', 'admin'])
  })
})

describe('Swarms open to the Team', () => {
  it('lets members, not guests, find and join a Swarm only once it is open to the Team', async () => {
    const orgId = await team('Open')
    const tab = await create(owner, 'Shared work', orgId)
    const names = async (who: AuthUser) => (await orgsOf(who)).find(o => o.id === orgId)?.swarms.map(s => s.id) ?? []
    expect(await names(member)).not.toContain(tab)
    expect(await names(admin)).toContain(tab)
    expect((await call('POST', `/api/super-tabs/${tab}/org-join`, member, { operationId: randomUUID() })).statusCode).toBe(403)
    expect((await call('POST', `/api/super-tabs/${tab}/org-visibility`, member, { visibility: 'org' })).statusCode).toBe(403)
    expect((await call('POST', `/api/super-tabs/${tab}/org-visibility`, owner, { visibility: 'org' })).statusCode).toBe(200)
    expect(await names(member)).toContain(tab)
    const joinedOf = async (who: AuthUser) => (await orgsOf(who)).find(o => o.id === orgId)!.swarms.find(s => s.id === tab)!.member
    expect([await joinedOf(member), await joinedOf(owner)]).toEqual([false, true])
    expect(await names(peer)).not.toContain(tab)
    expect((await call('POST', `/api/super-tabs/${tab}/org-join`, peer, { operationId: randomUUID() })).statusCode).toBe(403)
    const joined = await call('POST', `/api/super-tabs/${tab}/org-join`, member, { operationId: randomUUID() })
    expect(joined.statusCode).toBe(200)
    expect(joined.json().data.role).toBe('collaborator')
    expect((await call('GET', `/api/super-tabs/${tab}/parts`, member)).statusCode).toBe(200)
    // Closing it again leaves those who joined, and hides it from the others.
    expect((await call('POST', `/api/super-tabs/${tab}/org-visibility`, admin, { visibility: 'invite-only' })).statusCode).toBe(200)
    expect((await call('GET', `/api/super-tabs/${tab}/parts`, member)).statusCode).toBe(200)
  })

  it('refuses creating a Swarm in a Team for a guest or an outsider', async () => {
    const orgId = await team('Create')
    for (const who of [peer, other]) {
      const reply = await call('POST', '/api/super-tabs', who, { operationId: randomUUID(), name: 'Mine', orgId })
      expect(reply.statusCode, who.email).not.toBe(200)
    }
  })
})

describe('removing someone from a Team', () => {
  it('removes them from every Swarm of the Team at once, and leaves their other Teams alone', async () => {
    const orgId = await team('Removal')
    const a = await create(owner, 'A', orgId), b = await create(owner, 'B', orgId)
    for (const tab of [a, b]) await invite(tab, member)
    const elsewhere = await create(other, 'Their own')
    await invite(elsewhere, member, other)
    const removed = await call('DELETE', `/api/super-tabs/orgs/${orgId}/members/${member.sub}`, admin)
    expect(removed.statusCode).toBe(200)
    for (const tab of [a, b]) {
      expect(await swarmPeople(tab)).not.toContain(member.sub)
      expect((await call('GET', `/api/super-tabs/${tab}/parts`, member)).statusCode).toBe(403)
    }
    expect((await orgsOf(member)).map(o => o.id)).not.toContain(orgId)
    expect((await call('GET', `/api/super-tabs/${elsewhere}/parts`, member)).statusCode).toBe(200)
  })

  it('never removes the owner, nor someone who owns one of the Team\'s Swarms, and lets a person leave by themselves', async () => {
    const orgId = await team('Guards')
    expect((await call('DELETE', `/api/super-tabs/orgs/${orgId}/members/${owner.sub}`, owner)).statusCode).toBe(409)
    await create(member, 'Member owned', orgId)
    expect((await call('DELETE', `/api/super-tabs/orgs/${orgId}/members/${member.sub}`, owner)).statusCode).toBe(409)
    expect((await call('DELETE', `/api/super-tabs/orgs/${orgId}/members/${peer.sub}`, peer)).statusCode).toBe(200)
    expect((await orgsOf(peer)).map(o => o.id)).not.toContain(orgId)
  })

  it('keeps a removed person from rejoining by a link, while a new invitation brings them back', async () => {
    const orgId = await team('Rejoin')
    const tab = await create(owner, 'Linked', orgId)
    const sharing = await store.sharing(owner, tab)
    const saved = await store.saveSharing(owner, tab, { operationId: randomUUID(), revision: sharing.revision, access: { mode: 'link', role: 'collaborator' } })
    const token = new URL(saved.joinUrl!).searchParams.get('token')!
    expect((await call('DELETE', `/api/super-tabs/orgs/${orgId}/members/${peer.sub}`, owner)).statusCode).toBe(200)
    const again = await call('POST', `/api/super-tabs/${tab}/join`, peer, { operationId: randomUUID(), token })
    expect(again.statusCode).toBe(403)
    expect((await call('POST', `/api/super-tabs/orgs/${orgId}/invitations`, owner, { email: peer.email, role: 'guest' })).statusCode).toBe(200)
    expect((await call('POST', `/api/super-tabs/orgs/${orgId}/accept`, peer, {})).statusCode).toBe(200)
    expect((await call('POST', `/api/super-tabs/${tab}/join`, peer, { operationId: randomUUID(), token })).statusCode).toBe(200)
  })
})

describe('a machine contributed to Swarms of two Teams', () => {
  /** A contributed machine as the Swarm's parts hold it (only the fields this lookup reads). */
  const contribute = (tabId: string, machineId: string) => db.swarmMachine.create({ data: { id: `${tabId}:machine:${machineId}`, tabId,
    key: machineId, version: 1, changedAt: new Date(), ordinal: 0, data: {}, machineId, contributed: true, cleanupOwnerIds: [] } })
  const lookup = async (tabId: string, machineId: string) => db.$transaction(async tx => {
    const state = { ...(await store.load(tx, owner, tabId)).state }
    return store.otherOrgMachines(tx, { ...state, machines: [{ machineId } as never] })
  })

  it('is named for this Swarm only when the other Swarm is in another Team', async () => {
    const orgId = await team('Machines')
    const here = await create(owner, 'Here', orgId), sameTeam = await create(owner, 'Same Team', orgId), elsewhere = await create(other, 'Other Team')
    await contribute(sameTeam, 'shared-mac')
    expect(await lookup(here, 'shared-mac')).toEqual([])
    await contribute(elsewhere, 'shared-mac')
    expect(await lookup(here, 'shared-mac')).toEqual(['shared-mac'])
  })
})

describe('the migration of today\'s Swarms into Teams, and its undo', () => {
  /** A Swarm as it was before Teams: no Team on its row or head, and no Team of its owner. */
  async function legacy(as: AuthUser, name: string) {
    const tab = await create(as, name)
    const head = await db.swarmHead.findUniqueOrThrow({ where: { id: `${tab}:head` } })
    const { orgId: _orgId, ...data } = head.data as Record<string, unknown>
    await db.swarmHead.update({ where: { id: head.id }, data: { data: data as never } })
    await db.superTab.update({ where: { id: tab }, data: { orgId: null } })
    await db.swarmOrgMember.deleteMany({ where: { userId: as.sub } })
    await db.swarmOrg.deleteMany({ where: { ownerId: as.sub } })
    return tab
  }

  it('dry-runs without writing, then puts each owner\'s Swarms in one Team with everyone else a guest, once; the undo restores today', async () => {
    const first = await legacy(legacyOwner, 'Legacy one'), second = await legacy(legacyOwner, 'Legacy two')
    await invite(first, legacyPeer, legacyOwner)
    const before = await call('GET', `/api/super-tabs/${second}/parts`, legacyOwner)

    const dry = await migrateOrgs(db, { apply: false })
    expect(dry.swarms).toBe(2)
    expect(dry.orgsCreated).toBe(1)
    expect(await db.superTab.count({ where: { id: { in: [first, second] }, orgId: { not: null } } })).toBe(0)
    expect(await db.swarmOrg.count({ where: { ownerId: legacyOwner.sub } })).toBe(0)

    const applied = await migrateOrgs(db, { apply: true })
    expect(applied).toMatchObject({ swarms: 2, orgsCreated: 1, guestsAdded: 1, failed: [] })
    const [ownerOrg] = await orgsOf(legacyOwner)
    expect(ownerOrg).toMatchObject({ name: 'Legacy one', role: 'owner' })
    expect(ownerOrg!.swarms.map(s => s.id).sort()).toEqual([first, second].sort())
    const peerOrgs = await orgsOf(legacyPeer)
    expect(peerOrgs.map(o => [o.id, o.role, o.swarms.map(s => s.id)])).toEqual([[ownerOrg!.id, 'guest', [first]]])
    // Nobody gains or loses access.
    expect((await call('GET', `/api/super-tabs/${first}/parts`, legacyPeer)).statusCode).toBe(200)
    expect((await call('GET', `/api/super-tabs/${second}/parts`, legacyPeer)).statusCode).toBe(403)
    expect((await call('GET', `/api/super-tabs/${second}/parts`, legacyOwner)).json().data.members).toEqual(before.json().data.members)
    expect((await call('GET', `/api/super-tabs/${second}/parts`, legacyOwner)).json().data.head.data.orgId).toBe(ownerOrg!.id)

    expect(await migrateOrgs(db, { apply: true })).toMatchObject({ swarms: 0, orgsCreated: 0, guestsAdded: 0 })

    const undone = await rollbackOrgs(db, { apply: true })
    expect(undone.failed).toEqual([])
    expect(await db.superTab.count({ where: { id: { in: [first, second] }, orgId: { not: null } } })).toBe(0)
    expect((await call('GET', `/api/super-tabs/${second}/parts`, legacyOwner)).json().data.head.data.orgId).toBeUndefined()
    expect(await db.swarmOrgMember.count({ where: { userId: { in: [legacyOwner.sub, legacyPeer.sub] } } })).toBe(0)
    expect((await call('GET', `/api/super-tabs/${first}/parts`, legacyPeer)).statusCode).toBe(200)
  })

  it('serves a Swarm without a Team by its own membership until the switch is on, then refuses and stops listing it', async () => {
    const tab = await legacy(legacyOwner, 'Before Teams')
    expect((await call('GET', `/api/super-tabs/${tab}/parts`, legacyOwner)).statusCode).toBe(200)
    process.env.SWARM_TEAMS_REQUIRED = '1'
    try {
      const reply = await call('GET', `/api/super-tabs/${tab}/parts`, legacyOwner)
      expect(reply.statusCode).toBe(403)
      expect(JSON.stringify(reply.json())).toContain('ORG_ACCESS_REVOKED')
      expect((await listed(legacyOwner)).map(r => r.id)).not.toContain(tab)
    } finally { delete process.env.SWARM_TEAMS_REQUIRED }
    await migrateOrgs(db, { apply: true })
    await rollbackOrgs(db, { apply: true })
  })

  it('lists the machines that would serve two Teams afterwards, before anything is written', async () => {
    const mine = await legacy(legacyOwner, 'Mine'), theirs = await legacy(legacyPeer, 'Theirs')
    for (const tabId of [mine, theirs]) await db.swarmMachine.create({ data: { id: `${tabId}:machine:both`, tabId, key: 'both-mac', version: 1,
      changedAt: new Date(), ordinal: 0, data: {}, machineId: 'both-mac', contributed: true, cleanupOwnerIds: [] } })
    const dry = await migrateOrgs(db, { apply: false })
    expect(dry.anomalies.machinesInTwoTeams).toContainEqual({ machineId: 'both-mac', tabIds: [mine, theirs].sort() })
    await migrateOrgs(db, { apply: true })
    await rollbackOrgs(db, { apply: true })
  })
})
